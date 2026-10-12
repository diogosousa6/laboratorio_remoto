import React, { useState, useEffect, useCallback } from 'react';
import {
  Users, Calendar, BarChart2, LogOut,
  Trash2, ShieldCheck, CreditCard, PlusCircle,
  RefreshCw, ChevronDown, X, AlertTriangle,
  Monitor, Video, Wifi, WifiOff, Terminal, Zap, Info,
  Settings, Pencil
} from 'lucide-react';

// ======================================================
// CONFIG
// ======================================================
// Lido do .env no momento do build. O literal fica como recurso, para a
// aplicação não partir caso a variável falte.
const API_URL = process.env.REACT_APP_API_URL || 'https://www.ave.dee.isep.ipp.pt/DEE/micmic-lab';

// ======================================================
// UTILITÁRIOS
// ======================================================

function formatData(dataStr) {
  if (!dataStr) return '—';
  return new Date(dataStr).toLocaleDateString('pt-PT');
}

function hojeISO() {
  // Com toISOString() o dia de hoje atrasava-se até 1 hora depois da
  // meia-noite, por causa da conversão para UTC no horário de verão.
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Junta blocos de 10 min seguidos num só intervalo: ["09:00","09:10","09:20"]
// passa a "09:00–09:30".
function mesclarBlocosOcupados(blocos) {
  const minutos = blocos
    .map(b => { const [h, m] = b.split(':').map(Number); return h * 60 + m; })
    .sort((a, b) => a - b);

  const intervalos = [];
  let inicio = null, anterior = null;
  minutos.forEach(min => {
    if (inicio === null) { inicio = min; anterior = min; return; }
    if (min === anterior + 10) { anterior = min; return; }
    intervalos.push([inicio, anterior + 10]);
    inicio = min; anterior = min;
  });
  if (inicio !== null) intervalos.push([inicio, anterior + 10]);

  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return intervalos.map(([i, f]) => `${fmt(i)}–${fmt(f)}`);
}

// ======================================================
// COMPONENTE PRINCIPAL
// ======================================================

const AdminPanel = () => {

  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  const [tab, setTab] = useState('reservas');
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');

  // Só para o layout de ecrãs estreitos: sidebar vira abas, grids viram coluna.
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // Dados
  const [utilizadores, setUtilizadores] = useState([]);
  const [reservas, setReservas] = useState([]);
  const [stats, setStats] = useState(null);

  // Posto ao Vivo
  const [sessoesAtivas, setSessoesAtivas] = useState([]); // [{ posto_id, posto_nome, ativo, nome, utilizador_id, ... }]
  const [labEstado, setLabEstado] = useState(null);       // { switches, dac_value, serial_log_tail, ... }
  const [labOffline, setLabOffline] = useState(false);
  // Ligado por omissão; o admin pode desligar para poupar pedidos ao Pi.
  const [autoAtualizar, setAutoAtualizar] = useState(true);
  const [videoLigado, setVideoLigado] = useState(false);
  // Cache-buster do <img>, gerado só quando a câmara liga. Antes era um
  // Date.now() no src e, como o painel rerenderiza a cada 5s, o URL mudava
  // sempre e reiniciava o pedido do vídeo em ciclo.
  const [videoKey, setVideoKey] = useState(0);

  // Filtros
  const [filtroData, setFiltroData] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('ativa');

  // Modal de detalhes de uma reserva
  const [reservaInfo, setReservaInfo] = useState(null);

  // Modal nova reserva extraordinária
  const [modalReserva, setModalReserva] = useState(false);
  const [novaReserva, setNovaReserva] = useState({
    data: hojeISO(),
    hora_inicio: '09:00:00',
    hora_fim: '09:30:00',
    username_aluno: '',
    posto_id: '', // '' = aleatório (o sistema escolhe o primeiro posto ativo livre)
  });

  // Horários já ocupados no dia escolhido, para o admin ver antes de preencher
  // e não descobrir o conflito só ao tentar criar a reserva.
  const [ocupadosModal, setOcupadosModal] = useState([]);
  const [ocupadosModalLoading, setOcupadosModalLoading] = useState(false);

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  useEffect(() => {
    if (!modalReserva || !novaReserva.data) { setOcupadosModal([]); return; }
    setOcupadosModalLoading(true);
    fetch(`${API_URL}/api/ocupados?data=${novaReserva.data}`, { headers: authHeaders })
      .then(r => r.json())
      .then(d => setOcupadosModal(Array.isArray(d) ? d : []))
      .catch(() => setOcupadosModal([]))
      .finally(() => setOcupadosModalLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalReserva, novaReserva.data]);

  const mostrarSucesso = (msg) => {
    setSucesso(msg);
    setTimeout(() => setSucesso(''), 3000);
  };

  const mostrarErro = (msg) => {
    setErro(msg);
    setTimeout(() => setErro(''), 4000);
  };

  // ======================================================
  // FETCH
  // ======================================================

  const carregarUtilizadores = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/utilizadores`, { headers: authHeaders });
      const data = await r.json();
      
      if (!r.ok) throw new Error(data.message || 'Sem permissão para carregar utilizadores');
      
      setUtilizadores(Array.isArray(data) ? data : []);
    } catch (e) { 
      mostrarErro(e.message); 
      setUtilizadores([]); 
    }
    setLoading(false);
  }, [token]);

  const carregarReservas = useCallback(async () => {
    setLoading(true);
    try {
      let url = `${API_URL}/api/admin/reservas?`;
      if (filtroData) url += `data=${filtroData}&`;
      if (filtroEstado) url += `estado=${filtroEstado}`;
      
      const r = await fetch(url, { headers: authHeaders });
      const data = await r.json();
      
      if (!r.ok) {
        throw new Error(data.message || `Erro ${r.status} ao carregar reservas do servidor.`);
      }
      
      setReservas(Array.isArray(data) ? data : []);
    } catch (e) { 
      mostrarErro(e.message); 
      setReservas([]); 
    }
    setLoading(false);
  }, [token, filtroData, filtroEstado]);

  const carregarStats = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/estatisticas`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao carregar estatísticas');
      setStats(data);
    } catch (e) { mostrarErro(e.message); }
    setLoading(false);
  }, [token]);

  // ---- FILA EM TEMPO REAL: T1 (segundos entre cada revelação sucessiva) ----
  const [t1Segundos, setT1Segundos] = useState(null);
  const [t1Input, setT1Input] = useState('');
  const [t1Guardando, setT1Guardando] = useState(false);

  const carregarT1 = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/admin/fila-tempo-real/t1`, { headers: authHeaders });
      const data = await r.json();
      if (r.ok) { setT1Segundos(data.t1_segundos); setT1Input(String(data.t1_segundos)); }
    } catch (e) { /* silencioso */ }
  }, [token]);

  const guardarT1 = async () => {
    const valor = Number(t1Input);
    if (!Number.isInteger(valor) || valor < 1 || valor > 3600) {
      mostrarErro("T1 tem de ser um número inteiro de segundos entre 1 e 3600.");
      return;
    }
    setT1Guardando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/fila-tempo-real/t1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ t1_segundos: valor })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao guardar T1');
      setT1Segundos(data.t1_segundos);
      mostrarSucesso('T1 atualizado com sucesso.');
    } catch (e) { mostrarErro(e.message); }
    setT1Guardando(false);
  };

  // ---- FILA EM TEMPO REAL: janela de verificação (minutos a olhar para a
  // frente antes de decidir que não há vaga em breve) ----
  const [janelaMinutos, setJanelaMinutos] = useState(null);
  const [janelaInput, setJanelaInput] = useState('');
  const [janelaGuardando, setJanelaGuardando] = useState(false);

  const carregarJanela = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/admin/fila-tempo-real/janela`, { headers: authHeaders });
      const data = await r.json();
      if (r.ok) { setJanelaMinutos(data.janela_minutos); setJanelaInput(String(data.janela_minutos)); }
    } catch (e) { /* silencioso */ }
  }, [token]);

  const guardarJanela = async () => {
    const valor = Number(janelaInput);
    if (!Number.isInteger(valor) || valor < 10 || valor > 1440) {
      mostrarErro("A janela tem de ser um número inteiro de minutos entre 10 e 1440.");
      return;
    }
    setJanelaGuardando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/fila-tempo-real/janela`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ janela_minutos: valor })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao guardar a janela');
      setJanelaMinutos(data.janela_minutos);
      mostrarSucesso('Janela atualizada com sucesso.');
    } catch (e) { mostrarErro(e.message); }
    setJanelaGuardando(false);
  };

  // ---- HEARTBEAT DA SESSÃO: minutos sem sinal da página do laboratório antes
  // de a sessão ser dada como abandonada e terminada ----
  const [heartbeatTimeout, setHeartbeatTimeout] = useState(null);
  const [heartbeatInput, setHeartbeatInput] = useState('');
  const [heartbeatGuardando, setHeartbeatGuardando] = useState(false);

  const carregarHeartbeatTimeout = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/admin/sessao/heartbeat-timeout`, { headers: authHeaders });
      const data = await r.json();
      if (r.ok) { setHeartbeatTimeout(data.timeout_minutos); setHeartbeatInput(String(data.timeout_minutos)); }
    } catch (e) { /* silencioso */ }
  }, [token]);

  const guardarHeartbeatTimeout = async () => {
    const valor = Number(heartbeatInput);
    if (!Number.isInteger(valor) || valor < 1 || valor > 60) {
      mostrarErro("O limite tem de ser um número inteiro de minutos entre 1 e 60.");
      return;
    }
    setHeartbeatGuardando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/sessao/heartbeat-timeout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ timeout_minutos: valor })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao guardar o limite');
      setHeartbeatTimeout(data.timeout_minutos);
      mostrarSucesso('Limite atualizado com sucesso.');
    } catch (e) { mostrarErro(e.message); }
    setHeartbeatGuardando(false);
  };

  // ---- GESTÃO DE POSTOS (N postos de trabalho, intercambiáveis) ----
  const [postos, setPostos] = useState([]);
  const [novoPosto, setNovoPosto] = useState({ nome: '', pi_host: '', pi_port: '5000' });
  const [postoGuardando, setPostoGuardando] = useState(false);

  const carregarPostos = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/admin/postos`, { headers: authHeaders });
      const data = await r.json();
      if (r.ok) setPostos(Array.isArray(data) ? data : []);
    } catch (e) { /* silencioso */ }
  }, [token]);

  const criarPosto = async () => {
    if (!novoPosto.nome.trim() || !novoPosto.pi_host.trim()) {
      mostrarErro("Nome e endereço do Pi são obrigatórios.");
      return;
    }
    setPostoGuardando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/postos`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ nome: novoPosto.nome.trim(), pi_host: novoPosto.pi_host.trim(), pi_port: Number(novoPosto.pi_port) || 5000 })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao criar posto');
      mostrarSucesso('Posto criado.');
      setNovoPosto({ nome: '', pi_host: '', pi_port: '5000' });
      carregarPostos();
    } catch (e) { mostrarErro(e.message); }
    setPostoGuardando(false);
  };

  const alternarAtivoPosto = async (posto) => {
    try {
      const r = await fetch(`${API_URL}/api/admin/postos/${posto.id}`, {
        method: 'PUT', headers: authHeaders,
        body: JSON.stringify({ ativo: posto.ativo ? 0 : 1 })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao atualizar posto');
      carregarPostos();
    } catch (e) { mostrarErro(e.message); }
  };

  const apagarPosto = async (posto) => {
    if (!window.confirm(`Apagar o posto "${posto.nome}"? Só é possível se não tiver reservas associadas.`)) return;
    try {
      const r = await fetch(`${API_URL}/api/admin/postos/${posto.id}`, { method: 'DELETE', headers: authHeaders });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao apagar posto');
      mostrarSucesso('Posto apagado.');
      carregarPostos();
    } catch (e) { mostrarErro(e.message); }
  };

  // Permite corrigir o endereço do Pi sem apagar e recriar o posto, o que
  // deixa de ser possível assim que ele já tem reservas.
  const [postoEditandoId, setPostoEditandoId] = useState(null);
  const [postoEditForm, setPostoEditForm] = useState({ nome: '', pi_host: '', pi_port: '' });

  const iniciarEdicaoPosto = (posto) => {
    setPostoEditandoId(posto.id);
    setPostoEditForm({ nome: posto.nome, pi_host: posto.pi_host, pi_port: String(posto.pi_port) });
  };

  const guardarEdicaoPosto = async (id) => {
    if (!postoEditForm.nome.trim() || !postoEditForm.pi_host.trim()) {
      mostrarErro("Nome e endereço do Pi são obrigatórios.");
      return;
    }
    try {
      const r = await fetch(`${API_URL}/api/admin/postos/${id}`, {
        method: 'PUT', headers: authHeaders,
        body: JSON.stringify({
          nome: postoEditForm.nome.trim(),
          pi_host: postoEditForm.pi_host.trim(),
          pi_port: Number(postoEditForm.pi_port) || 5000
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'Erro ao atualizar posto');
      mostrarSucesso('Posto atualizado.');
      setPostoEditandoId(null);
      carregarPostos();
    } catch (e) { mostrarErro(e.message); }
  };

  // ---- POSTO AO VIVO ----
  // Um item por posto — livre, ou com a sessão que lá está a decorrer.
  const [postoSelecionadoId, setPostoSelecionadoId] = useState(null);
  const sessaoDoPostoSelecionado = sessoesAtivas.find(s => s.posto_id === postoSelecionadoId) || null;

  const carregarSessaoAtual = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/admin/sessao-atual`, { headers: authHeaders });
      const data = await r.json();
      if (r.ok && Array.isArray(data)) {
        setSessoesAtivas(data);
        // Só na primeira vez: seleciona o primeiro posto com sessão ativa, ou
        // o primeiro de todos.
        setPostoSelecionadoId(atual => {
          if (atual !== null && data.some(p => p.posto_id === atual)) return atual;
          const primeiroAtivo = data.find(p => p.ativo);
          return (primeiroAtivo || data[0])?.posto_id ?? null;
        });
      }
    } catch (e) { setSessoesAtivas([]); }
  }, [token]);

  // Vai buscar o estado ao vivo do Pi (via proxy no Node) de um posto específico
  const carregarEstadoLab = useCallback(async (utilizadorId, postoId) => {
    if (!utilizadorId || !postoId) return;
    try {
      const r = await fetch(`${API_URL}/api/admin/lab-estado?utilizador_id=${encodeURIComponent(utilizadorId)}&posto_id=${postoId}`, { headers: authHeaders });
      if (!r.ok) { setLabOffline(true); setLabEstado(null); return; }
      const data = await r.json();
      setLabEstado(data);
      setLabOffline(false);
    } catch (e) { setLabOffline(true); setLabEstado(null); }
  }, [token]);

  // ---- CONTROLO DO HARDWARE PELO ADMIN (switch, DAC, série) ----
  const [enviandoComando, setEnviandoComando] = useState(false);
  const [dacArrasto, setDacArrasto] = useState(null); // valor temporário enquanto o admin arrasta o slider
  const [serialInput, setSerialInput] = useState('');

  const atualizarEstadoAposComando = () => {
    if (sessaoDoPostoSelecionado?.utilizador_id) carregarEstadoLab(sessaoDoPostoSelecionado.utilizador_id, postoSelecionadoId);
  };

  const enviarComandoSwitch = async (nome) => {
    setEnviandoComando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/lab-switch`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ nome, posto_id: postoSelecionadoId })
      });
      const data = await r.json();
      if (r.ok) atualizarEstadoAposComando();
      else mostrarErro(data.erro || data.message || 'Erro ao mexer no switch');
    } catch (e) { mostrarErro('Erro de rede ao mexer no switch'); }
    setEnviandoComando(false);
  };

  const enviarComandoDac = async (valor) => {
    setEnviandoComando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/lab-dac`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ valor, posto_id: postoSelecionadoId })
      });
      const data = await r.json();
      if (r.ok) atualizarEstadoAposComando();
      else mostrarErro(data.erro || data.message || 'Erro ao mudar o DAC');
    } catch (e) { mostrarErro('Erro de rede ao mudar o DAC'); }
    setEnviandoComando(false);
  };

  const enviarComandoSerial = async () => {
    if (!serialInput.trim()) return;
    setEnviandoComando(true);
    try {
      const r = await fetch(`${API_URL}/api/admin/lab-serial`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ texto: serialInput, posto_id: postoSelecionadoId })
      });
      const data = await r.json();
      if (r.ok) { setSerialInput(''); atualizarEstadoAposComando(); }
      else mostrarErro(data.erro || data.message || 'Erro ao enviar pela porta série');
    } catch (e) { mostrarErro('Erro de rede ao enviar pela porta série'); }
    setEnviandoComando(false);
  };

  useEffect(() => {
    if (tab === 'utilizadores') carregarUtilizadores();
    else if (tab === 'reservas') carregarReservas();
    else if (tab === 'stats') carregarStats();
    else if (tab === 'configs') { carregarT1(); carregarJanela(); carregarHeartbeatTimeout(); carregarPostos(); }
    else if (tab === 'live') carregarSessaoAtual();
  }, [tab]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Polling: só corre se o admin ligar explicitamente a auto-atualização
  useEffect(() => {
    if (tab !== 'live') { setVideoLigado(false); return; }
    if (!autoAtualizar) return;

    const intervalo = setInterval(() => {
      carregarSessaoAtual();
    }, 5000);

    return () => clearInterval(intervalo);
  }, [tab, autoAtualizar, carregarSessaoAtual]);

  // Assim que se sabe quem está no posto selecionado, vai buscar o estado do
  // lab. Também só repete se autoAtualizar estiver ligado.
  useEffect(() => {
    if (tab !== 'live') return;
    if (sessaoDoPostoSelecionado?.ativo && sessaoDoPostoSelecionado?.utilizador_id) {
      carregarEstadoLab(sessaoDoPostoSelecionado.utilizador_id, postoSelecionadoId);
      if (!autoAtualizar) return;
      const intervaloEstado = setInterval(() => {
        carregarEstadoLab(sessaoDoPostoSelecionado.utilizador_id, postoSelecionadoId);
      }, 5000);
      return () => clearInterval(intervaloEstado);
    } else {
      setLabEstado(null);
      setLabOffline(false);
    }
  }, [tab, autoAtualizar, sessaoDoPostoSelecionado, postoSelecionadoId, carregarEstadoLab]);

  // Trocar de posto reinicia a câmara e limpa o estado antigo até chegar o novo.
  useEffect(() => {
    setVideoLigado(false);
    setLabEstado(null);
  }, [postoSelecionadoId]);

  // O botão "Atualizar" pede sempre os dois, mesmo com a checkbox desligada.
  // O tempo mínimo é para o ícone chegar a girar em pedidos muito rápidos.
  const [atualizandoManual, setAtualizandoManual] = useState(false);
  const atualizarPostoAoVivoManual = async () => {
    setAtualizandoManual(true);
    const inicio = Date.now();
    await Promise.all([
      carregarSessaoAtual(),
      (sessaoDoPostoSelecionado?.ativo && sessaoDoPostoSelecionado?.utilizador_id) ? carregarEstadoLab(sessaoDoPostoSelecionado.utilizador_id, postoSelecionadoId) : Promise.resolve()
    ]);
    const restante = 450 - (Date.now() - inicio);
    setTimeout(() => setAtualizandoManual(false), Math.max(0, restante));
  };

  useEffect(() => {
    if (tab === 'reservas') carregarReservas();
  }, [filtroData, filtroEstado]);

  // ======================================================
  // AÇÕES
  // ======================================================

  const cancelarReserva = async (id) => {
    if (!window.confirm('Cancelar esta reserva?')) return;
    try {
      const r = await fetch(`${API_URL}/api/admin/reserva/${id}`, {
        method: 'DELETE', headers: authHeaders
      });
      const data = await r.json();
      if (r.ok) { mostrarSucesso(data.message); carregarReservas(); }
      else mostrarErro(data.message);
    } catch (e) { mostrarErro('Erro de rede'); }
  };

  const atualizarRole = async (userId, role) => {
    try {
      const r = await fetch(`${API_URL}/api/admin/utilizadores/${userId}/role`, {
        method: 'PUT', headers: authHeaders,
        body: JSON.stringify({ role })
      });
      const data = await r.json();
      if (r.ok) { mostrarSucesso(data.message); carregarUtilizadores(); }
      else mostrarErro(data.message);
    } catch (e) { mostrarErro('Erro de rede'); }
  };

  const atualizarCreditos = async (userId, creditos) => {
    const valor = parseInt(prompt('Novo valor de créditos:', creditos));
    if (isNaN(valor) || valor < 0) return;
    try {
      const r = await fetch(`${API_URL}/api/admin/utilizadores/${userId}/creditos`, {
        method: 'PUT', headers: authHeaders,
        body: JSON.stringify({ creditos: valor })
      });
      const data = await r.json();
      if (r.ok) { mostrarSucesso(data.message); carregarUtilizadores(); }
      else mostrarErro(data.message);
    } catch (e) { mostrarErro('Erro de rede'); }
  };

  const criarReservaExtraordinaria = async () => {
    if (!novaReserva.username_aluno || novaReserva.username_aluno.trim() === "") {
      mostrarErro("O campo Username do Aluno é obrigatório.");
      return;
    }

    // Impedir hora de início já passada, quando a reserva é para hoje.
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
    const hojeString = hojeISO();

    if (novaReserva.data === hojeString) {
      // Só HH e MM, para ignorar os segundos se vierem.
      const [hStr, mStr] = novaReserva.hora_inicio.split(':');
      const horaReserva = parseInt(hStr, 10);
      const minReserva = parseInt(mStr, 10);

      const horaAtual = agora.getHours();
      const minAtual = agora.getMinutes();

      if (horaReserva < horaAtual || (horaReserva === horaAtual && minReserva <= minAtual)) {
        mostrarErro("Não é possível criar uma reserva para um horário que já passou.");
        return;
      }
    }

    try {
      const r = await fetch(`${API_URL}/api/admin/reservar`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify(novaReserva)
      });
      const data = await r.json();
      if (r.ok) {
        mostrarSucesso(`Reserva criada! (#${data.id})`);
        setModalReserva(false);
        setNovaReserva({
          data: hojeISO(),
          hora_inicio: '09:00:00',
          hora_fim: '09:30:00',
          username_aluno: '',
          posto_id: '',
        });
        carregarReservas();
      } else mostrarErro(data.message);
    } catch (e) { mostrarErro('Erro de rede'); }
  };

  const handleLogout = () => {
    localStorage.clear();
    window.location.reload();
  };

  // ======================================================
  // RENDER
  // ======================================================

  const tabs = [
    { id: 'reservas', label: 'Reservas', icon: Calendar },
    { id: 'live', label: 'Posto ao Vivo', icon: Monitor },
    { id: 'utilizadores', label: 'Utilizadores', icon: Users },
    { id: 'stats', label: 'Estatísticas', icon: BarChart2 },
    { id: 'configs', label: 'Configurações', icon: Settings },
  ];

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", minHeight: '100vh', background: '#0f172a', color: '#e2e8f0' }}>

      {/* HEADER */}
      <header style={{
        background: '#1e293b', borderBottom: '1px solid #334155',
        padding: '0 24px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', height: 64
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ShieldCheck size={22} color="#6366f1" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#f1f5f9', letterSpacing: '0.05em' }}>
              PAINEL ADMIN — MICMIC LAB
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {user.nome || user.username}
            </div>
          </div>
        </div>
        <button onClick={handleLogout} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#ef4444', border: 'none', color: '#fff',
          borderRadius: 8, padding: '8px 16px', cursor: 'pointer',
          fontSize: 13, fontFamily: 'inherit', fontWeight: 600
        }}>
          <LogOut size={15} /> Sair
        </button>
      </header>

      {/* ALERTAS */}
      {sucesso && (
        <div style={{
          background: '#166534', color: '#bbf7d0', padding: '10px 24px',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 8
        }}>
          ✓ {sucesso}
        </div>
      )}
      {erro && (
        <div style={{
          background: '#7f1d1d', color: '#fecaca', padding: '10px 24px',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 8
        }}>
          <AlertTriangle size={14} /> {erro}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', minHeight: 'calc(100vh - 64px)' }}>

        {/* SIDEBAR — vira uma faixa de abas horizontal com scroll em ecrãs estreitos */}
        <nav style={{
          width: isMobile ? '100%' : 200, background: '#1e293b',
          borderRight: isMobile ? 'none' : '1px solid #334155',
          borderBottom: isMobile ? '1px solid #334155' : 'none',
          padding: isMobile ? '8px' : '16px 0',
          display: isMobile ? 'flex' : 'block',
          overflowX: isMobile ? 'auto' : 'visible',
          gap: isMobile ? 6 : 0
        }}>
          {tabs.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: isMobile ? 'auto' : '100%',
                  whiteSpace: isMobile ? 'nowrap' : 'normal',
                  padding: isMobile ? '10px 14px' : '12px 20px',
                  background: active ? '#312e81' : 'transparent',
                  borderLeft: !isMobile && active ? '3px solid #6366f1' : (isMobile ? 'none' : '3px solid transparent'),
                  borderBottom: isMobile && active ? '3px solid #6366f1' : (isMobile ? '3px solid transparent' : 'none'),
                  borderRadius: isMobile ? 8 : 0,
                  color: active ? '#a5b4fc' : '#94a3b8',
                  border: 'none', cursor: 'pointer',
                  fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
                  textAlign: 'left', transition: 'all 0.15s',
                  flexShrink: 0
                }}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </nav>

        {/* CONTEÚDO */}
        <main style={{ flex: 1, padding: isMobile ? 12 : 24, overflowY: 'auto', minWidth: 0 }}>

          {/* ==================== RESERVAS ==================== */}
          {tab === 'reservas' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Todas as Reservas</h2>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input
                    type="date"
                    value={filtroData}
                    onChange={e => setFiltroData(e.target.value)}
                    style={inputStyle}
                    placeholder="Filtrar data"
                  />
                  <select
                    value={filtroEstado}
                    onChange={e => setFiltroEstado(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Todos</option>
                    <option value="ativa">Ativas</option>
                    <option value="em_curso">Em Curso</option>
                    <option value="cancelada">Canceladas</option>
                    <option value="concluida">Concluídas</option>
                    <option value="falta">Faltas</option>
                  </select>
                  <button onClick={carregarReservas} style={btnSecondary}>
                    <RefreshCw size={14} />
                  </button>
                  <button onClick={() => { carregarPostos(); setModalReserva(true); }} style={btnPrimary}>
                    <PlusCircle size={14} /> Reserva Extra
                  </button>
                </div>
              </div>

              {loading ? <Spinner /> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        {['ID', 'Utilizador', 'Data', 'Horário', 'Estado', 'Ações'].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reservas.length === 0 ? (
                        <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#475569' }}>
                          Nenhuma reserva encontrada
                        </td></tr>
                      ) : reservas.map(r => (
                        <tr key={r.id} style={{ borderBottom: '1px solid #1e293b' }}>
                          <td style={tdStyle}>{r.id}</td>
                          <td style={tdStyle}>
                            <div style={{ fontWeight: 600, color: '#c7d2fe' }}>{r.nome}</div>
                            <div style={{ fontSize: 11, color: '#64748b' }}>{r.username}</div>
                          </td>
                          <td style={tdStyle}>{formatData(r.data_reserva)}</td>
                          <td style={tdStyle}>{r.hora_inicio?.slice(0,5)} — {r.hora_fim?.slice(0,5)}</td>
                          <td style={tdStyle}>
                            <span style={{
                              padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                              background: r.estado === 'em_curso' ? '#92400e' : r.estado === 'falta' ? '#581c87' : String(r.estado).toLowerCase().includes('ativ') ? '#166534' : String(r.estado).toLowerCase().includes('cancel') ? '#7f1d1d' : '#1e3a5f',
                              color: r.estado === 'em_curso' ? '#fde68a' : r.estado === 'falta' ? '#e9d5ff' : String(r.estado).toLowerCase().includes('ativ') ? '#86efac' : String(r.estado).toLowerCase().includes('cancel') ? '#fca5a5' : '#93c5fd'
                            }}>
                              {r.estado || 'ativa'}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => setReservaInfo(r)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#818cf8', padding: 4 }}
                              title="Ver detalhes"
                            >
                              <Info size={16} />
                            </button>
                            {(r.estado === undefined || r.estado === 'em_curso' || String(r.estado).toLowerCase().includes('ativ')) && (
                              <button
                                onClick={() => cancelarReserva(r.id)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', padding: 4 }}
                                title="Cancelar Reserva"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== UTILIZADORES ==================== */}
          {tab === 'utilizadores' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Utilizadores</h2>
                <button onClick={carregarUtilizadores} style={btnSecondary}><RefreshCw size={14} /></button>
              </div>

              {loading ? <Spinner /> : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        {['Username', 'Nome', 'Email', 'Role', 'Créditos', 'Registado', 'Ações'].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {utilizadores.map(u => (
                        <tr key={u.id} style={{ borderBottom: '1px solid #1e293b' }}>
                          <td style={{ ...tdStyle, fontWeight: 700, color: '#a5b4fc' }}>{u.username}</td>
                          <td style={tdStyle}>{u.nome}</td>
                          <td style={{ ...tdStyle, fontSize: 12, color: '#94a3b8' }}>{u.email}</td>
                          <td style={tdStyle}>
                            <span style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: 12,
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.5px',
                              background: u.role === 'admin' ? '#4c1d95' : '#1e293b',
                              color: u.role === 'admin' ? '#c4b5fd' : '#94a3b8',
                              border: `1px solid ${u.role === 'admin' ? '#6d28d9' : '#334155'}`
                            }}>
                              {u.role}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, color: '#fbbf24', fontWeight: 700 }}>{u.creditos}</td>
                          <td style={{ ...tdStyle, fontSize: 12, color: '#64748b' }}>{formatData(u.data_registo)}
                          </td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => atualizarCreditos(u.id, u.creditos)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#818cf8', padding: 4 }}
                              title="Editar créditos"
                            >
                              <CreditCard size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ==================== POSTO AO VIVO ==================== */}
          {tab === 'live' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Posto ao Vivo</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#94a3b8', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoAtualizar}
                      onChange={e => setAutoAtualizar(e.target.checked)}
                    />
                    Auto-atualizar (5s)
                  </label>
                  <button
                    onClick={atualizarPostoAoVivoManual}
                    disabled={atualizandoManual}
                    style={{ ...btnSecondary, opacity: atualizandoManual ? 0.7 : 1, cursor: atualizandoManual ? 'default' : 'pointer' }}
                  >
                    <RefreshCw
                      size={14}
                      style={{
                        animation: atualizandoManual ? 'girar-refresh 0.6s linear infinite' : 'none'
                      }}
                    />
                    {atualizandoManual ? 'A atualizar...' : 'Atualizar'}
                  </button>
                  <style>{`
                    @keyframes girar-refresh {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              </div>

              {/* Seletor de posto — um por posto configurado, com um ponto a
                  indicar se está livre ou tem sessão a decorrer */}
              {sessoesAtivas.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                  {sessoesAtivas.map(p => (
                    <button
                      key={p.posto_id}
                      onClick={() => setPostoSelecionadoId(p.posto_id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
                        border: p.posto_id === postoSelecionadoId ? '1px solid #6366f1' : '1px solid #334155',
                        background: p.posto_id === postoSelecionadoId ? '#312e81' : '#1e293b',
                        color: '#f1f5f9', fontSize: 13, fontWeight: 600
                      }}
                    >
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: p.ativo ? '#10b981' : '#475569'
                      }} />
                      {p.posto_nome}
                    </button>
                  ))}
                </div>
              )}

              {/* Nenhum posto configurado */}
              {sessoesAtivas.length === 0 && (
                <div style={{
                  background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
                  padding: 48, textAlign: 'center'
                }}>
                  <Monitor size={48} style={{ color: '#475569', margin: '0 auto 16px' }} />
                  <p style={{ color: '#94a3b8', fontSize: 15, margin: 0 }}>
                    Nenhum posto configurado ainda.
                  </p>
                  <p style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>
                    Adiciona um posto na aba Configurações.
                  </p>
                </div>
              )}

              {/* Posto selecionado, mas livre */}
              {sessoesAtivas.length > 0 && !sessaoDoPostoSelecionado?.ativo && (
                <div style={{
                  background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
                  padding: 48, textAlign: 'center'
                }}>
                  <Monitor size={48} style={{ color: '#475569', margin: '0 auto 16px' }} />
                  <p style={{ color: '#94a3b8', fontSize: 15, margin: 0 }}>
                    Ninguém está a usar este posto neste momento.
                  </p>
                  <p style={{ color: '#64748b', fontSize: 13, marginTop: 8 }}>
                    Esta página atualiza-se automaticamente a cada 5 segundos.
                  </p>
                </div>
              )}

              {/* Há sessão ativa no posto selecionado */}
              {sessaoDoPostoSelecionado?.ativo && (
                <div>
                  {/* Cartão de quem está a usar */}
                  <div style={{
                    background: '#1e293b', border: '1px solid #334155',
                    borderLeft: '4px solid #10b981', borderRadius: 12,
                    padding: 20, marginBottom: 16,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12
                  }}>
                    <div>
                      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>A utilizar o laboratório · {sessaoDoPostoSelecionado.posto_nome}</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#f1f5f9' }}>
                        {sessaoDoPostoSelecionado.nome || sessaoDoPostoSelecionado.username}
                      </div>
                      <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>
                        {sessaoDoPostoSelecionado.username} · Sessão {sessaoDoPostoSelecionado.hora_inicio?.slice(0,5)} → {sessaoDoPostoSelecionado.hora_fim?.slice(0,5)}
                      </div>
                    </div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: labOffline ? '#7f1d1d' : '#064e3b',
                      padding: '8px 14px', borderRadius: 20
                    }}>
                      {labOffline ? <WifiOff size={16} style={{ color: '#fca5a5' }} /> : <Wifi size={16} style={{ color: '#6ee7b7' }} />}
                      <span style={{ fontSize: 12, fontWeight: 700, color: labOffline ? '#fca5a5' : '#6ee7b7' }}>
                        {labOffline ? 'Lab offline' : 'Lab online'}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.4fr 1fr', gap: 16 }}>
                    {/* Câmara em direto */}
                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
                      <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Video size={16} /> Câmara do Laboratório
                      </h3>

                      {!videoLigado ? (
                        <div style={{
                          background: '#0f172a', borderRadius: 8, aspectRatio: '4/3',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12
                        }}>
                          <Video size={40} style={{ color: '#475569' }} />
                          <button onClick={() => { setLabOffline(false); setVideoKey(Date.now()); setVideoLigado(true); }} style={btnPrimary}>
                            Ligar câmara em direto
                          </button>
                        </div>
                      ) : (
                        <div style={{ position: 'relative' }}>
                          <img
                            src={`${API_URL}/api/admin/lab-video?token=${token}&utilizador_id=${encodeURIComponent(sessaoDoPostoSelecionado?.utilizador_id || '')}&posto_id=${postoSelecionadoId}&t=${videoKey}`}
                            alt="Câmara do laboratório"
                            style={{ width: '100%', borderRadius: 8, display: 'block', background: '#0f172a' }}
                            onError={() => setLabOffline(true)}
                          />
                          <button
                            onClick={() => setVideoLigado(false)}
                            style={{
                              position: 'absolute', top: 8, right: 8,
                              background: 'rgba(15,23,42,0.8)', border: 'none', borderRadius: 6,
                              color: '#f1f5f9', padding: '6px 10px', cursor: 'pointer', fontSize: 12
                            }}
                          >
                            Parar
                          </button>
                        </div>
                      )}
                      <p style={{ fontSize: 11, color: '#64748b', marginTop: 8, marginBottom: 0 }}>
                        Ver a câmara é passivo, não afeta a sessão do aluno, contudo os interruptores e o DAC ao lado têm efeito imediato no hardware que o aluno está a usar.
                      </p>
                    </div>

                    {/* Estado dos interruptores + DAC */}
                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
                      <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Zap size={16} /> Estado dos Interruptores
                      </h3>

                      {labOffline || !labEstado ? (
                        <p style={{ fontSize: 13, color: '#64748b' }}>
                          {labOffline ? 'Sem ligação ao laboratório.' : 'A carregar estado…'}
                        </p>
                      ) : (
                        <>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                            {Object.entries(labEstado.switches || {}).map(([key, sw]) => (
                              <button
                                key={key}
                                onClick={() => enviarComandoSwitch(sw.name)}
                                disabled={enviandoComando}
                                style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  background: '#0f172a', border: 'none', borderRadius: 8, padding: '10px 12px',
                                  cursor: enviandoComando ? 'default' : 'pointer', opacity: enviandoComando ? 0.6 : 1
                                }}
                              >
                                <span style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 600 }}>{sw.name}</span>
                                <span style={{
                                  fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 12,
                                  background: sw.state ? '#064e3b' : '#334155',
                                  color: sw.state ? '#6ee7b7' : '#94a3b8'
                                }}>
                                  {sw.state ? 'ON' : 'OFF'}
                                </span>
                              </button>
                            ))}
                          </div>

                          <div style={{ background: '#0f172a', borderRadius: 8, padding: '12px 14px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <span style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 600 }}>Saída DAC</span>
                              <span style={{ fontSize: 15, color: '#a5b4fc', fontWeight: 800, fontFamily: 'monospace' }}>
                                {dacArrasto ?? labEstado.dac_value ?? 0} <span style={{ fontSize: 11, color: '#64748b' }}>/4095</span>
                              </span>
                            </div>
                            <input
                              type="range" min={0} max={4095}
                              value={dacArrasto ?? labEstado.dac_value ?? 0}
                              disabled={enviandoComando}
                              onChange={e => setDacArrasto(Number(e.target.value))}
                              onMouseUp={() => { if (dacArrasto !== null) { enviarComandoDac(dacArrasto); setDacArrasto(null); } }}
                              onTouchEnd={() => { if (dacArrasto !== null) { enviarComandoDac(dacArrasto); setDacArrasto(null); } }}
                              style={{ width: '100%' }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Consola série */}
                  <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16, marginTop: 16 }}>
                    <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Terminal size={16} /> Consola Série (RX/TX)
                    </h3>
                    <pre style={{
                      background: '#0f172a', borderRadius: 8, padding: 14,
                      color: '#6ee7b7', fontSize: 12, fontFamily: 'monospace',
                      maxHeight: 220, overflowY: 'auto', margin: 0,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                    }}>
                      {labEstado?.serial_log_tail || (labOffline ? '— sem ligação —' : '— sem dados na consola —')}
                    </pre>
                    {!labOffline && labEstado && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <input
                          type="text"
                          value={serialInput}
                          onChange={e => setSerialInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') enviarComandoSerial(); }}
                          placeholder="Texto a enviar pela porta série..."
                          disabled={enviandoComando}
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <button onClick={enviarComandoSerial} disabled={enviandoComando} style={btnPrimary}>
                          Enviar
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== ESTATÍSTICAS ==================== */}
          {tab === 'stats' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Estatísticas</h2>
                <button onClick={carregarStats} style={btnSecondary}><RefreshCw size={14} /></button>
              </div>

              {loading || !stats ? <Spinner /> : (
                <div>
                  {/* Cards de resumo */}
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
                    {[
                      { label: 'Reservas Ativas', value: stats.totalReservas?.[0]?.total || 0, color: '#6366f1' },
                      { label: 'Reservas Concluídas', value: stats.totalConcluidas?.[0]?.total || 0, color: '#22c55e' },
                      { label: 'Reservas Canceladas', value: stats.totalCanceladas?.[0]?.total || 0, color: '#ef4444' },
                      { label: 'Faltas', value: stats.totalFaltas?.[0]?.total || 0, color: '#a855f7' },
                      { label: 'Total Utilizadores', value: stats.totalUtilizadores?.[0]?.total || 0, color: '#10b981' },
                    ].map(card => (
                      <div key={card.label} style={{
                        background: '#1e293b', border: '1px solid #334155',
                        borderLeft: `4px solid ${card.color}`,
                        borderRadius: 12, padding: 20
                      }}>
                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>{card.label}</div>
                        <div style={{ fontSize: 32, fontWeight: 900, color: card.color }}>{card.value}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
                    {/* Top utilizadores */}
                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
                      <h3 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 16, margin: '0 0 16px 0' }}>
                        Top Utilizadores (por minutos)
                      </h3>
                      {(stats.topUtilizadores || []).map((u, i) => (
                        <div key={i} style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '8px 0', borderBottom: '1px solid #0f172a', fontSize: 13
                        }}>
                          <span style={{ color: '#c7d2fe' }}>{u.nome || u.username}</span>
                          <span style={{ color: '#fbbf24' }}>{Math.round(u.minutos_totais || 0)} min</span>
                        </div>
                      ))}
                    </div>

                    {/* Reservas por hora */}
                    <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
                      <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 16px 0' }}>
                        Sessões por Hora do Dia
                      </h3>
                      {(stats.ocupacaoPorHora || []).map((h, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '4px 0', fontSize: 12
                        }}>
                          <span style={{ color: '#64748b', width: 40 }}>{String(h.hora).padStart(2, '0')}h</span>
                          <div style={{
                            height: 8, background: '#6366f1', borderRadius: 4,
                            width: `${Math.min(100, (h.reservas / 10) * 100)}%`
                          }} />
                          <span style={{ color: '#94a3b8' }}>{h.reservas}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'configs' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Configurações</h2>
              </div>

              {/* Definições da fila em tempo real */}
              <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px 0' }}>Fila de Espera em Tempo Real</h3>
                <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px 0' }}>
                  Quando abre uma vaga, o 1º da fila recebe o link de imediato; o 2º passados T1 segundos; o 3º passados 2×T1; e assim sucessivamente.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, color: '#cbd5e1' }}>T1 (segundos):</label>
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    value={t1Input}
                    onChange={(e) => setT1Input(e.target.value)}
                    style={{
                      width: 100, padding: '8px 12px', borderRadius: 8,
                      border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9'
                    }}
                  />
                  <button onClick={guardarT1} disabled={t1Guardando} style={btnPrimary}>
                    {t1Guardando ? 'A guardar...' : 'Guardar'}
                  </button>
                  {t1Segundos !== null && (
                    <span style={{ fontSize: 12, color: '#64748b' }}>Valor atual: {t1Segundos}s</span>
                  )}
                </div>

                <p style={{ fontSize: 12, color: '#64748b', margin: '20px 0 16px 0' }}>
                  Um aluno só pode entrar na fila de hoje se não houver nenhuma vaga dentro desta janela — se já há um horário livre mais tarde dentro desse período, é melhor reservar diretamente.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, color: '#cbd5e1' }}>Janela de verificação (minutos):</label>
                  <input
                    type="number"
                    min="10"
                    max="1440"
                    value={janelaInput}
                    onChange={(e) => setJanelaInput(e.target.value)}
                    style={{
                      width: 100, padding: '8px 12px', borderRadius: 8,
                      border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9'
                    }}
                  />
                  <button onClick={guardarJanela} disabled={janelaGuardando} style={btnPrimary}>
                    {janelaGuardando ? 'A guardar...' : 'Guardar'}
                  </button>
                  {janelaMinutos !== null && (
                    <span style={{ fontSize: 12, color: '#64748b' }}>Valor atual: {janelaMinutos} min</span>
                  )}
                </div>
              </div>

              {/* Heartbeat da sessão em curso */}
              <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px 0' }}>Sessão Abandonada</h3>
                <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px 0' }}>
                  A página do laboratório (no Pi) manda um sinal a cada 30s enquanto estiver aberta. Se parar de chegar durante este tempo, a sessão em curso é terminada automaticamente — os mesmos passos do botão de pânico (desliga o hardware, liberta o resto da reserva, avisa a fila de espera), sem o aluno precisar de clicar em nada.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, color: '#cbd5e1' }}>Limite sem sinal (minutos):</label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={heartbeatInput}
                    onChange={(e) => setHeartbeatInput(e.target.value)}
                    style={{
                      width: 100, padding: '8px 12px', borderRadius: 8,
                      border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9'
                    }}
                  />
                  <button onClick={guardarHeartbeatTimeout} disabled={heartbeatGuardando} style={btnPrimary}>
                    {heartbeatGuardando ? 'A guardar...' : 'Guardar'}
                  </button>
                  {heartbeatTimeout !== null && (
                    <span style={{ fontSize: 12, color: '#64748b' }}>Valor atual: {heartbeatTimeout} min</span>
                  )}
                </div>
              </div>

              {/* Postos de trabalho */}
              <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 4px 0' }}>Postos de Trabalho</h3>
                <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px 0' }}>
                  Os N postos (Raspberry Pi) disponíveis — o sistema atribui automaticamente ao aluno um dos postos que esteja livre.
                </p>

                {postos.length > 0 && (
                  <div style={{ marginBottom: 16, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                          <th style={{ padding: '6px 8px' }}>Nome</th>
                          <th style={{ padding: '6px 8px' }}>Endereço do Pi</th>
                          <th style={{ padding: '6px 8px' }}>Estado</th>
                          <th style={{ padding: '6px 8px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {postos.map(posto => (
                          postoEditandoId === posto.id ? (
                            <tr key={posto.id} style={{ borderBottom: '1px solid #0f172a' }}>
                              <td style={{ padding: '8px' }}>
                                <input
                                  type="text" value={postoEditForm.nome}
                                  onChange={e => setPostoEditForm({ ...postoEditForm, nome: e.target.value })}
                                  style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 130 }}
                                />
                              </td>
                              <td style={{ padding: '8px', display: 'flex', gap: 6 }}>
                                <input
                                  type="text" value={postoEditForm.pi_host}
                                  onChange={e => setPostoEditForm({ ...postoEditForm, pi_host: e.target.value })}
                                  style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 140 }}
                                />
                                <input
                                  type="number" value={postoEditForm.pi_port}
                                  onChange={e => setPostoEditForm({ ...postoEditForm, pi_port: e.target.value })}
                                  style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 80 }}
                                />
                              </td>
                              <td style={{ padding: '8px' }}>
                                <span style={{
                                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                                  background: posto.ativo ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.2)',
                                  color: posto.ativo ? '#34d399' : '#94a3b8'
                                }}>
                                  {posto.ativo ? 'Ativo' : 'Inativo'}
                                </span>
                              </td>
                              <td style={{ padding: '8px', display: 'flex', gap: 8 }}>
                                <button onClick={() => guardarEdicaoPosto(posto.id)} style={btnPrimary}>
                                  Guardar
                                </button>
                                <button onClick={() => setPostoEditandoId(null)} style={btnSecondary}>
                                  Cancelar
                                </button>
                              </td>
                            </tr>
                          ) : (
                            <tr key={posto.id} style={{ borderBottom: '1px solid #0f172a' }}>
                              <td style={{ padding: '8px', color: '#f1f5f9', fontWeight: 600 }}>{posto.nome}</td>
                              <td style={{ padding: '8px', color: '#cbd5e1' }}>{posto.pi_host}:{posto.pi_port}</td>
                              <td style={{ padding: '8px' }}>
                                <span style={{
                                  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                                  background: posto.ativo ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.2)',
                                  color: posto.ativo ? '#34d399' : '#94a3b8'
                                }}>
                                  {posto.ativo ? 'Ativo' : 'Inativo'}
                                </span>
                              </td>
                              <td style={{ padding: '8px', display: 'flex', gap: 8 }}>
                                <button onClick={() => iniciarEdicaoPosto(posto)} style={btnSecondary}>
                                  <Pencil size={14} />
                                </button>
                                <button onClick={() => alternarAtivoPosto(posto)} style={btnSecondary}>
                                  {posto.ativo ? 'Desativar' : 'Ativar'}
                                </button>
                                <button onClick={() => apagarPosto(posto)} style={{ ...btnSecondary, color: '#f87171' }}>
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="text" placeholder="Nome:"
                    value={novoPosto.nome}
                    onChange={e => setNovoPosto({ ...novoPosto, nome: e.target.value })}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 200, boxSizing: 'border-box' }}
                  />
                  <input
                    type="text" placeholder="IP do Pi:"
                    value={novoPosto.pi_host}
                    onChange={e => setNovoPosto({ ...novoPosto, pi_host: e.target.value })}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 260, boxSizing: 'border-box' }}
                  />
                  <input
                    type="number" placeholder="Porta"
                    value={novoPosto.pi_port}
                    onChange={e => setNovoPosto({ ...novoPosto, pi_port: e.target.value })}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', width: 90, boxSizing: 'border-box' }}
                  />
                  <button onClick={criarPosto} disabled={postoGuardando} style={btnPrimary}>
                    <PlusCircle size={14} /> {postoGuardando ? 'A criar...' : 'Adicionar posto'}
                  </button>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

{/* MODAL — RESERVA EXTRAORDINÁRIA */}
      {modalReserva && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
        }}>
          <div style={{
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 16, padding: isMobile ? 20 : 28,
            width: isMobile ? '90vw' : 420, maxWidth: 420, boxSizing: 'border-box'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: '#f1f5f9', fontWeight: 700 }}>
                Reserva Extraordinária
              </h3>
              <button
                onClick={() => setModalReserva(false)}
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px', fontWeight: 'bold' }}
              >
                ✕
              </button>
            </div>

            {/* 1. DATA */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                Data
              </label>
              <input
                type="date"
                value={novaReserva.data}
                onChange={e => setNovaReserva({ ...novaReserva, data: e.target.value })}
                min={hojeISO()} // tranca os dias passados no calendário
                style={{
                  ...inputStyle,
                  width: '100%',
                }}
              />
            </div>

            {/* HORÁRIOS JÁ OCUPADOS NESTE DIA */}
            <div style={{ marginBottom: 14, padding: 10, background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}>
              <p style={{ fontSize: 11, color: '#94a3b8', margin: '0 0 6px 0', fontWeight: 600 }}>
                Horários já ocupados neste dia
              </p>
              {ocupadosModalLoading ? (
                <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>A carregar...</p>
              ) : ocupadosModal.length === 0 ? (
                <p style={{ fontSize: 12, color: '#4ade80', margin: 0 }}>Dia livre — nenhuma reserva ativa.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {mesclarBlocosOcupados(ocupadosModal).map((intervalo, i) => (
                    <span key={i} style={{
                      fontSize: 11, padding: '3px 8px', borderRadius: 999,
                      background: 'rgba(248,113,113,0.15)', color: '#f87171', fontWeight: 600
                    }}>
                      {intervalo}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 2. HORA INÍCIO */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                Hora início (HH:MM:SS)
              </label>
              <input
                type="text"
                value={novaReserva.hora_inicio}
                onChange={e => setNovaReserva({ ...novaReserva, hora_inicio: e.target.value })}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>

            {/* 3. HORA FIM */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                Hora fim (HH:MM:SS)
              </label>
              <input
                type="text"
                value={novaReserva.hora_fim}
                onChange={e => setNovaReserva({ ...novaReserva, hora_fim: e.target.value })}
                style={{ ...inputStyle, width: '100%' }}
              />
              {/* Indicador de duração calculada em tempo real */}
              {(() => {
                try {
                  const [hi, mi] = novaReserva.hora_inicio.split(':').map(Number);
                  const [hf, mf] = novaReserva.hora_fim.split(':').map(Number);
                  if ([hi, mi, hf, mf].some(isNaN)) return null;
                  let dur = (hf * 60 + mf) - (hi * 60 + mi);
                  if (dur < 0) dur += 1440; // cruza a meia-noite
                  if (dur <= 0) {
                    return <p style={{ fontSize: 11, color: '#f87171', marginTop: 6, marginBottom: 0 }}>⚠ A hora de fim tem de ser diferente da de início.</p>;
                  }
                  const horas = Math.floor(dur / 60);
                  const mins = dur % 60;
                  const txtDur = horas > 0 ? `${horas}h${mins > 0 ? ` ${mins}min` : ''}` : `${mins}min`;
                  // Slots de 10 min que a reserva vai ocupar (arredondado p/ cima)
                  const nSlots = Math.ceil(dur / 10);
                  return (
                    <p style={{ fontSize: 11, color: '#818cf8', marginTop: 6, marginBottom: 0 }}>
                      Duração: <strong>{txtDur}</strong> · ocupa {nSlots} {nSlots === 1 ? 'bloco' : 'blocos'} de 10 min no calendário
                    </p>
                  );
                } catch { return null; }
              })()}
            </div>

            {/* 4. USERNAME DO ALUNO */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#a5b4fc', fontWeight: 600, marginBottom: 4 }}>
                Username: Número/Sigla
              </label>
              <input
                type="text"
                placeholder="Ex: 1220982"
                value={novaReserva.username_aluno}
                onChange={e => setNovaReserva({ ...novaReserva, username_aluno: e.target.value })}
                style={{ ...inputStyle, width: '100%', borderColor: '#4f46e5' }}
              />
            </div>

            {/* 5. POSTO (aleatório por omissão, ou escolhido explicitamente) */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                Posto
              </label>
              <select
                value={novaReserva.posto_id}
                onChange={e => setNovaReserva({ ...novaReserva, posto_id: e.target.value })}
                style={{ ...inputStyle, width: '100%' }}
              >
                <option value="">Aleatório (escolhido automaticamente)</option>
                {postos.filter(p => p.ativo).map(p => (
                  <option key={p.id} value={p.id}>{p.nome}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button onClick={criarReservaExtraordinaria} style={{ ...btnPrimary, flex: 1 }}>
                Criar Reserva
              </button>
              <button onClick={() => setModalReserva(false)} style={{ ...btnSecondary, flex: 1 }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DETALHES DA RESERVA */}
      {reservaInfo && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
        }}>
          <div style={{
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 16, padding: isMobile ? 20 : 28,
            width: isMobile ? '90vw' : 420, maxWidth: 420, boxSizing: 'border-box'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: '#f1f5f9', fontWeight: 700 }}>
                Detalhes da Reserva #{reservaInfo.id}
              </h3>
              <button
                onClick={() => setReservaInfo(null)}
                style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px', fontWeight: 'bold' }}
              >
                ✕
              </button>
            </div>

            {[
              ['Aluno', `${reservaInfo.nome} (${reservaInfo.username})`],
              ['Data', formatData(reservaInfo.data_reserva)],
              ['Horário reservado', `${reservaInfo.hora_inicio?.slice(0, 5)} — ${(reservaInfo.hora_fim_original || reservaInfo.hora_fim)?.slice(0, 5)}`],
              ['Slot realmente usado', `${reservaInfo.hora_inicio?.slice(0, 5)} — ${reservaInfo.hora_fim?.slice(0, 5)}`],
              ['Entrou no lab às ', reservaInfo.hora_inicio_real ? reservaInfo.hora_inicio_real.slice(0, 8) : '—'],
              ['Terminou no lab às ', reservaInfo.hora_fim_real ? reservaInfo.hora_fim_real.slice(0, 8) : '—'],
              ['Estado', reservaInfo.estado],
              ['Posto', reservaInfo.posto_nome || '—'],
              ['Criada por', reservaInfo.criado_por_admin ? 'Admin (reserva extraordinária)' : 'O próprio aluno'],
              ['Marcada em', reservaInfo.criado_em || '—'],
            ].map(([label, valor]) => (
              <div key={label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
                <div style={{ fontSize: 14, color: '#f1f5f9', fontWeight: 600, marginTop: 2 }}>{valor}</div>
              </div>
            ))}

            <button onClick={() => setReservaInfo(null)} style={{ ...btnSecondary, width: '100%', marginTop: 8 }}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ======================================================
// ESTILOS PARTILHADOS
// ======================================================

const inputStyle = {
  background: '#0f172a', border: '1px solid #334155',
  color: '#e2e8f0', borderRadius: 8, padding: '8px 12px',
  fontSize: 13, fontFamily: "'IBM Plex Mono', monospace",
  outline: 'none'
};

const btnPrimary = {
  display: 'flex', alignItems: 'center', gap: 6,
  background: '#4f46e5', border: 'none', color: '#fff',
  borderRadius: 8, padding: '8px 16px', cursor: 'pointer',
  fontSize: 13, fontFamily: "'IBM Plex Mono', monospace",
  fontWeight: 600, whiteSpace: 'nowrap'
};

const btnSecondary = {
  display: 'flex', alignItems: 'center', gap: 6,
  background: '#1e293b', border: '1px solid #334155', color: '#94a3b8',
  borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
  fontSize: 13, fontFamily: "'IBM Plex Mono', monospace"
};

const tableStyle = {
  width: '100%', borderCollapse: 'collapse',
  background: '#1e293b', borderRadius: 12, overflow: 'hidden',
  fontSize: 13
};

const thStyle = {
  padding: '12px 16px', textAlign: 'left',
  background: '#0f172a', color: '#64748b',
  fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase'
};

const tdStyle = {
  padding: '12px 16px', color: '#cbd5e1', verticalAlign: 'middle'
};

const Spinner = () => (
  <div style={{ textAlign: 'center', padding: 60, color: '#475569', fontSize: 13 }}>
    A carregar...
  </div>
);

export default AdminPanel;