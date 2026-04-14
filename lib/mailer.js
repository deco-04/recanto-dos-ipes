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
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
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

  const petReminderHtml = booking.hasPet ? `
  <tr>
    <td style="padding:16px 32px;background:#f9f4ef;border-radius:8px;margin:0 32px;">
      <p style="margin:0;font-size:14px;color:#5a4a3f;line-height:1.6;">
        🐾 <strong>Lembrete sobre seus pets:</strong>${booking.petDescription ? ` ${escHtml(booking.petDescription)}.` : ''} Pedimos que os animais sejam mantidos supervisionados
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
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
              <p style="margin:0;color:#C5D86D;font-size:22px;font-weight:700;">🌿 Reserva Confirmada!</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 20px;color:#1A1A1A;font-size:16px;">Olá, <strong>${escHtml(booking.guestName)}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Sua reserva foi confirmada com sucesso. Estamos ansiosos para recebê-lo(a) no Recanto dos Ipês!
              </p>
              <table width="100%" style="background:#F7F7F2;border-radius:12px;padding:20px;margin-bottom:24px;" cellpadding="8">
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-in</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkIn}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-out</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkOut}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Hóspedes</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.guestCount}</td></tr>
                ${booking.hasPet ? `<tr><td style="color:#6B6B6B;font-size:13px;">Pet</td><td style="color:#261C15;font-weight:600;font-size:13px;">${escHtml(booking.petDescription) || 'Sim'}</td></tr>` : ''}
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
              <img src="https://app.recantosdaserra.com/brand/rds-mark-white.svg" width="72" alt="Recantos da Serra" style="display:block;margin:0 auto 16px;border:0;height:auto;">
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
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
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
              <img src="https://app.recantosdaserra.com/brand/rds-mark-white.svg" width="72" alt="Recantos da Serra" style="display:block;margin:0 auto 16px;border:0;height:auto;">
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

/** Minimal HTML entity escaping for user-supplied strings in email templates. */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates AI-powered solutions and a ready-to-send guest message for checkout
 * problems using Claude. Returns null if ANTHROPIC_API_KEY is not set or if the
 * API call fails — the caller should degrade gracefully.
 *
 * @param {Array<{label: string, observacao: string}>} problemas
 * @param {string} guestName
 * @param {Date|string} checkOut
 * @returns {Promise<{solucoes: string, mensagemHospede: string}|null>}
 */
async function generateProblemaInsights(problemas, guestName, checkOut) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const checkOutFmt = new Date(checkOut).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
  const firstName = guestName.split(' ')[0];
  const problemaList = problemas.map((p, i) => `${i + 1}. ${p.label}: ${p.observacao}`).join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    messages: [{
      role: 'user',
      content: `Você é o assistente de operações do Sítio Recanto dos Ipês, uma pousada em Jaboticatubas, MG (Serra do Cipó).

A vistoria de checkout de "${guestName}" (saída: ${checkOutFmt}) registrou os seguintes problemas:

${problemaList}

Responda com dois blocos separados pela linha "---":

SOLUÇÕES:
Para cada problema numerado, sugira 2–3 ações práticas de manutenção ou reparo. Use marcadores (•). Seja direto e técnico.

---

