require('dotenv').config();

const { jwtVerify, createRemoteJWKSet } = require('jose');
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { enviarEmail, emailVagaLivre } = require('./enviarEmail');
const config = require('./config');

const app = express();

// ======================================================
// JWKS (verificação JWT do DEE)
// ======================================================

const JWKS = createRemoteJWKSet(new URL(config.DEE_JWKS_URL));

app.use(cors());
app.use(express.json());
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
});

app.use((req, res, next) => {
    console.log('URL recebida pelo Node:', req.url, '| Method:', req.method);
    // Remove prefixo se vier do proxy com /DEE/micmic-lab
    if (req.url.startsWith('/DEE/micmic-lab')) {
        req.url = req.url.slice('/DEE/micmic-lab'.length) || '/';
    }
    // Corrige dupla barra // que o proxy pode introduzir
    while (req.url.startsWith('//')) {
        req.url = req.url.slice(1);
    }
    if (!req.url.startsWith('/')) req.url = '/' + req.url;
    console.log('URL após rewrite:', req.url);
    next();
});

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const SECRET_KEY = process.env.JWT_SECRET;

// Usernames dos professores/administradores
const ADMINS_UC = config.ADMINS_UC;

// URL da aplicação (usada no redirect DEE)
const APP_URL = config.APP_URL;

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Erro ao ligar ao MySQL:', err);
        return;
    }
    console.log('Ligado à base de dados!');
    inicializarBD();
});

// ======================================================
// INICIALIZAR TABELAS
// ======================================================

function inicializarBD() {

    // Tabela utilizadores com campo role e username DEE
    db.query(`
        CREATE TABLE IF NOT EXISTS utilizadores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            nome VARCHAR(200),
            email VARCHAR(200),
            role ENUM('aluno', 'admin') DEFAULT 'aluno',
            creditos INT DEFAULT 60,
            ultima_reserva_fim DATETIME DEFAULT NULL,
            data_registo DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => { if (err) console.error('Erro ao criar tabela utilizadores:', err); });

    // Postos de trabalho. Criada antes de "reservas" porque essa referencia postos(id).
    db.query(`
        CREATE TABLE IF NOT EXISTS postos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            pi_host VARCHAR(100) NOT NULL,
            pi_port INT NOT NULL DEFAULT 5000,
            ativo TINYINT(1) NOT NULL DEFAULT 1,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) return console.error('Erro ao criar tabela postos:', err);
        // Posto que já existia antes de haver vários, para as reservas antigas
        // continuarem a apontar para o Pi certo.
        db.query(
            'INSERT IGNORE INTO postos (id, nome, pi_host, pi_port, ativo) VALUES (1, ?, ?, ?, 1)',
            ['Posto 1', '193.136.63.52', 5000],
            (errSeed) => {
                if (errSeed) console.error('Erro ao semear posto inicial:', errSeed);
                recarregarPostosAtivos();
            }
        );
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS reservas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            utilizador_id INT NOT NULL,
            posto_id INT DEFAULT NULL,
            data_reserva DATE NOT NULL,
            hora_inicio TIME NOT NULL,
            hora_fim TIME NOT NULL,
            hora_fim_original TIME DEFAULT NULL,
            hora_inicio_real TIME DEFAULT NULL,
            hora_fim_real TIME DEFAULT NULL,
            estado ENUM('ativa', 'em_curso', 'cancelada', 'concluida', 'falta') DEFAULT 'ativa',
            criado_por_admin TINYINT(1) NOT NULL DEFAULT 0,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (utilizador_id) REFERENCES utilizadores(id),
            FOREIGN KEY (posto_id) REFERENCES postos(id)
        )
    `, (err) => { if (err) console.error('Erro ao criar tabela reservas:', err); });

    // Fila de espera por disponibilidade num dia
    db.query(`
        CREATE TABLE IF NOT EXISTS fila_espera (
            id INT AUTO_INCREMENT PRIMARY KEY,
            utilizador_id INT NOT NULL,
            data_reserva DATE NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY utilizador_dia (utilizador_id, data_reserva),
            FOREIGN KEY (utilizador_id) REFERENCES utilizadores(id)
        )
    `, (err) => { if (err) console.error('Erro ao criar tabela fila_espera:', err); });

    // Vaga temporária atribuída ao 1º da fila. O UNIQUE em data_reserva garante
    // que só há uma ativa por dia.
    db.query(`
        CREATE TABLE IF NOT EXISTS vaga_pendente (
            id INT AUTO_INCREMENT PRIMARY KEY,
            utilizador_id INT NOT NULL,
            data_reserva DATE NOT NULL UNIQUE,
            expira_em DATETIME NOT NULL,
            FOREIGN KEY (utilizador_id) REFERENCES utilizadores(id)
        )
    `, (err) => { if (err) console.error('Erro ao criar tabela vaga_pendente:', err); });

    // Uma só linha, com as definições ajustáveis pelo admin e a data do último
    // reset de créditos.
    db.query(`
        CREATE TABLE IF NOT EXISTS estado_sistema (
            id INT PRIMARY KEY DEFAULT 1,
            ultimo_reset_creditos DATETIME DEFAULT NULL,
            fila_tempo_real_t1_segundos INT DEFAULT 20,
            fila_janela_verificacao_minutos INT DEFAULT 60,
            heartbeat_sessao_timeout_minutos INT DEFAULT 5
        )
    `, (err) => {
        if (err) return console.error('Erro ao criar tabela estado_sistema:', err);
        db.query('INSERT IGNORE INTO estado_sistema (id) VALUES (1)', (err2) => {
            if (err2) console.error('Erro ao inicializar estado_sistema:', err2);
        });
    });

    console.log('Tabelas verificadas/criadas.');
    agendarResetSemanal();
}

// ======================================================
// RESET SEMANAL DE CRÉDITOS (toda segunda-feira à meia-noite)
// ======================================================
// A data do último reset fica em estado_sistema e não só em memória: se o
// processo reiniciar sem ter feito o reset da semana, a verificação periódica
// apanha-o em atraso em vez de o saltar.

function calcularSegundaMaisRecente(agora) {
    const diaSemana = agora.getDay(); // 0=domingo, 1=segunda, ...
    const diasDesdeSegunda = (diaSemana + 6) % 7; // segunda=0, terça=1, ..., domingo=6
    const segunda = new Date(agora);
    segunda.setDate(agora.getDate() - diasDesdeSegunda);
    segunda.setHours(0, 0, 0, 0);
    return segunda;
}

function agendarResetSemanal() {
    verificarResetSemanal();
    setInterval(verificarResetSemanal, 60 * 60 * 1000); // verifica de hora a hora
}

function verificarResetSemanal() {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const segundaMaisRecente = calcularSegundaMaisRecente(agora);

    db.query('SELECT ultimo_reset_creditos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return console.error('Erro ao verificar reset semanal:', err);

        const ultimoReset = results[0]?.ultimo_reset_creditos ? new Date(results[0].ultimo_reset_creditos) : null;
        if (!ultimoReset || ultimoReset < segundaMaisRecente) {
            executarReset(segundaMaisRecente);
        }
    });
}

function executarReset(segundaDeReferencia) {
    db.query(
        "UPDATE utilizadores SET creditos = 60, ultima_reserva_fim = NULL WHERE role != 'admin'",
        (err, result) => {
            if (err) {
                console.error('Erro no reset semanal de créditos:', err);
                return;
            }
            console.log(`Reset semanal: ${result.affectedRows} utilizadores com créditos renovados.`);
            db.query(
                'UPDATE estado_sistema SET ultimo_reset_creditos = ? WHERE id = 1',
                [segundaDeReferencia],
                (err2) => { if (err2) console.error('Erro ao registar data do reset semanal:', err2); }
            );
        }
    );
}

// ======================================================
// MIDDLEWARE: Verificar token local
// ======================================================

function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Token não fornecido" });
    }

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) {
            return res.status(403).json({ message: "Token inválido ou expirado" });
        }
        req.user = user;
        next();
    });
}

// ======================================================
// MIDDLEWARE: Verificar se é administrador
// ======================================================

function verificarAdmin(req, res, next) {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ message: "Não autenticado" });
    }

    // Em vez de olhar para o token, vai à BD ver o estado atual real
    db.query('SELECT role FROM utilizadores WHERE id = ?', [req.user.id], (err, results) => {
        if (err || results.length === 0) {
            return res.status(500).json({ message: "Erro ao validar permissões" });
        }

        const roleAtual = results[0].role;

        if (roleAtual === 'admin') {
            req.user.role = 'admin';
            next();
        } else {
            return res.status(403).json({ message: "Acesso restrito a administradores" });
        }
    });
}

// ======================================================
// AUTH DEE — Redirecionar para login DEE
// ======================================================

app.get('/api/auth/dee', (req, res) => {
    // O frontend redireciona para cá, que por sua vez redireciona para o DEE
    // O callback será a raiz da app com ?jwt=... (o DEE chama-lhe auth_jwt ou jwt)
    const callbackUrl = `${APP_URL}`;
    const loginUrl = `${config.DEE_LOGIN_URL}?requester=${encodeURIComponent(callbackUrl)}`;
    res.redirect(loginUrl);
});

// ======================================================
// AUTH DEE — Processar JWT recebido do DEE
// O frontend chama esta rota com o jwt recebido na query string
// ======================================================

app.post('/api/auth/dee/callback', async (req, res) => {
    try {
        const { auth_jwt } = req.body;

        if (!auth_jwt) {
            return res.status(400).json({ message: "JWT não fornecido" });
        }
        // Verificar JWT assinado pelo DEE usando JWKS público
        const { payload } = await jwtVerify(auth_jwt, JWKS);

        const { username, shortName, email, role } = payload.data;

        console.log(`JWT DEE validado: ${username} (${role})`);

        // Verificar se utilizador existe, senão criar
        db.query(
            'SELECT * FROM utilizadores WHERE username = ?',
            [username],
            (err, results) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Erro na base de dados" });
                }

                const upsertUser = (userId, userRole, creditos) => {
                    // Gerar token local
                    const tokenPayload = {
                        id: userId,
                        username,
                        nome: shortName,
                        email: email || `${username}@isep.ipp.pt`,
                        role: userRole
                    };

                    const token = jwt.sign(tokenPayload, SECRET_KEY, { expiresIn: '8h' });

                    return res.status(200).json({
                        message: "Autenticação bem-sucedida",
                        token,
                        user: {
                            id: userId,
                            username,
                            nome: shortName,
                            email: email || `${username}@isep.ipp.pt`,
                            role: userRole,
                            creditos
                        }
                    });
                };

                if (results.length === 0) {
                    const roleLocal = ADMINS_UC.includes(username) ? 'admin' : 'aluno';
                    const creditosIniciais = 60;

                    db.query(
                        'INSERT INTO utilizadores (username, nome, email, role, creditos, data_registo) VALUES (?, ?, ?, ?, ?, NOW())',
                        [username, shortName, email || `${username}@isep.ipp.pt`, roleLocal, creditosIniciais],
                        (err, result) => {
                            if (err) {
                                console.error(err);
                                return res.status(500).json({ message: "Erro ao criar utilizador" });
                            }
                            upsertUser(result.insertId, roleLocal, creditosIniciais);
                        }
                    );
                } else {
                    const user = results[0];
                    const roleCorreto = ADMINS_UC.includes(username) ? 'admin' : 'aluno';
                    
                    if (roleCorreto !== user.role) {
                        // Grava o role novo antes de emitir o token, senão o login
                        // ainda saía com o role antigo.
                        db.query('UPDATE utilizadores SET role = ? WHERE id = ?', [roleCorreto, user.id], (err) => {
                            if (err) console.error("Erro ao atualizar role de admin:", err);
                            upsertUser(user.id, roleCorreto, user.creditos);
                        });
                    } else {
                        upsertUser(user.id, user.role, user.creditos);
                    }
                }
            }
        );

    } catch (err) {
        console.error("Erro a validar JWT DEE:", err);
        res.status(401).json({ message: "JWT inválido ou expirado" });
    }
});

// ======================================================
// VERIFICAR TOKEN (útil para o frontend validar sessão)
// ======================================================

app.get('/api/verificar', verificarToken, (req, res) => {
    // Os créditos vêm da BD e não do token.
    db.query('SELECT creditos, role, ultima_reserva_fim FROM utilizadores WHERE id = ?', [req.user.id], (err, results) => {
        if (err || results.length === 0) {
            return res.status(200).json({ message: "Token válido", user: req.user });
        }
        
        const userBD = results[0];
        res.status(200).json({
            message: "Token válido",
            user: { 
                ...req.user, 
                creditos: userBD.creditos, 
                role: userBD.role,
                ultima_reserva_fim: userBD.ultima_reserva_fim 
            }
        });
    });
});

// ======================================================
// BUSCAR HORÁRIOS OCUPADOS
// ======================================================

// Blocos de 10 min de um dia em que TODOS os postos ativos estão ocupados.
// Só esses contam como indisponíveis: basta um posto livre para o bloco ainda
// dar para reservar. Devolve um Set de "HH:MM".
function calcularBlocosCheios(data, callback) {
    const sql = `
        SELECT hora_inicio, hora_fim, data_reserva, posto_id
        FROM reservas
        WHERE estado IN ('ativa', 'em_curso')
        AND (
            data_reserva = ?
            OR (data_reserva = DATE_SUB(?, INTERVAL 1 DAY)
                AND TIME_TO_SEC(hora_fim) < TIME_TO_SEC(hora_inicio))
        )
    `;

    db.query(sql, [data, data], (err, results) => {
        if (err) return callback(err, null);

        const postosPorBloco = new Map(); // "HH:MM" -> Set de posto_id ocupados nesse bloco

        results.forEach(reserva => {
            const [startH, startM] = String(reserva.hora_inicio).split(':').map(Number);
            const [endH, endM] = String(reserva.hora_fim).split(':').map(Number);

            const dataReservaStr = reserva.data_reserva instanceof Date
                ? reserva.data_reserva.toISOString().split('T')[0]
                : String(reserva.data_reserva).split('T')[0];

            const ehDoDiaAnterior = (dataReservaStr !== data);
            const minutosInicio = startH * 60 + startM;
            const minutosFim = endH * 60 + endM;
            const cruzaMeiaNoite = minutosFim < minutosInicio;

            let slotInicio, slotFim;

            if (ehDoDiaAnterior && cruzaMeiaNoite) {
                slotInicio = 0;
                slotFim = minutosFim;
            } else if (!ehDoDiaAnterior && cruzaMeiaNoite) {
                slotInicio = minutosInicio;
                slotFim = 24 * 60;
            } else if (!ehDoDiaAnterior && !cruzaMeiaNoite) {
                slotInicio = minutosInicio;
                slotFim = minutosFim;
            } else {
                return;
            }

            // Reservas antigas podem não ter posto_id; nessa altura só havia o posto 1.
            const postoEfetivo = reserva.posto_id != null ? reserva.posto_id : 1;

            for (let min = slotInicio; min < slotFim; min += 10) {
                // Uma reserva que acabe a meio de um bloco (14:45) ocupa-o todo,
                // porque o que fica marcado é o início do bloco (14:40).
                const minAlinhado = Math.floor(min / 10) * 10;
                const h = Math.floor(minAlinhado / 60);
                const m = minAlinhado % 60;
                const bloco = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                if (!postosPorBloco.has(bloco)) postosPorBloco.set(bloco, new Set());
                postosPorBloco.get(bloco).add(postoEfetivo);
            }
        });

        const totalPostos = POSTOS_ATIVOS.length;
        const blocosCheios = new Set();
        postosPorBloco.forEach((postosOcupados, bloco) => {
            if (totalPostos > 0 && postosOcupados.size >= totalPostos) blocosCheios.add(bloco);
        });

        callback(null, blocosCheios);
    });
}

app.get('/api/ocupados', verificarToken, (req, res) => {
    const { data } = req.query;
    if (!data) return res.status(400).json({ message: "Data é obrigatória" });

    calcularBlocosCheios(data, (err, blocosCheios) => {
        if (err) return res.status(500).json({ message: "Erro ao consultar ocupação" });
        res.status(200).json(Array.from(blocosCheios));
    });
});


// ======================================================
// INSERIR NOVA RESERVA
// ======================================================

app.post('/api/reservar', verificarToken, (req, res) => {
    const { data, hora_inicio, hora_fim } = req.body;

    if (!data || !hora_inicio || !hora_fim) {
        return res.status(400).json({ message: "Dados incompletos" });
    }

    // Se o dia tem uma vaga pendente de outra pessoa da fila, está trancado para ela.
    db.query(
        'SELECT utilizador_id FROM vaga_pendente WHERE data_reserva = ? AND expira_em > NOW()',
        [data],
        (errVaga, vagaRes) => {
            if (errVaga) {
                console.error("Erro ao verificar dia trancado:", errVaga);
                return res.status(500).json({ message: "Erro ao verificar disponibilidade." });
            }

            if (vagaRes && vagaRes.length > 0 && vagaRes[0].utilizador_id !== req.user.id) {
                return res.status(423).json({
                    message: "Este dia está temporariamente reservado para outro aluno da fila de espera. Tenta novamente mais tarde ou escolhe outro dia."
                });
            }

            continuarReserva();
        }
    );

    function continuarReserva() {
    const [ano, mes, dia] = data.split('-').map(Number);
    const [hInicioAluno, mInicioAluno] = hora_inicio.split(':').map(Number);
    const [hFimAluno, mFimAluno] = hora_fim.split(':').map(Number);

    let duracao = (new Date(`1970-01-01T${hora_fim}`) - new Date(`1970-01-01T${hora_inicio}`)) / 60000;

    let cruzouMeiaNoite = false;
    if (duracao < 0) {
        duracao += 1440; // cruzou a meia-noite
        cruzouMeiaNoite = true;
    }

    if (duracao <= 0) {
        return res.status(400).json({ message: "Horário inválido" });
    }

    if (duracao > 30 || ![10, 20, 30].includes(duracao)) {
        return res.status(400).json({ 
            message: "Duração inválida. O tempo máximo permitido por reserva é de 30 minutos, sendo permitidos apenas blocos de 10, 20 ou 30 minutos." 
        });
    }

    // Impedir reservas no passado, a contar sempre pela hora de Lisboa
    // (UTC+1 no inverno, UTC+2 no verão) e não pela do servidor.
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));

    // Verifica se a hora de fim é menor que a de início (ex: 00:10 < 23:40)
    cruzouMeiaNoite = (hFimAluno < hInicioAluno);

    let dataFimDesejadaAluno = new Date(ano, mes - 1, dia, hFimAluno, mFimAluno, 0);

    // Se cruzou a meia-noite (ex: 23:40 às 00:10), a hora de fim já pertence ao DIA SEGUINTE
    if (cruzouMeiaNoite) {
        dataFimDesejadaAluno.setDate(dataFimDesejadaAluno.getDate() + 1);
    }

    if (isNaN(dataFimDesejadaAluno.getTime())) {
        return res.status(400).json({ message: "Formato de data ou hora inválido." });
    }

    // Validar se o horário de início já passou (Hora Início)
    const dataInicioDesejadaAluno = new Date(ano, mes - 1, dia, hInicioAluno, mInicioAluno, 0);

    if (dataInicioDesejadaAluno <= agora) {
        return res.status(400).json({
            message: "Não é possível efetuar uma reserva para um horário que já passou."
        });
    }

    // Verificar créditos e política de agendamento
    db.query(
        'SELECT creditos, ultima_reserva_fim FROM utilizadores WHERE id = ?',
        [req.user.id],
        (err, userResults) => {
            if (err) return res.status(500).json({ message: "Erro ao verificar utilizador" });
            if (userResults.length === 0) return res.status(404).json({ message: "Utilizador não encontrado" });

            const { creditos, ultima_reserva_fim } = userResults[0];

            // Política: só pode reservar se a última reserva já foi utilizada (tempo passou)
            if (ultima_reserva_fim && new Date(ultima_reserva_fim) > new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }))) {                const fim = new Date(ultima_reserva_fim).toLocaleString('pt-PT');
                return res.status(400).json({
                    message: `Só pode fazer nova reserva após utilizar a anterior (termina em ${fim}).`
                });
            }

            if (creditos < duracao) {
                return res.status(400).json({
                    message: `Créditos insuficientes. Tens ${creditos} créditos e precisas de ${duracao}.`
                });
            }

            // Os postos são intercambiáveis: serve qualquer um que esteja livre
            // neste intervalo.
            escolherPostoLivre(data, hora_inicio, hora_fim, cruzouMeiaNoite, (errPosto, postoLivre) => {
                if (errPosto) {
                    console.error("Erro na query de validação:", errPosto);
                    return res.status(500).json({ message: "Erro de validação" });
                }
                if (!postoLivre) {
                    return res.status(400).json({ message: "Este horário está ocupado!" });
                }

                const novaUltimaReservaFim = dataFimDesejadaAluno;

                // hora_fim_original guarda o horário tal como foi marcado, porque
                // hora_fim pode ser reescrito depois (o botão de pânico arredonda-o
                // para libertar o resto do bloco).
                const sqlInsert = `
                    INSERT INTO reservas (data_reserva, hora_inicio, hora_fim, hora_fim_original, utilizador_id, posto_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `;

                db.query(sqlInsert, [data, hora_inicio, hora_fim, hora_fim, req.user.id, postoLivre.id], (err, result) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).json({ message: "Erro ao guardar reserva" });
                    }

                    // Atualizar créditos e ultima_reserva_fim
                    const dataParaBD = dataFimDesejadaAluno.toISOString().slice(0, 19).replace('T', ' ');
                    db.query(
                        'UPDATE utilizadores SET creditos = creditos - ?, ultima_reserva_fim = ? WHERE id = ?',
                        [duracao, dataParaBD, req.user.id],
                        (err) => { if (err) console.error("Erro ao atualizar créditos:", err); }
                    );

                    console.log(`Reserva #${result.insertId} criada por ${req.user.username}`);

                    // Se este utilizador tinha uma vaga pendente neste dia (veio da fila),
                    // usou-a agora — apagar para libertar o "dia trancado".
                    db.query(
                        'DELETE FROM vaga_pendente WHERE data_reserva = ? AND utilizador_id = ?',
                        [data, req.user.id],
                        (errDelVaga) => { if (errDelVaga) console.error("Erro ao limpar vaga pendente:", errDelVaga); }
                    );

                    // Já conseguiu a vaga, por isso sai da fila deste dia (fecha
                    // também a ligação em tempo real, se tiver alguma aberta).
                    sairDaFilaTempoReal(data, req.user.id);

                    // Se com esta reserva voltou a não haver vaga, avisar quem
                    // continua à espera de que a vaga já foi ocupada.
                    if (data === dataHojeLisboa()) {
                        obterJanelaVerificacaoMinutos((errJanela, janelaMinutos) => {
                            if (errJanela) return;
                            contarSlotsOcupadosComSeguinte(data, (errOcup, ocupadosSet, ocupadosAmanha) => {
                                if (!errOcup && naoHaVagaParaEntrarNaFila(data, ocupadosSet, janelaMinutos, ocupadosAmanha)) {
                                    notificarVagaPerdida(data, req.user.id);
                                }
                            });
                        });
                    }

                    res.status(201).json({
                        message: "Reserva criada com sucesso",
                        id: result.insertId,
                        creditos_gastos: duracao
                    });
                });
            });
        }
    );
    } // fim de continuarReserva
});

