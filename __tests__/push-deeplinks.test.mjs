import { describe, it, expect } from 'vitest';
import { pushTypeToUrl } from '../lib/push-deeplinks.js';

// Pins the URL contract for every push type the system emits today. If a new
// type is added in lib/cron.js or elsewhere, the test for unknown types will
// still pass (we want a /admin fallback) — but the canonical list below should
// be expanded so we have a regression net.
//
// Source of types: grep "type: '" in lib/cron.js + routes/staff.js + lib/push.js
// callers, cross-referenced with the system prompt list (32 types total).

describe('pushTypeToUrl — explicit data.url override', () => {
  it('returns data.url when provided (any type)', () => {
    expect(pushTypeToUrl('BOOKING_REQUESTED', { url: '/custom' })).toBe('/custom');
    expect(pushTypeToUrl('CONTENT_BLOG_READY', { url: '/whatever' })).toBe('/whatever');
    expect(pushTypeToUrl('UNKNOWN_TYPE',       { url: '/x' })).toBe('/x');
  });

  it('ignores empty / non-string url and falls back to type-based mapping', () => {
    expect(pushTypeToUrl('CONTENT_BLOG_READY', { url: '', postId: 'abc' }))
      .toBe('/admin/conteudo?postId=abc');
    expect(pushTypeToUrl('CONTENT_BLOG_READY', { url: null, postId: 'abc' }))
      .toBe('/admin/conteudo?postId=abc');
    expect(pushTypeToUrl('CONTENT_BLOG_READY', { url: 123,  postId: 'abc' }))
      .toBe('/admin/conteudo?postId=abc');
  });
});

describe('pushTypeToUrl — bookings', () => {
  it('BOOKING_REQUESTED → /admin/reservas/:id', () => {
    expect(pushTypeToUrl('BOOKING_REQUESTED', { bookingId: 'b1' }))
      .toBe('/admin/reservas/b1');
  });
  it('BOOKING_REQUESTED without bookingId → /admin/reservas', () => {
    expect(pushTypeToUrl('BOOKING_REQUESTED', {})).toBe('/admin/reservas');
  });
  it('OTA_BOOKING_INCOMPLETE → /admin/reservas/:id (or list)', () => {
    expect(pushTypeToUrl('OTA_BOOKING_INCOMPLETE', { bookingId: 'b2' }))
      .toBe('/admin/reservas/b2');
    expect(pushTypeToUrl('OTA_BOOKING_INCOMPLETE', {})).toBe('/admin/reservas');
  });
  it('PRESTAY_REMINDER_SENT → /admin/reservas/:id', () => {
    expect(pushTypeToUrl('PRESTAY_REMINDER_SENT', { bookingId: 'b3' }))
      .toBe('/admin/reservas/b3');
  });
  it('CHECKIN_TODAY_ADMIN → /admin/reservas?checkIn=today', () => {
    expect(pushTypeToUrl('CHECKIN_TODAY_ADMIN', {}))
      .toBe('/admin/reservas?checkIn=today');
  });
  it('OTA_BOOKING_CANCELLED → /admin/reservas?status=CANCELLED', () => {
    expect(pushTypeToUrl('OTA_BOOKING_CANCELLED', {}))
      .toBe('/admin/reservas?status=CANCELLED');
  });
});

describe('pushTypeToUrl — vistorias', () => {
  it('INSPECTION_SUBMITTED → /admin/vistoria/:id', () => {
    expect(pushTypeToUrl('INSPECTION_SUBMITTED', { inspectionId: 'i1' }))
      .toBe('/admin/vistoria/i1');
  });
  it('INSPECTION_ISSUES → /admin/vistoria/:id', () => {
    expect(pushTypeToUrl('INSPECTION_ISSUES', { inspectionId: 'i2' }))
      .toBe('/admin/vistoria/i2');
  });
  it('INSPECTION_OVERDUE → /admin/vistorias', () => {
    expect(pushTypeToUrl('INSPECTION_OVERDUE', {})).toBe('/admin/vistorias');
  });
  it('PRE_CHECKIN with bookingId → casa vistoria nova URL', () => {
    expect(pushTypeToUrl('PRE_CHECKIN', { bookingId: 'b9' }))
      .toBe('/casa/vistoria/nova?bookingId=b9&tipo=PRE_CHECKIN');
  });
  it('PRE_CHECKIN without bookingId → /casa/vistorias', () => {
    expect(pushTypeToUrl('PRE_CHECKIN', {})).toBe('/casa/vistorias');
  });
});

describe('pushTypeToUrl — tasks', () => {
  it('TASK_ASSIGNED → /casa/tarefas', () => {
    expect(pushTypeToUrl('TASK_ASSIGNED', {})).toBe('/casa/tarefas');
  });
  it('TASK_DUE_TOMORROW → /casa/tarefas', () => {
    expect(pushTypeToUrl('TASK_DUE_TOMORROW', {})).toBe('/casa/tarefas');
  });
  it('TASK_COMPLETED → /casa/tarefas', () => {
    expect(pushTypeToUrl('TASK_COMPLETED', {})).toBe('/casa/tarefas');
  });
  it('TASK_OVERDUE → /casa/tarefas?filter=overdue', () => {
    expect(pushTypeToUrl('TASK_OVERDUE', {})).toBe('/casa/tarefas?filter=overdue');
  });
  it('TASK_OVERDUE_ADMIN → /admin/tarefas?filter=overdue', () => {
    expect(pushTypeToUrl('TASK_OVERDUE_ADMIN', {})).toBe('/admin/tarefas?filter=overdue');
  });
});

