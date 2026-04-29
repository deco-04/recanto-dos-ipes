'use strict';

/**
 * Maps a push-notification type + its data payload to the in-app URL the
 * user should land on when they tap the notification. Pure function — no
 * side effects, no I/O. Pinned with regression tests so future push-type
 * additions can't silently fall back to /admin.
 *
 * Default fallback: /admin (existing behavior, kept as safety net).
 *
 * Why this exists: the service worker uses
 *   `event.notification.data?.url || '/admin'`
 * so unless the backend explicitly sets `data.url`, every tap routes the
 * user to /admin — regardless of notification type. That's how the user
 * tapped a CONTENT_BLOG_READY notification and ended up far from the
 * kanban card they wanted. This helper centralizes the routing decision
 * and is auto-injected by `lib/push.js` for every push that goes out.
 */
function pushTypeToUrl(type, data = {}) {
  // Allow callers to override explicitly — e.g. guest-facing notifications
  // that already include a /dashboard or /confirmar-hospede URL. Defense-
  // in-depth: only honor relative paths (must start with `/`). This blocks
  // an accidental or malicious `data.url = 'javascript:...'` or external
  // origin from being passed through to the service worker, which calls
  // `clients.openWindow(url)` on tap. All current callers are server-
  // internal so the risk is theoretical, but the guard is one line and
  // future-proofs against any endpoint that proxies user input into data.
  if (
    data &&
    typeof data.url === 'string' &&
    data.url.startsWith('/')
  ) {
    return data.url;
  }

  switch (type) {
    // — Bookings (admin-facing)
    case 'BOOKING_REQUESTED':
    case 'OTA_BOOKING_INCOMPLETE':
    case 'PRESTAY_REMINDER_SENT':
      return data.bookingId ? `/admin/reservas/${data.bookingId}` : '/admin/reservas';
    case 'CHECKIN_TODAY_ADMIN':
      return '/admin/reservas?checkIn=today';
    case 'OTA_BOOKING_CANCELLED':
      return '/admin/reservas?status=CANCELLED';

    // — Vistorias
    case 'INSPECTION_SUBMITTED':
    case 'INSPECTION_ISSUES':
      return data.inspectionId ? `/admin/vistoria/${data.inspectionId}` : '/admin/vistorias';
    case 'INSPECTION_OVERDUE':
      return '/admin/vistorias';
    case 'PRE_CHECKIN':
      return data.bookingId
        ? `/casa/vistoria/nova?bookingId=${data.bookingId}&tipo=PRE_CHECKIN`
        : '/casa/vistorias';

    // — Tasks
    case 'TASK_ASSIGNED':
    case 'TASK_DUE_TOMORROW':
    case 'TASK_COMPLETED':
      return '/casa/tarefas';
    case 'TASK_OVERDUE':
      return '/casa/tarefas?filter=overdue';
    case 'TASK_OVERDUE_ADMIN':
      return '/admin/tarefas?filter=overdue';

    // — Content (the bug-source)
    case 'CONTENT_BLOG_READY':
    case 'CONTENT_ALTERNATIVE_READY':
    case 'CONTENT_COMMENT':
      return data.postId ? `/admin/conteudo?postId=${data.postId}` : '/admin/conteudo';
    case 'CONTENT_PACKAGE_READY':
      return data.brand ? `/admin/conteudo?brand=${data.brand}` : '/admin/conteudo';

    // — Inbox + comms
    case 'INBOX_MESSAGE':
      return data.conversationId ? `/admin/mensagens/${data.conversationId}` : '/admin/mensagens';
    case 'TICKET_COMMENT':
    case 'SERVICE_TICKET_RESOLVED':
      return '/admin/manutencao';

    // — Pool ops
    case 'POOL_MAINTENANCE_LOGGED':
      return '/piscina/historico';

    // — Inventário
    case 'ESTOQUE_BAIXO':
      return '/casa/inventario';

    // — Staff lifecycle
    case 'STAFF_ACCESS_REQUEST':
      return '/admin/equipe/solicitacoes';
    case 'STAFF_RECOVERY_REQUEST':
    case 'STAFF_MEMBER_ADDED':
      return '/admin/equipe';

    // — NPS
    case 'NPS_DETRACTOR':
      return '/admin/nps?segment=DETRACTOR';

    // — Surveys, IA, guest-facing — these typically already include their
    //   own data.url (handled at the top of this function). Fallbacks here
    //   are for safety only.
    case 'CHECKIN_REMINDER':
    case 'BOOKING_CONFIRMED_GUEST':
    case 'BOOKING_DECLINED_GUEST':
    case 'PRESTAY_D7_GUEST':
    case 'SURVEY_REQUEST':
      return '/dashboard';
    case 'IA_ALERTA_URGENTE':
      return '/admin/ia-operacoes';

    default:
      // Unknown type — be loud in dev, silent in prod.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[push-deeplinks] Unknown type "${type}" — falling back to /admin`);
      }
      return '/admin';
  }
}

module.exports = { pushTypeToUrl };
