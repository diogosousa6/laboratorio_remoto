import React, { useState, useEffect, useCallback, useRef } from 'react';

import {
  Clock,
  CheckCircle,
  Sun,
  Sunset,
  Moon,
  MoonStar,
  Timer,
  LogOut,
  AlertCircle,
  Info,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

import translations from './translations';

// Lido do .env no momento do build. O literal fica como recurso, para a
// aplicação não partir caso a variável falte.
const API_URL = process.env.REACT_APP_API_URL || 'https://www.ave.dee.isep.ipp.pt/DEE/micmic-lab';
// 144 blocos de 10 min por posto ativo. Arranca a assumir um posto e é
// corrigido quando o componente principal souber o número real.
let TOTAL_SLOTS_DIA = 144;

const hojeISOLisboa = () => {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
};

// Hoje, os blocos já passados nunca chegam a ficar ocupados, por isso o total
// para decidir se o dia está cheio conta só os que faltam. Dias futuros contam
// os 144 todos.
const slotsTotalDoDia = (dateStr) => {
  if (dateStr !== hojeISOLisboa()) return TOTAL_SLOTS_DIA;
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const blocosPassados = Math.floor(minutosAgora / 10);
  return Math.max(0, TOTAL_SLOTS_DIA - blocosPassados);
};

// Partilhado entre generateSlots() e o filtro de horários passados, para não
// ter os mesmos números em dois sítios.
const RANGES_PERIODO = { madrugada: [0, 6], manha: [6, 12], tarde: [12, 18], noite: [18, 24] };

// Devolve a data do dia seguinte no formato YYYY-MM-DD
const getNextDateStr = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};


// ======================================================
// CALENDÁRIO PERSONALIZADO
// ======================================================

