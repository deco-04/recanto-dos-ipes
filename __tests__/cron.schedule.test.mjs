import { describe, it, expect, vi } from 'vitest';
import { scheduleWeeklyContentCron } from '../lib/cron-content.js';

// This helper is extracted so we can pin the TZ + pattern contract without
// spinning up the whole cron.js (which registers ~20 jobs and touches many
// modules). If a future refactor accidentally drifts the timezone or the
// cron pattern, these tests fail loudly.
describe('scheduleWeeklyContentCron', () => {
  it('registers with pattern "0 7 * * 1" and timezone "America/Denver" (DST-aware)', () => {
    const fakeCron = { schedule: vi.fn() };
    const handler  = vi.fn();

    scheduleWeeklyContentCron(fakeCron, handler);

    expect(fakeCron.schedule).toHaveBeenCalledTimes(1);
    const [pattern, fn, options] = fakeCron.schedule.mock.calls[0];

    expect(pattern).toBe('0 7 * * 1');
    expect(options).toEqual({ timezone: 'America/Denver' });
    expect(fn).toBe(handler);
  });

  it('returns the registration object from cron.schedule (for tests and introspection)', () => {
    const task     = { start: vi.fn(), stop: vi.fn() };
    const fakeCron = { schedule: vi.fn().mockReturnValue(task) };

    const result = scheduleWeeklyContentCron(fakeCron, () => {});

    expect(result).toBe(task);
  });
});
