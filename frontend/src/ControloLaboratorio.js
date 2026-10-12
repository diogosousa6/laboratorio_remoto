import React, { useState, useEffect, useRef } from 'react';
import translations from './translations';

const ControloLaboratorio = ({ user, token, API_URL, carregarReservas }) => {
  const [reservaAtiva, setReservaAtiva] = useState(null);
  // Espelha reservaAtiva para o intervalo do relógio ler sempre o valor mais
  // recente sem ter de ser reiniciado.
  const reservaAtivaRef = useRef(null);
  useEffect(() => { reservaAtivaRef.current = reservaAtiva; }, [reservaAtiva]);
  const [tempoRestante, setTempoRestante] = useState("");
  const [estadoAcesso, setEstadoAcesso] = useState("nenhum"); // nenhum, contagem, ativo

  // A língua escolhe-se no lab_sche.js; aqui só se lê o que está guardado e
  // se atualiza quando muda do outro lado.
  const [lang, setLang] = useState(() => localStorage.getItem('lang') || 'pt');
  const t = translations[lang];

  useEffect(() => {
    const onLangChange = () => setLang(localStorage.getItem('lang') || 'pt');
    window.addEventListener('langchange', onLangChange);
    return () => window.removeEventListener('langchange', onLangChange);
  }, []);

  // 1. Verificar se há alguma sessão para agora ou para os próximos 5 minutos
  const verificarSessaoAtual = async () => {
    try {
      const response = await fetch(`${API_URL}/api/verificar-acesso`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      });
      
      const data = await response.json();

      if (data.valido) {
        setReservaAtiva(data);
        ajustarEstadoTempo(data.hora_inicio, data.hora_fim, data.data_reserva);
      } else if (data.proxima_reserva) {
        // Ainda não dá para entrar, mas há uma reserva a começar dentro de
        // 5 min: mostra a contagem em vez de não mostrar nada.
        setReservaAtiva(data.proxima_reserva);
        ajustarEstadoTempo(data.proxima_reserva.hora_inicio, data.proxima_reserva.hora_fim, data.proxima_reserva.data_reserva);
      } else {
        // Não há sessão ativa nem nada a começar nos próximos 5 minutos
        setEstadoAcesso("nenhum");
        setReservaAtiva(null);
      }
    } catch (error) {
      console.error("Erro ao verificar acesso:", error);
    }
  };

  // 2. Controlar o relógio e os estados do botão
  const ajustarEstadoTempo = (horaInicioStr, horaFimStr, dataReservaStr) => {
    const agora = new Date();
    // Ancorar à data da reserva e não ao dia de hoje do browser: uma reserva
    // que começou ontem e cruzou a meia-noite ainda está ativa depois das 00h.
    let dataAncora = dataReservaStr;
    if (!dataAncora) {
      const ano = agora.getFullYear();
      const mes = String(agora.getMonth() + 1).padStart(2, '0');
      const dia = String(agora.getDate()).padStart(2, '0');
      dataAncora = `${ano}-${mes}-${dia}`;
    }

    const horaInicio = new Date(`${dataAncora}T${horaInicioStr}`);
    let horaFim = new Date(`${dataAncora}T${horaFimStr}`);

    // Se a reserva cruza a meia-noite (fim <= início), o fim é no dia seguinte
    if (horaFim <= horaInicio) {
      horaFim.setDate(horaFim.getDate() + 1);
    }

    if (agora < horaInicio) {
      // Ainda não começou — contagem decrescente até à hora exata
      setEstadoAcesso("contagem");
      const diff = horaInicio - agora;
      setTempoRestante(formatarMilissegundos(diff));
    } else if (agora >= horaInicio && agora <= horaFim) {
      // Bateu a hora exata (ou está dentro do intervalo) — acesso libertado
      setEstadoAcesso("ativo");
      setTempoRestante("");
    } else {
      // Terminou o tempo
      setEstadoAcesso("nenhum");
      setReservaAtiva(null);
    }
  };

  // Relógio de 1 em 1 segundo. O intervalo é montado uma só vez e lê o valor
  // atual pela ref; se dependesse de reservaAtiva era destruído e recriado a
  // cada mudança, e disparava pedidos a mais na transição de estado.
  useEffect(() => {
    verificarSessaoAtual();

    const interval = setInterval(() => {
      const atual = reservaAtivaRef.current;
      if (atual) {
        ajustarEstadoTempo(atual.hora_inicio, atual.hora_fim, atual.data_reserva);
      } else {
        // Sem reserva conhecida, vai procurando por uma.
        verificarSessaoAtual();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const formatarMilissegundos = (ms) => {
    const totalSegundos = Math.floor(ms / 1000);
    const minutos = Math.floor(totalSegundos / 60);
    const segundos = totalSegundos % 60;
    return `${String(minutos).padStart(2, '0')}m : ${String(segundos).padStart(2, '0')}s`;
  };

  // Avisa o backend de que o aluno vai mesmo entrar (é só aqui que a reserva
  // passa a 'em_curso') e abre o Pi com o token de sessão devolvido, em vez do
  // utilizador_id em bruto, que qualquer pessoa podia adivinhar.
  const handleEntrarLaboratorio = async () => {
    try {
      const response = await fetch(`${API_URL}/api/confirmar-entrada`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      if (!data.valido || !data.token_sessao) {
        alert(t.erroEntrarLab);
        return;
      }
      const piHost = data.pi_host || '193.136.63.52';
      const piPort = data.pi_port || 5000;
      window.open(
        `http://${piHost}:${piPort}/main?page=terminal&token=${encodeURIComponent(data.token_sessao)}`,
        '_blank',
        'noopener,noreferrer'
      );
    } catch (error) {
      console.error("Erro ao confirmar entrada:", error);
      alert(t.erroEntrarLab);
    }
  };

  // 3. Ação do Botão de Pânico (Sair Mais Cedo)
  const handleBotaoPanico = async () => {
    if (!window.confirm(t.confirmPanico)) return;

    try {
      const response = await fetch(`${API_URL}/api/cancelar-antecipado`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ reserva_id: reservaAtiva.reserva_id })
      });

      const data = await response.json();
      alert(data.message);
      
      setReservaAtiva(null);
      setEstadoAcesso("nenhum");
      if (carregarReservas) carregarReservas(); 
    } catch (error) {
      alert(t.erroPanico);
    }
  };

  return (
    <div style={{ padding: '20px', border: '1px solid #ccc', borderRadius: '8px', marginTop: '20px' }}>
      <h2>{t.controloTitulo}</h2>

      {/* SE NÃO HÁ RESERVA DETETADA */}
      {estadoAcesso === "nenhum" && (
        <div>
          <p>{t.semSessao}</p>
        </div>
      )}

      {/* CENÁRIO 5 MINUTOS ANTES: Botão Bloqueado + Relógio a descer */}
      {estadoAcesso === "contagem" && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#ff9800', fontWeight: 'bold' }}>{t.sessaoDetetada}</p>
          <h3 style={{ fontSize: '24px', margin: '15px 0' }}>{t.faltam(tempoRestante)}</h3>
          <button disabled style={{ padding: '12px 25px', backgroundColor: '#ccc', cursor: 'not-allowed', color: '#666', border: 'none', borderRadius: '4px' }}>
            {t.entrarBloqueado}
          </button>
        </div>
      )}

      {/* CENÁRIO HORA EXATA: Botão Verde Ativo + Botão de Pânico Vermelho */}
      {estadoAcesso === "ativo" && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#4caf50', fontWeight: 'bold' }}>{t.sessaoDecorrer(reservaAtiva.hora_fim)}</p>

          <div style={{ margin: '20px 0' }}>
            <button
              onClick={handleEntrarLaboratorio}
              style={{ padding: '15px 35px', backgroundColor: '#4caf50', color: 'white', textDecoration: 'none', fontWeight: 'bold', borderRadius: '4px', display: 'inline-block', border: 'none', cursor: 'pointer' }}
            >
              {t.entrarLabRemoto}
            </button>
          </div>

          <hr style={{ margin: '20px 0', borderColor: '#eee' }} />

          {/* O BOTÃO DE PÂNICO */}
          <button
            onClick={handleBotaoPanico}
            style={{ padding: '10px 20px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            {t.terminarSessaoCedo}
          </button>
        </div>
      )}
    </div>
  );
};

export default ControloLaboratorio;