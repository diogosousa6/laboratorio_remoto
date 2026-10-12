// Parâmetros de configuração do MICMIC Lab.
//
// Aqui ficam os valores que não são segredos — esses estão no .env — mas que
// também não devem estar espalhados pelo server.js: a lista de administradores,
// os endereços da autenticação do DEE e o endereço público da aplicação.
// Mudar de laboratório ou de servidor passa a ser editar este ficheiro.

const DEE_BASE = 'https://www.ave.dee.isep.ipp.pt/DEE';

module.exports = {
    // Usernames com privilégios de administração
    ADMINS_UC: ['2250002', 'jes'],

    // Autenticação do DEE
    DEE_JWKS_URL: `${DEE_BASE}/auth/.well-known/jwks.json`,
    DEE_LOGIN_URL: `${DEE_BASE}/auth/login.php`,

    // Endereço público da aplicação, usado no redirect do DEE e nos links dos
    // emails. O .env tem precedência, para o ambiente de desenvolvimento.
    APP_URL: process.env.APP_URL || `${DEE_BASE}/micmic-lab`
};