MENSAGEM PARA O HÓSPEDE:
Escreva uma mensagem cordial em português para enviar via WhatsApp. Comece com "Olá, ${firstName}!". Tom: gentil e profissional, não acusatório. Objetivo: informar que notamos algo durante a vistoria pós-saída, agradecer pela estadia, deixar a porta aberta para o hóspede comentar. Não mencione valores nem cobranças. Máximo 3 parágrafos curtos.`,
    }],
  });

  const content = response.content[0]?.text || '';
  const sepIdx = content.indexOf('---');
  if (sepIdx === -1) return { solucoes: content.trim(), mensagemHospede: '' };

  return {
    solucoes: content.slice(0, sepIdx).replace(/^SOLUÇÕES:\s*/i, '').trim(),
    mensagemHospede: content.slice(sepIdx + 3).replace(/^MENSAGEM PARA O HÓSPEDE:\s*/i, '').trim(),
  };
}

/**
 * Sends a checkout-problema alert email to the admin inbox.
 * Includes full problem details, AI-generated solutions (if Claude key is
 * configured), a ready-to-copy guest WhatsApp message, and a link to the
 * maintenance ticket.
 *
 * @param {{ booking, staffName, problemas, reportId, propertySlug }} opts
 */
async function sendCheckoutProblemaAlert({ booking, staffName, problemas, reportId, propertySlug }) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return; // silently skip if no destination configured

  const checkOutFmt = new Date(booking.checkOut).toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const adminUrl = process.env.STAFF_APP_URL || 'https://app.recantosdaserra.com';

  // AI insights (non-fatal — falls back to template if unavailable)
  let insights = null;
  try {
    insights = await generateProblemaInsights(problemas, booking.guestName, booking.checkOut);
  } catch (err) {
    console.error('[mailer] AI insights error (non-fatal):', err.message);
  }

  // Fallback guest message if AI not available
  const fallbackGuestMsg = `Olá, ${booking.guestName.split(' ')[0]}!\n\nMuito obrigado pela sua estadia no Sítio Recanto dos Ipês! Foi um prazer recebê-lo(a).\n\nDurante a vistoria pós-saída, nossa equipe registrou algumas observações que gostaríamos de compartilhar com você. Ficamos à disposição caso queira conversar sobre qualquer aspecto da sua estadia.\n\nEsperamos vê-lo(a) novamente em breve! 🌿`;

  const guestMessage = insights?.mensagemHospede || fallbackGuestMsg;
  const solucoesText = insights?.solucoes || problemas.map((p, i) =>
    `${i + 1}. ${p.label}:\n   • Verificar o item pessoalmente e avaliar a extensão do problema\n   • Acionar equipe de manutenção se necessário`
  ).join('\n\n');

  // ── Build problem cards HTML ─────────────────────────────────────────────────
  const problemaCardsHtml = problemas.map((p, i) => `
    <tr><td style="padding:0 0 12px;">
      <div style="background:#FFF8F5;border-left:4px solid #C45C2E;border-radius:0 8px 8px 0;padding:14px 16px;">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#C45C2E;text-transform:uppercase;letter-spacing:0.5px;">
          Problema ${i + 1} — ${escHtml(p.label)}
        </p>
        <p style="margin:0;font-size:14px;color:#3D2B1A;line-height:1.5;">${escHtml(p.observacao)}</p>
      </div>
    </td></tr>
  `).join('');

  // ── Build solutions HTML ─────────────────────────────────────────────────────
  // Convert plain text with bullet markers to HTML paragraphs
  const solucoesHtml = solucoesText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.startsWith('•')
      ? `<p style="margin:0 0 6px;color:#5A4A3F;font-size:13px;padding-left:12px;">${line}</p>`
      : `<p style="margin:8px 0 4px;color:#261C15;font-size:13px;font-weight:700;">${line}</p>`)
    .join('');

  // ── Guest message HTML (pre-formatted, dark box) ─────────────────────────────
  const guestMsgHtml = guestMessage
    .split('\n').filter(Boolean)
    .map(p => `<p style="margin:0 0 10px;color:#F5EFE6;font-size:13px;line-height:1.6;">${p}</p>`)
    .join('');

  const aiTag = insights
    ? `<span style="font-size:10px;background:#E8F5E9;color:#2B7929;border-radius:4px;padding:2px 6px;font-weight:600;vertical-align:middle;">✦ Gerado por IA</span>`
    : `<span style="font-size:10px;background:#F5EFE6;color:#9A7355;border-radius:4px;padding:2px 6px;font-weight:600;vertical-align:middle;">Template padrão</span>`;

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#F5EFE6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5EFE6;padding:40px 20px;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

            <!-- Header -->
            <tr><td style="background:#C45C2E;padding:28px 32px;">
              <p style="margin:0 0 4px;color:#FFE4D6;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Vistoria de Checkout</p>
              <p style="margin:0;color:#FFFFFF;font-size:22px;font-weight:700;line-height:1.3;">
                ⚠️ ${problemas.length} problema${problemas.length > 1 ? 's' : ''} registrado${problemas.length > 1 ? 's' : ''}
              </p>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.80);font-size:14px;">${escHtml(booking.guestName)} · ${escHtml(checkOutFmt)}</p>
            </td></tr>

            <!-- Booking summary -->
            <tr><td style="padding:24px 32px 0;">
              <table width="100%" style="background:#F5EFE6;border-radius:10px;padding:16px;" cellpadding="6">
                <tr>
                  <td style="color:#9A7355;font-size:12px;width:120px;">Hóspede</td>
                  <td style="color:#261C15;font-weight:600;font-size:13px;">${escHtml(booking.guestName)}</td>
                </tr>
                <tr>
                  <td style="color:#9A7355;font-size:12px;">Checkout</td>
                  <td style="color:#261C15;font-size:13px;">${escHtml(checkOutFmt)}</td>
                </tr>
                <tr>
                  <td style="color:#9A7355;font-size:12px;">Inspetor</td>
                  <td style="color:#261C15;font-size:13px;">${escHtml(staffName)}</td>
                </tr>
                <tr>
                  <td style="color:#9A7355;font-size:12px;">Problemas</td>
                  <td style="color:#C45C2E;font-weight:700;font-size:13px;">${problemas.length} item${problemas.length > 1 ? 's' : ''}</td>
                </tr>
              </table>
            </td></tr>

            <!-- Problems -->
            <tr><td style="padding:24px 32px 0;">
              <p style="margin:0 0 12px;color:#261C15;font-size:15px;font-weight:700;">Problemas encontrados</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${problemaCardsHtml}
              </table>
            </td></tr>

            <!-- Solutions -->
            <tr><td style="padding:24px 32px 0;">
              <p style="margin:0 0 4px;color:#261C15;font-size:15px;font-weight:700;">
                Soluções possíveis &nbsp;${aiTag}
              </p>
              <div style="background:#F9F6F2;border-radius:10px;padding:16px;margin-top:8px;">
                ${solucoesHtml}
              </div>
            </td></tr>

            <!-- Guest message -->
            <tr><td style="padding:24px 32px 0;">
              <p style="margin:0 0 4px;color:#261C15;font-size:15px;font-weight:700;">
                Mensagem pronta para o hóspede &nbsp;${aiTag}
              </p>
              <p style="margin:0 0 8px;color:#9A7355;font-size:12px;">Copie e envie via WhatsApp ou e-mail</p>
              <div style="background:#3D2B1A;border-radius:10px;padding:20px;">
                ${guestMsgHtml}
              </div>
            </td></tr>

            <!-- Actions -->
            <tr><td style="padding:24px 32px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:12px;">
                    <a href="${adminUrl}/admin/manutencao" style="display:inline-block;background:#261C15;color:#F5EFE6;font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:8px;">
                      Ver chamado de manutenção →
                    </a>
                  </td>
                  <td>
                    <a href="${adminUrl}/casa/vistoria/${reportId}" style="display:inline-block;background:#F5EFE6;color:#261C15;border:1px solid #C9A96E;font-size:13px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:8px;">
                      Abrir vistoria completa →
                    </a>
                  </td>
                </tr>
              </table>
            </td></tr>

            <!-- Footer -->
            <tr><td style="background:#F5EFE6;padding:16px 32px;border-top:1px solid #E5D9C8;">
              <p style="margin:0;color:#9A7355;font-size:11px;text-align:center;">
                Sítio Recanto dos Ipês · Alerta automático gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  const textProblemas = problemas.map((p, i) => `${i + 1}. ${p.label}: ${p.observacao}`).join('\n');

  await sendMail({
    from:    FROM_RECANTO(),
    to:      adminEmail,
    subject: `⚠️ Checkout ${booking.guestName} — ${problemas.length} problema${problemas.length > 1 ? 's' : ''} registrado${problemas.length > 1 ? 's' : ''}`,
    html,
    text:    `PROBLEMAS NO CHECKOUT — ${booking.guestName} (${checkOutFmt})\nInspetor: ${staffName}\n\n${textProblemas}\n\nSOLUÇÕES SUGERIDAS:\n${solucoesText}\n\nMENSAGEM PARA O HÓSPEDE:\n${guestMessage}\n\nVer vistoria: ${adminUrl}/casa/vistoria/${reportId}\nVer chamados: ${adminUrl}/admin/manutencao`,
  });
}

/**
 * Sends an outbound email from the staff inbox to a contact.
 * @param {object} opts
 * @param {string} opts.to          - Recipient email address
 * @param {string} opts.fromName    - Staff member's display name
 * @param {string} opts.subject     - Email subject
 * @param {string} opts.body        - Plain-text message body
 * @param {string} [opts.signature] - Staff member's email signature (appended to body)
 */
async function sendInboxEmail({ to, fromName, subject, body, signature }) {
  const from = `"${fromName} · Recantos da Serra" <${process.env.GMAIL_USER}>`;
  const fullText = signature ? `${body}\n\n--\n${signature}` : body;
  const htmlBody = escHtml(fullText).replace(/\n/g, '<br>');

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:24px;background:#ffffff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.6;">
      <div style="max-width:560px;">
        <p style="margin:0 0 16px;">${htmlBody}</p>
      </div>
    </body>
    </html>
  `;

  await sendMail({ from, to, subject, html, text: fullText });
}

