import { describe, it, expect } from 'vitest';
import { renderTemplatePreview } from '../lib/whatsapp.js';

// When an auto-sent template fires on booking confirm/decline, we log a
// preview row into InboxMessage so admins see the message in the guest's
// conversation thread (not just in MessageLog). The preview renders the
// template name + variables into a short, human-readable body. Pure
// function — no network, no DB — so we can pin edge cases here.

describe('renderTemplatePreview', () => {
  it('substitutes {{1}}, {{2}}, {{3}} in the template body with the provided vars', () => {
    const preview = renderTemplatePreview('booking_confirmed', ['Andre', 'Recanto dos Ipês', '12/05/2026']);
    expect(preview).toMatch(/Andre/);
    expect(preview).toMatch(/Recanto dos Ip[eê]s/);
    expect(preview).toMatch(/12\/05\/2026/);
  });

  it('renders booking_confirmed with the 5-variable schema', () => {
    const preview = renderTemplatePreview('booking_confirmed', [
      'Andre', 'Recanto dos Ipês', '12/05/2026', '14/05/2026', '2,00',
    ]);
    expect(preview).toMatch(/confirmada/i);
    expect(preview).toMatch(/12\/05\/2026/);
    expect(preview).toMatch(/14\/05\/2026/);
    expect(preview).toMatch(/R\$\s*2,00/);
  });

  it('renders booking_declined with the 2-variable schema and includes the reason', () => {
    const preview = renderTemplatePreview('booking_declined', [
      'Andre', 'Infelizmente as datas solicitadas não estão mais disponíveis.',
    ]);
    expect(preview).toMatch(/Andre/);
    expect(preview).toMatch(/Infelizmente as datas/);
    // Tone check: should read empathetic, not transactional
    expect(preview).toMatch(/n[aã]o conseguiremos|infelizmente/i);
  });

  it('falls back to a generic preview for unknown templates (never throws)', () => {
    const preview = renderTemplatePreview('some_future_template', ['a', 'b']);
    expect(typeof preview).toBe('string');
    expect(preview.length).toBeGreaterThan(0);
  });

  it('handles missing vars gracefully (leaves placeholders visible for audit)', () => {
    const preview = renderTemplatePreview('booking_confirmed', []);
    expect(preview).toMatch(/\{\{1\}\}/);   // placeholder still visible, not crashed
  });

  it('truncates very long inputs to protect the InboxMessage body column', () => {
    const longReason = 'x'.repeat(2000);
    const preview = renderTemplatePreview('booking_declined', ['Andre', longReason]);
    // InboxMessage.body is stored as-is; keep under ~1000 chars to play nice
    // with conversation list previews + DB row size.
    expect(preview.length).toBeLessThanOrEqual(1000);
  });

  it('is a pure function — no side effects', () => {
    const vars = ['Andre', 'Test'];
    const snapshot = JSON.stringify(vars);
    renderTemplatePreview('booking_confirmed', vars);
    expect(JSON.stringify(vars)).toBe(snapshot);
  });
});