const Calendario = ({ selectedDate, onSelectDate, occupancyMap, onMonthView, t }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  // Avisa o pai para carregar a ocupação do mês visível. Carrega também o mês
  // seguinte, porque a grelha mostra sempre uns dias dele no fim e esses
  // também são clicáveis e coloridos.
  useEffect(() => {
    if (!onMonthView) return;
    onMonthView(viewYear, viewMonth + 1);
    const proximoMesNum = viewMonth === 11 ? 1 : viewMonth + 2;
    const anoDoProximoMes = viewMonth === 11 ? viewYear + 1 : viewYear;
    onMonthView(anoDoProximoMes, proximoMesNum);
  }, [viewYear, viewMonth]);

  const nomeMes = new Date(viewYear, viewMonth, 1).toLocaleDateString(t.locale, {
    month: 'long', year: 'numeric'
  });

  const primeiroDia = new Date(viewYear, viewMonth, 1).getDay();
  const diasNoMes = new Date(viewYear, viewMonth + 1, 0).getDate();

  // monthOffset: -1 = mês anterior (só preenchimento, nunca interativo),
  // 0 = mês em vista, +1 = mês seguinte (interativo, tal como o mês em vista).
  const cells = [];
  for (let i = 0; i < primeiroDia; i++) {
    const diasMesAnterior = new Date(viewYear, viewMonth, 0).getDate();
    cells.push({ day: diasMesAnterior - primeiroDia + 1 + i, currentMonth: false, monthOffset: -1 });
  }
  for (let d = 1; d <= diasNoMes; d++) {
    cells.push({ day: d, currentMonth: true, monthOffset: 0 });
  }
  const restante = 42 - cells.length;
  for (let i = 1; i <= restante; i++) {
    cells.push({ day: i, currentMonth: false, monthOffset: 1 });
  }

  // Data real de uma célula, pelo mês a que ela pertence e não pelo mês em
  // vista. Trata também a mudança de ano.
  const getDateStr = (day, monthOffset = 0) => {
    const d = new Date(viewYear, viewMonth + monthOffset, day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const ehInterativo = (currentMonth, monthOffset) => currentMonth || monthOffset === 1;

  const getDayColor = (day, currentMonth, monthOffset) => {
    if (!ehInterativo(currentMonth, monthOffset)) return {};
    const dateStr = getDateStr(day, monthOffset);
    const slots = occupancyMap[dateStr];

    const dataObj = new Date(dateStr + 'T00:00:00');
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (dataObj < todayStart) return {};

    if (slots === undefined) return {};
    if (slots === 0) return { background: '#16a34a', color: '#fff' };
    if (slots >= slotsTotalDoDia(dateStr)) return { background: '#dc2626', color: '#fff' };
    return { background: '#d97706', color: '#fff' };
  };

  const isSelected = (day, currentMonth, monthOffset) => {
    if (!ehInterativo(currentMonth, monthOffset)) return false;
    return getDateStr(day, monthOffset) === selectedDate;
  };

  const isToday = (day, currentMonth, monthOffset) => {
    if (!ehInterativo(currentMonth, monthOffset)) return false;
    const d = new Date(viewYear, viewMonth + monthOffset, day);
    return (
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear()
    );
  };

  const isPast = (day, currentMonth, monthOffset) => {
    if (!ehInterativo(currentMonth, monthOffset)) return true;
    const dataObj = new Date(getDateStr(day, monthOffset) + 'T00:00:00');
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return dataObj < todayStart;
  };

  const handleClick = (day, currentMonth, monthOffset) => {
    if (!ehInterativo(currentMonth, monthOffset) || isPast(day, currentMonth, monthOffset)) return;
    onSelectDate(getDateStr(day, monthOffset));
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth} className="p-1 rounded hover:bg-slate-100 text-slate-500 transition-colors">
          <ChevronLeft size={18} />
        </button>
        <span className="font-bold text-slate-700 text-sm capitalize">{nomeMes}</span>
        <button onClick={nextMonth} className="p-1 rounded hover:bg-slate-100 text-slate-500 transition-colors">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {t.diasSemana.map(d => (
          <div key={d} className="text-center text-[10px] font-bold text-slate-400 py-1">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell, i) => {
          const interativo = ehInterativo(cell.currentMonth, cell.monthOffset);
          const past = isPast(cell.day, cell.currentMonth, cell.monthOffset);
          const selected = isSelected(cell.day, cell.currentMonth, cell.monthOffset);
          const todayCell = isToday(cell.day, cell.currentMonth, cell.monthOffset);
          const colorStyle = getDayColor(cell.day, cell.currentMonth, cell.monthOffset);

          return (
            <button
              key={i}
              onClick={() => handleClick(cell.day, cell.currentMonth, cell.monthOffset)}
              disabled={!interativo || past}
              style={selected ? { background: '#4f46e5', color: '#fff', borderRadius: 8 } : colorStyle.background ? { ...colorStyle, borderRadius: 8 } : {}}
              className={`
                relative text-center py-1.5 text-xs font-semibold rounded-lg transition-all
                ${!interativo ? 'text-slate-300 cursor-default' : ''}
                ${interativo && past ? 'text-slate-300 cursor-default' : ''}
                ${interativo && !past && !selected && !colorStyle.background ? 'text-slate-700 hover:bg-indigo-50 cursor-pointer' : ''}
                ${selected ? 'shadow-md scale-110' : ''}
                ${todayCell && !selected ? 'ring-2 ring-indigo-400' : ''}
              `}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-center gap-4 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-600 inline-block"/> {t.livre}</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-amber-600 inline-block"/> {t.parcial}</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-600 inline-block"/> {t.cheio}</span>
      </div>
    </div>
  );
};

// ======================================================
// COMPONENTE PRINCIPAL
// ======================================================

const LabScheduling = () => {

  const token = localStorage.getItem("token");

  const [user] = useState(JSON.parse(localStorage.getItem("user") || '{}'));

  const [creditos, setCreditos] = useState(user?.creditos || 0);
  const [showReservations, setShowReservations] = useState(false);
  const [reservas, setReservas] = useState([]);

  const [selectedDate, setSelectedDate] = useState("");
  const [selectedDuration, setSelectedDuration] = useState(30);
  const [selectedPeriod, setSelectedPeriod] = useState("manha");
  const [selectedTime, setSelectedTime] = useState(null);
  const [bookingStatus, setBookingStatus] = useState(null);
  const [confirmedBooking, setConfirmedBooking] = useState(null);

  // O dia seguinte também é preciso para saber a que dia pertence cada bloco
  // quando uma reserva atravessa a meia-noite.
  const [bookedSlots, setBoostedSlots] = useState([]);
  const [bookedSlotsNextDay, setBookedSlotsNextDay] = useState([]);

  const [aviso, setAviso] = useState('');
  const [avisoTipo, setAvisoTipo] = useState('');

  const [occupancyMap, setOccupancyMap] = useState({});

  const [lang, setLang] = useState(() => localStorage.getItem('lang') || 'pt');
  const t = translations[lang];

  useEffect(() => {
    localStorage.setItem('lang', lang);
    // Avisa outros componentes montados na mesma página (ex: ControloLaboratorio)
    window.dispatchEvent(new Event('langchange'));
  }, [lang]);

  // ---- FILA DE ESPERA ----
  const [filaEstado, setFilaEstado] = useState({ na_fila: false, posicao: null, total: 0 });
  // Se mostrar o painel "entrar na fila" vem sempre do backend, nunca é
  // decidido aqui, para não voltar a divergir do que ele aceita.
  const [filaVisibilidade, setFilaVisibilidade] = useState({ mostrar_fila: false, proxima_vaga: null });
  // Fila de HOJE, de propósito independente do dia selecionado no calendário,
  // para não desaparecer do ecrã só porque o aluno foi ver outro dia.
  const [filaHojeEstado, setFilaHojeEstado] = useState({ na_fila: false, posicao: null, total: 0 });
  const [minhaVaga, setMinhaVaga] = useState({ tem_vaga: false, data: null, expira_em: null });
  const [vagaCountdown, setVagaCountdown] = useState(""); // contagem decrescente da vaga
  const [filaLoading, setFilaLoading] = useState(false);
  // { hora_inicio, hora_fim, duracao_min } enquanto há uma vaga à espera de
  // resposta, null caso contrário.
  const [ofertaVagaHoje, setOfertaVagaHoje] = useState(null);

  const durations = [10, 20, 30];

  // ======================================================
  // LOGOUT
  // ======================================================

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.reload();
  };

  // ======================================================
  // FILA DE ESPERA
  // ======================================================

  // Ver se estou na fila de um dia (e a posição)
  const verificarFila = useCallback(async (data) => {
    if (!data) return;
    try {
      const r = await fetch(`${API_URL}/api/fila/estado?data=${data}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) {
        const d = await r.json();
        setFilaEstado(d);
      }
    } catch (e) { /* silencioso */ }
  }, [token]);

  // Quem decide se o painel de entrar na fila aparece é o backend, pela mesma
  // lógica que o /api/fila/entrar usa para aceitar o pedido.
  const verificarPodeEntrarFila = useCallback(async (data) => {
    if (!data) return;
    try {
      const r = await fetch(`${API_URL}/api/fila/pode-entrar?data=${data}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) setFilaVisibilidade(await r.json());
    } catch (e) { /* silencioso */ }
  }, [token]);

  // Fila de hoje, independente do dia que está aberto no calendário, para o
  // indicador do topo não depender de onde o aluno anda a navegar.
  const verificarFilaHoje = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/fila/estado?data=${hojeISOLisboa()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) setFilaHojeEstado(await r.json());
    } catch (e) { /* silencioso */ }
  }, [token]);

  // Ver se tenho uma vaga pendente ativa (dia trancado para mim)
  const verificarMinhaVaga = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/fila/minha-vaga`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) {
        const d = await r.json();
        setMinhaVaga(d);
      }
    } catch (e) { /* silencioso */ }
  }, [token]);

  // Entrar na fila de espera do dia selecionado
  const entrarNaFila = async () => {
    if (!selectedDate) return;
    setFilaLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/fila/entrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data: selectedDate })
      });
      const d = await r.json();
      if (r.ok) {
        // Mensagem daqui e não a da API: a da API vem sempre em português e
        // não distingue hoje de dias futuros, chegando a dizer "serás avisado
        // por email" na fila de hoje, onde isso nunca acontece.
        setAviso(selectedDate === hojeISOLisboa() ? t.entrasteFilaHoje : t.entrasteFila);
        setAvisoTipo('info');
        verificarFila(selectedDate);
        if (selectedDate === hojeISOLisboa()) verificarFilaHoje();
      } else {
        setAviso(d.message || t.naoEntrarFila);
        setAvisoTipo('erro');
      }
    } catch (e) {
      setAviso(t.erroEntrarFila);
      setAvisoTipo('erro');
    } finally {
      setFilaLoading(false);
    }
  };

  // Com data explícita sai dessa fila (usado pelo banner do topo); sem ela,
  // sai da fila do dia selecionado no calendário.
  const sairDaFila = async (dataAlvo = selectedDate) => {
    if (!dataAlvo) return;
    setFilaLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/fila/sair?data=${dataAlvo}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const d = await r.json();
      if (r.ok) {
        setAviso(d.message || t.saisteFila);
        setAvisoTipo('info');
        setOfertaVagaHoje(null);
        verificarFila(selectedDate);
        if (dataAlvo === hojeISOLisboa()) verificarFilaHoje();
      } else {
        setAviso(d.message || t.naoSairFila);
        setAvisoTipo('erro');
      }
    } catch (e) {
      setAviso(t.erroSairFila);
      setAvisoTipo('erro');
    } finally {
      setFilaLoading(false);
    }
  };

  // Verificar vaga pendente ao carregar a página
  useEffect(() => {
    verificarMinhaVaga();
    verificarFilaHoje();
  }, []);

  // Número de postos ativos, para a capacidade do dia (e as cores do
  // calendário) não assumirem sempre um só. Como TOTAL_SLOTS_DIA vive fora do
  // componente, este estado serve só para forçar um render quando o valor
  // real chega; senão as cores ficavam erradas até à próxima interação.
  const [, forcarRecalculoCores] = useState(0);
  useEffect(() => {
    fetch(`${API_URL}/api/postos-ativos-contagem`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.total > 0) {
          TOTAL_SLOTS_DIA = 144 * d.total;
          forcarRecalculoCores(v => v + 1);
        }
      })
      .catch(() => {});
  }, [token]);

  // ======================================================
  // FILA EM TEMPO REAL (hoje) — ligação SSE + heartbeat
  // ======================================================

  // Independente de selectedDate: a ligação é sempre sobre o dia de hoje,
  // esteja o aluno a ver que calendário estiver.
  const estouNaFilaDeHoje = filaHojeEstado.na_fila;

  // Chamado quando chega o aviso de vaga disponível, para o horário libertado
  // aparecer sem o aluno ter de recarregar a página.
  const recarregarOcupacaoHoje = useCallback(() => {
    const hoje = hojeISOLisboa();
    fetch(`${API_URL}/api/ocupados?data=${hoje}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(slots => {
        if (Array.isArray(slots)) {
          setOccupancyMap(prev => ({ ...prev, [hoje]: slots.length }));
          if (hoje === selectedDate) setBoostedSlots(slots);
        }
      })
      .catch(() => {});
  }, [token, selectedDate]);

  useEffect(() => {
    if (!estouNaFilaDeHoje) return;

    const data = hojeISOLisboa();
    const es = new EventSource(`${API_URL}/api/fila-tempo-real/eventos?data=${data}&token=${encodeURIComponent(token)}`);
    es.addEventListener('vaga-disponivel', (evento) => {
      try {
        setOfertaVagaHoje(JSON.parse(evento.data));
      } catch (e) { /* payload inesperado, ignorar */ }
      recarregarOcupacaoHoje();
    });
    es.addEventListener('vaga-perdida', () => {
      setOfertaVagaHoje(null);
      setAviso(t.vagaPerdidaMensagem);
      setAvisoTipo('erro');
    });

    const enviarHeartbeat = () => {
      fetch(`${API_URL}/api/fila-tempo-real/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data })
      }).catch(() => {});
    };
    enviarHeartbeat();
    const heartbeatInterval = setInterval(enviarHeartbeat, 30000);

    // Não há aviso no fecho da aba de propósito: o "pagehide" também dispara
    // num F5 e expulsava o aluno da fila só por ele atualizar a página. Quem
    // trata do fecho real é o heartbeat, ou o botão "Sair da fila".
    return () => {
      es.close();
      clearInterval(heartbeatInterval);
    };
  }, [estouNaFilaDeHoje, token, recarregarOcupacaoHoje]);

  // Põe o título do separador a piscar enquanto o aluno não está a olhar para
  // a página, para dar por a vaga ter aparecido.
  useEffect(() => {
    if (!ofertaVagaHoje) return;

    const tituloOriginal = document.title;
    let mostrarAlerta = false;
    let intervalId = null;

    const iniciarPiscar = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        document.title = mostrarAlerta ? tituloOriginal : '🔔 Vaga disponível!';
        mostrarAlerta = !mostrarAlerta;
      }, 1000);
    };
    const pararPiscar = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      document.title = tituloOriginal;
    };

    if (document.hidden) iniciarPiscar();
    const aoMudarVisibilidade = () => { document.hidden ? iniciarPiscar() : pararPiscar(); };
    document.addEventListener('visibilitychange', aoMudarVisibilidade);

    return () => {
      pararPiscar();
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
    };
  }, [ofertaVagaHoje]);

  // Sempre que muda o dia selecionado, ver se estou na fila desse dia
  useEffect(() => {
    if (selectedDate) verificarFila(selectedDate);
  }, [selectedDate, verificarFila]);

  // O mesmo para o painel de fila. Só no dia de hoje repete a cada 30s, porque
  // aí a janela depende de "agora" e pode abrir uma vaga só com o tempo a passar.
  useEffect(() => {
    if (!selectedDate) return;
    verificarPodeEntrarFila(selectedDate);
    if (selectedDate !== hojeISOLisboa()) return;
    const intervalo = setInterval(() => verificarPodeEntrarFila(selectedDate), 30000);
    return () => clearInterval(intervalo);
  }, [selectedDate, verificarPodeEntrarFila, bookedSlots]);

  // Contagem decrescente da vaga pendente (atualiza a cada segundo)
  useEffect(() => {
    if (!minhaVaga.tem_vaga || !minhaVaga.expira_em) { setVagaCountdown(""); return; }

    const atualizar = () => {
      const agora = new Date();

      // O expira_em vem como "YYYY-MM-DD HH:MM:SS" em hora de Lisboa. O Date é
      // montado peça a peça para o JS não ler a string como UTC e desfasar 1 hora.
      const [dataParte, horaParte] = String(minhaVaga.expira_em).split(/[ T]/);
      const [ano, mes, dia] = dataParte.split('-').map(Number);
      const [hh, mm, ss] = (horaParte || '00:00:00').split(':').map(Number);
      const expira = new Date(ano, mes - 1, dia, hh, mm, ss || 0);

      const diff = expira - agora;
      if (diff <= 0) {
        setVagaCountdown("expirada");
        setMinhaVaga({ tem_vaga: false, data: null, expira_em: null });
        return;
      }
      const min = Math.floor(diff / 60000);
      const seg = Math.floor((diff % 60000) / 1000);
      setVagaCountdown(`${min}m ${String(seg).padStart(2, '0')}s`);
    };

    atualizar();
    const intervalo = setInterval(atualizar, 1000);
    return () => clearInterval(intervalo);
  }, [minhaVaga]);

  // Ler ?dia= do URL (link do email) e pré-selecionar essa data
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const diaParam = params.get('dia');
    if (diaParam && /^\d{4}-\d{2}-\d{2}$/.test(diaParam)) {
      setSelectedDate(diaParam);
    }
  }, []);


  // ======================================================
  // MINHAS RESERVAS
  // ======================================================

  const carregarReservas = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/minhas-reservas`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 || response.status === 403) { handleLogout(); return; }
      const data = await response.json();
      setReservas(Array.isArray(data) ? data : []);
    } catch (error) { console.error(error); }
  }, [token]);

  // Reserva o que o backend calcular como livre neste instante, que pode não
  // bater certo com o que o aviso mostrou se entretanto passou tempo, e entra
  // logo no laboratório, como faz o botão do ControloLaboratorio.
  const aceitarVagaTempoReal = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/fila-tempo-real/aceitar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data: hojeISOLisboa() })
      });
      const d = await r.json();
      setOfertaVagaHoje(null);
      if (r.ok && d.token_sessao) {
        verificarFilaHoje();
        carregarReservas();
        const piHost = d.pi_host || '193.136.63.52';
        const piPort = d.pi_port || 5000;
        window.open(
          `http://${piHost}:${piPort}/main?page=terminal&token=${encodeURIComponent(d.token_sessao)}`,
          '_blank',
          'noopener,noreferrer'
        );
      } else {
        setAviso(d.message || t.erroAceitarVaga);
        setAvisoTipo('erro');
        recarregarOcupacaoHoje();
      }
    } catch (e) {
      setOfertaVagaHoje(null);
      setAviso(t.erroAceitarVaga);
      setAvisoTipo('erro');
    }
  }, [token, recarregarOcupacaoHoje, verificarFilaHoje, carregarReservas, t]);

  // Recusar não sai da fila: o backend passa a oferta já ao próximo da ronda,
  // sem esperar pelo T1 dele.
  const recusarVagaTempoReal = useCallback(() => {
    setOfertaVagaHoje(null);
    fetch(`${API_URL}/api/fila-tempo-real/recusar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: hojeISOLisboa() })
    }).catch(() => {});
  }, [token]);

  // ======================================================
  // VERIFICAR SESSÃO
  // ======================================================

  useEffect(() => {
    fetch(`${API_URL}/api/verificar`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.status === 401 || r.status === 403) { handleLogout(); return null; } return r.json(); })
      .then(data => {
        if (!data) return;
        setCreditos(data.user?.creditos ?? creditos);
        localStorage.setItem("user", JSON.stringify({ ...user, ...data.user }));
      })
      .catch(err => console.error(err));

    carregarReservas();
  }, []);

  // ======================================================
  // CARREGAR OCUPAÇÃO DO MÊS (para o calendário)
  // ======================================================

  // Evita repetir pedidos ao navegar para trás e para a frente nos meses.
  const mesesCarregados = useRef(new Set());

  const carregarOcupacaoMes = useCallback(async (ano, mes) => {
    const chaveMs = `${ano}-${mes}`;
    if (mesesCarregados.current.has(chaveMs)) return; // já carregado
    mesesCarregados.current.add(chaveMs);

    const diasParaCarregar = [];
    const hoje = new Date();
    const todayStart = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());

    // Só o mês pedido. O calendário chama isto por cada mês visitado, não é
    // preciso pré-carregar o seguinte.
    const diasNoMes = new Date(ano, mes, 0).getDate();
    for (let d = 1; d <= diasNoMes; d++) {
      const dateStr = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (new Date(dateStr + 'T00:00:00') >= todayStart) diasParaCarregar.push(dateStr);
    }

    if (diasParaCarregar.length === 0) return;

    const newMap = {};
    const chunks = [];
    for (let i = 0; i < diasParaCarregar.length; i += 10) chunks.push(diasParaCarregar.slice(i, i + 10));

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (dateStr) => {
        try {
          const r = await fetch(`${API_URL}/api/ocupados?data=${dateStr}`, { headers: { Authorization: `Bearer ${token}` } });
          if (r.ok) {
            const slots = await r.json();
            newMap[dateStr] = Array.isArray(slots) ? slots.length : 0;
          }
        } catch {}
      }));
    }

    setOccupancyMap(prev => ({ ...prev, ...newMap }));
  }, [token]);

  // ======================================================
  // CANCELAR RESERVA
  // ======================================================

  const cancelarReserva = async (id) => {
    if (!window.confirm(t.confirmCancelar)) return;
    const reservaInfo = reservas.find(r => r.id === id);
    try {
      const response = await fetch(`${API_URL}/api/reserva/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (response.ok) {
        const novosCreditos = Math.min(creditos + data.creditos_devolvidos, 60);
        setCreditos(novosCreditos);
        setAviso('');
        localStorage.setItem("user", JSON.stringify({ ...user, creditos: novosCreditos }));
        carregarReservas();

        if (reservaInfo?.data_reserva) {
          const dataReserva = reservaInfo.data_reserva.split('T')[0];
          const nextDateStr = getNextDateStr(dataReserva);

          fetch(`${API_URL}/api/ocupados?data=${dataReserva}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(slots => {
              if (Array.isArray(slots)) {
                setOccupancyMap(prev => ({ ...prev, [dataReserva]: slots.length }));
                if (dataReserva === selectedDate) setBoostedSlots(slots);
                if (nextDateStr === selectedDate) setBookedSlotsNextDay(slots);
              }
            }).catch(() => {});

          fetch(`${API_URL}/api/ocupados?data=${nextDateStr}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(slots => {
              if (Array.isArray(slots)) {
                setOccupancyMap(prev => ({ ...prev, [nextDateStr]: slots.length }));
                if (nextDateStr === selectedDate) setBookedSlotsNextDay(slots);
              }
            }).catch(() => {});
        }
      } else {
        alert(data.message || t.erroCancelar);
      }
    } catch (error) { alert(t.erroCancelar); }
  };

  // ======================================================
  // HORÁRIOS OCUPADOS (dia selecionado + dia seguinte)
  // ======================================================

  useEffect(() => {
    if (!selectedDate) return;
    const nextDateStr = getNextDateStr(selectedDate);

    Promise.all([
      fetch(`${API_URL}/api/ocupados?data=${selectedDate}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API_URL}/api/ocupados?data=${nextDateStr}`, { headers: { Authorization: `Bearer ${token}` } })
    ])
      .then(async ([resToday, resNext]) => {
        if (resToday.status === 401 || resToday.status === 403) { handleLogout(); return null; }
        const dataToday = await resToday.json();
        const dataNext = resNext.ok ? await resNext.json() : [];
        return { dataToday, dataNext };
      })
      .then(result => {
        if (!result) return;
        setBoostedSlots(Array.isArray(result.dataToday) ? result.dataToday : []);
        setBookedSlotsNextDay(Array.isArray(result.dataNext) ? result.dataNext : []);
        setSelectedTime(null);
        setBookingStatus(null);
        setConfirmedBooking(null);
      })
      .catch(() => { setBoostedSlots([]); setBookedSlotsNextDay([]); });
  }, [selectedDate]);

  // ======================================================
  // GERAR SLOTS
  // ======================================================

  const generateSlots = () => {
    const slots = [];
    const [start, end] = RANGES_PERIODO[selectedPeriod];
    for (let h = start; h < end; h++) {
      const hour = h % 24;
      for (let min = 0; min < 60; min += 10) {
        slots.push(`${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`);
      }
    }
    return slots;
  };

  const timeSlots = generateSlots();

  // Colisão do horário escolhido, com a duração selecionada, com algum slot
  // ocupado. Cada bloco de 10 min pode cair em hoje ou em amanhã.
  const verificarOverlap = (startH, startM) => {
    for (let b = 0; b < selectedDuration / 10; b++) {
      const total = (startH * 60) + startM + (b * 10);
      if (total < 24 * 60) {
        const slot = `${Math.floor(total / 60)}`.padStart(2, '0') + ':' + `${total % 60}`.padStart(2, '0');
        if (bookedSlots.includes(slot)) return true;
      } else {
        const wrapped = total - 24 * 60;
        const slot = `${Math.floor(wrapped / 60)}`.padStart(2, '0') + ':' + `${wrapped % 60}`.padStart(2, '0');
        if (bookedSlotsNextDay.includes(slot)) return true;
      }
    }
    return false;
  };

  // ======================================================
  // FAZER RESERVA
  // ======================================================

  const handleBooking = async () => {
    if (!selectedDate || !selectedTime) {
      alert(t.selecioneDataHora);
      return;
    }
    if (creditos < selectedDuration) {
      setAviso(t.creditosInsuficientesMsg(creditos, selectedDuration));
      setAvisoTipo('erro');
      return;
    }

    const [startH, startM] = selectedTime.split(':').map(Number);
    let endM = startM + selectedDuration;
    let endH = (startH + Math.floor(endM / 60)) % 24;
    endM = endM % 60;
    const endTimeStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}:00`;

    // Com a duração a empurrar o fim para lá da meia-noite (23:50 + 30min), a
    // data mostrada tem de avançar um dia, senão dá a hora certa no dia errado.
    const cruzouMeiaNoite = endH < startH;
    let dataFimStr = selectedDate;
    if (cruzouMeiaNoite) {
      const dataFimObj = new Date(`${selectedDate}T00:00:00`);
      dataFimObj.setDate(dataFimObj.getDate() + 1);
      dataFimStr = `${dataFimObj.getFullYear()}-${String(dataFimObj.getMonth() + 1).padStart(2, '0')}-${String(dataFimObj.getDate()).padStart(2, '0')}`;
    }

    try {
      const response = await fetch(`${API_URL}/api/reservar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          data: selectedDate,
          hora_inicio: selectedTime + ":00",
          hora_fim: endTimeStr,
          posto: 1
        })
      });

      if (response.status === 401 || response.status === 403) { handleLogout(); return; }

      if (response.ok) {
        const novosCreditos = Math.max(0, creditos - selectedDuration);
        setCreditos(novosCreditos);
        localStorage.setItem("user", JSON.stringify({ ...user, creditos: novosCreditos }));

        setBookingStatus('success');
        setConfirmedBooking({
          date: selectedDate,
          startTime: selectedTime,
          endTime: endTimeStr,
          duration: selectedDuration
        });
        setAviso(t.proximaReservaDisponivel(endTimeStr.slice(0, 5), dataFimStr));
        setAvisoTipo('info');

        // Atualizar slots localmente, respeitando a que dia cada bloco pertence
        const novosBlocosHoje = [...bookedSlots];
        const novosBlocosAmanha = [...bookedSlotsNextDay];
        let blocosHoje = 0, blocosAmanha = 0;

        for (let b = 0; b < selectedDuration / 10; b++) {
          const total = (startH * 60) + startM + (b * 10);
          if (total < 24 * 60) {
            novosBlocosHoje.push(`${Math.floor(total / 60)}`.padStart(2, '0') + ':' + `${total % 60}`.padStart(2, '0'));
            blocosHoje++;
          } else {
            const wrapped = total - 24 * 60;
            novosBlocosAmanha.push(`${Math.floor(wrapped / 60)}`.padStart(2, '0') + ':' + `${wrapped % 60}`.padStart(2, '0'));
            blocosAmanha++;
          }
        }
        setBoostedSlots(novosBlocosHoje);
        setBookedSlotsNextDay(novosBlocosAmanha);

        const nextDateStr = getNextDateStr(selectedDate);
        setOccupancyMap(prev => ({
          ...prev,
          [selectedDate]: (prev[selectedDate] || 0) + blocosHoje,
          ...(blocosAmanha > 0 ? { [nextDateStr]: (prev[nextDateStr] || 0) + blocosAmanha } : {})
        }));

        setSelectedTime(null);
        carregarReservas();

        // Se esta reserva usou a minha vaga pendente, atualizar (o banner desaparece)
        verificarMinhaVaga();
        verificarFila(selectedDate);
        // Marcando para hoje, o backend já me tirou da fila de hoje. Atualizar
        // aqui faz o banner desaparecer logo, sem esperar por um refresh.
        if (selectedDate === hojeISOLisboa()) {
          setOfertaVagaHoje(null);
          verificarFilaHoje();
        }

      } else {
        const errorData = await response.json().catch(() => ({}));
        setAviso(errorData.message || t.erroGravar);
        setAvisoTipo('erro');
      }
    } catch (error) {
      alert(t.servidorDesligado);
    }
  };

  // ======================================================
  // ADICIONAR AO OUTLOOK (opcional, só quando o aluno clica)
  // ======================================================

  const abrirLinkOutlook = ({ date, horaInicio, horaFim, duracaoMin }) => {
    const subject = encodeURIComponent(t.outlookAssunto);
    const body = encodeURIComponent(t.outlookDuracao(duracaoMin));
    window.open(
      `https://outlook.office.com/calendar/0/deeplink/compose?subject=${subject}&body=${body}&startdt=${date}T${horaInicio}&enddt=${date}T${horaFim}`,
      '_blank'
    );
  };

  const handleAdicionarOutlook = () => {
    if (!confirmedBooking) return;
    const { date, startTime, endTime, duration } = confirmedBooking;
    abrirLinkOutlook({ date, horaInicio: `${startTime}:00`, horaFim: endTime, duracaoMin: duration });
  };

  // ======================================================
  // RENDER
  // ======================================================

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans text-slate-900">
      <div className="max-w-6xl mx-auto">

        {/* HEADER */}
        <header className="mb-8 border-b pb-4 flex justify-between items-center flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-indigo-900 uppercase tracking-tight">
              ISEP - Engenharia do Porto
            </h1>
            <p className="text-slate-500 font-medium">
              {t.subtitle(user?.nome || user?.username)}
            </p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-bold">
              <button
                onClick={() => setLang('pt')}
                className={`px-3 py-2 transition-all ${lang === 'pt' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
              >
                PT
              </button>
              <button
                onClick={() => setLang('en')}
                className={`px-3 py-2 transition-all ${lang === 'en' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
              >
                EN
              </button>
            </div>
            <div className="bg-indigo-50 border border-indigo-200 px-4 py-2 rounded-xl text-center">
              <p className="text-xs text-slate-500">{t.creditos}</p>
              <p className={`text-xl font-black ${creditos < 10 ? 'text-red-600' : 'text-indigo-700'}`}>{creditos}</p>
              <p className="text-[10px] text-slate-400">{t.creditosRenovam}</p>
            </div>
            <button
              onClick={() => { carregarReservas(); setShowReservations(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-bold shadow-md transition-all"
            >
              {t.minhasReservas}
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-xl font-bold shadow-md transition-all"
            >
              <LogOut size={18} /> {t.logout}
            </button>
          </div>
        </header>

        {/* AVISO */}
        {aviso && (
          <div className={`mb-6 p-4 rounded-xl flex items-start gap-3 text-sm font-medium ${
            avisoTipo === 'erro' ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-amber-50 border border-amber-200 text-amber-800'
          }`}>
            {avisoTipo === 'erro' ? <AlertCircle size={18} className="mt-0.5 shrink-0" /> : <Info size={18} className="mt-0.5 shrink-0" />}
            <span>{aviso}</span>
          </div>
        )}

        {/* BANNER DE VAGA PENDENTE (dia trancado para mim pela fila de espera) */}
        {minhaVaga.tem_vaga && minhaVaga.data && (
          <div className="mb-6 p-5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-lg flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-start gap-3">
              <span className="text-3xl">🎉</span>
              <div>
                <p className="font-black text-lg">{t.vagaTitulo}</p>
                <p className="text-sm text-indigo-100">
                  {t.vagaDescricao(new Date(minhaVaga.data + 'T00:00:00').toLocaleDateString(t.locale, { weekday: 'long', day: 'numeric', month: 'long' }))}
                </p>
                <p className="text-xs text-indigo-200 mt-1">
                  {t.vagaTempo} <strong className="text-white font-mono">{vagaCountdown}</strong>
                </p>
              </div>
            </div>
            <button
              onClick={() => { setSelectedDate(minhaVaga.data); setSelectedTime(null); }}
              className="bg-white text-indigo-700 hover:bg-indigo-50 px-5 py-2.5 rounded-xl font-bold shadow-md transition-all whitespace-nowrap"
            >
              {t.vagaBotao}
            </button>
          </div>
        )}

        {/* BANNER PERSISTENTE DA FILA DE HOJE — fica visível independentemente
            do dia que o aluno estiver a ver no calendário, para não parecer
            que "desapareceu" da fila só por ter navegado para outro dia. */}
        {filaHojeEstado.na_fila && (
          <div className="mb-6 p-5 rounded-xl bg-white border-2 border-indigo-200 shadow-sm">
            {ofertaVagaHoje ? (
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <p className="font-black text-emerald-700">{t.ofertaVagaTitulo}</p>
                  <p className="text-sm text-emerald-600">
                    {t.ofertaVagaDescricao(ofertaVagaHoje.hora_inicio, ofertaVagaHoje.hora_fim, ofertaVagaHoje.duracao_min)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={recusarVagaTempoReal}
                    className="border-2 border-slate-200 text-slate-500 hover:bg-slate-100 px-4 py-2.5 rounded-xl font-bold text-sm transition-all whitespace-nowrap"
                  >
                    {t.ofertaVagaNao}
                  </button>
                  <button
                    onClick={aceitarVagaTempoReal}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl font-bold shadow-md transition-all whitespace-nowrap"
                  >
                    {t.ofertaVagaSim}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <p className="font-bold text-indigo-800">{t.naFilaTituloTempoReal}</p>
                  <p className="text-xs text-indigo-600">{t.naFilaPosicaoTempoReal(filaHojeEstado.posicao, filaHojeEstado.total)}</p>
                </div>
                <button
                  onClick={() => sairDaFila(hojeISOLisboa())}
                  disabled={filaLoading}
                  className="border-2 border-red-200 text-red-600 hover:bg-red-500 hover:text-white px-4 py-2 rounded-xl font-bold text-sm transition-all disabled:opacity-50 whitespace-nowrap"
                >
                  {filaLoading ? t.aProcessar : t.sairDaFila}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* COLUNA 1 — Duração + Calendário */}
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-bold mb-4 flex items-center text-indigo-700">
                <Timer className="mr-2" size={20}/> {t.duracaoTitulo}
              </h2>
              <div className="grid grid-cols-3 gap-2">
                {durations.map(d => (
                  <button key={d}
                    onClick={() => { setSelectedDuration(d); setSelectedTime(null); }}
                    className={`p-3 rounded-lg border-2 font-bold transition-all ${
                      selectedDuration === d
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                        : 'bg-slate-50 border-slate-100 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {d} min
                  </button>
                ))}
              </div>
              {creditos < selectedDuration && (
                <p className="mt-3 text-xs text-red-500 font-semibold flex items-center gap-1">
                  <AlertCircle size={12} /> {t.creditosInsuficientesDuracao}
                </p>
              )}
            </div>

            <div>
              <h2 className="text-lg font-bold mb-3 flex items-center text-indigo-700 px-1">
                <span className="mr-2">📅</span> {t.dataTitulo}
              </h2>
              <Calendario
                selectedDate={selectedDate}
                onSelectDate={(date) => { setSelectedDate(date); setSelectedTime(null); setBookingStatus(null); setConfirmedBooking(null); }}
                occupancyMap={occupancyMap}
                onMonthView={carregarOcupacaoMes}
                t={t}
              />

              {/* PAINEL DA FILA DE ESPERA — a decisão de mostrar isto vem
                  sempre do backend (/api/fila/pode-entrar), a mesma lógica
                  usada para aceitar ou recusar o pedido de entrar na fila;
                  nunca recalculada aqui, para nunca voltar a divergir. */}
              {selectedDate && filaVisibilidade.mostrar_fila && (
                <div className="mt-4 bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block"/>
                    <p className="text-sm font-bold text-slate-700">
                      {selectedDate === hojeISOLisboa() ? t.semVagaAgora : t.diaCheio}
                    </p>
                  </div>

                  {filaEstado.na_fila ? (
                    selectedDate === hojeISOLisboa() ? (
                      // Não repetir: isto já aparece no banner do topo.
                      <p className="text-xs text-indigo-500 italic">{t.verBannerTopo}</p>
                    ) : (
                      <>
                        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-3">
                          <p className="text-sm text-indigo-800 font-semibold">{t.naFilaTitulo}</p>
                          <p className="text-xs text-indigo-600 mt-1">
                            {t.naFilaPosicao(filaEstado.posicao, filaEstado.total)}
                          </p>
                        </div>
                        <button
                          onClick={() => sairDaFila()}
                          disabled={filaLoading}
                          className="w-full py-2.5 rounded-lg border-2 border-red-200 text-red-600 hover:bg-red-500 hover:text-white font-bold text-sm transition-all disabled:opacity-50"
                        >
                          {filaLoading ? t.aProcessar : t.sairDaFila}
                        </button>
                      </>
                    )
                  ) : (
                    <>
                      <p className="text-xs text-slate-500 mb-3">
                        {selectedDate === hojeISOLisboa() ? t.entrarFilaDescricaoHoje : t.entrarFilaDescricao}
                      </p>
                      <button
                        onClick={entrarNaFila}
                        disabled={filaLoading}
                        className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm transition-all shadow-md disabled:opacity-50"
                      >
                        {filaLoading ? t.aProcessar : t.entrarNaFila}
                      </button>
                      {filaEstado.total > 0 && (
                        <p className="text-[11px] text-slate-400 text-center mt-2">
                          {t.pessoasNaFila(filaEstado.total)}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* COLUNA 2 — Horário */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-bold mb-4 flex items-center text-indigo-700">
              <Clock className="mr-2" size={20}/> {t.horarioTitulo}
            </h2>

            <div className="flex border rounded-lg mb-4 overflow-hidden shadow-sm">
              {[
                { id: "madrugada", label: t.madrugada, Icon: MoonStar },
                { id: "manha", label: t.manha, Icon: Sun },
                { id: "tarde", label: t.tarde, Icon: Sunset },
                { id: "noite", label: t.noite, Icon: Moon },
              ].map(({ id, label, Icon }) => (
                <button key={id}
                  onClick={() => { setSelectedPeriod(id); setSelectedTime(null); }}
                  className={`flex-1 py-3 flex flex-col items-center text-[10px] font-bold transition-colors ${
                    selectedPeriod === id ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <Icon size={16} className="mb-1"/> {label}
                </button>
              ))}
            </div>

            {!selectedDate ? (
              <div className="text-center py-20 text-slate-300">
                <p className="text-sm italic">{t.selecioneData}</p>
              </div>
            ) : (() => {
                // Só mostra horários que realmente cabem com a duração escolhida.
                // A própria reserva do utilizador mantém-se visível (informativo).
                const ehReservaPropria = (startH, startM) => {
                  const slotMin = startH * 60 + startM;
                  return reservas.find(r => {
                    if (r.estado !== 'ativa') return false;
                    const dataR = r.data_reserva?.split('T')[0];
                    const [hI, mI] = r.hora_inicio.split(':').map(Number);
                    const [hF, mF] = r.hora_fim.split(':').map(Number);
                    const inicioMin = hI * 60 + mI;
                    const fimMin = hF * 60 + mF;
                    const cruzaMeiaNoite = fimMin <= inicioMin;

                    if (dataR === selectedDate) {
                      // Parte da reserva que fica no próprio dia em que começou
                      if (cruzaMeiaNoite) return slotMin >= inicioMin && slotMin < 24 * 60;
                      return slotMin >= inicioMin && slotMin < fimMin;
                    }

                    if (cruzaMeiaNoite && getNextDateStr(dataR) === selectedDate) {
                      // Parte da reserva que "derrama" para o dia seguinte
                      return slotMin < fimMin;
                    }

                    return false;
                  });
                };

                // Esconde os horários que já passaram. Todos pertencem ao
                // selectedDate, incluindo os da madrugada (00:00-05:50) do
                // período noite: é assim que o backend os grava, e o dia só
                // avança quando a duração empurra o fim para lá da meia-noite.
                const agoraLisboa = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));

                const slotsVisiveis = timeSlots.filter((time) => {
                  const [startH, startM] = time.split(':').map(Number);
                  if (ehReservaPropria(startH, startM)) return true;

                  if (selectedDate) {
                    const instanteSlot = new Date(`${selectedDate}T00:00:00`);
                    instanteSlot.setHours(startH, startM, 0, 0);
                    if (instanteSlot <= agoraLisboa) return false;
                  }

                  return !verificarOverlap(startH, startM);
                });

                if (slotsVisiveis.length === 0) {
                  return (
                    <div className="text-center py-16 text-slate-300 border-2 border-dashed border-slate-100 rounded-xl">
                      <p className="text-sm italic">{t.semHorarios(selectedDuration)}</p>
                      <p className="text-xs mt-1">{t.tentaDuracaoMenor}</p>
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-4 gap-2 overflow-y-auto max-h-[400px] pr-2">
                    {slotsVisiveis.map((time) => {
                      const [startH, startM] = time.split(':').map(Number);
                      const reservaAtiva = ehReservaPropria(startH, startM);

                      let cls = "py-2 text-[11px] rounded border font-bold transition-all ";
                      if (reservaAtiva) {
                        cls += "bg-indigo-200 text-indigo-800 border-indigo-300 cursor-not-allowed";
                      } else if (selectedTime === time) {
                        cls += "bg-indigo-600 text-white border-indigo-600 shadow-md scale-105";
                      } else {
                        cls += "bg-white text-slate-600 border-slate-100 hover:border-indigo-300 hover:text-indigo-700";
                      }

                      return (
                        <button key={time}
                          onClick={() => !reservaAtiva && setSelectedTime(time)}
                          disabled={!!reservaAtiva}
                          className={cls}
                          title={reservaAtiva ? t.tuaReserva : ''}
                        >
                          {time}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}

            {selectedDate && (
              <div className="mt-3 pt-3 border-t border-slate-100 flex gap-4 text-[10px] text-slate-500 flex-wrap">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-indigo-200 inline-block"/> {t.tuaReserva}</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-white border border-slate-200 inline-block"/> {t.livre}</span>
                <span className="text-slate-400 italic">{t.horariosImpossiveis}</span>
              </div>
            )}
          </div>

          {/* COLUNA 3 — Confirmação */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-lg font-bold mb-4 flex items-center text-indigo-700">
              <CheckCircle className="mr-2" size={20}/> {t.finalizarTitulo}
            </h2>

            {bookingStatus === 'success' && confirmedBooking ? (
              <div className="space-y-4">
                <div className="mt-4 p-4 bg-emerald-100 rounded-xl text-center shadow-inner border-2 border-emerald-400">
                  <p className="text-emerald-900 text-[10px] font-black uppercase flex justify-center items-center mb-2">
                    <CheckCircle size={12} className="mr-1"/> {t.reservaConfirmada}
                  </p>
                  <p className="text-emerald-900 text-sm">{t.acessoFeitoDescricao}</p>
                </div>

                <button onClick={handleAdicionarOutlook}
                  className="w-full py-3 rounded-xl font-bold border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50 transition-all"
                >
                  {t.adicionarOutlook}
                </button>
              </div>
            ) : selectedDate && selectedTime ? (
              <div className="space-y-4">
                <div className="p-5 bg-indigo-900 text-white rounded-2xl shadow-xl relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-10"><Clock size={80}/></div>
                  <p className="text-[10px] opacity-70 uppercase tracking-widest font-bold mb-3">{t.ticketAcesso}</p>
                  <div><p className="text-xs opacity-80">{t.data}</p><p className="font-mono font-bold">{selectedDate}</p></div>
                  <div className="mt-4"><p className="text-xs opacity-80">{t.horaInicio}</p><p className="font-mono text-3xl font-black">{selectedTime}</p></div>
                  <p className="text-[10px] bg-indigo-800 inline-block px-2 py-1 rounded mt-4">{t.sessaoDeMinutos(selectedDuration)}</p>
                  <p className="text-[10px] opacity-50 mt-2">{t.creditosAposReserva(Math.max(0, creditos - selectedDuration))}</p>
                </div>

                <button onClick={handleBooking} disabled={creditos < selectedDuration}
                  className={`w-full py-4 rounded-xl font-black shadow-lg active:scale-95 transition-all uppercase tracking-wider ${
                    creditos < selectedDuration ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {creditos < selectedDuration ? t.creditosInsuficientes : t.confirmarMarcacao}
                </button>
              </div>
            ) : (
              <div className="text-center py-20 text-slate-300 border-2 border-dashed border-slate-100 rounded-2xl">
                <p className="text-sm italic">{t.completePassos}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MODAL MINHAS RESERVAS */}
      {showReservations && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-indigo-700">{t.asMinhasReservas}</h2>
              <button onClick={() => setShowReservations(false)}
                className="text-slate-400 hover:text-slate-700 text-2xl font-bold leading-none">✕</button>
            </div>

            {reservas.length === 0 ? (
              <p className="text-slate-400 text-center py-12 italic">{t.nenhumaReserva}</p>
            ) : reservas.map((reserva) => {
              const isAtiva = reserva.estado === 'ativa';
              const dataReservaStr = reserva.data_reserva?.split('T')[0];
              const [hI, mI] = (reserva.hora_inicio || '00:00').split(':').map(Number);
              const [hF, mF] = (reserva.hora_fim || '00:00').split(':').map(Number);
              // Comparar o horário completo em minutos, não só a hora
              // (ex: "23:50" -> "23:30" tem a mesma hora mas cruza a meia-noite)
              const cruzaMeiaNoite = (hF * 60 + mF) < (hI * 60 + mI);
              const dataFimObj = new Date(`${dataReservaStr}T${reserva.hora_fim?.slice(0,5)}:00`);
              if (cruzaMeiaNoite) dataFimObj.setDate(dataFimObj.getDate() + 1);
              const dataPassada = dataFimObj < new Date();
              let duracaoMin = (hF * 60 + mF) - (hI * 60 + mI);
              if (cruzaMeiaNoite) duracaoMin += 24 * 60;

              return (
                <div key={reserva.id}
                  className={`border rounded-xl p-4 mb-4 ${!isAtiva || dataPassada ? 'opacity-50' : ''}`}>
                  <div className="flex justify-between items-start flex-wrap gap-2">
                    <div>
                      <p className="font-bold text-slate-800">
                        {new Date(reserva.data_reserva).toLocaleDateString(t.locale, {
                          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
                        })}
                      </p>
                      <p className="text-slate-600 text-sm">
                        {reserva.hora_inicio?.slice(0, 5)} → {reserva.hora_fim?.slice(0, 5)}
                      </p>
                    </div>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full self-start ${
                      isAtiva && !dataPassada ? 'bg-green-100 text-green-700'
                      : reserva.estado === 'cancelada' ? 'bg-red-100 text-red-700'
                      : 'bg-slate-100 text-slate-500'
                    }`}>
                      {isAtiva && dataPassada ? t.expirada : (t.estados[reserva.estado] || reserva.estado)}
                    </span>
                  </div>

                  {isAtiva && !dataPassada && (
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => cancelarReserva(reserva.id)}
                        className="mt-3 bg-red-50 hover:bg-red-500 hover:text-white text-red-600 border border-red-200 px-4 py-2 rounded-lg font-bold text-sm transition-all">
                        {t.cancelarReserva}
                      </button>
                      <button onClick={() => abrirLinkOutlook({
                          date: dataReservaStr,
                          horaInicio: reserva.hora_inicio,
                          horaFim: reserva.hora_fim,
                          duracaoMin
                        })}
                        className="mt-3 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-600 border border-indigo-200 px-4 py-2 rounded-lg font-bold text-sm transition-all">
                        {t.adicionarOutlook}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default LabScheduling;