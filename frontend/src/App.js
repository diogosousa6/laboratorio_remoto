import React, { useState, useEffect } from 'react';
import LabScheduling from './lab_sche';
import AdminPanel from './admin_panel';
import ControloLaboratorio from './ControloLaboratorio';

// ======================================================
// CONFIG
// ======================================================
// Lido do .env no momento do build. O literal fica como recurso, para a
// aplicação não partir caso a variável falte.
const API_URL = process.env.REACT_APP_API_URL || 'https://www.ave.dee.isep.ipp.pt/DEE/micmic-lab';
const DEE_LOGIN_URL = process.env.REACT_APP_DEE_LOGIN_URL || 'https://www.ave.dee.isep.ipp.pt/DEE/auth/login.php';

// ======================================================
// ECRÃ DE LOGIN (redireciona para DEE)
// ======================================================

const LoginScreen = () => {
  const handleLogin = () => {
    // O DEE redireciona de volta para esta página com ?auth_jwt=...
    const callbackUrl = encodeURIComponent(window.location.origin + window.location.pathname);
    window.location.href = `${DEE_LOGIN_URL}?requester=${callbackUrl}`;
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0f172a', fontFamily: "'IBM Plex Mono', monospace"
    }}>
      <div style={{
        background: '#1e293b', border: '1px solid #334155',
        borderRadius: 20, padding: 48, textAlign: 'center', maxWidth: 400, width: '90%'
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🔬</div>
        <h1 style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 900, margin: '0 0 8px 0', letterSpacing: '-0.02em' }}>
          MICMIC Lab
        </h1>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 32 }}>
          Laboratório Remoto — ISEP
        </p>
        <button
          onClick={handleLogin}
          style={{
            width: '100%', padding: '14px 24px',
            background: '#4f46e5', color: '#fff', border: 'none',
            borderRadius: 12, fontSize: 14, fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit',
            letterSpacing: '0.05em'
          }}
        >
          Entrar com credenciais DEE →
        </button>
        <p style={{ color: '#334155', fontSize: 11, marginTop: 20 }}>
          Autenticação via sistema institucional do ISEP
        </p>
      </div>
    </div>
  );
};

// ======================================================
// APP PRINCIPAL
// ======================================================

const App = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Verificar se voltou do DEE com ?auth_jwt=...
    const params = new URLSearchParams(window.location.search);
    const deeJwt = params.get('auth_jwt') || params.get('jwt');

    if (deeJwt) {
      // Limpar o JWT da URL sem reload
      window.history.replaceState({}, '', window.location.pathname);
      processarJwtDEE(deeJwt);
      return;
    }

    // 2. Verificar sessão local existente
    const token = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');

    if (token && savedUser) {
      // Validar token no servidor
      fetch(`${API_URL}/api/verificar`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          setUser({ ...JSON.parse(savedUser), ...data.user });
        })
        .catch(() => {
          localStorage.clear();
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const processarJwtDEE = async (deeJwt) => {
    try {
      const r = await fetch(`${API_URL}/api/auth/dee/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_jwt: deeJwt })
      });

      if (!r.ok) throw new Error('Falha na autenticação');

      const data = await r.json();

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      setUser(data.user);
    } catch (e) {
      console.error('Erro DEE auth:', e);
      alert('Erro de autenticação. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: '#0f172a',
        color: '#64748b', fontFamily: 'monospace', fontSize: 14
      }}>
        A verificar sessão...
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  // Redirecionar admin para o painel
  if (user.role === 'admin') return <AdminPanel />;

  // ======================================================
  // Utilizador normal — agendamento + painel de controlo abaixo
  // ======================================================
  return (
    <div style={{ background: '#0f172a', minHeight: '100vh', color: '#fff', paddingBottom: '40px' }}>
      {/* CALENDÁRIO */}
      <LabScheduling user={user} token={localStorage.getItem('token')} API_URL={API_URL} />

      {/* RELÓGIO E ACESSO AO LABORATÓRIO */}
      <ControloLaboratorio
        user={user} 
        token={localStorage.getItem('token')} 
        API_URL={API_URL}
        carregarReservas={() => window.location.reload()} 
      />
    </div>
  );
};

export default App;
