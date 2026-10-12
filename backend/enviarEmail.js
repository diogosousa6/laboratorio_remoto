// ============================================================
// MÓDULO DE ENVIO DE EMAIL
// ============================================================
const nodemailer = require('nodemailer');

const passLimpa = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: passLimpa
    }
});

// Nunca rebenta o servidor: se falhar, regista no console e resolve a false.
function enviarEmail(para, assunto, html, texto = '') {
    return new Promise((resolve) => {
        if (!process.env.EMAIL_USER || !passLimpa) {
            console.error("[EMAIL] Credenciais em falta no .env — email não enviado.");
            return resolve(false);
        }

        transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: para,
            subject: assunto,
            text: texto || html.replace(/<[^>]*>/g, ''), // fallback: HTML sem tags
            html: html
        }, (err, info) => {
            if (err) {
                console.error(`[EMAIL] Falha ao enviar para ${para}:`, err.message);
                return resolve(false);
            }
            console.log(`[EMAIL] Enviado para ${para} (${info.messageId})`);
            resolve(true);
        });
    });
}

// Email enviado ao 1º da fila quando lhe é atribuída a vaga pendente. O dia
// fica trancado para ele durante 1 hora, até à horaLimite; o horário concreto
// é escolhido por ele no sistema, através do linkMarcar.
function emailVagaLivre(nome, dataFormatada, horaLimite, linkMarcar) {
    const assunto = `🎉 Abriu uma vaga no laboratório — ${dataFormatada}`;
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px;">
            <h2 style="color: #4f46e5; margin-top: 0;">🎉 Abriu uma vaga!</h2>
            <p style="color: #1e293b; font-size: 15px;">Olá ${nome},</p>
            <p style="color: #1e293b; font-size: 15px;">
                Ficou disponível uma vaga no laboratório remoto para o dia
                <strong>${dataFormatada}</strong>, o horário libertado está reservado só para ti.
            </p>
            <div style="background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 16px; margin: 20px 0;">
                <p style="color: #92400e; margin: 0; font-size: 14px;">
                    ⏳ Tens até às <strong>${horaLimite}</strong> (1 hora) para marcares a tua sessão.
                    Passado esse tempo, a vaga passa para a próxima pessoa da fila.
                </p>
            </div>
            <div style="text-align: center; margin: 28px 0;">
                <a href="${linkMarcar}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 15px;">
                    Marcar a minha sessão
                </a>
            </div>
            <p style="color: #64748b; font-size: 13px; text-align: center;">
                O botão leva-te ao sistema já no dia ${dataFormatada}, onde escolhes o horário.
            </p>
            <p style="color: #64748b; font-size: 13px; margin-top: 24px;">
                MICMIC — Laboratório Remoto · ISEP
            </p>
        </div>
    `;
    return { assunto, html };
}

module.exports = { enviarEmail, emailVagaLivre };