import { describe, expect, it } from 'vitest';
import { CONFIRM, DELETE_DAYS, FINISH_CHOICE, TIMER_DONE, TIMER_DUE, TIMER_PAUSED_OUT } from './copy';

describe('copy builders', () => {
  it('names the user in the delete confirm', () => {
    expect(CONFIRM.deleteUser('sam')).toBe('Delete sam and ALL of their data? This cannot be undone.');
  });

  it('describes a finished timer with or without a label', () => {
    expect(TIMER_DONE.body('Write the report', '25:00')).toBe('Write the report · 25:00');
    expect(TIMER_DONE.body('', '25:00')).toBe('25:00 logged.');
  });

  it('asks what to do with a timer that ran out', () => {
    expect(TIMER_DUE.body('Write the report', '25m')).toBe('Write the report · 25m. Finish, or add more time.');
    expect(TIMER_DUE.body('', '25m')).toBe('25m. Finish, or add more time.');
    expect(TIMER_DUE.more(5)).toBe('Add 5 min');
  });

  it('offers both lengths when a late finish has to choose', () => {
    expect(FINISH_CHOICE.body('3m')).toBe('The timer ran out 3m ago.');
    expect(FINISH_CHOICE.body(null)).toBe('The timer just ran out.');
    expect(FINISH_CHOICE.planned('25m')).toBe('Planned · 25m');
    expect(FINISH_CHOICE.worked('28m')).toBe('Worked · 28m');
  });

  it('describes a session closed after a forgotten pause', () => {
    expect(TIMER_PAUSED_OUT.body('Write the report', '12m')).toBe(
      'Write the report · 12m logged. It sat paused for an hour, so it ended where the pause began.',
    );
    expect(TIMER_PAUSED_OUT.body('', '12m')).toMatch(/^12m logged\./);
  });

  it('counts days in the delete-old-days confirm and result', () => {
    expect(DELETE_DAYS.confirm(1, 'Monday, June 1, 2026')).toBe('Delete 1 day before Monday, June 1, 2026? This cannot be undone.');
    expect(DELETE_DAYS.confirm(12, 'Monday, June 1, 2026')).toMatch(/^Delete 12 days before /);
    expect(DELETE_DAYS.done(0)).toBe('Deleted 0 days.');
    expect(DELETE_DAYS.done(1)).toBe('Deleted 1 day.');
  });
});