// ======================================================
// MINHAS RESERVAS
// ======================================================


app.get('/api/minhas-reservas', verificarToken, (req, res) => {

    const sql = `
        SELECT id, data_reserva, hora_inicio, hora_fim, estado
        FROM reservas
        WHERE utilizador_id = ?
        ORDER BY data_reserva DESC, hora_inicio DESC
    `;

    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Erro ao listar as reservas do utilizador:", err);
            return res.status(500).json({ message: "Erro ao obter reservas" });
        }
        
        const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
        
        // O estado só muda na BD no job do minuto; aqui mostra-se já 'concluida'
        // se o tempo da reserva passou, para o frontend não ficar atrasado.
        const reservasAtualizadas = results.map(r => {
        const d = new Date(r.data_reserva);
        const ano = d.getFullYear();
        const mes = d.getMonth();
        const dia = d.getDate();

        const [hInicio, mInicio] = String(r.hora_inicio).split(':').map(Number);
        const [hFim, mFim] = String(r.hora_fim).split(':').map(Number);

        // Comparar o horário todo em minutos, não só a hora: "23:50" -> "23:30"
        // tem a mesma hora mas cruza a meia-noite.
        const cruzaMeiaNoite = (hFim * 60 + mFim) < (hInicio * 60 + mInicio);

        let dataFimReserva = new Date(ano, mes, dia, hFim, mFim, 0);
        if (cruzaMeiaNoite) {
            dataFimReserva.setDate(dataFimReserva.getDate() + 1);
        }

        if (r.estado === 'ativa' && agora > dataFimReserva) {
            return { ...r, estado: 'concluida' };
        }
        return r;
        });

        res.status(200).json(reservasAtualizadas);
    });
});

// ======================================================
// CANCELAR RESERVA (utilizador cancela a sua própria reserva)
// ======================================================

app.delete('/api/reserva/:id', verificarToken, (req, res) => {
    const reservaId = req.params.id;

    db.query(
        'SELECT * FROM reservas WHERE id = ? AND utilizador_id = ?',
        [reservaId, req.user.id],
        (err, results) => {
            if (err) return res.status(500).json({ message: "Erro ao procurar reserva" });
            if (results.length === 0) return res.status(404).json({ message: "Reserva não encontrada" });

            const reserva = results[0];

            if (reserva.estado === 'cancelada') {
                return res.status(400).json({ message: "Reserva já cancelada" });
            }

            if (reserva.criado_por_admin) {
                return res.status(403).json({ 
                    message: "Não podes cancelar uma reserva criada pelo administrador." 
                });
            }

            // ====================================================================
            // Bloquear cancelamento com menos de 2 horas
            // ====================================================================
            const agoraTimestamp = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' })).getTime();

            // Isola o dia correto (YYYY-MM-DD)
            const dataString = new Date(reserva.data_reserva).toISOString().split('T')[0];
            
            // Garante o formato HH:mm correto da hora de início
            const [hInicio, mInicio] = reserva.hora_inicio.split(':');
            const horaInicioFormatada = `${String(hInicio).padStart(2, '0')}:${String(mInicio).padStart(2, '0')}`;
            
            // Monta o timestamp exato do início da reserva
            const dataInicioReserva = new Date(`${dataString}T${horaInicioFormatada}:00`);
            
            const duasHorasEmMs = 2 * 60 * 60 * 1000;

            if (dataInicioReserva.getTime() - agoraTimestamp < duasHorasEmMs) {
                return res.status(400).json({ 
                    message: "Não podes cancelar uma reserva com menos de 2 horas de antecedência ou que já tenha decorrido." 
                });
            }

            let duracao =
                (new Date(`1970-01-01T${reserva.hora_fim}`) -
                new Date(`1970-01-01T${reserva.hora_inicio}`)) / 60000;

            if (duracao < 0) {
                duracao += 1440; // cruzou a meia-noite
            }

            db.query('UPDATE reservas SET estado = ? WHERE id = ?', ['cancelada', reservaId], (err) => {
                if (err) return res.status(500).json({ message: "Erro ao cancelar reserva" });

                // Devolver créditos e limpar ultima_reserva_fim se era a última
                db.query(
                    'UPDATE utilizadores SET creditos = LEAST(creditos + ?, 60), ultima_reserva_fim = NULL WHERE id = ?',
                    [duracao, req.user.id],
                    (err) => { if (err) console.error(err); }
                );

                // Libertou-se uma vaga neste dia — avisar o 1º da fila de espera (se houver)
                processarProximoDaFila(dataString);

                res.status(200).json({
                    message: "Reserva cancelada com sucesso",
                    creditos_devolvidos: duracao
                });
            });
        }
    );
});

// ======================================================
// VERIFICAR ACESSO (por utilizador_id)
// ======================================================

