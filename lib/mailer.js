'use strict';

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  return _transporter;
}

const FROM = () => process.env.EMAIL_FROM || `"Recanto dos Ipês" <${process.env.GMAIL_USER}>`;

/**
 * Sends a 6-digit OTP code to the given email address.
 */
async function sendOtpEmail({ to, code, purpose }) {
  const subject = purpose === 'LINK_BOOKING'
    ? 'Crie sua conta — Recanto dos Ipês'
    : 'Seu código de acesso — Recanto dos Ipês';

  const purposeText = purpose === 'LINK_BOOKING'
    ? 'para criar sua conta e vincular sua reserva'
    : 'para acessar sua conta';

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

            <!-- Header -->
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <p style="margin:0;color:#C5D86D;font-size:22px;font-weight:700;letter-spacing:-0.3px;">
                Sítio Recanto dos Ipês
              </p>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">
                Jaboticatubas, MG · Serra do Cipó
              </p>
            </td></tr>

            <!-- Body -->
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 12px;color:#1A1A1A;font-size:16px;">Olá!</p>
              <p style="margin:0 0 28px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Use o código abaixo ${purposeText}. Válido por <strong>15 minutos</strong>.
              </p>

              <!-- Code box -->
              <div style="background:#F7F7F2;border:2px solid #C5D86D;border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;">
                <p style="margin:0 0 6px;color:#6B6B6B;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Código de verificação</p>
                <p style="margin:0;font-size:42px;font-weight:700;color:#261C15;letter-spacing:12px;">${code}</p>
              </div>

              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Se você não solicitou este código, pode ignorar este e-mail com segurança.
                Nenhuma ação é necessária.
              </p>
            </td></tr>

            <!-- Footer -->
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Sítio Recanto dos Ipês · Jaboticatubas, MG
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await getTransporter().sendMail({
    from:    FROM(),
    to,
    subject,
    html,
    text: `Seu código de acesso ao Recanto dos Ipês: ${code}\n\nVálido por 15 minutos.\n\nSe você não solicitou este código, ignore este e-mail.`,
  });
}

/**
 * Sends a booking confirmation email to the guest.
 */
async function sendBookingConfirmation({ booking }) {
  const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const total    = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(booking.totalAmount));

  const petReminderHtml = (booking.petCount > 0) ? `
  <tr>
    <td style="padding:16px 32px;background:#f9f4ef;border-radius:8px;margin:0 32px;">
      <p style="margin:0;font-size:14px;color:#5a4a3f;line-height:1.6;">
        🐾 <strong>Lembrete sobre seus pets:</strong> Pedimos que os animais sejam mantidos supervisionados
        durante toda a estadia, e que dejetos sejam recolhidos do jardim e áreas comuns.
        Qualquer dúvida, entre em contato via WhatsApp antes da chegada. Obrigado pela compreensão! 🙏
      </p>
    </td>
  </tr>
  <tr><td style="height:16px"></td></tr>
` : '';

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <p style="margin:0;color:#C5D86D;font-size:22px;font-weight:700;">🌿 Reserva Confirmada!</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 20px;color:#1A1A1A;font-size:16px;">Olá, <strong>${booking.guestName}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Sua reserva foi confirmada com sucesso. Estamos ansiosos para recebê-lo(a) no Recanto dos Ipês!
              </p>
              <table width="100%" style="background:#F7F7F2;border-radius:12px;padding:20px;margin-bottom:24px;" cellpadding="8">
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-in</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkIn}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-out</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkOut}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Hóspedes</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.guestCount}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Total pago</td><td style="color:#261C15;font-weight:700;font-size:14px;">${total}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Reserva nº</td><td style="color:#261C15;font-size:12px;font-family:monospace;">${booking.invoiceNumber}</td></tr>
              </table>
              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Em caso de dúvidas, responda a este e-mail ou entre em contato via WhatsApp.
              </p>
            </td></tr>
            ${petReminderHtml}
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Sítio Recanto dos Ipês · Jaboticatubas, MG
              </p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await getTransporter().sendMail({
    from:    FROM(),
    to:      booking.guestEmail,
    subject: `✅ Reserva confirmada — ${checkIn.split(',')[1]?.trim() || checkIn}`,
    html,
  });
}

module.exports = { sendOtpEmail, sendBookingConfirmation };