/**
 * Email sent when a direct booking lands as REQUESTED (pre-auth held).
 * Guest is informed their request is under review; no charge yet.
 */
async function sendBookingRequestReceived({ booking }) {
  const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const total    = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(booking.totalAmount));
  const petLine  = booking.hasPet
    ? `<tr><td style="color:#6B6B6B;font-size:13px;">Pet</td><td style="color:#261C15;font-weight:600;font-size:13px;">${escHtml(booking.petDescription) || 'Sim'}</td></tr>`
    : '';

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
              <p style="margin:0;color:#C5D86D;font-size:22px;font-weight:700;">☀️ Solicitação Recebida!</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 16px;color:#1A1A1A;font-size:16px;">Olá, <strong>${escHtml(booking.guestName)}</strong>!</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Recebemos sua solicitação de reserva! Nossa equipe irá analisar e confirmar em até <strong>24 horas</strong>.
              </p>
              <table width="100%" style="background:#F7F7F2;border-radius:12px;padding:20px;margin-bottom:24px;" cellpadding="8">
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-in</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkIn}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Check-out</td><td style="color:#261C15;font-weight:600;font-size:13px;">${checkOut}</td></tr>
                <tr><td style="color:#6B6B6B;font-size:13px;">Hóspedes</td><td style="color:#261C15;font-weight:600;font-size:13px;">${booking.guestCount}</td></tr>
                ${petLine}
                <tr><td style="color:#6B6B6B;font-size:13px;">Pré-autorizado</td><td style="color:#261C15;font-weight:700;font-size:14px;">${total} <span style="font-weight:400;font-size:11px;color:#9A9A9A;">(não cobrado ainda)</span></td></tr>
              </table>
              <div style="background:#FEF9EE;border-radius:10px;padding:16px;margin-bottom:24px;">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#92400E;">O que acontece agora?</p>
                <p style="margin:0;font-size:13px;color:#78350F;line-height:1.6;">
                  1. Nossa equipe revisa sua solicitação.<br>
                  2. Ao confirmar, o valor é cobrado e você recebe todos os detalhes.<br>
                  3. Se não pudermos confirmar, a pré-autorização é cancelada sem nenhum custo.
                </p>
              </div>
              <p style="margin:0;color:#9A9A9A;font-size:12px;line-height:1.6;">
                Dúvidas? Entre em contato via WhatsApp: +55 31 2391-6688
              </p>
            </td></tr>
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
    subject: 'Sua solicitação de reserva foi recebida ☀️',
    html,
    text: `Olá, ${booking.guestName}!\n\nRecebemos sua solicitação de reserva para ${checkIn} a ${checkOut} (${booking.guestCount} hóspedes). Valor pré-autorizado: ${total}.\n\nNossa equipe confirmará em até 24 horas. Nenhum valor foi cobrado ainda.\n\nDúvidas: +55 31 2391-6688`,
  });
}