// Usa sempre req.user.id e nunca o utilizador_id do corpo do pedido: senão
// bastava adivinhar um id para ver o nome e o horário de qualquer aluno.
// O Pi já não usa esta rota para dar acesso (tem o token de sessão); quem a
// chama é só o frontend, para saber se mostra a contagem ou o botão de entrar.
app.post('/api/verificar-acesso', verificarToken, (req, res) => {
    const utilizador_id = req.user.id;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const dataHoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const dataOntem = (() => {
        const o = new Date(agora);
        o.setDate(o.getDate() - 1);
        return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,'0')}-${String(o.getDate()).padStart(2,'0')}`;
    })();
    const horaAgora = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}:${String(agora.getSeconds()).padStart(2,'0')}`;

    // Mesma lógica de 3 cenários usada em /api/admin/sessao-atual: reserva
    // normal de hoje, reserva de hoje que cruza a meia-noite (ainda antes das
    // 24h), ou reserva de ontem que cruzou a meia-noite (já depois das 00h).
    const sql = `
        SELECT r.id, r.hora_inicio, r.hora_fim, r.data_reserva, r.estado, u.nome, u.username
        FROM reservas r
        JOIN utilizadores u ON u.id = r.utilizador_id
        WHERE r.estado IN ('ativa', 'em_curso')
        AND r.utilizador_id = ?
        AND (
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_inicio) <= TIME_TO_SEC(?)
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(?))
            OR
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) <= TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_inicio) <= TIME_TO_SEC(?))
            OR
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) <= TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(?))
        )
    `;

    const params = [
        utilizador_id,
        dataHoje, horaAgora, horaAgora,   // reserva normal de hoje
        dataHoje, horaAgora,              // reserva de hoje que cruza meia-noite
        dataOntem, horaAgora              // reserva de ontem que cruzou meia-noite
    ];

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ valido: false, message: "Erro interno" });
        }

        if (results.length === 0) {
            // Sem nada válido agora, ver se há reserva a começar nos próximos 5
            // minutos, só para o frontend mostrar a contagem. Não dá acesso
            // nenhum: isso continua a exigir hora_inicio <= agora, na query acima.
            const dataAmanha = (() => {
                const o = new Date(agora);
                o.setDate(o.getDate() + 1);
                return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,'0')}-${String(o.getDate()).padStart(2,'0')}`;
            })();

            return db.query(
                `SELECT id, hora_inicio, hora_fim, data_reserva FROM reservas
                 WHERE estado = 'ativa' AND utilizador_id = ? AND data_reserva IN (?, ?)
                 ORDER BY data_reserva ASC, hora_inicio ASC`,
                [utilizador_id, dataHoje, dataAmanha],
                (errProx, candidatas) => {
                    const semNadaAgora = {
                        valido: false,
                        message: "Acesso negado. Não tens nenhuma reserva ativa para este momento."
                    };
                    if (errProx || !candidatas || candidatas.length === 0) {
                        return res.status(200).json(semNadaAgora);
                    }

                    const limiteJanela = new Date(agora.getTime() + 5 * 60000);
                    let proxima = null;
                    for (const c of candidatas) {
                        const cDataStr = c.data_reserva instanceof Date
                            ? c.data_reserva.toISOString().split('T')[0]
                            : String(c.data_reserva).split('T')[0];
                        const [h, m] = String(c.hora_inicio).split(':').map(Number);
                        const inicioObj = new Date(`${cDataStr}T00:00:00`);
                        inicioObj.setHours(h, m, 0, 0);
                        if (inicioObj > agora && inicioObj <= limiteJanela) {
                            // Inclui reserva_id mesmo aqui: se o relógio do
                            // browser passar sozinho para "ativo" antes do
                            // próximo fetch (ver ajustarEstadoTempo), o botão
                            // de pânico precisa deste campo para funcionar.
                            proxima = { reserva_id: c.id, hora_inicio: c.hora_inicio, hora_fim: c.hora_fim, data_reserva: cDataStr };
                            break;
                        }
                    }

                    if (!proxima) return res.status(200).json(semNadaAgora);

                    return res.status(200).json({
                        valido: false,
                        proxima_reserva: proxima,
                        message: "A tua sessão vai começar em breve."
                    });
                }
            );
        }

        const reserva = results[0];

        let dataString = reserva.data_reserva;
        if (reserva.data_reserva instanceof Date) {
             dataString = reserva.data_reserva.toISOString().split('T')[0];
        }

        const respostaSucesso = {
            valido: true,
            reserva_id: reserva.id,
            utilizador_id: utilizador_id,
            utilizador: reserva.nome,
            username: reserva.username,
            data_reserva: dataString,
            hora_inicio: reserva.hora_inicio,
            hora_fim: reserva.hora_fim,
            expira_em: `${dataString}T${reserva.hora_fim}`
        };

        // Esta rota não muda o estado na BD. A passagem de 'ativa' a 'em_curso'
        // é só em /api/confirmar-entrada, senão bastava ter a app aberta para a
        // sessão ficar marcada como iniciada.
        return res.status(200).json(respostaSucesso);
    });
});

// ======================================================
// CONFIRMAR ENTRADA NO LABORATÓRIO
// Chamado quando o aluno clica em "ENTRAR NO LABORATÓRIO REMOTO".
// É aqui (e só aqui) que a reserva passa de 'ativa' a 'em_curso'.
// ======================================================

app.post('/api/confirmar-entrada', verificarToken, (req, res) => {
    const utilizador_id = req.user.id;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const dataHoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const dataOntem = (() => {
        const o = new Date(agora);
        o.setDate(o.getDate() - 1);
        return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,'0')}-${String(o.getDate()).padStart(2,'0')}`;
    })();
    const horaAgora = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}:${String(agora.getSeconds()).padStart(2,'0')}`;

    // Mesma lógica de 3 cenários de /api/verificar-acesso
    const sql = `
        SELECT id, estado, data_reserva, hora_inicio, hora_fim, posto_id
        FROM reservas
        WHERE estado IN ('ativa', 'em_curso')
        AND utilizador_id = ?
        AND (
            (data_reserva = ?
             AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(hora_inicio)
             AND TIME_TO_SEC(hora_inicio) <= TIME_TO_SEC(?)
             AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(?))
            OR
            (data_reserva = ?
             AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(hora_inicio)
             AND TIME_TO_SEC(hora_inicio) <= TIME_TO_SEC(?))
            OR
            (data_reserva = ?
             AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(hora_inicio)
             AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(?))
        )
    `;
    const params = [
        utilizador_id,
        dataHoje, horaAgora, horaAgora,
        dataHoje, horaAgora,
        dataOntem, horaAgora
    ];

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ valido: false, message: "Erro interno" });
        }

        if (results.length === 0) {
            return res.status(200).json({
                valido: false,
                message: "Não tens nenhuma reserva ativa para este momento."
            });
        }

        const reserva = results[0];

        const dataReservaStr = reserva.data_reserva instanceof Date
            ? reserva.data_reserva.toISOString().split('T')[0]
            : String(reserva.data_reserva).split('T')[0];
        const gerarTokenSessao = () => gerarTokenSessaoPi(
            utilizador_id, reserva.id, dataReservaStr, String(reserva.hora_inicio), String(reserva.hora_fim)
        );

        // O endereço vai na resposta porque o browser é reencaminhado para o Pi
        // do posto desta reserva. Antes tinha o endereço fixo e abria sempre o
        // primeiro posto, fosse qual fosse o atribuído.
        const postoDaReserva = POSTOS_ATIVOS.find(p => p.id === reserva.posto_id) || POSTOS_ATIVOS[0];
        const enderecoPosto = postoDaReserva
            ? { pi_host: postoDaReserva.pi_host, pi_port: postoDaReserva.pi_port }
            : {};

        if (reserva.estado !== 'ativa') {
            // Já estava em_curso (ex: clicou duas vezes) — idempotente.
            ultimoHeartbeatSessao.set(reserva.id, Date.now());
            return res.status(200).json({ valido: true, reserva_id: reserva.id, token_sessao: gerarTokenSessao(), ...enderecoPosto });
        }

        db.query(
            "UPDATE reservas SET estado = 'em_curso', hora_inicio_real = ? WHERE id = ?",
            [horaAgora, reserva.id],
            (errUpdate) => {
                if (errUpdate) {
                    console.error("Erro ao confirmar entrada:", errUpdate);
                    return res.status(500).json({ valido: false, message: "Erro ao confirmar entrada." });
                }
                // Marca já um sinal de vida, senão o job seguinte (até 30s
                // depois) apanhava a reserva ainda sem nenhum registado.
                ultimoHeartbeatSessao.set(reserva.id, Date.now());
                res.status(200).json({ valido: true, reserva_id: reserva.id, token_sessao: gerarTokenSessao(), ...enderecoPosto });
            }
        );
    });
});

// ======================================================
// BOTÃO DE PÂNICO: CHECK-OUT ANTECIPADO
// ======================================================

// Termina uma sessão em curso antes do tempo. Usada pelo botão de pânico do
// aluno e pelo job de heartbeat, quando a página do laboratório deixa de dar
// sinal de vida.
function terminarSessaoAntecipadamente(reservaId, callback) {
    db.query("SELECT * FROM reservas WHERE id = ?", [reservaId], (err, results) => {
        if (err) return callback(err);
        if (!results || results.length === 0) return callback(null, { erro: "Reserva não encontrada." });

        const reserva = results[0];
        if (reserva.estado !== 'em_curso') {
            return callback(null, { erro: "A sessão já não está em curso." });
        }

        const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));

        // 1. Arredondar para o próximo bloco de 10 min, senão o bloco atual
        //    continuava a aparecer ocupado no calendário dos outros alunos.
        const minutosAtuais = agora.getMinutes();
        const minutosArredondados = Math.ceil(minutosAtuais / 10) * 10;

        const novaHoraFim = new Date(agora);
        novaHoraFim.setMinutes(minutosArredondados);
        novaHoraFim.setSeconds(0);

        const horaFimFormatada = `${String(novaHoraFim.getHours()).padStart(2, '0')}:${String(novaHoraFim.getMinutes()).padStart(2, '0')}:00`;

        // Momento exato em que terminou, para as estatísticas de uso real.
        const horaFimRealFormatada = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}:${String(agora.getSeconds()).padStart(2, '0')}`;

        const [hFimOriginal, mFimOriginal] = reserva.hora_fim.split(':').map(Number);
        const horaFimObjOriginal = new Date(agora);
        horaFimObjOriginal.setHours(hFimOriginal, mFimOriginal, 0);

        // A comparação é com agora.getHours() e não com novaHoraFim.getHours():
        // quando o arredondamento salta para a hora seguinte (23:55 -> 00:00),
        // novaHoraFim já não dá a hora real e o dia não avançava.
        if (hFimOriginal < agora.getHours()) {
            horaFimObjOriginal.setDate(horaFimObjOriginal.getDate() + 1);
        }

        // Sem blocos por libertar não há nada para encerrar mais cedo, e evita
        // alargar a reserva por engano.
        if (novaHoraFim >= horaFimObjOriginal) {
            return callback(null, { erro: "A sessão já está a terminar, não é possível encerrar mais cedo." });
        }

        // 2. Desligar relés/DAC primeiro, enquanto a sessão ainda é válida, e só
        //    depois marcar a reserva como concluída.
        desligarRaspberryPi(reserva.utilizador_id, reserva.posto_id, () => {
            db.query(
                "UPDATE reservas SET hora_fim = ?, hora_fim_real = ?, estado = 'concluida' WHERE id = ?",
                [horaFimFormatada, horaFimRealFormatada, reservaId],
                (errUpd) => {
                    if (errUpd) return callback(errUpd);

                    revogarSessao(reservaId);
                    ultimoHeartbeatSessao.delete(reservaId);

                    const dataString = new Date(reserva.data_reserva).toISOString().split('T')[0];
                    processarProximoDaFila(dataString);

                    callback(null, { sucesso: true });
                }
            );
        });
    });
}

app.post('/api/cancelar-antecipado', verificarToken, (req, res) => {
    const { reserva_id } = req.body;
    const utilizador_id = req.user.id;

    if (!reserva_id) {
        return res.status(400).json({ message: "ID da reserva é obrigatório." });
    }

    // Confirma que a reserva é mesmo deste utilizador antes de a deixar terminá-la.
    db.query("SELECT id FROM reservas WHERE id = ? AND utilizador_id = ?", [reserva_id, utilizador_id], (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao procurar a reserva." });
        if (results.length === 0) return res.status(404).json({ message: "Reserva não encontrada." });

        terminarSessaoAntecipadamente(reserva_id, (errTerm, resultado) => {
            if (errTerm) return res.status(500).json({ message: "Erro ao atualizar a reserva na BD." });
            if (resultado && resultado.erro) return res.status(400).json({ message: resultado.erro });

            return res.json({
                message: "Sessão encerrada mais cedo. Os créditos não são devolvidos."
            });
        });
    });
});

// Igual a /api/cancelar-antecipado, mas chamada da página do laboratório no Pi,
// que não tem o JWT de login do aluno, só o token de sessão. É esse token que
// identifica a reserva e prova que o pedido é legítimo.
app.post('/api/sessao/terminar', (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ message: "Token em falta." });

    jwt.verify(token, PI_SESSION_SECRET, (errJwt, payload) => {
        if (errJwt || !payload || !payload.reserva_id) {
            return res.status(401).json({ message: "Token inválido ou expirado." });
        }

        terminarSessaoAntecipadamente(payload.reserva_id, (errTerm, resultado) => {
            if (errTerm) return res.status(500).json({ message: "Erro ao terminar a sessão." });
            if (resultado && resultado.erro) return res.status(400).json({ message: resultado.erro });

            return res.json({
                message: "Sessão terminada. Podes fechar esta página."
            });
        });
    });
});

// ======================================================
// ===================== ADMIN ===========================
// ======================================================

// --- Listar todos os utilizadores ---

app.get('/api/admin/utilizadores', verificarToken, verificarAdmin, (req, res) => {
    db.query(
        'SELECT id, username, nome, email, role, creditos, ultima_reserva_fim, data_registo FROM utilizadores ORDER BY id DESC',
        (err, results) => {
            if (err) {
                console.error("Erro ao listar utilizadores:", err);
                return res.status(500).json({ message: "Erro interno", detalhe: err.message });
            }
            res.json(results);
        }
    );
});

// --- Promover/despromover admin ---

app.put('/api/admin/utilizadores/:id/role', verificarToken, verificarAdmin, (req, res) => {
    const { role } = req.body;
    const validRoles = ['aluno', 'admin'];

    if (!validRoles.includes(role)) {
        return res.status(400).json({ message: "Role inválido" });
    }

    db.query('UPDATE utilizadores SET role = ? WHERE id = ?', [role, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar role" });
        res.json({ message: "Role atualizado com sucesso" });
    });
});

// --- Ajustar créditos de um utilizador ---

app.put('/api/admin/utilizadores/:id/creditos', verificarToken, verificarAdmin, (req, res) => {
    const { creditos } = req.body;

    if (typeof creditos !== 'number' || creditos < 0) {
        return res.status(400).json({ message: "Valor inválido" });
    }

    db.query('UPDATE utilizadores SET creditos = ? WHERE id = ?', [creditos, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar créditos" });
        res.json({ message: "Créditos atualizados" });
    });
});

// --- Listar todas as reservas (com filtros opcionais) ---

app.get('/api/admin/reservas', verificarToken, verificarAdmin, (req, res) => {
    const { data, utilizador_id, estado } = req.query;

    let sql = `
        SELECT r.id, r.data_reserva, r.hora_inicio, r.hora_fim, r.hora_fim_original, r.estado,
               r.hora_inicio_real, r.hora_fim_real, r.criado_por_admin, r.posto_id,
               DATE_FORMAT(r.criado_em, '%d/%m/%Y, %H:%i:%s') AS criado_em,
               u.nome, u.username, u.email, p.nome AS posto_nome
        FROM reservas r
        JOIN utilizadores u ON u.id = r.utilizador_id
        LEFT JOIN postos p ON p.id = r.posto_id
        WHERE 1=1
    `;
    const params = [];

    if (data) { sql += ' AND r.data_reserva = ?'; params.push(data); }
    if (utilizador_id) { sql += ' AND r.utilizador_id = ?'; params.push(utilizador_id); }
    if (estado) { sql += ' AND r.estado = ?'; params.push(estado); }

    sql += ' ORDER BY r.data_reserva DESC, r.hora_inicio DESC LIMIT 200';

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ message: "Erro" });
        const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
        const reservasAtualizadas = results.map(r => {
            // Componentes extraídos à mão para não passar pelo UTC.
            const d = new Date(r.data_reserva);
            const ano = d.getFullYear();
            const mes = d.getMonth();
            const dia = d.getDate();

            const [hInicioAdm, mInicioAdm] = String(r.hora_inicio).split(':').map(Number);
            const [hFim, mFim] = String(r.hora_fim).split(':').map(Number);

            // Comparar o horário todo em minutos, não só a hora (ex: "23:50" -> "23:30").
            const cruzaMeiaNoiteAdm = (hFim * 60 + mFim) < (hInicioAdm * 60 + mInicioAdm);

            let dataFimReserva = new Date(ano, mes, dia, hFim, mFim, 0);
            if (cruzaMeiaNoiteAdm) {
                dataFimReserva.setDate(dataFimReserva.getDate() + 1);
            }

            // Ainda 'ativa' mas com o tempo passado: mostra 'concluida' ao frontend.
            if (r.estado === 'ativa' && agora > dataFimReserva) {
                return { ...r, estado: 'concluida' };
            }
            return r;
        });

        res.json(reservasAtualizadas);
    });
});

// --- Cancelar qualquer reserva (admin) ---

