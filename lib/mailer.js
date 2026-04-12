'use strict';

/**
 * Email service — Gmail REST API via OAuth2 (HTTPS port 443, NOT SMTP).
 *
 * Railway blocks outbound SMTP (ports 587/465). This module uses the Gmail API
 * which communicates exclusively over HTTPS port 443.
 *
 * Required env vars:
 *   GMAIL_USER            — Gmail address (e.g. recantodoipes@gmail.com)
 *   GOOGLE_CLIENT_ID      — Google Cloud OAuth2 client ID
 *   GOOGLE_CLIENT_SECRET  — Google Cloud OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN   — Offline refresh token with gmail.send scope
 */

const { google } = require('googleapis');

function getGmailClient() {
  const missing = ['GMAIL_USER', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
    .filter(k => !process.env[k]);

  if (missing.length) {
    throw new Error(`[mailer] Missing env vars: ${missing.join(', ')}`);
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );

  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  return google.gmail({ version: 'v1', auth });
}

/**
 * RFC 2047-encodes a display name in an email address if it contains non-ASCII chars.
 * e.g. `"Sítio Recanto dos Ipês" <foo@bar.com>` → `=?UTF-8?B?...?= <foo@bar.com>`
 */
function encodeRFC2047Address(addr) {
  const match = addr.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (!match) return addr;
  const [, name, email] = match;
  if (!/[^\x00-\x7F]/.test(name)) return addr; // pure ASCII — no encoding needed
  return `=?UTF-8?B?${Buffer.from(name.trim()).toString('base64')}?= <${email}>`;
}

/**
 * Encodes an email message in base64url (required by Gmail API).
 * Builds a minimal RFC 2822 message with UTF-8 support.
 */
function buildRawEmail({ from, to, subject, html, text }) {
  const boundary = `boundary_${Date.now()}`;
  const lines = [
    `From: ${encodeRFC2047Address(from)}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || '').toString('base64'),
    '',
    `--${boundary}--`,
  ];

  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendMail({ from, to, subject, html, text }) {
  const gmail = getGmailClient();
  const raw = buildRawEmail({ from, to, subject, html, text });
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

// ── Shared FROM address ───────────────────────────────────────────────────────
const FROM_RECANTO = () => `"Sítio Recanto dos Ipês" <${process.env.GMAIL_USER}>`;
const FROM_RECANTOS = () => `"Recantos da Serra" <${process.env.GMAIL_USER}>`;

// ── Email templates ───────────────────────────────────────────────────────────

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

  await sendMail({
    from:    FROM_RECANTO(),
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

  await sendMail({
    from:    FROM_RECANTO(),
    to:      booking.guestEmail,
    subject: `Reserva confirmada — ${checkIn.split(',')[1]?.trim() || checkIn}`,
    html,
    text: `Olá, ${booking.guestName}!\n\nSua reserva foi confirmada.\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\nTotal: ${total}\nReserva nº: ${booking.invoiceNumber}`,
  });
}

/**
 * Sends a staff invite email with a one-time setup link.
 * Link expires in 24 hours.
 */
async function sendStaffInvite({ to, name, inviteUrl }) {
  const firstName = name.split(' ')[0];

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
                Recantos da Serra
              </p>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">
                Central da Equipe
              </p>
            </td></tr>

            <!-- Body -->
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 12px;color:#1A1A1A;font-size:16px;">Olá, <strong>${firstName}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Você foi convidado(a) para acessar a <strong>Central da Equipe</strong> dos Recantos da Serra.
                Clique no botão abaixo para criar sua senha e ativar seu acesso.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr><td style="background:#261C15;border-radius:10px;padding:14px 32px;text-align:center;">
                  <a href="${inviteUrl}" style="color:#C5D86D;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.2px;">
                    Criar minha senha
                  </a>
                </td></tr>
              </table>

              <p style="margin:0 0 8px;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Ou copie e cole o link abaixo no seu navegador:
              </p>
              <p style="margin:0 0 28px;color:#6B6B6B;font-size:11px;word-break:break-all;font-family:monospace;">
                ${inviteUrl}
              </p>

              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Este link expira em <strong>24 horas</strong> e pode ser usado uma única vez.<br>
                Se você não esperava receber este e-mail, pode ignorá-lo com segurança.
              </p>
            </td></tr>

            <!-- Footer -->
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Recantos da Serra · Jaboticatubas, MG
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await sendMail({
    from:    FROM_RECANTOS(),
    to,
    subject: 'Convite para a Central da Equipe — Recantos da Serra',
    html,
    text: `Olá, ${firstName}!\n\nVocê foi convidado(a) para acessar a Central da Equipe dos Recantos da Serra.\n\nCrie sua senha acessando o link abaixo (válido por 24 horas):\n${inviteUrl}\n\nSe você não esperava receber este e-mail, pode ignorá-lo.`,
  });
}

/**
 * Sends a co-guest invitation email.
 * Called when a main guest invites a companion to their reservation.
 */
async function sendGuestInvite({ to, name, hostName, checkIn, checkOut, inviteUrl }) {
  const firstName = name.split(' ')[0];

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
              <p style="margin:0 0 12px;color:#1A1A1A;font-size:16px;">Olá, <strong>${firstName}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                <strong>${hostName}</strong> te convidou para uma estadia no Sítio Recanto dos Ipês.
              </p>

              <!-- Dates box -->
              <div style="background:#F7F7F2;border-radius:12px;padding:20px;margin-bottom:28px;">
                <table width="100%" cellpadding="6">
                  <tr>
                    <td style="color:#6B6B6B;font-size:13px;">Check-in</td>
                    <td style="color:#261C15;font-weight:600;font-size:13px;">${checkIn}</td>
                  </tr>
                  <tr>
                    <td style="color:#6B6B6B;font-size:13px;">Check-out</td>
                    <td style="color:#261C15;font-weight:600;font-size:13px;">${checkOut}</td>
                  </tr>
                </table>
              </div>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr><td style="background:#261C15;border-radius:10px;padding:14px 32px;text-align:center;">
                  <a href="${inviteUrl}" style="color:#C5D86D;font-size:15px;font-weight:700;text-decoration:none;">
                    Confirmar presença
                  </a>
                </td></tr>
              </table>

              <p style="margin:0 0 8px;color:#9A9A9A;font-size:12px;">Ou copie o link:</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:11px;word-break:break-all;font-family:monospace;">${inviteUrl}</p>

              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Este link expira em <strong>72 horas</strong>.<br>
                Se você não esperava este e-mail, pode ignorá-lo.
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

  await sendMail({
    from:    FROM_RECANTO(),
    to,
    subject: `Você foi convidado para uma estadia — Recanto dos Ipês`,
    html,
    text: `Olá, ${firstName}!\n\n${hostName} te convidou para uma estadia no Sítio Recanto dos Ipês.\n\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\n\nConfirme sua presença:\n${inviteUrl}\n\nLink válido por 72 horas.`,
  });
}

/**
 * Sends a plain-text notification email to the admin inbox (GMAIL_USER).
 * Used for staff password recovery requests and access requests.
 */
async function sendAdminNotification({ subject, text }) {
  await sendMail({
    from:    FROM_RECANTOS(),
    to:      process.env.GMAIL_USER,
    subject,
    html:    `<pre style="font-family:sans-serif;white-space:pre-wrap;">${text}</pre>`,
    text,
  });
}

/**
 * Sends a password reset link directly to the staff member's email.
 */
async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const firstName = name.split(' ')[0];

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
                Recantos da Serra
              </p>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">
                Central da Equipe
              </p>
            </td></tr>

            <!-- Body -->
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 12px;color:#1A1A1A;font-size:16px;">Olá, <strong>${firstName}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Recebemos uma solicitação para redefinir a senha da sua conta na
                <strong>Central da Equipe</strong>. Clique no botão abaixo para criar uma nova senha.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr><td style="background:#261C15;border-radius:10px;padding:14px 32px;text-align:center;">
                  <a href="${resetUrl}" style="color:#C5D86D;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.2px;">
                    Redefinir minha senha
                  </a>
                </td></tr>
              </table>

              <p style="margin:0 0 8px;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Ou copie e cole o link abaixo no seu navegador:
              </p>
              <p style="margin:0 0 28px;color:#6B6B6B;font-size:11px;word-break:break-all;font-family:monospace;">
                ${resetUrl}
              </p>

              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Este link expira em <strong>1 hora</strong> e pode ser usado uma única vez.<br>
                Se você não solicitou a redefinição, pode ignorar este e-mail com segurança — sua senha não será alterada.
              </p>
            </td></tr>

            <!-- Footer -->
            <tr><td style="background:#F7F7F2;padding:20px 36px;border-top:1px solid #E4E6C3;">
              <p style="margin:0;color:#9A9A9A;font-size:11px;text-align:center;">
                © ${new Date().getFullYear()} Recantos da Serra · Jaboticatubas, MG
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  await sendMail({
    from:    FROM_RECANTOS(),
    to,
    subject: 'Redefinição de senha — Central da Equipe',
    html,
    text: `Olá, ${firstName}!\n\nRecebemos uma solicitação para redefinir sua senha na Central da Equipe dos Recantos da Serra.\n\nAcesse o link abaixo para criar uma nova senha (válido por 1 hora):\n${resetUrl}\n\nSe você não solicitou a redefinição, ignore este e-mail.`,
  });
}

module.exports = { sendOtpEmail, sendBookingConfirmation, sendStaffInvite, sendAdminNotification, sendGuestInvite, sendPasswordResetEmail };