describe('pushTypeToUrl — content (the bug-source)', () => {
  it('CONTENT_BLOG_READY with postId → /admin/conteudo?postId=X', () => {
    expect(pushTypeToUrl('CONTENT_BLOG_READY', { postId: 'cmo123' }))
      .toBe('/admin/conteudo?postId=cmo123');
  });
  it('CONTENT_BLOG_READY without postId → /admin/conteudo', () => {
    expect(pushTypeToUrl('CONTENT_BLOG_READY', {})).toBe('/admin/conteudo');
  });
  it('CONTENT_ALTERNATIVE_READY with postId → /admin/conteudo?postId=X', () => {
    expect(pushTypeToUrl('CONTENT_ALTERNATIVE_READY', { postId: 'p2' }))
      .toBe('/admin/conteudo?postId=p2');
  });
  it('CONTENT_COMMENT with postId → /admin/conteudo?postId=X', () => {
    expect(pushTypeToUrl('CONTENT_COMMENT', { postId: 'p3' }))
      .toBe('/admin/conteudo?postId=p3');
  });
  it('CONTENT_PACKAGE_READY with brand → /admin/conteudo?brand=X', () => {
    expect(pushTypeToUrl('CONTENT_PACKAGE_READY', { brand: 'RDI' }))
      .toBe('/admin/conteudo?brand=RDI');
  });
  it('CONTENT_PACKAGE_READY without brand → /admin/conteudo', () => {
    expect(pushTypeToUrl('CONTENT_PACKAGE_READY', {})).toBe('/admin/conteudo');
  });
});

describe('pushTypeToUrl — inbox + comms', () => {
  it('INBOX_MESSAGE with conversationId → /admin/mensagens/:id', () => {
    expect(pushTypeToUrl('INBOX_MESSAGE', { conversationId: 'c1' }))
      .toBe('/admin/mensagens/c1');
  });
  it('INBOX_MESSAGE without conversationId → /admin/mensagens', () => {
    expect(pushTypeToUrl('INBOX_MESSAGE', {})).toBe('/admin/mensagens');
  });
  it('TICKET_COMMENT → /admin/manutencao', () => {
    expect(pushTypeToUrl('TICKET_COMMENT', {})).toBe('/admin/manutencao');
  });
  it('SERVICE_TICKET_RESOLVED → /admin/manutencao', () => {
    expect(pushTypeToUrl('SERVICE_TICKET_RESOLVED', {})).toBe('/admin/manutencao');
  });
});

describe('pushTypeToUrl — pool + estoque + staff', () => {
  it('POOL_MAINTENANCE_LOGGED → /piscina/historico', () => {
    expect(pushTypeToUrl('POOL_MAINTENANCE_LOGGED', {})).toBe('/piscina/historico');
  });
  it('ESTOQUE_BAIXO → /casa/inventario', () => {
    expect(pushTypeToUrl('ESTOQUE_BAIXO', {})).toBe('/casa/inventario');
  });
  it('STAFF_ACCESS_REQUEST → /admin/equipe/solicitacoes', () => {
    expect(pushTypeToUrl('STAFF_ACCESS_REQUEST', {})).toBe('/admin/equipe/solicitacoes');
  });
  it('STAFF_RECOVERY_REQUEST → /admin/equipe', () => {
    expect(pushTypeToUrl('STAFF_RECOVERY_REQUEST', {})).toBe('/admin/equipe');
  });
  it('STAFF_MEMBER_ADDED → /admin/equipe', () => {
    expect(pushTypeToUrl('STAFF_MEMBER_ADDED', {})).toBe('/admin/equipe');
  });
});

describe('pushTypeToUrl — NPS', () => {
  it('NPS_DETRACTOR → /admin/nps?segment=DETRACTOR', () => {
    expect(pushTypeToUrl('NPS_DETRACTOR', {})).toBe('/admin/nps?segment=DETRACTOR');
  });
});