app.delete('/api/admin/reserva/:id', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT * FROM reservas WHERE id = ?', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ message: "Erro" });
        if (results.length === 0) return res.status(404).json({ message: "Reserva não encontrada" });

        const reserva = results[0];
        let duracao =
            (new Date(`1970-01-01T${reserva.hora_fim}`) -
            new Date(`1970-01-01T${reserva.hora_inicio}`)) / 60000;
        
        if (duracao < 0) {
            duracao += 1440; // cruzou a meia-noite
        }

        // Só se devolvem créditos se foi o aluno a marcar. As reservas do admin
        // não lhe custaram créditos, por isso também não se devolve nada.
        const reservaCriadaPeloAdmin = reserva.criado_por_admin === 1;

        // Dia da reserva (para avisar a fila de espera depois de cancelar)
        const dataStringAdmin = new Date(reserva.data_reserva).toISOString().split('T')[0];

        // Se estava 'em_curso', a sessão decorria mesmo: desliga-se o Pi primeiro
        // e fica 'concluida', para contar nas estatísticas. Se era só 'ativa',
        // nunca chegou a começar e fica 'cancelada'.
        const estavaEmCurso = reserva.estado === 'em_curso';
        const novoEstado = estavaEmCurso ? 'concluida' : 'cancelada';

        // Cortada a meio, guarda-se a hora real de fim, senão as estatísticas
        // contavam a duração reservada em vez da usada.
        const horaFimRealAgora = estavaEmCurso
            ? new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }))
            : null;
        const horaFimRealFormatada = horaFimRealAgora
            ? `${String(horaFimRealAgora.getHours()).padStart(2, '0')}:${String(horaFimRealAgora.getMinutes()).padStart(2, '0')}:${String(horaFimRealAgora.getSeconds()).padStart(2, '0')}`
            : null;

        // Arredonda hora_fim ao próximo bloco de 10 min, como em
        // terminarSessaoAntecipadamente. Sem isto o resto do horário continuava
        // bloqueado no calendário depois de o admin cortar a sessão.
        let horaFimFormatada = null;
        if (estavaEmCurso) {
            const minutosArredondados = Math.ceil(horaFimRealAgora.getMinutes() / 10) * 10;
            const novaHoraFim = new Date(horaFimRealAgora);
            novaHoraFim.setMinutes(minutosArredondados);
            novaHoraFim.setSeconds(0);

            const [hFimOriginal, mFimOriginal] = reserva.hora_fim.split(':').map(Number);
            const horaFimObjOriginal = new Date(horaFimRealAgora);
            horaFimObjOriginal.setHours(hFimOriginal, mFimOriginal, 0);
            if (hFimOriginal < horaFimRealAgora.getHours()) {
                horaFimObjOriginal.setDate(horaFimObjOriginal.getDate() + 1);
            }

            const horaFimEfetiva = novaHoraFim < horaFimObjOriginal ? novaHoraFim : horaFimObjOriginal;
            horaFimFormatada = `${String(horaFimEfetiva.getHours()).padStart(2, '0')}:${String(horaFimEfetiva.getMinutes()).padStart(2, '0')}:00`;
        }

        const finalizarCancelamento = () => {
            const sqlUpdate = estavaEmCurso
                ? 'UPDATE reservas SET estado = ?, hora_fim = ?, hora_fim_real = ? WHERE id = ?'
                : 'UPDATE reservas SET estado = ? WHERE id = ?';
            const paramsUpdate = estavaEmCurso
                ? [novoEstado, horaFimFormatada, horaFimRealFormatada, req.params.id]
                : [novoEstado, req.params.id];

            db.query(sqlUpdate, paramsUpdate, (err) => {
                if (err) return res.status(500).json({ message: "Erro ao cancelar" });

                if (estavaEmCurso) revogarSessao(Number(req.params.id));

                if (reservaCriadaPeloAdmin) {
                    // Não devolve créditos nem mexe em ultima_reserva_fim: as
                    // reservas extraordinárias não entram no fair-use do aluno.
                    processarProximoDaFila(dataStringAdmin);
                    return res.json({
                        message: `Reserva (criada pelo admin) ${estavaEmCurso ? 'terminada' : 'cancelada'}. Não foram devolvidos créditos.`,
                        creditos_devolvidos: 0
                    });
                }

                // Reserva criada pelo aluno — devolver os créditos gastos.
                db.query(
                    'UPDATE utilizadores SET creditos = LEAST(creditos + ?, 60), ultima_reserva_fim = NULL WHERE id = ?',
                    [duracao, reserva.utilizador_id],
                    (err) => { if (err) console.error(err); }
                );

                // Libertou-se uma vaga — avisar o 1º da fila de espera (se houver)
                processarProximoDaFila(dataStringAdmin);

                res.json({
                    message: estavaEmCurso ? "Sessão terminada pelo administrador" : "Reserva cancelada pelo administrador",
                    creditos_devolvidos: duracao
                });
            });
        };

        if (estavaEmCurso) {
            desligarRaspberryPi(reserva.utilizador_id, reserva.posto_id, finalizarCancelamento);
        } else {
            finalizarCancelamento();
        }
    });
});

// Agendamento extraordinário (admin pode reservar sem restrições de crédito) 

app.post('/api/admin/reservar', verificarToken, verificarAdmin, (req, res) => {
    // Recebemos o username_aluno (obrigatório) e o utilizador_id (opcional) do frontend
    const { data, hora_inicio, hora_fim, username_aluno, utilizador_id, posto_id } = req.body;

    // 1. Validação de dados básicos e obrigatoriedade do username
    if (!data || !hora_inicio || !hora_fim) {
        return res.status(400).json({ message: "Dados incompletos" });
    }
    if (!username_aluno || username_aluno.trim() === "") {
        return res.status(400).json({ message: "O campo Username do Aluno é obrigatório." });
    }

    // 2. Calcular duração (o admin pode escolher QUALQUER duração).
    //    Só validamos que é positiva e trata-se a meia-noite.
    let duracao = (new Date(`1970-01-01T${hora_fim}`) - new Date(`1970-01-01T${hora_inicio}`)) / 60000;
    const cruzouMeiaNoiteAdmin = duracao < 0;
    if (duracao < 0) {
        duracao += 1440; // reserva cruza a meia-noite
    }
    if (duracao <= 0) {
        return res.status(400).json({
            message: "Horário inválido: a hora de fim tem de ser diferente da de início."
        });
    }

    // Impedir reservas no passado, pela hora de Lisboa.
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const [anoAdmin, mesAdmin, diaAdmin] = data.split('-').map(Number);

    // Basta validar o início: como hora_fim > hora_inicio (fora do caso de
    // cruzar a meia-noite), se o início ainda não passou o fim também não.
    const [hInicioAdmin, mInicioAdmin] = hora_inicio.split(':').map(Number);
    const dataInicioDesejadaAdmin = new Date(anoAdmin, mesAdmin - 1, diaAdmin, hInicioAdmin, mInicioAdmin, 0);

    if (dataInicioDesejadaAdmin <= agora) {
        return res.status(400).json({
            message: "Operação recusada. Não é possível criar uma reserva para um horário que já passou."
        });
    }

    // 3. Descobrir e validar o ID do Aluno através do Username obrigatório
    db.query('SELECT id FROM utilizadores WHERE username = ?', [username_aluno.trim()], (err, users) => {
        if (err) return res.status(500).json({ message: "Erro ao validar o utilizador" });
        if (users.length === 0) {
            return res.status(404).json({ message: "Aluno com o username especificado não foi encontrado." });
        }

        // O ID é opcional; sem ele vale o que se encontrou pelo username.
        const uid = utilizador_id ? parseInt(utilizador_id) : users[0].id;

        // Inserir a reserva na BD, já com o posto escolhido (auto ou forçado)
        function inserirReservaComPosto(postoEscolhidoId) {
            const sqlInsert = `
                INSERT INTO reservas (data_reserva, hora_inicio, hora_fim, hora_fim_original, utilizador_id, posto_id, estado, criado_por_admin)
                VALUES (?, ?, ?, ?, ?, ?, 'ativa', 1)
            `;

            db.query(sqlInsert, [data, hora_inicio, hora_fim, hora_fim, uid, postoEscolhidoId], (err, result) => {
                if (err) {
                    console.error("Erro ao criar reserva extraordinária:", err);
                    return res.status(500).json({ message: "Erro ao gravar a reserva extraordinária na base de dados." });
                }

                // Não se mexe em créditos nem em ultima_reserva_fim: isto não
                // custa nada ao aluno e não entra no fair-use das marcações dele.
                console.log(`Reserva extraordinária #${result.insertId} criada para o aluno ID ${uid} no posto ${postoEscolhidoId}`);

                return res.status(201).json({
                    message: "Reserva extraordinária criada com sucesso!",
                    id: result.insertId
                });
            });
        }

        // Com um posto específico só se confirma que está livre; sem ele
        // ("aleatório"), escolhe-se o primeiro posto ativo livre.
        const postoIdForcado = posto_id ? parseInt(posto_id) : null;

        if (postoIdForcado) {
            const postoEscolhido = POSTOS_ATIVOS.find(p => p.id === postoIdForcado);
            if (!postoEscolhido) {
                return res.status(400).json({ message: "O posto escolhido não existe ou está inativo." });
            }
            postoEspecificoLivre(postoIdForcado, data, hora_inicio, hora_fim, cruzouMeiaNoiteAdmin, (errPosto, livre) => {
                if (errPosto) return res.status(500).json({ message: "Erro de validação de horários" });
                if (!livre) {
                    return res.status(400).json({ message: `O posto "${postoEscolhido.nome}" já está ocupado nesse horário.` });
                }
                inserirReservaComPosto(postoIdForcado);
            });
        } else {
            escolherPostoLivre(data, hora_inicio, hora_fim, cruzouMeiaNoiteAdmin, (errPosto, postoLivre) => {
                if (errPosto) return res.status(500).json({ message: "Erro de validação de horários" });
                if (!postoLivre) {
                    return res.status(400).json({ message: "Este horário já está ocupado por outra reserva!" });
                }
                inserirReservaComPosto(postoLivre.id);
            });
        }
    });
});


// --- Estatísticas de utilização ---

app.get('/api/admin/estatisticas', verificarToken, verificarAdmin, (req, res) => {
    const queries = {
        totalReservas: 'SELECT COUNT(*) AS total FROM reservas WHERE estado = "ativa"',
        totalCanceladas: 'SELECT COUNT(*) AS total FROM reservas WHERE estado = "cancelada"',
        totalFaltas: 'SELECT COUNT(*) AS total FROM reservas WHERE estado = "falta"',
        totalConcluidas: 'SELECT COUNT(*) AS total FROM reservas WHERE estado = "concluida"',
        totalUtilizadores: 'SELECT COUNT(*) AS total FROM utilizadores',
        reservasPorDia: `
            SELECT data_reserva, COUNT(*) AS total
            FROM reservas WHERE estado = 'ativa'
            GROUP BY data_reserva ORDER BY data_reserva DESC LIMIT 30
        `,
        topUtilizadores: `
            SELECT u.nome, u.username, COUNT(r.id) AS total_reservas,
                   SUM(
                       MOD(
                           (TIME_TO_SEC(COALESCE(r.hora_fim_real, r.hora_fim)) - TIME_TO_SEC(COALESCE(r.hora_inicio_real, r.hora_inicio)) + 86400),
                           86400
                       ) / 60
                   ) AS minutos_totais
            FROM reservas r
            JOIN utilizadores u ON u.id = r.utilizador_id
            WHERE r.estado = 'concluida'
            GROUP BY u.id ORDER BY minutos_totais DESC LIMIT 10
        `,
        ocupacaoPorHora: `
            SELECT HOUR(hora_inicio) AS hora, COUNT(*) AS reservas
            FROM reservas WHERE estado = 'concluida'
            GROUP BY hora ORDER BY hora
        `
    };

    const resultado = {};
    const keys = Object.keys(queries);
    let done = 0;

    keys.forEach(key => {
        db.query(queries[key], (err, rows) => {
            if (err) { resultado[key] = null; }
            else { resultado[key] = rows; }
            done++;
            if (done === keys.length) {
                res.json(resultado);
            }
        });
    });
});

// ======================================================
// PROXY para o Raspberry Pi (evita bloqueio de "conteúdo misto"
// HTTPS -> HTTP quando o Painel Admin embebe o vídeo/estado do Pi)
// ======================================================
const http = require('http');
// Postos ativos em memória, para não ir à BD em cada pedido. Recarregado
// sempre que o admin cria, edita ou apaga um posto.
let POSTOS_ATIVOS = []; // [{ id, nome, pi_host, pi_port }]

function recarregarPostosAtivos(callback) {
    db.query('SELECT id, nome, pi_host, pi_port FROM postos WHERE ativo = 1 ORDER BY id ASC', (err, results) => {
        if (err) {
            console.error('Erro ao carregar postos ativos:', err);
            if (callback) callback(err);
            return;
        }
        POSTOS_ATIVOS = results || [];
        if (callback) callback(null, POSTOS_ATIVOS);
    });
}

// Primeiro posto sem reserva sobreposta ao intervalo pedido, ou null se
// estiverem todos ocupados. Os três casos da query são os de sempre: mesmo
// dia, reserva de ontem que cruza para hoje, reserva que cruza para amanhã.
function escolherPostoLivre(data, horaInicio, horaFim, cruzouMeiaNoite, callback) {
    if (POSTOS_ATIVOS.length === 0) return callback(null, null);

    const sql = `
        SELECT DISTINCT posto_id FROM reservas
        WHERE estado IN ('ativa', 'em_curso') AND posto_id IS NOT NULL
        AND (
            (data_reserva = ? AND hora_inicio < ? AND hora_fim > ?)
            OR (data_reserva = DATE_SUB(?, INTERVAL 1 DAY)
                AND hora_fim < hora_inicio
                AND TIME_TO_SEC(?) < TIME_TO_SEC(hora_fim))
            OR (? = 1
                AND data_reserva = DATE_ADD(?, INTERVAL 1 DAY)
                AND ? > hora_inicio
                AND TIME_TO_SEC(?) > TIME_TO_SEC(hora_inicio))
        )
    `;
    const params = [data, horaFim, horaInicio, data, horaInicio, cruzouMeiaNoite ? 1 : 0, data, horaFim, horaFim];

    db.query(sql, params, (err, ocupadosRows) => {
        if (err) return callback(err);
        const ocupadosIds = new Set(ocupadosRows.map(r => r.posto_id));
        const livre = POSTOS_ATIVOS.find(p => !ocupadosIds.has(p.id));
        callback(null, livre || null);
    });
}

// Mesma verificação de sobreposição do escolherPostoLivre, mas só para o posto
// que o admin escolheu na reserva extraordinária.
function postoEspecificoLivre(postoId, data, horaInicio, horaFim, cruzouMeiaNoite, callback) {
    const sql = `
        SELECT id FROM reservas
        WHERE estado IN ('ativa', 'em_curso') AND posto_id = ?
        AND (
            (data_reserva = ? AND hora_inicio < ? AND hora_fim > ?)
            OR (data_reserva = DATE_SUB(?, INTERVAL 1 DAY)
                AND hora_fim < hora_inicio
                AND TIME_TO_SEC(?) < TIME_TO_SEC(hora_fim))
            OR (? = 1
                AND data_reserva = DATE_ADD(?, INTERVAL 1 DAY)
                AND ? > hora_inicio
                AND TIME_TO_SEC(?) > TIME_TO_SEC(hora_inicio))
        )
        LIMIT 1
    `;
    const params = [postoId, data, horaFim, horaInicio, data, horaInicio, cruzouMeiaNoite ? 1 : 0, data, horaFim, horaFim];

    db.query(sql, params, (err, rows) => {
        if (err) return callback(err);
        callback(null, rows.length === 0);
    });
}

// Segredo partilhado com o Pi, exigido só nas rotas de controlo do admin
// (switch/DAC/série), para o Pi saber que o pedido veio do Node e não de
// alguém a bater diretamente no IP dele.
const PI_ADMIN_SECRET = process.env.PI_ADMIN_SECRET;

// Assina o token de sessão do Pi. Separado do JWT_SECRET para que uma fuga de
// um não comprometa o outro.
const PI_SESSION_SECRET = process.env.PI_SESSION_SECRET;

// Token de sessão do Pi: válido só até à hora de fim da reserva. Usado pelo
// /api/confirmar-entrada e pela aceitação de vaga na fila em tempo real.
function gerarTokenSessaoPi(utilizadorId, reservaId, dataReservaStr, horaInicioStr, horaFimStr) {
    const [ano, mes, dia] = dataReservaStr.split('-').map(Number);
    const [hIni, mIni] = horaInicioStr.split(':').map(Number);
    const [hFim, mFim] = horaFimStr.split(':').map(Number);
    const horaInicioObj = new Date(ano, mes - 1, dia, hIni, mIni, 0);
    const horaFimObj = new Date(ano, mes - 1, dia, hFim, mFim, 0);
    if (horaFimObj <= horaInicioObj) horaFimObj.setDate(horaFimObj.getDate() + 1);

    return jwt.sign(
        { utilizador_id: utilizadorId, reserva_id: reservaId, exp: Math.floor(horaFimObj.getTime() / 1000) },
        PI_SESSION_SECRET
    );
}

// Uma ligação SSE por reserva em curso, para poder revogar a sessão sem
// esperar que o token expire. Só em memória: se o servidor reiniciar, o Pi
// religa-se quando a página recarregar.
const sessoesAtivas = new Map(); // reserva_id -> objeto de resposta SSE

function revogarSessao(reservaId) {
    const resSSE = sessoesAtivas.get(reservaId);
    if (!resSSE) return;
    try {
        resSSE.write('data: revoke\n\n');
        resSSE.end();
    } catch (e) { /* ligação já pode estar fechada, ignorar */ }
    sessoesAtivas.delete(reservaId);
}