/**
 * Email sent when admin declines a REQUESTED booking.
 * Includes admin's typed reason. Pre-auth was already cancelled before calling this.
 */
async function sendBookingDeclined({ booking, declineReason }) {
  const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#F7F7F2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F2;padding:40px 20px;">
        <tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <tr><td style="background:#261C15;padding:32px;text-align:center;">
              <img src="https://sitiorecantodosipes.com/brand/sri-mark-white.svg" width="88" alt="Sítio Recanto dos Ipês" style="display:block;margin:0 auto 20px;border:0;height:auto;">
              <p style="margin:0;color:#C5D86D;font-size:18px;font-weight:700;">Atualização sobre sua solicitação</p>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.65);font-size:13px;">Sítio Recanto dos Ipês · Jaboticatubas, MG</p>
            </td></tr>
            <tr><td style="padding:40px 36px;">
              <p style="margin:0 0 16px;color:#1A1A1A;font-size:16px;">Olá, <strong>${escHtml(booking.guestName)}</strong>,</p>
              <p style="margin:0 0 24px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Infelizmente não foi possível confirmar sua solicitação para o período de <strong>${checkIn}</strong> a <strong>${checkOut}</strong>.
              </p>
              <div style="background:#FFF5F5;border-left:4px solid #FCA5A5;border-radius:0 10px 10px 0;padding:16px;margin-bottom:24px;">
                <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#991B1B;text-transform:uppercase;letter-spacing:0.5px;">Motivo</p>
                <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.6;">${escHtml(declineReason) || 'As datas solicitadas não estão disponíveis.'}</p>
              </div>
              <div style="background:#F0FDF4;border-radius:10px;padding:16px;margin-bottom:24px;">
                <p style="margin:0;font-size:13px;color:#14532D;line-height:1.6;">
                  ✓ A pré-autorização do seu cartão foi <strong>cancelada automaticamente</strong>. Nenhum valor foi cobrado.
                </p>
              </div>
              <p style="margin:0 0 16px;color:#6B6B6B;font-size:14px;line-height:1.6;">
                Adoraríamos recebê-lo(a) em outra data! Consulte nossa disponibilidade:
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                <tr><td style="background:#2B7929;border-radius:10px;padding:12px 28px;">
                  <a href="https://sitiorecantodosipes.com/booking" style="color:white;font-weight:700;font-size:14px;text-decoration:none;">Ver disponibilidade</a>
                </td></tr>
              </table>
              <p style="margin:0;color:#9A9A9A;font-size:12px;">
                Dúvidas? Fale conosco: +55 31 2391-6688
              </p>
            </td></tr>
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
    subject: 'Atualização sobre sua solicitação de reserva',
    html,
    text: `Olá, ${booking.guestName},\n\nInfelizmente não foi possível confirmar sua solicitação.\n\nMotivo: ${declineReason || 'As datas solicitadas não estão disponíveis.'}\n\nA pré-autorização do seu cartão foi cancelada. Nenhum valor foi cobrado.\n\nConsulte outras datas em: sitiorecantodosipes.com/booking`,
  });
}

module.exports = {
  sendOtpEmail,
  sendBookingConfirmation,
  sendBookingRequestReceived,
  sendBookingDeclined,
  sendStaffInvite,
  sendAdminNotification,
  sendGuestInvite,
  sendPasswordResetEmail,
  sendCheckoutProblemaAlert,
  sendInboxEmail,
};