describe('pushTypeToUrl — guest-facing types', () => {
  it('CHECKIN_REMINDER falls back to /dashboard if no url', () => {
    expect(pushTypeToUrl('CHECKIN_REMINDER', {})).toBe('/dashboard');
  });
  it('CHECKIN_REMINDER honours data.url when set', () => {
    expect(pushTypeToUrl('CHECKIN_REMINDER', { url: '/dashboard/checkin/abc' }))
      .toBe('/dashboard/checkin/abc');
  });
  it('BOOKING_CONFIRMED_GUEST falls back to /dashboard', () => {
    expect(pushTypeToUrl('BOOKING_CONFIRMED_GUEST', {})).toBe('/dashboard');
  });
  it('BOOKING_DECLINED_GUEST falls back to /dashboard', () => {
    expect(pushTypeToUrl('BOOKING_DECLINED_GUEST', {})).toBe('/dashboard');
  });
  it('PRESTAY_D7_GUEST falls back to /dashboard', () => {
    expect(pushTypeToUrl('PRESTAY_D7_GUEST', {})).toBe('/dashboard');
  });
  it('SURVEY_REQUEST falls back to /dashboard', () => {
    expect(pushTypeToUrl('SURVEY_REQUEST', {})).toBe('/dashboard');
  });
  it('IA_ALERTA_URGENTE falls back to /admin/ia-operacoes', () => {
    expect(pushTypeToUrl('IA_ALERTA_URGENTE', {})).toBe('/admin/ia-operacoes');
  });
});

describe('pushTypeToUrl — unknown type', () => {
  it('falls back to /admin', () => {
    expect(pushTypeToUrl('SOMETHING_NEW', {})).toBe('/admin');
  });
  it('handles missing data argument gracefully', () => {
    expect(pushTypeToUrl('SOMETHING_NEW')).toBe('/admin');
  });
});

// Canonical 32-type matrix — guards against silently dropping coverage when
// new types are added. Each row asserts (type, sample-data, expected-url).
describe('pushTypeToUrl — full canonical matrix (32 types)', () => {
  const cases = [
    ['BOOKING_CONFIRMED_GUEST',    {},                          '/dashboard'],
    ['BOOKING_DECLINED_GUEST',     {},                          '/dashboard'],
    ['BOOKING_REQUESTED',          { bookingId: 'b' },          '/admin/reservas/b'],
    ['CHECKIN_REMINDER',           {},                          '/dashboard'],
    ['CHECKIN_TODAY_ADMIN',        {},                          '/admin/reservas?checkIn=today'],
    ['CONTENT_ALTERNATIVE_READY',  { postId: 'p' },             '/admin/conteudo?postId=p'],
    ['CONTENT_BLOG_READY',         { postId: 'p' },             '/admin/conteudo?postId=p'],
    ['CONTENT_COMMENT',            { postId: 'p' },             '/admin/conteudo?postId=p'],
    ['CONTENT_PACKAGE_READY',      { brand: 'RDI' },            '/admin/conteudo?brand=RDI'],
    ['ESTOQUE_BAIXO',              {},                          '/casa/inventario'],
    ['IA_ALERTA_URGENTE',          {},                          '/admin/ia-operacoes'],
    ['INBOX_MESSAGE',              { conversationId: 'c' },     '/admin/mensagens/c'],
    ['INSPECTION_ISSUES',          { inspectionId: 'i' },       '/admin/vistoria/i'],
    ['INSPECTION_OVERDUE',         {},                          '/admin/vistorias'],
    ['INSPECTION_SUBMITTED',       { inspectionId: 'i' },       '/admin/vistoria/i'],
    ['NPS_DETRACTOR',              {},                          '/admin/nps?segment=DETRACTOR'],
    ['OTA_BOOKING_CANCELLED',      {},                          '/admin/reservas?status=CANCELLED'],
    ['OTA_BOOKING_INCOMPLETE',     { bookingId: 'b' },          '/admin/reservas/b'],
    ['POOL_MAINTENANCE_LOGGED',    {},                          '/piscina/historico'],
    ['PRESTAY_D7_GUEST',           {},                          '/dashboard'],
    ['PRESTAY_REMINDER_SENT',      { bookingId: 'b' },          '/admin/reservas/b'],
    ['PRE_CHECKIN',                { bookingId: 'b' },          '/casa/vistoria/nova?bookingId=b&tipo=PRE_CHECKIN'],
    ['SERVICE_TICKET_RESOLVED',    {},                          '/admin/manutencao'],
    ['STAFF_ACCESS_REQUEST',       {},                          '/admin/equipe/solicitacoes'],
    ['STAFF_MEMBER_ADDED',         {},                          '/admin/equipe'],
    ['STAFF_RECOVERY_REQUEST',     {},                          '/admin/equipe'],
    ['SURVEY_REQUEST',             {},                          '/dashboard'],
    ['TASK_ASSIGNED',              {},                          '/casa/tarefas'],
    ['TASK_COMPLETED',             {},                          '/casa/tarefas'],
    ['TASK_DUE_TOMORROW',          {},                          '/casa/tarefas'],
    ['TASK_OVERDUE',               {},                          '/casa/tarefas?filter=overdue'],
    ['TASK_OVERDUE_ADMIN',         {},                          '/admin/tarefas?filter=overdue'],
    ['TICKET_COMMENT',             {},                          '/admin/manutencao'],
  ];

  it('covers exactly 33 explicit type rows in the matrix', () => {
    // 32 from spec + TASK_OVERDUE_ADMIN which the spec calls out separately.
    // Keeping the count assertion so adding a new row to the spec is loud.
    expect(cases).toHaveLength(33);
  });

  for (const [type, data, expected] of cases) {
    it(`${type} → ${expected}`, () => {
      expect(pushTypeToUrl(type, data)).toBe(expected);
    });
  }
});