// Canal SSE que o Pi abre no início de cada sessão. O próprio token de sessão
// prova que a ligação é daquela reserva, não é preciso outro segredo.
app.get('/api/pi/sessao-eventos', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).end();

    let payload;
    try {
        payload = jwt.verify(token, PI_SESSION_SECRET);
    } catch (e) {
        return res.status(401).end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sessoesAtivas.set(payload.reserva_id, res);

    // Mantém a ligação viva através do proxy do ISEP, que fecha ligações HTTP
    // sem dados ao fim de cerca de 1 minuto.
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (e) { /* ligação já fechada */ }
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        if (sessoesAtivas.get(payload.reserva_id) === res) {
            sessoesAtivas.delete(payload.reserva_id);
        }
    });
});

// Pede ao Pi para desligar relés/DAC. Tem de ser chamado ANTES de marcar a
// reserva como concluída ou cancelada, porque o Pi só aceita o pedido enquanto
// a sessão ainda é válida na BD. O callback corre sempre, mesmo com o Pi
// offline, para não bloquear o resto do fluxo.
function desligarRaspberryPi(utilizadorId, postoId, callback) {
    if (!utilizadorId) return callback();
    // Sem posto preenchido (reserva antiga) ou com o posto já inativo, usa-se
    // o primeiro ativo.
    const posto = POSTOS_ATIVOS.find(p => p.id === postoId) || POSTOS_ATIVOS[0];
    if (!posto) return callback(); // nenhum posto configurado — nada a desligar

    const piReq = http.request({
        host: posto.pi_host,
        port: posto.pi_port,
        path: `/api/desligar-tudo?utilizador_id=${encodeURIComponent(utilizadorId)}`,
        method: 'GET',
        timeout: 5000
    }, (piRes) => {
        piRes.on('data', () => {});
        piRes.on('end', () => callback());
    });
    piReq.on('error', (e) => {
        console.error('Falha ao contactar Pi para desligar:', e.message);
        callback();
    });
    piReq.on('timeout', () => { piReq.destroy(); });
    piReq.end();
}

// ============================================================
// HEARTBEAT DA SESSÃO EM CURSO
// Estar autenticado no agendamento não é o mesmo que estar a usar o
// laboratório. A página do Pi manda um sinal de vida enquanto estiver aberta;
// se parar de chegar, a sessão é terminada como se o aluno se tivesse ido
// embora sem clicar em nada. Só em memória (ver a guarda no job abaixo).
// ============================================================
const ultimoHeartbeatSessao = new Map(); // reserva_id -> timestamp (Date.now())

// Chamado pela página do Pi a cada ~30s. O próprio token de sessão identifica
// a reserva — não é preciso nenhuma autenticação paralela.
app.post('/api/sessao/heartbeat', (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ message: "Token em falta." });

    jwt.verify(token, PI_SESSION_SECRET, (errJwt, payload) => {
        if (errJwt || !payload || !payload.reserva_id) {
            return res.status(401).json({ message: "Token inválido ou expirado." });
        }

        db.query("SELECT estado FROM reservas WHERE id = ?", [payload.reserva_id], (err, results) => {
            if (err) return res.status(500).json({ message: "Erro ao verificar sessão." });
            if (!results || results.length === 0 || results[0].estado !== 'em_curso') {
                return res.status(404).json({ message: "Sessão não está em curso." });
            }
            ultimoHeartbeatSessao.set(payload.reserva_id, Date.now());
            res.json({ ok: true });
        });
    });
});

// Termina sessões cujo heartbeat não chega há mais tempo do que o configurado.
// Uma reserva em_curso ainda sem nenhum sinal registado (acabou de começar, ou
// o servidor reiniciou) fica de fora até chegar o primeiro.
setInterval(() => {
    obterHeartbeatTimeoutMinutos((errCfg, timeoutMinutos) => {
        if (errCfg) return;
        const limiteMs = timeoutMinutos * 60 * 1000;
        const agora = Date.now();

        db.query("SELECT id FROM reservas WHERE estado = 'em_curso'", (err, resultados) => {
            if (err || !resultados) return;

            resultados.forEach(r => {
                const ultimo = ultimoHeartbeatSessao.get(r.id);
                if (ultimo === undefined) return;
                if (agora - ultimo <= limiteMs) return;

                console.log(`[HEARTBEAT] Reserva ${r.id} sem sinal há mais de ${timeoutMinutos} min. A terminar sessão automaticamente.`);
                terminarSessaoAntecipadamente(r.id, (errTerm, resultado) => {
                    if (errTerm) console.error(`[HEARTBEAT] Erro ao terminar reserva ${r.id}:`, errTerm);
                    else if (resultado && resultado.erro) console.log(`[HEARTBEAT] Reserva ${r.id}: ${resultado.erro}`);
                });
            });
        });
    });
}, 30000);

// --- Limite do heartbeat da sessão (minutos sem sinal antes de terminar) ---
app.get('/api/admin/sessao/heartbeat-timeout', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT heartbeat_sessao_timeout_minutos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao consultar o limite." });
        res.json({ timeout_minutos: (results[0] && results[0].heartbeat_sessao_timeout_minutos) || 5 });
    });
});

app.put('/api/admin/sessao/heartbeat-timeout', verificarToken, verificarAdmin, (req, res) => {
    const minutos = Number(req.body.timeout_minutos);
    if (!Number.isInteger(minutos) || minutos < 1 || minutos > 60) {
        return res.status(400).json({ message: "O limite tem de ser um número inteiro de minutos entre 1 e 60." });
    }
    db.query('UPDATE estado_sistema SET heartbeat_sessao_timeout_minutos = ? WHERE id = 1', [minutos], (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar o limite." });
        res.json({ message: "Limite atualizado com sucesso.", timeout_minutos: minutos });
    });
});

// Proxy do stream de vídeo (MJPEG)
app.get('/api/admin/lab-video', (req, res) => {
    const tokenQuery = req.query.token;
    const utilizadorId = req.query.utilizador_id;
    const postoId = Number(req.query.posto_id);
    if (!tokenQuery) return res.status(401).json({ message: "Token em falta" });
    if (!utilizadorId) return res.status(400).json({ message: "Utilizador em falta" });
    if (!postoId) return res.status(400).json({ message: "Posto em falta" });

    const posto = POSTOS_ATIVOS.find(p => p.id === postoId);
    if (!posto) return res.status(404).json({ message: "Posto não encontrado ou inativo." });

    jwt.verify(tokenQuery, SECRET_KEY, (errJwt, userJwt) => {
        if (errJwt) return res.status(401).json({ message: "Token inválido" });
        if (!userJwt || userJwt.role !== 'admin') {
            return res.status(403).json({ message: "Acesso negado" });
        }

        // O /video_feed do Pi deixou de aceitar utilizador_id em bruto: agora
        // exige um token assinado. Como o admin não tem token de aluno, gera-se
        // um aqui a partir da reserva em curso desse utilizador.
        const agoraLisboa = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
        const dataHoje = `${agoraLisboa.getFullYear()}-${String(agoraLisboa.getMonth() + 1).padStart(2, '0')}-${String(agoraLisboa.getDate()).padStart(2, '0')}`;
        const dataOntem = (() => {
            const o = new Date(agoraLisboa);
            o.setDate(o.getDate() - 1);
            return `${o.getFullYear()}-${String(o.getMonth() + 1).padStart(2, '0')}-${String(o.getDate()).padStart(2, '0')}`;
        })();
        const horaAgora = `${String(agoraLisboa.getHours()).padStart(2, '0')}:${String(agoraLisboa.getMinutes()).padStart(2, '0')}:${String(agoraLisboa.getSeconds()).padStart(2, '0')}`;

        const sqlSessao = `
            SELECT id, data_reserva, hora_inicio, hora_fim
            FROM reservas
            WHERE estado IN ('ativa', 'em_curso') AND utilizador_id = ? AND posto_id = ?
            AND (
                (data_reserva = ?
                 AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(hora_inicio)
                 AND TIME_TO_SEC(hora_inicio) <= TIME_TO_SEC(?)
                 AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(?))
                OR
                (data_reserva = ?
                 AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(hora_inicio)
                 AND TIME_TO_SEC(hora_inicio) <= TIME_TO_SEC(?))
                OR
                (data_reserva = ?
                 AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(hora_inicio)
                 AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(?))
            )
            LIMIT 1
        `;
        const paramsSessao = [
            utilizadorId, postoId,
            dataHoje, horaAgora, horaAgora,
            dataHoje, horaAgora,
            dataOntem, horaAgora
        ];

        db.query(sqlSessao, paramsSessao, (errSessao, resultsSessao) => {
            if (errSessao) return res.status(500).json({ message: "Erro ao verificar sessão." });
            if (!resultsSessao || resultsSessao.length === 0) {
                return res.status(404).json({ message: "Sem sessão ativa para este utilizador." });
            }

            const sessao = resultsSessao[0];
            const dataReservaStr = sessao.data_reserva instanceof Date
                ? sessao.data_reserva.toISOString().split('T')[0]
                : String(sessao.data_reserva).split('T')[0];
            const tokenSessaoPi = gerarTokenSessaoPi(
                utilizadorId, sessao.id, dataReservaStr, String(sessao.hora_inicio), String(sessao.hora_fim)
            );

            const piReq = http.request({
                host: posto.pi_host,
                port: posto.pi_port,
                path: `/video_feed?token=${encodeURIComponent(tokenSessaoPi)}`,
                method: 'GET'
            }, (piRes) => {
                res.writeHead(piRes.statusCode, piRes.headers);
                piRes.pipe(res);
            });

            piReq.on('error', (err) => {
                console.error("Erro proxy vídeo:", err.message);
                if (!res.headersSent) res.status(502).json({ message: "Laboratório offline ou inacessível" });
            });

            // Se o cliente se for embora, fechar também a ligação ao Pi
            req.on('close', () => piReq.destroy());
            piReq.end();
        });
    });
});

// Proxy do estado ao vivo (interruptores, DAC, log série) do Pi.
app.get('/api/admin/lab-estado', verificarToken, verificarAdmin, (req, res) => {
    const utilizadorId = req.query.utilizador_id;
    const postoId = Number(req.query.posto_id);
    if (!utilizadorId) return res.status(400).json({ message: "Utilizador em falta" });
    if (!postoId) return res.status(400).json({ message: "Posto em falta" });

    const posto = POSTOS_ATIVOS.find(p => p.id === postoId);
    if (!posto) return res.status(404).json({ message: "Posto não encontrado ou inativo." });

    const piReq = http.request({
        host: posto.pi_host,
        port: posto.pi_port,
        path: `/api/estado-live?utilizador_id=${encodeURIComponent(utilizadorId)}`,
        method: 'GET',
        timeout: 5000
    }, (piRes) => {
        let body = '';
        piRes.on('data', chunk => body += chunk);
        piRes.on('end', () => {
            res.status(piRes.statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.send(body);
        });
    });

    piReq.on('error', (err) => {
        console.error("Erro proxy estado:", err.message);
        res.status(502).json({ message: "Laboratório offline ou inacessível" });
    });
    piReq.on('timeout', () => { piReq.destroy(); });
    piReq.end();
});

// ======================================================
// CONTROLO DO HARDWARE PELO ADMIN (switch, DAC, porta série)
// Reenvia o comando ao Pi com o segredo partilhado no cabeçalho. Aqui não há
// nenhum aluno com reserva por trás, é o admin a agir diretamente.
// ======================================================
function proxyComandoParaPi(posto, caminho, corpo, res) {
    const dados = JSON.stringify(corpo);
    const piReq = http.request({
        host: posto.pi_host,
        port: posto.pi_port,
        path: caminho,
        method: 'POST',
        timeout: 5000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(dados),
            'X-Admin-Secret': PI_ADMIN_SECRET
        }
    }, (piRes) => {
        let body = '';
        piRes.on('data', chunk => body += chunk);
        piRes.on('end', () => {
            res.status(piRes.statusCode);
            res.setHeader('Content-Type', 'application/json');
            res.send(body);
        });
    });

    piReq.on('error', (err) => {
        console.error("Erro proxy comando Pi:", err.message);
        res.status(502).json({ message: "Laboratório offline ou inacessível" });
    });
    piReq.on('timeout', () => { piReq.destroy(); });
    piReq.write(dados);
    piReq.end();
}

// Devolve o posto de req.body.posto_id, ou responde logo com erro se faltar ou
// estiver inativo. Evita repetir isto nas três rotas abaixo.
function obterPostoDoPedido(req, res) {
    const postoId = Number(req.body.posto_id);
    if (!postoId) { res.status(400).json({ message: "Posto em falta" }); return null; }
    const posto = POSTOS_ATIVOS.find(p => p.id === postoId);
    if (!posto) { res.status(404).json({ message: "Posto não encontrado ou inativo." }); return null; }
    return posto;
}

app.post('/api/admin/lab-switch', verificarToken, verificarAdmin, (req, res) => {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ message: "Nome do switch em falta" });
    const posto = obterPostoDoPedido(req, res);
    if (!posto) return;
    proxyComandoParaPi(posto, '/api/admin/switch', { nome }, res);
});

app.post('/api/admin/lab-dac', verificarToken, verificarAdmin, (req, res) => {
    const { valor } = req.body;
    if (valor === undefined || valor === null) return res.status(400).json({ message: "Valor do DAC em falta" });
    const posto = obterPostoDoPedido(req, res);
    if (!posto) return;
    proxyComandoParaPi(posto, '/api/admin/dac', { valor }, res);
});

app.post('/api/admin/lab-serial', verificarToken, verificarAdmin, (req, res) => {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ message: "Texto em falta" });
    const posto = obterPostoDoPedido(req, res);
    if (!posto) return;
    proxyComandoParaPi(posto, '/api/admin/serial', { texto }, res);
});

// ======================================================
// SESSÃO ATUAL — quem está a usar o laboratório agora
// (para o separador "Posto ao Vivo" no Painel Admin)
// ======================================================
// Um item por posto ativo: livre, ou com a sessão que lá está a decorrer.
// Podem estar várias ativas ao mesmo tempo, uma por posto.
app.get('/api/admin/sessao-atual', verificarToken, verificarAdmin, (req, res) => {
    const agoraLisboa = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const dataHoje = `${agoraLisboa.getFullYear()}-${String(agoraLisboa.getMonth() + 1).padStart(2, '0')}-${String(agoraLisboa.getDate()).padStart(2, '0')}`;
    const dataOntem = (() => {
        const o = new Date(agoraLisboa);
        o.setDate(o.getDate() - 1);
        return `${o.getFullYear()}-${String(o.getMonth() + 1).padStart(2, '0')}-${String(o.getDate()).padStart(2, '0')}`;
    })();
    const horaAgora = `${String(agoraLisboa.getHours()).padStart(2, '0')}:${String(agoraLisboa.getMinutes()).padStart(2, '0')}:${String(agoraLisboa.getSeconds()).padStart(2, '0')}`;

    // Procura reservas cujo intervalo [inicio, fim) contém o momento atual,
    // em QUALQUER posto. Trata reservas normais e as que atravessam a meia-noite.
    const sql = `
        SELECT r.id, r.posto_id, r.data_reserva, r.hora_inicio, r.hora_fim, r.estado,
               r.utilizador_id, u.nome, u.username
        FROM reservas r
        JOIN utilizadores u ON u.id = r.utilizador_id
        WHERE r.estado IN ('ativa', 'em_curso')
        AND (
            -- Reserva de hoje que NÃO cruza a meia-noite: inicio <= agora < fim
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_inicio) <= TIME_TO_SEC(?)
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(?))
            OR
            -- Reserva de hoje que cruza a meia-noite: agora >= inicio (parte antes das 24h)
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) <= TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_inicio) <= TIME_TO_SEC(?))
            OR
            -- Reserva de ontem que cruzou a meia-noite: agora < fim (parte depois das 00h)
            (r.data_reserva = ?
             AND TIME_TO_SEC(r.hora_fim) <= TIME_TO_SEC(r.hora_inicio)
             AND TIME_TO_SEC(r.hora_fim) > TIME_TO_SEC(?))
        )
    `;

    const params = [
        dataHoje, horaAgora, horaAgora,   // reserva normal de hoje
        dataHoje, horaAgora,              // reserva de hoje que cruza meia-noite
        dataOntem, horaAgora             // reserva de ontem que cruzou meia-noite
    ];

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error("Erro sessao-atual:", err);
            return res.status(500).json({ message: "Erro ao consultar sessão atual" });
        }

        const porPosto = new Map();
        (results || []).forEach(r => { porPosto.set(r.posto_id, r); });

        const lista = POSTOS_ATIVOS.map(posto => {
            const r = porPosto.get(posto.id);
            if (!r) {
                return { posto_id: posto.id, posto_nome: posto.nome, ativo: false };
            }
            return {
                posto_id: posto.id,
                posto_nome: posto.nome,
                ativo: true,
                reserva_id: r.id,
                utilizador_id: r.utilizador_id,
                nome: r.nome,
                username: r.username,
                data_reserva: r.data_reserva,
                hora_inicio: r.hora_inicio,
                hora_fim: r.hora_fim,
                estado: r.estado
            };
        });

        res.json(lista);
    });
});

