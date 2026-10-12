# MICMIC Lab — Laboratório Remoto

Projeto PESTA (ISEP, Departamento de Engenharia Eletrotécnica). Plataforma web que permite a alunos reservar e controlar remotamente uma bancada de laboratório com um microcontrolador ATmega, através de um Raspberry Pi.

## Estrutura

| Pasta | O que é | Tecnologias |
|---|---|---|
| `backend/` | API, autenticação, reservas e envio de emails | Node.js, Express, MySQL, JWT |
| `frontend/` | Interface web: agendamento, controlo da bancada e painel de administração | React |
| `raspberry-pi/` | Servidor que corre no Raspberry Pi e atua sobre o hardware | Python, Flask |
| `docs/` | Relatório, poster, apresentação e enunciado | |

O servidor do Raspberry Pi programa o microcontrolador com o `avrdude`, controla entradas e saídas através de um expansor MCP23008 e de um DAC MCP4725, comunica por porta série e transmite a imagem da câmara.

## Configuração

Cada componente lê as suas credenciais de variáveis de ambiente. Em cada pasta há um `.env.example` com os nomes das variáveis; copia-o para `.env` e preenche os valores.

```bash
cp backend/.env.example backend/.env
```

Os segredos `PI_ADMIN_SECRET` e `PI_SESSION_SECRET` têm de ser iguais no backend e no Raspberry Pi.

## Executar

Backend:

```bash
cd backend
npm install
npm start
```

Frontend:

```bash
cd frontend
npm install
npm start
```

Raspberry Pi. O `main.py` não carrega o `.env` sozinho, por isso as duas variáveis têm de estar definidas no ambiente antes de arrancar:

```bash
cd raspberry-pi
export PI_ADMIN_SECRET=...
export PI_SESSION_SECRET=...
python3 main.py
```