// ======================================================
// GESTÃO DE POSTOS
// ======================================================

// Só a contagem, sem os endereços: o calendário do aluno precisa dela para
// saber a capacidade do dia (144 blocos × postos ativos) e escolher a cor.
app.get('/api/postos-ativos-contagem', verificarToken, (req, res) => {
    res.json({ total: POSTOS_ATIVOS.length });
});

app.get('/api/admin/postos', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT * FROM postos ORDER BY id ASC', (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao listar postos." });
        res.json(results);
    });
});

app.post('/api/admin/postos', verificarToken, verificarAdmin, (req, res) => {
    const { nome, pi_host, pi_port } = req.body;
    if (!nome || !pi_host) {
        return res.status(400).json({ message: "Nome e endereço do Pi são obrigatórios." });
    }
    const porta = pi_port ? Number(pi_port) : 5000;
    db.query(
        'INSERT INTO postos (nome, pi_host, pi_port, ativo) VALUES (?, ?, ?, 1)',
        [nome, pi_host, porta],
        (err, result) => {
            if (err) return res.status(500).json({ message: "Erro ao criar posto." });
            recarregarPostosAtivos();
            res.status(201).json({ message: "Posto criado.", id: result.insertId });
        }
    );
});

app.put('/api/admin/postos/:id', verificarToken, verificarAdmin, (req, res) => {
    const { nome, pi_host, pi_port, ativo } = req.body;
    const campos = [];
    const valores = [];
    if (nome !== undefined) { campos.push('nome = ?'); valores.push(nome); }
    if (pi_host !== undefined) { campos.push('pi_host = ?'); valores.push(pi_host); }
    if (pi_port !== undefined) { campos.push('pi_port = ?'); valores.push(Number(pi_port)); }
    if (ativo !== undefined) { campos.push('ativo = ?'); valores.push(ativo ? 1 : 0); }
    if (campos.length === 0) return res.status(400).json({ message: "Nada para atualizar." });

    valores.push(req.params.id);
    db.query(`UPDATE postos SET ${campos.join(', ')} WHERE id = ?`, valores, (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar posto." });
        recarregarPostosAtivos();
        res.json({ message: "Posto atualizado." });
    });
});

// Só apaga se não houver reservas a apontar para o posto. Havendo histórico,
// resta desativá-lo: continua a contar nas estatísticas mas deixa de receber
// atribuições automáticas.
app.delete('/api/admin/postos/:id', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT COUNT(*) AS total FROM reservas WHERE posto_id = ?', [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao verificar posto." });
        if (results[0].total > 0) {
            return res.status(400).json({ message: "Este posto já tem reservas associadas — desativa-o em vez de o apagar." });
        }
        db.query('DELETE FROM postos WHERE id = ?', [req.params.id], (errDel) => {
            if (errDel) return res.status(500).json({ message: "Erro ao apagar posto." });
            recarregarPostosAtivos();
            res.json({ message: "Posto apagado." });
        });
    });
});

// ======================================================
// SERVIDOR
// ======================================================


const path = require('path');

// Sai da pasta 'backend' e vai buscar o site à pasta 'frontend/build'
app.use(express.static(path.join(__dirname, '../frontend/build')));


// ============================================================
// FILA DE ESPERA — rotas básicas (entrar, sair, ver estado)
// A fila é por DIA. Um aluno pode estar em filas de vários dias,
// mas só uma vez por dia (garantido pela UNIQUE KEY na BD).
// ============================================================

// Capacidade do dia: 144 blocos de 10 min por cada posto ativo.
function totalSlotsDia() {
    return 144 * POSTOS_ATIVOS.length;
}

// Hoje, os blocos já passados nunca chegam a ficar ocupados, por isso o total
// para decidir se o dia está cheio conta só os que faltam. Senão o dia nunca
// mais chegava a "cheio" à medida que a tarde avançava. Dias futuros contam
// todos os blocos.
function slotsTotalDoDia(data) {
    const totalDia = totalSlotsDia();
    if (data !== dataHojeLisboa()) return totalDia;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
    // Todos os postos perdem os mesmos blocos, daí a multiplicação.
    const blocosPassadosPorPosto = Math.floor(minutosAgora / 10);
    return Math.max(0, totalDia - (blocosPassadosPorPosto * POSTOS_ATIVOS.length));
}

// Blocos totalmente ocupados de um dia, para saber se está cheio. É a mesma
// conta que /api/ocupados faz.
function contarSlotsOcupados(data, callback) {
    calcularBlocosCheios(data, callback);
}

// Janela configurada pelo admin: minutos a olhar para a frente antes de
// decidir que não há vaga em breve. 60 por omissão.
function obterJanelaVerificacaoMinutos(callback) {
    db.query('SELECT fila_janela_verificacao_minutos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return callback(err, null);
        callback(null, (results && results[0] && results[0].fila_janela_verificacao_minutos) || 60);
    });
}

// Minutos sem heartbeat antes de a sessão ser dada como abandonada. 5 por omissão.
function obterHeartbeatTimeoutMinutos(callback) {
    db.query('SELECT heartbeat_sessao_timeout_minutos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return callback(err, null);
        callback(null, (results && results[0] && results[0].heartbeat_sessao_timeout_minutos) || 5);
    });
}

// Primeiro bloco livre de hoje dentro da janela, em "HH:MM", ou null se não
// houver nenhum. Só nesse caso faz sentido entrar na fila: havendo algo livre
// em breve, vale mais reservar já.
function proximaVagaDentroDaJanela(ocupadosSet, janelaMinutos, ocupadosAmanha) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
    const primeiroBloco = Math.ceil(minutosAgora / 10) * 10;
    // A janela é a configurada no painel de administração e não é cortada à
    // meia-noite: às 23:55, com 60 minutos, olha até às 00:55 do dia seguinte.
    const limite = primeiroBloco + janelaMinutos;
    const { slotDe, ocupado } = criarTesteDeOcupacao(ocupadosSet, ocupadosAmanha);

    for (let min = primeiroBloco; min < limite; min += 10) {
        if (!ocupado(min)) return slotDe(min);
    }
    return null;
}

// Se o aluno deve entrar na fila em vez de reservar diretamente.
//  - Hoje: basta não haver vaga dentro da janela. Não se entra na fila só
//    porque o bloco seguinte está ocupado, havendo um livre daí a pouco.
//  - Dias futuros: não há "agora", por isso o dia tem mesmo de estar cheio.
function naoHaVagaParaEntrarNaFila(data, ocupadosSet, janelaMinutos, ocupadosAmanha) {
    if (data === dataHojeLisboa()) {
        return proximaVagaDentroDaJanela(ocupadosSet, janelaMinutos, ocupadosAmanha) === null;
    }
    return ocupadosSet.size >= slotsTotalDoDia(data);
}

// Formata uma data YYYY-MM-DD para texto legível em português (ex: "20 de julho de 2026")
function formatarDataPT(dataStr) {
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const [ano, mes, dia] = dataStr.split('-').map(Number);
    return `${dia} de ${meses[mes - 1]} de ${ano}`;
}

function dataHojeLisboa() {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

// Data seguinte a "YYYY-MM-DD", com a viragem de mês e de ano tratada pelo Date.
function diaSeguinte(data) {
    const [ano, mes, dia] = data.split('-').map(Number);
    const d = new Date(ano, mes - 1, dia + 1);
    const p = n => String(n).padStart(2, 0 + "");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Ocupação do dia pedido e do seguinte. A janela de verificação e a vaga
// oferecida podem atravessar a meia-noite, por isso não basta olhar para um dia.
function contarSlotsOcupadosComSeguinte(data, callback) {
    calcularBlocosCheios(data, (err, hoje) => {
        if (err) return callback(err, null, null);
        calcularBlocosCheios(diaSeguinte(data), (err2, amanha) => {
            if (err2) return callback(err2, null, null);
            callback(null, hoje, amanha);
        });
    });
}

// Trata os minutos como contínuos a partir da meia-noite do dia pedido:
// abaixo de 1440 são desse dia, de 1440 a 2879 são do dia seguinte.
function criarTesteDeOcupacao(ocupadosSet, ocupadosAmanha) {
    const slotDe = (min) => {
        const m = ((min % 1440) + 1440) % 1440;
        const p = n => String(n).padStart(2, 0 + "");
        return p(Math.floor(m / 60)) + ":" + p(m % 60);
    };
    const ocupado = (min) => {
        if (min < 1440) return ocupadosSet.has(slotDe(min));
        if (min < 2880 && ocupadosAmanha) return ocupadosAmanha.has(slotDe(min));
        return true; // além do dia seguinte, ou sem dados: pára aqui
    };
    return { slotDe, ocupado };
}

// ============================================================
// FILA EM TEMPO REAL (SSE) — só para vagas que abrem no próprio dia.
// Vive toda em memória. O aluno liga-se por SSE ao entrar na fila de hoje e é
// avisado por aqui, sem esperar pelo email, quando uma vaga se liberta.
// A presença mede-se pelo heartbeat do browser (90s sem sinal e sai da fila);
// o fecho da ligação SSE não conta, porque o EventSource religa-se sozinho.
// ============================================================

const filasTempoReal = new Map(); // data (YYYY-MM-DD) -> estado (ver obterOuCriarFilaTempoReal)

function obterOuCriarFilaTempoReal(data) {
    if (!filasTempoReal.has(data)) {
        filasTempoReal.set(data, {
            conexoes: new Map(),          // utilizador_id -> res (ligação SSE)
            ultimoHeartbeat: new Map(),   // utilizador_id -> timestamp do último sinal de vida
            timeoutsPorUtilizador: new Map(), // utilizador_id -> timeoutId da oferta agendada (stagger)
            rondaOrdem: [],               // ordem (por chegada) dos candidatos desta ronda de ofertas
            rondaEnviados: new Set(),     // quem já recebeu a oferta desta ronda
        });
    }
    return filasTempoReal.get(data);
}

// Limpa só a ligação SSE, não tira o aluno da fila_espera. A ligação pode cair
// sem ele ter desistido, e o EventSource religa-se sozinho.
function limparConexaoTempoReal(data, utilizadorId) {
    const estadoFila = filasTempoReal.get(data);
    if (!estadoFila) return;
    const resAntiga = estadoFila.conexoes.get(utilizadorId);
    if (resAntiga) { try { resAntiga.end(); } catch (e) { /* já fechada */ } }
    estadoFila.conexoes.delete(utilizadorId);
    // O ultimoHeartbeat fica de propósito. O heartbeat do browser é um
    // setInterval independente desta ligação e continua a chegar por POST.
    // Apagá-lo aqui fazia com que o job de 30s nunca mais visse esta entrada,
    // e quem fechasse a aba ficava na fila para sempre.
}

// Tira mesmo o aluno da fila. Só quando há a certeza de que desistiu: sem
// heartbeat há demasiado tempo, clique em "Sair da fila", ou reserva feita.
function sairDaFilaTempoReal(data, utilizadorId) {
    limparConexaoTempoReal(data, utilizadorId);
    const estadoFila = filasTempoReal.get(data);
    if (estadoFila) {
        estadoFila.ultimoHeartbeat.delete(utilizadorId);
        const timeoutPendente = estadoFila.timeoutsPorUtilizador.get(utilizadorId);
        if (timeoutPendente) clearTimeout(timeoutPendente);
        estadoFila.timeoutsPorUtilizador.delete(utilizadorId);
    }
    db.query('DELETE FROM fila_espera WHERE utilizador_id = ? AND data_reserva = ?', [utilizadorId, data], () => {});
}

// Corre a cada 30s: remove quem não dá sinal de vida há mais de 90s
// (3× o intervalo esperado do heartbeat do browser).
setInterval(() => {
    const agora = Date.now();
    filasTempoReal.forEach((estadoFila, data) => {
        estadoFila.ultimoHeartbeat.forEach((ultimoSinal, utilizadorId) => {
            if (agora - ultimoSinal > 90000) {
                console.log(`[FILA-RT] ${utilizadorId} sem sinal de vida há demasiado tempo. A remover da fila de ${data}.`);
                sairDaFilaTempoReal(data, utilizadorId);
            }
        });
    });
}, 30000);

function enviarEventoSSE(data, utilizadorId, evento, payload) {
    const estadoFila = filasTempoReal.get(data);
    const res = estadoFila && estadoFila.conexoes.get(utilizadorId);
    if (!res) return; // aluno não tem ligação aberta neste momento — perde o aviso
    try {
        res.write(`event: ${evento}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (e) { /* ligação já fechada, ignorar */ }
}

// Avisa quem continua ligado de que a vaga já foi ocupada por outra pessoa.
// Ninguém sai da fila, ficam à espera da próxima. Cancela também as ofertas já
// agendadas, que a esta altura chegariam tarde.
function notificarVagaPerdida(data, utilizadorIdVencedor) {
    const estadoFila = filasTempoReal.get(data);
    if (!estadoFila) return;

    estadoFila.timeoutsPorUtilizador.forEach(id => clearTimeout(id));
    estadoFila.timeoutsPorUtilizador = new Map();

    estadoFila.conexoes.forEach((res, utilizadorId) => {
        if (utilizadorId === utilizadorIdVencedor) return;
        enviarEventoSSE(data, utilizadorId, 'vaga-perdida', { data });
    });
}

// Quanto tempo está livre a partir deste instante até ao próximo bloco
// ocupado, no máximo 30 min. Raramente dá um múltiplo de 10 certo (8 min,
// 22 min), e é de propósito: isto é "usa o que sobrou", não uma marcação
// com hora à escolha. Null se não houver pelo menos 10 min.
function calcularJanelaLivreAgora(ocupadosSet, ocupadosAmanha) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
    const blocoAgora = Math.floor(minutosAgora / 10) * 10;

    const { ocupado } = criarTesteDeOcupacao(ocupadosSet, ocupadosAmanha);

    if (ocupado(blocoAgora)) {
        return null; // o bloco em curso já foi ocupado entretanto
    }

    // 30 minutos é a duração máxima de uma sessão. A vaga pode atravessar a
    // meia-noite, tal como qualquer outra reserva do sistema.
    let min = blocoAgora;
    const limite = blocoAgora + 30;
    while (min < limite && !ocupado(min)) {
        min += 10;
    }
    const fimMin = min; // exclusivo, já alinhado a um bloco de 10 min

    const fimObj = new Date(agora);
    // setHours(24, 20) transita sozinho para as 00:20 do dia seguinte.
    fimObj.setHours(Math.floor(fimMin / 60), fimMin % 60, 0, 0);

    const duracaoMin = Math.floor((fimObj.getTime() - agora.getTime()) / 60000);
    if (duracaoMin < 10) return null;

    const hh = n => n.toString().padStart(2, 0 + "");
    return {
        hora_inicio: hh(agora.getHours()) + ":" + hh(agora.getMinutes()),
        hora_fim: hh(fimObj.getHours()) + ":" + hh(fimObj.getMinutes()),
        duracao_min: duracaoMin
    };
}

// Oferece a vaga a um candidato. A janela é recalculada neste instante e não
// no momento em que a ronda foi agendada, porque entretanto passou tempo.
function ofertarVaga(data, utilizadorId) {
    const estadoFila = filasTempoReal.get(data);
    if (!estadoFila) return;
    estadoFila.timeoutsPorUtilizador.delete(utilizadorId);
    if (estadoFila.rondaEnviados.has(utilizadorId)) return; // já foi oferecida (ex: cascata de recusa chegou primeiro)
    estadoFila.rondaEnviados.add(utilizadorId);

    contarSlotsOcupadosComSeguinte(data, (err, ocupadosSet, ocupadosAmanha) => {
        if (err) return;
        const janela = calcularJanelaLivreAgora(ocupadosSet, ocupadosAmanha);
        if (!janela) return; // nada aproveitável agora — não vale a pena oferecer
        enviarEventoSSE(data, utilizadorId, 'vaga-disponivel', janela);
    });
}

// Quando um aluno recusa a vaga. Não sai da fila (pode estar à espera de uma
// maior), mas a oferta passa já ao próximo, sem esperar pelo T1 dele.
function avancarParaProximoDaRonda(data, utilizadorIdAtual) {
    const estadoFila = filasTempoReal.get(data);
    if (!estadoFila || estadoFila.rondaOrdem.length === 0) return;

    const indiceAtual = estadoFila.rondaOrdem.indexOf(utilizadorIdAtual);
    if (indiceAtual === -1) return;

    for (let i = indiceAtual + 1; i < estadoFila.rondaOrdem.length; i++) {
        const proximoId = estadoFila.rondaOrdem[i];
        if (estadoFila.rondaEnviados.has(proximoId)) continue; // já foi notificado, nada a acelerar
        ofertarVaga(data, proximoId);
        return;
    }
}

// Vaga que se liberta hoje. A oferta vai saindo aos poucos: o 1º da fila
// recebe-a já, o 2º daí a T1 segundos, o 3º a 2×T1, e assim por diante. Quem
// já a recebeu não a perde, por isso pode haver várias ofertas ativas ao mesmo
// tempo; fica com a vaga quem aceitar primeiro.
function processarFilaTempoReal(data) {
    const sqlFila = `
        SELECT f.utilizador_id, u.creditos
        FROM fila_espera f
        JOIN utilizadores u ON u.id = f.utilizador_id
        WHERE f.data_reserva = ?
        ORDER BY f.criado_em ASC
    `;
    db.query(sqlFila, [data], (err, fila) => {
        if (err) { console.error("[FILA-RT] Erro ao buscar fila do dia:", err); return; }

        const candidatos = fila.filter(a => a.creditos > 0).map(a => a.utilizador_id);
        if (candidatos.length === 0) {
            console.log(`[FILA-RT] Ninguém na fila de hoje (${data}). Vaga fica livre para todos.`);
            return;
        }

        db.query('SELECT fila_tempo_real_t1_segundos FROM estado_sistema WHERE id = 1', (errT1, resultsT1) => {
            const t1Segundos = (resultsT1 && resultsT1[0] && resultsT1[0].fila_tempo_real_t1_segundos) || 20;
            const estadoFila = obterOuCriarFilaTempoReal(data);

            // Cancela as ofertas pendentes da ronda anterior, no caso de duas
            // vagas abrirem muito seguidas.
            estadoFila.timeoutsPorUtilizador.forEach(id => clearTimeout(id));
            estadoFila.timeoutsPorUtilizador = new Map();
            estadoFila.rondaOrdem = candidatos;
            estadoFila.rondaEnviados = new Set();

            candidatos.forEach((utilizadorId, indice) => {
                const atrasoMs = t1Segundos * indice * 1000; // posição n = indice+1 -> T1*(n-1)
                const timeoutId = setTimeout(() => ofertarVaga(data, utilizadorId), atrasoMs);
                estadoFila.timeoutsPorUtilizador.set(utilizadorId, timeoutId);
            });
        });
    });
}

// Pega no 1º da fila de um dia (FIFO), cria-lhe uma vaga pendente válida por
// 1 hora, manda-lhe email e tira-o da fila. Não faz nada se o dia já tiver uma
// vaga pendente ativa — o UNIQUE em data_reserva também o impede na BD.
function processarProximoDaFila(data) {
    // Vagas de hoje vão pela fila em tempo real; dias futuros pela fila por email.
    if (data === dataHojeLisboa()) {
        return processarFilaTempoReal(data);
    }

    // Já existe vaga pendente para este dia? Se sim, não faz nada (dia já trancado)
    db.query('SELECT id FROM vaga_pendente WHERE data_reserva = ?', [data], (errCheck, vagaExistente) => {
        if (errCheck) { console.error("[FILA] Erro ao verificar vaga pendente:", errCheck); return; }
        if (vagaExistente && vagaExistente.length > 0) {
            console.log(`[FILA] Dia ${data} já tem vaga pendente ativa. Não processa próximo.`);
            return;
        }

        // Buscar o 1º da fila deste dia (o que entrou primeiro)
        const sqlPrimeiro = `
            SELECT f.id AS fila_id, f.utilizador_id, u.nome, u.email, u.creditos
            FROM fila_espera f
            JOIN utilizadores u ON u.id = f.utilizador_id
            WHERE f.data_reserva = ?
            ORDER BY f.criado_em ASC
            LIMIT 1
        `;
        db.query(sqlPrimeiro, [data], (errPrim, resultados) => {
            if (errPrim) { console.error("[FILA] Erro ao buscar 1º da fila:", errPrim); return; }
            if (!resultados || resultados.length === 0) {
                console.log(`[FILA] Ninguém na fila do dia ${data}. Vaga fica livre para todos.`);
                return;
            }

            const primeiro = resultados[0];

            // Segurança extra: se entretanto ficou sem créditos, saltá-lo e ir ao próximo
            if (primeiro.creditos <= 0) {
                console.log(`[FILA] ${primeiro.nome} sem créditos. A remover da fila e a tentar o próximo.`);
                db.query('DELETE FROM fila_espera WHERE id = ?', [primeiro.fila_id], () => {
                    processarProximoDaFila(data); // recursivo: tenta o seguinte
                });
                return;
            }

            // Vaga pendente: dia trancado para ele durante 1 hora. A hora limite
            // vai em fuso de Lisboa para o email mostrar a hora certa.
            const agoraLisboa = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
            const expiraEm = new Date(agoraLisboa.getTime() + 60 * 60 * 1000); // agora (Lisboa) + 1h
            const expiraEmSQL = `${expiraEm.getFullYear()}-${String(expiraEm.getMonth()+1).padStart(2,'0')}-${String(expiraEm.getDate()).padStart(2,'0')} ${String(expiraEm.getHours()).padStart(2,'0')}:${String(expiraEm.getMinutes()).padStart(2,'0')}:${String(expiraEm.getSeconds()).padStart(2,'0')}`;

            db.query(
                'INSERT INTO vaga_pendente (utilizador_id, data_reserva, expira_em) VALUES (?, ?, ?)',
                [primeiro.utilizador_id, data, expiraEmSQL],
                (errIns) => {
                    if (errIns) {
                        // Se falhou por duplicado (corrida), outro processo já tratou — ok
                        if (errIns.code === 'ER_DUP_ENTRY') return;
                        console.error("[FILA] Erro ao criar vaga pendente:", errIns);
                        return;
                    }

                    // Remover o aluno da fila (já foi notificado)
                    db.query('DELETE FROM fila_espera WHERE id = ?', [primeiro.fila_id], (errDel) => {
                        if (errDel) console.error("[FILA] Erro ao remover da fila:", errDel);
                    });

                    console.log(`[FILA] Vaga do dia ${data} atribuída a ${primeiro.nome} até ${expiraEmSQL}. A enviar email...`);

                    // Enviar email de aviso
                    const dataFormatada = formatarDataPT(data);
                    const horaLimite = `${String(expiraEm.getHours()).padStart(2,'0')}:${String(expiraEm.getMinutes()).padStart(2,'0')}`;

                    // O frontend lê o ?dia= e pré-seleciona essa data no calendário.
                    const linkMarcar = `${config.APP_URL}/?dia=${data}`;

                    const { assunto, html } = emailVagaLivre(primeiro.nome, dataFormatada, horaLimite, linkMarcar);

                    if (primeiro.email) {
                        enviarEmail(primeiro.email, assunto, html).then(ok => {
                            if (!ok) console.error(`[FILA] Email para ${primeiro.email} falhou (vaga na mesma criada).`);
                        });
                    } else {
                        console.warn(`[FILA] ${primeiro.nome} não tem email registado. Vaga criada mas sem aviso.`);
                    }
                }
            );
        });
    });
}

// --- Se faz sentido mostrar a opção de entrar na fila ---
// Usa a mesma naoHaVagaParaEntrarNaFila do /api/fila/entrar, para o frontend
// não voltar a decidir isto sozinho e divergir do que o backend aceita.
app.get('/api/fila/pode-entrar', verificarToken, (req, res) => {
    const { data } = req.query;
    if (!data) return res.status(400).json({ message: "Data em falta." });

    obterJanelaVerificacaoMinutos((errJanela, janelaMinutos) => {
        if (errJanela) return res.status(500).json({ message: "Erro ao verificar disponibilidade." });

        contarSlotsOcupadosComSeguinte(data, (err, ocupadosSet, ocupadosAmanha) => {
            if (err) return res.status(500).json({ message: "Erro ao verificar ocupação." });

            const mostrarFila = naoHaVagaParaEntrarNaFila(data, ocupadosSet, janelaMinutos, ocupadosAmanha);
            const proximaVaga = (!mostrarFila && data === dataHojeLisboa())
                ? proximaVagaDentroDaJanela(ocupadosSet, janelaMinutos, ocupadosAmanha)
                : null;

            res.json({ mostrar_fila: mostrarFila, proxima_vaga: proximaVaga });
        });
    });
});

// --- Entrar na fila de espera de um dia ---

app.post('/api/fila/entrar', verificarToken, (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ message: "Data em falta." });

    // Hoje: não pode haver vaga dentro da janela. Dias futuros: o dia tem de
    // estar cheio. Fora disso o aluno reserva direto.
    obterJanelaVerificacaoMinutos((errJanela, janelaMinutos) => {
    if (errJanela) return res.status(500).json({ message: "Erro ao verificar disponibilidade." });

    contarSlotsOcupadosComSeguinte(data, (err, ocupadosSet, ocupadosAmanha) => {
        if (err) return res.status(500).json({ message: "Erro ao verificar ocupação." });

        const ehHoje = data === dataHojeLisboa();
        if (!naoHaVagaParaEntrarNaFila(data, ocupadosSet, janelaMinutos, ocupadosAmanha)) {
            const proximoLivre = ehHoje ? proximaVagaDentroDaJanela(ocupadosSet, janelaMinutos, ocupadosAmanha) : null;
            return res.status(400).json({
                message: ehHoje
                    ? `Ainda há vaga disponível às ${proximoLivre}. Podes reservar diretamente.`
                    : "Este dia ainda tem vagas disponíveis. Podes reservar diretamente."
            });
        }

        // Verificar créditos: sem créditos (>0), não pode entrar na fila.
        db.query('SELECT creditos FROM utilizadores WHERE id = ?', [req.user.id], (errCred, credRes) => {
            if (errCred || !credRes || credRes.length === 0) {
                return res.status(500).json({ message: "Erro ao verificar créditos." });
            }
            const creditos = credRes[0].creditos;
            if (creditos <= 0) {
                return res.status(400).json({
                    message: "Não tens créditos suficientes para entrar na fila de espera. Os créditos renovam toda a segunda-feira."
                });
            }

            // Inserir na fila (a UNIQUE KEY impede duplicados no mesmo dia)
            db.query(
                'INSERT INTO fila_espera (utilizador_id, data_reserva) VALUES (?, ?)',
                [req.user.id, data],
                (errInsert) => {
                    if (errInsert) {
                        if (errInsert.code === 'ER_DUP_ENTRY') {
                            return res.status(409).json({ message: "Já estás na fila de espera deste dia." });
                        }
                        console.error("Erro ao entrar na fila:", errInsert);
                        return res.status(500).json({ message: "Erro ao entrar na fila." });
                    }

                    // Descobrir a posição na fila
                    db.query(
                        'SELECT COUNT(*) AS posicao FROM fila_espera WHERE data_reserva = ? AND criado_em <= (SELECT criado_em FROM fila_espera WHERE utilizador_id = ? AND data_reserva = ?)',
                        [data, req.user.id, data],
                        (errPos, posResults) => {
                            const posicao = posResults && posResults[0] ? posResults[0].posicao : null;
                            res.json({
                                message: data === dataHojeLisboa()
                                    ? "Entraste na fila de espera de hoje! Serás avisado aqui mesmo, em tempo real, assim que abrir uma vaga."
                                    : "Entraste na fila de espera! Serás notificado por email se uma vaga ficar livre.",
                                posicao
                            });
                        }
                    );
                }
            );
        });
    });
    });
});

// --- Sair da fila de espera de um dia ---
app.delete('/api/fila/sair', verificarToken, (req, res) => {
    // A data vem na query string (?data=...) — mais fiável em pedidos DELETE
    // do que no corpo, que nem sempre é interpretado.
    const data = req.query.data || (req.body && req.body.data);
    if (!data) return res.status(400).json({ message: "Data em falta." });

    db.query(
        'DELETE FROM fila_espera WHERE utilizador_id = ? AND data_reserva = ?',
        [req.user.id, data],
        (err, result) => {
            if (err) {
                console.error("Erro ao sair da fila:", err);
                return res.status(500).json({ message: "Erro ao sair da fila." });
            }
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: "Não estavas na fila deste dia." });
            }
            limparConexaoTempoReal(data, req.user.id);
            res.json({ message: "Saíste da fila de espera." });
        }
    );
});

// --- Ver o estado da fila de um dia (se estou na fila, posição, total) ---
app.get('/api/fila/estado', verificarToken, (req, res) => {
    const { data } = req.query;
    if (!data) return res.status(400).json({ message: "Data em falta." });

    // Total de pessoas na fila desse dia
    db.query(
        'SELECT COUNT(*) AS total FROM fila_espera WHERE data_reserva = ?',
        [data],
        (errTotal, totalResults) => {
            if (errTotal) return res.status(500).json({ message: "Erro ao consultar fila." });
            const total = totalResults[0].total;

            // Estou na fila? Em que posição?
            db.query(
                `SELECT criado_em FROM fila_espera WHERE utilizador_id = ? AND data_reserva = ?`,
                [req.user.id, data],
                (errEu, euResults) => {
                    if (errEu) return res.status(500).json({ message: "Erro ao consultar fila." });

                    if (!euResults || euResults.length === 0) {
                        return res.json({ na_fila: false, total });
                    }

                    // Posição = quantas pessoas entraram antes ou ao mesmo tempo que eu
                    db.query(
                        'SELECT COUNT(*) AS posicao FROM fila_espera WHERE data_reserva = ? AND criado_em <= ?',
                        [data, euResults[0].criado_em],
                        (errPos, posResults) => {
                            const posicao = posResults && posResults[0] ? posResults[0].posicao : null;
                            res.json({ na_fila: true, posicao, total });
                        }
                    );
                }
            );
        }
    );
});

// --- Ver se tenho uma vaga pendente ativa (dia trancado para mim) ---
app.get('/api/fila/minha-vaga', verificarToken, (req, res) => {
    const sql = `
        SELECT data_reserva, expira_em
        FROM vaga_pendente
        WHERE utilizador_id = ? AND expira_em > NOW()
        ORDER BY expira_em ASC
        LIMIT 1
    `;
    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Erro ao consultar vaga pendente:", err);
            return res.status(500).json({ message: "Erro ao consultar vaga." });
        }
        if (!results || results.length === 0) {
            return res.json({ tem_vaga: false });
        }
        const vaga = results[0];
        const dataStr = vaga.data_reserva instanceof Date
            ? vaga.data_reserva.toISOString().split('T')[0]
            : String(vaga.data_reserva).split('T')[0];
        res.json({
            tem_vaga: true,
            data: dataStr,
            expira_em: vaga.expira_em
        });
    });
});

// ============================================================
// FILA EM TEMPO REAL — rotas do canal SSE, heartbeat e saída explícita
// ============================================================

// Ligação SSE: o aluno abre isto assim que entra na fila de um dia igual a
// hoje. O token vem por query string (?token=) porque o EventSource do
// browser não permite enviar cabeçalhos personalizados.
app.get('/api/fila-tempo-real/eventos', (req, res) => {
    const { data, token } = req.query;
    if (!data || !token) return res.status(400).end();

    jwt.verify(token, SECRET_KEY, (errJwt, user) => {
        if (errJwt) return res.status(401).end();

        const estadoFila = obterOuCriarFilaTempoReal(data);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        estadoFila.conexoes.set(user.id, res);
        estadoFila.ultimoHeartbeat.set(user.id, Date.now());

        // Sem isto o proxy do ISEP corta a ligação ao fim de ~1 minuto sem
        // dados, o mesmo que acontece no canal de revogação do Pi.
        const heartbeatSSE = setInterval(() => {
            try { res.write(': heartbeat\n\n'); } catch (e) { /* já fechada */ }
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeatSSE);
            // Limpa só a ligação. Quem decide tirar da fila é o heartbeat.
            limparConexaoTempoReal(data, user.id);
        });
    });
});

// Sinal de vida do browser, independente da ligação SSE. É o que a verificação
// dos 30s usa para remover quem desapareceu.
app.post('/api/fila-tempo-real/heartbeat', verificarToken, (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ message: "Data em falta." });

    const estadoFila = obterOuCriarFilaTempoReal(data);
    estadoFila.ultimoHeartbeat.set(req.user.id, Date.now());
    res.json({ ok: true });
});

// Aceitar a vaga oferecida pela fila em tempo real. A janela é recalculada
// aqui e não se confia na que foi enviada por SSE, que pode estar velha.
// Havendo pelo menos 10 min, reserva esse intervalo tal como está (não tem de
// ser 10/20/30 como uma reserva normal) e dá entrada no laboratório de uma vez.
app.post('/api/fila-tempo-real/aceitar', verificarToken, (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ message: "Data em falta." });
    if (data !== dataHojeLisboa()) {
        return res.status(400).json({ message: "Esta ação só é válida para o dia de hoje." });
    }

    contarSlotsOcupadosComSeguinte(data, (err, ocupadosSet, ocupadosAmanha) => {
        if (err) return res.status(500).json({ message: "Erro ao verificar ocupação." });

        const janela = calcularJanelaLivreAgora(ocupadosSet, ocupadosAmanha);
        if (!janela) {
            return res.status(409).json({ message: "Essa vaga já não está disponível." });
        }

        db.query('SELECT creditos, ultima_reserva_fim FROM utilizadores WHERE id = ?', [req.user.id], (errUser, userResults) => {
            if (errUser || !userResults || userResults.length === 0) {
                return res.status(500).json({ message: "Erro ao verificar utilizador." });
            }
            const { creditos, ultima_reserva_fim } = userResults[0];

            if (ultima_reserva_fim && new Date(ultima_reserva_fim) > new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }))) {
                return res.status(400).json({ message: "Só podes fazer nova reserva depois de utilizar a anterior." });
            }
            if (creditos < janela.duracao_min) {
                return res.status(400).json({ message: `Créditos insuficientes para os ${janela.duracao_min} min disponíveis.` });
            }

            const horaInicioStr = `${janela.hora_inicio}:00`;
            const horaFimStr = `${janela.hora_fim}:00`;

            // A vaga pode atravessar a meia-noite (ex.: 23:55 -> 00:20), tal como
            // qualquer outra reserva. A hora de fim menor ou igual à de início
            // é o mesmo critério usado no resto do sistema.
            const cruzaMeiaNoite = horaFimStr <= horaInicioStr;
            escolherPostoLivre(data, horaInicioStr, horaFimStr, cruzaMeiaNoite, (errPosto, postoLivre) => {
                if (errPosto) return res.status(500).json({ message: "Erro ao escolher posto." });
                if (!postoLivre) return res.status(409).json({ message: "Essa vaga já não está disponível." });

            const sqlInsert = `
                INSERT INTO reservas (data_reserva, hora_inicio, hora_fim, hora_fim_original, utilizador_id, posto_id, estado, hora_inicio_real)
                VALUES (?, ?, ?, ?, ?, ?, 'em_curso', ?)
            `;
            db.query(sqlInsert, [data, horaInicioStr, horaFimStr, horaFimStr, req.user.id, postoLivre.id, horaInicioStr], (errInsert, resultInsert) => {
                if (errInsert) {
                    console.error("Erro ao aceitar vaga em tempo real:", errInsert);
                    return res.status(500).json({ message: "Erro ao criar a reserva." });
                }

                const reservaId = resultInsert.insertId;

                db.query(
                    'UPDATE utilizadores SET creditos = creditos - ?, ultima_reserva_fim = ? WHERE id = ?',
                    [janela.duracao_min, `${cruzaMeiaNoite ? diaSeguinte(data) : data} ${horaFimStr}`, req.user.id],
                    (errUpd) => { if (errUpd) console.error("Erro ao atualizar créditos:", errUpd); }
                );

                // Já entra como 'em_curso' — dá-lhe já o limite todo do heartbeat.
                ultimoHeartbeatSessao.set(reservaId, Date.now());

                sairDaFilaTempoReal(data, req.user.id);

                // Se isto deixou de novo sem vaga em breve, avisar quem ainda espera.
                obterJanelaVerificacaoMinutos((errJanela, janelaMinutos) => {
                    if (errJanela) return;
                    contarSlotsOcupadosComSeguinte(data, (errOcup2, ocupadosSet2, ocupadosAmanha2) => {
                        if (!errOcup2 && naoHaVagaParaEntrarNaFila(data, ocupadosSet2, janelaMinutos, ocupadosAmanha2)) {
                            notificarVagaPerdida(data, req.user.id);
                        }
                    });
                });

                const tokenSessao = gerarTokenSessaoPi(req.user.id, reservaId, data, janela.hora_inicio, janela.hora_fim);

                res.status(201).json({
                    message: "Reserva confirmada — acesso ao laboratório concedido.",
                    reserva_id: reservaId,
                    hora_inicio: janela.hora_inicio,
                    hora_fim: janela.hora_fim,
                    duracao_min: janela.duracao_min,
                    token_sessao: tokenSessao,
                    pi_host: postoLivre.pi_host,
                    pi_port: postoLivre.pi_port,
                    valido: true
                });
            });
            });
        });
    });
});

// Recusar a vaga oportunista oferecida — não sai da fila (continua candidato
// para a próxima), mas passa já a oferta ao próximo da ronda, sem esperar
// pelo atraso T1 dele.
app.post('/api/fila-tempo-real/recusar', verificarToken, (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ message: "Data em falta." });

    avancarParaProximoDaRonda(data, req.user.id);
    res.json({ ok: true });
});

// --- T1 da fila em tempo real (segundos entre cada revelação sucessiva) ---
app.get('/api/admin/fila-tempo-real/t1', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT fila_tempo_real_t1_segundos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao consultar T1." });
        res.json({ t1_segundos: (results[0] && results[0].fila_tempo_real_t1_segundos) || 20 });
    });
});

app.put('/api/admin/fila-tempo-real/t1', verificarToken, verificarAdmin, (req, res) => {
    const t1 = Number(req.body.t1_segundos);
    if (!Number.isInteger(t1) || t1 < 1 || t1 > 3600) {
        return res.status(400).json({ message: "T1 tem de ser um número inteiro de segundos entre 1 e 3600." });
    }
    db.query('UPDATE estado_sistema SET fila_tempo_real_t1_segundos = ? WHERE id = 1', [t1], (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar T1." });
        res.json({ message: "T1 atualizado com sucesso.", t1_segundos: t1 });
    });
});

// --- Janela de verificação da fila (minutos a olhar para a frente antes de
// decidir que não há vaga em breve) ---
app.get('/api/admin/fila-tempo-real/janela', verificarToken, verificarAdmin, (req, res) => {
    db.query('SELECT fila_janela_verificacao_minutos FROM estado_sistema WHERE id = 1', (err, results) => {
        if (err) return res.status(500).json({ message: "Erro ao consultar a janela." });
        res.json({ janela_minutos: (results[0] && results[0].fila_janela_verificacao_minutos) || 60 });
    });
});

app.put('/api/admin/fila-tempo-real/janela', verificarToken, verificarAdmin, (req, res) => {
    const janela = Number(req.body.janela_minutos);
    if (!Number.isInteger(janela) || janela < 10 || janela > 1440) {
        return res.status(400).json({ message: "A janela tem de ser um número inteiro de minutos entre 10 e 1440." });
    }
    db.query('UPDATE estado_sistema SET fila_janela_verificacao_minutos = ? WHERE id = 1', [janela], (err) => {
        if (err) return res.status(500).json({ message: "Erro ao atualizar a janela." });
        res.json({ message: "Janela atualizada com sucesso.", janela_minutos: janela });
    });
});

// Qualquer rota que não seja da API, devolve o index.html do site
app.get(/.*/, (req,res) => {
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

const PORT = process.env.PORT || 8080;

// ======================================================
// VERIFICAÇÃO AUTOMÁTICA DE FALTAS
// ======================================================

setInterval(() => {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));

    const dataHoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const dataOntem = (() => {
        const o = new Date(agora);
        o.setDate(o.getDate() - 1);
        return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,'0')}-${String(o.getDate()).padStart(2,'0')}`;
    })();

    // Reservas 'ativa' (ninguém entrou) de hoje ou de ontem. Ontem também, para
    // apanhar as que atravessam a meia-noite e que depois das 00h já não
    // apareceriam nesta procura.
    const sqlProcurarFaltas = `
        SELECT id, utilizador_id, hora_inicio, hora_fim, data_reserva
        FROM reservas
        WHERE estado = 'ativa'
        AND (data_reserva = ? OR data_reserva = ?)
    `;

    db.query(sqlProcurarFaltas, [dataHoje, dataOntem], (err, results) => {
        if (err) {
            console.error("Erro ao verificar No-Shows:", err);
            return;
        }
        if (!results || results.length === 0) return;

        results.forEach(reserva => {
            const dataReservaStr = reserva.data_reserva instanceof Date
                ? reserva.data_reserva.toISOString().split('T')[0]
                : String(reserva.data_reserva).split('T')[0];
            const [ano, mes, dia] = dataReservaStr.split('-').map(Number);
            const [hIni, mIni] = String(reserva.hora_inicio).split(':').map(Number);
            const [hFim, mFim] = String(reserva.hora_fim).split(':').map(Number);

            // Com objetos Date, e não minutos do dia, a meia-noite deixa de ser
            // um caso especial: fim <= início quer dizer dia seguinte.
            const horaInicioObj = new Date(ano, mes - 1, dia, hIni, mIni, 0);
            const horaFimObj = new Date(ano, mes - 1, dia, hFim, mFim, 0);
            if (horaFimObj <= horaInicioObj) {
                horaFimObj.setDate(horaFimObj.getDate() + 1);
            }

            // Regras para ser "falta":
            //  - já passaram MAIS de 10 min desde o início
            //  - a reserva ainda não terminou
            const dezMinDepoisDoInicio = new Date(horaInicioObj.getTime() + 10 * 60000);
            const jaPassou10min = agora > dezMinDepoisDoInicio;
            const aindaNaoTerminou = agora < horaFimObj;

            if (jaPassou10min && aindaNaoTerminou) {
                console.log(`[NO-SHOW] Reserva ID ${reserva.id} passou dos 10 min sem entrada. A marcar falta...`);
                db.query(
                    "UPDATE reservas SET estado = 'falta' WHERE id = ?",
                    [reserva.id],
                    (errUpdate) => {
                        if (errUpdate) console.error(`Erro ao marcar falta na reserva ${reserva.id}:`, errUpdate);
                        else console.log(`[NO-SHOW] Reserva ID ${reserva.id} marcada como falta. (créditos não devolvidos)`);
                    }
                );
            }
        });
    });

}, 60000); // 60000ms = 1 minuto

// ======================================================
// FECHO AUTOMÁTICO DE SESSÕES TERMINADAS
// Reservas 'em_curso' cuja hora_fim já passou: manda o Pi desligar os relés
// (antes de concluir, senão o Pi já não aceita) e marca-as como 'concluida'.
// ======================================================
setInterval(() => {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));

    const dataHoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const dataOntem = (() => {
        const o = new Date(agora);
        o.setDate(o.getDate() - 1);
        return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,'0')}-${String(o.getDate()).padStart(2,'0')}`;
    })();
    const horaAgora = `${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}:${String(agora.getSeconds()).padStart(2,'0')}`;

    // Procura reservas 'em_curso' que já terminaram, tratando também as que cruzam a meia-noite:
    //  - Reserva normal de hoje: hora_fim > hora_inicio E hora_fim <= agora
    //  - Reserva de ontem que cruzou a meia-noite: hora_fim <= hora_inicio E hora_fim <= agora
    const sqlSessoesTerminadas = `
        SELECT id, utilizador_id, posto_id, hora_inicio, hora_fim, data_reserva
        FROM reservas
        WHERE estado = 'em_curso'
        AND (
            (data_reserva = ?
             AND TIME_TO_SEC(hora_fim) > TIME_TO_SEC(hora_inicio)
             AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(?))
            OR
            (data_reserva = ?
             AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(hora_inicio)
             AND TIME_TO_SEC(hora_fim) <= TIME_TO_SEC(?))
        )
    `;

    db.query(sqlSessoesTerminadas, [dataHoje, horaAgora, dataOntem, horaAgora], (err, results) => {
        if (err) {
            console.error("Erro ao verificar sessões terminadas:", err);
            return;
        }

        if (!results || results.length === 0) return;

        results.forEach(reserva => {
            console.log(`[FIM-SESSÃO] Reserva ID ${reserva.id} terminou. A desligar laboratório...`);

            const concluir = () => {
                db.query(
                    "UPDATE reservas SET estado = 'concluida' WHERE id = ?",
                    [reserva.id],
                    (errUpd) => {
                        if (errUpd) console.error(`Erro ao concluir reserva ${reserva.id}:`, errUpd);
                        else console.log(`[FIM-SESSÃO] Reserva ID ${reserva.id} concluída.`);
                        // Fecha o canal de eventos se ainda estiver aberto. O token
                        // expira na mesma altura, isto é só para limpar o mapa.
                        revogarSessao(reserva.id);
                    }
                );
            };

            // 1) Pedir ao Pi para desligar tudo, 2) só depois marcar concluída
            desligarRaspberryPi(reserva.utilizador_id, reserva.posto_id, concluir);
        });
    });

}, 60000); // 60000ms = 1 minuto

// ============================================================
// FILA DE ESPERA — expiração de vagas pendentes
// Vagas cujo prazo de 1h passou: apaga-as (o dia destranca) e passa ao próximo
// da fila. Se já não houver ninguém, o dia fica livre para todos.
// ============================================================
setInterval(() => {
    db.query(
        'SELECT id, data_reserva FROM vaga_pendente WHERE expira_em <= NOW()',
        (err, expiradas) => {
            if (err) {
                console.error("[FILA] Erro ao verificar vagas expiradas:", err);
                return;
            }
            if (!expiradas || expiradas.length === 0) return;

            expiradas.forEach(vaga => {
                const dataStr = vaga.data_reserva instanceof Date
                    ? vaga.data_reserva.toISOString().split('T')[0]
                    : String(vaga.data_reserva).split('T')[0];

                console.log(`[FILA] Vaga pendente do dia ${dataStr} expirou. A passar ao próximo...`);

                db.query('DELETE FROM vaga_pendente WHERE id = ?', [vaga.id], (errDel) => {
                    if (errDel) {
                        console.error("[FILA] Erro ao apagar vaga expirada:", errDel);
                        return;
                    }
                    processarProximoDaFila(dataStr);
                });
            });
        }
    );
}, 60000); // 60000ms = 1 minuto

app.listen(PORT, () => {
    console.log(`Servidor a correr na porta ${PORT}`);
});