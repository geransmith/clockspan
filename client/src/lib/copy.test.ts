import { describe, expect, it } from 'vitest';
import {
  BANNERS_MORE,
  BOARD,
  BOARD_DRAG,
  BREAK,
  BREAK_SUGGESTION,
  CELEBRATION_EMOJI,
  CELEBRATION_PHRASES,
  CONFIRM,
  DAYS_DELETED,
  DONE_STAYS,
  EMPTIED_RECURRING,
  EMPTIED_ROW,
  FINISH_CHOICE,
  LEFT_OPEN,
  LOAD_FAILED,
  PLAN_NEXT,
  PRIORITY_WARNINGS,
  REQUEST_FAILED,
  SAVE_FAILED,
  SECOND_MEAL_NOTE,
  SERVER_UNREACHABLE,
  STICKER_EMOJI,
  TIMER_DONE,
  TIMER_DUE,
  TIMER_PAUSED_OUT,
  TODAY_OFFER,
  UNREADABLE_ANSWER,
} from './copy';

describe('copy builders', () => {
  it('names the user in the delete confirm', () => {
    expect(CONFIRM.deleteUser('sam')).toBe('Delete sam and ALL of their data? This cannot be undone.');
  });

  it('says how much time a cleared row keeps', () => {
    expect(EMPTIED_ROW('25m')).toBe('The 25m logged on this row stays with it. Use Add priority for something new.');
    expect(EMPTIED_ROW(null)).toBe('The time logged on this row stays with it. Use Add priority for something new.');
  });

  it('names the day the offered priorities were left open on', () => {
    expect(LEFT_OPEN.title('yesterday')).toBe('Still open from yesterday');
  });

  it('says an emptied recurring row is still the routine, and names the number a day in the offer', () => {
    expect(EMPTIED_RECURRING).toBe('This row is still a recurring priority. Use Add priority for something new.');
    expect(TODAY_OFFER.over(3)).toBe('More than 3 recurring rows today.');
    expect(TODAY_OFFER.over(1)).toBe('More than 1 recurring row today.');
  });

  it('describes a finished timer with or without a label', () => {
    expect(TIMER_DONE.body('Write the report', '25m')).toBe('Write the report · 25m logged.');
    expect(TIMER_DONE.body('', '25m')).toBe('25m logged.');
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

  it('names the break length and when it ends', () => {
    expect(BREAK.start(5, false)).toBe('Break · 5 min');
    expect(BREAK.start(20, true)).toBe('Long break · 20 min');
    expect(BREAK.running('10:35 AM')).toBe('Break until 10:35 AM');
  });

  it('offers the break a session earned and says what it was sized on', () => {
    expect(BREAK_SUGGESTION.kicker(2, 4)).toBe('Session 2 of 4');
    expect(BREAK_SUGGESTION.title(5, false)).toBe('Take a 5 min break');
    expect(BREAK_SUGGESTION.title(20, true)).toBe('Take a long break, 20 min');
    expect(BREAK_SUGGESTION.body('25m', false, 4)).toBe('For the 25m you just logged.');
    expect(BREAK_SUGGESTION.body('1h 40m', true, 4)).toBe('For the 1h 40m logged over all 4.');
  });

  it('names the day being planned and counts the rows added', () => {
    expect(PLAN_NEXT.open('tomorrow')).toBe('Plan tomorrow');
    expect(PLAN_NEXT.title('Mon, Sep 28')).toBe('Plan for Mon, Sep 28');
    expect(PLAN_NEXT.already(2)).toBe('2 already on the list');
    expect(PLAN_NEXT.save('tomorrow')).toBe('Add to tomorrow');
    expect(PLAN_NEXT.done(1, 'tomorrow')).toBe('1 row added for tomorrow.');
    expect(PLAN_NEXT.done(3, 'tomorrow')).toBe('3 rows added for tomorrow.');
  });

  it('says when the second meal period is or was due', () => {
    expect(SECOND_MEAL_NOTE(false, '6:30 PM', '10h 00m')).toBe('Second meal period due by 6:30 PM (10h 00m worked)');
    expect(SECOND_MEAL_NOTE(true, '6:30 PM', '10h 00m')).toBe('Second meal period was due by 6:30 PM (10h 00m worked)');
  });

  it('names what went wrong when the server does not answer', () => {
    expect(SERVER_UNREACHABLE.body('Request failed (502)')).toBe("Can't reach the server: Request failed (502)");
  });

  it('names the status of a refusal with no message of its own, or an answer that is not JSON', () => {
    expect(REQUEST_FAILED(502)).toBe('Request failed (502)');
    expect(UNREADABLE_ANSWER(200)).toBe('Unreadable answer (200)');
  });

  it('gives a failed save or load a reason that holds for a refusal as well as for no answer', () => {
    // The same banner follows a timeout and a 409, so neither line may blame only the network.
    for (const body of [SAVE_FAILED.body, LOAD_FAILED.body]) {
      expect(body).toMatch(/refused/);
      expect(body).toMatch(/did not answer/);
    }
  });

  it('counts days in the delete-old-days confirm and result', () => {
    expect(CONFIRM.deleteDays(1, 'Monday, June 1, 2026')).toBe('Delete 1 day before Monday, June 1, 2026? This cannot be undone.');
    expect(CONFIRM.deleteDays(12, 'Monday, June 1, 2026')).toMatch(/^Delete 12 days before /);
    expect(DAYS_DELETED(0)).toBe('Deleted 0 days.');
    expect(DAYS_DELETED(1)).toBe('Deleted 1 day.');
  });

  it('names the days a deleted card is taken off, and none when it is on no list', () => {
    expect(CONFIRM.deleteCard([])).toBe('Delete this card?');
    expect(CONFIRM.deleteCard(['today'])).toBe('Delete this card and take it off the list for today?');
    expect(CONFIRM.deleteCard(['today', 'tomorrow'])).toBe('Delete this card and take it off the list for today and tomorrow?');
  });

  it('names the recurring priority a delete takes, and says its rows stay', () => {
    expect(CONFIRM.deleteRecurring('Follow-ups')).toBe('Delete Follow-ups? Rows it already added keep their text.');
  });

  it('names the card and the day in the board refusals, and the cap in the full line', () => {
    expect(BOARD.full).toBe('Later and Next hold 300 cards at most.');
    expect(BOARD.recurringStays('Monitor the queue')).toBe("Monitor the queue stays on today's list. Use Remove from today.");
    expect(BOARD.planned('Write a KB', 'tomorrow')).toBe("Write a KB is planned for tomorrow. Change it on that day's sheet.");
  });

  it('says a done item stays done and offers a new card in the lane it was moved to', () => {
    expect(DONE_STAYS.title('Ship the fix')).toBe('Ship the fix is done.');
    expect(DONE_STAYS.add('Next')).toBe('Add a new card to Next');
    expect(DONE_STAYS.announce('Ship the fix', 'Next')).toBe('Ship the fix stays in Done. The notice can add a new card to Next.');
  });

  it('names the card and the column in what a drag on the board says', () => {
    expect(BOARD_DRAG.pickedUp('Write a KB', 'Later')).toBe('Picked up Write a KB, in Later.');
    expect(BOARD_DRAG.over('Write a KB', 'In progress')).toBe('Write a KB is over In progress.');
    expect(BOARD_DRAG.overBefore('Write a KB', 'Next', 'Follow up')).toBe('Write a KB is over Next, before Follow up.');
    expect(BOARD_DRAG.overEnd('Write a KB', 'Next')).toBe('Write a KB is over Next, at the end.');
    expect(BOARD_DRAG.overStart('Write a KB', 'Later')).toBe('Write a KB is over Later, where it started.');
    expect(BOARD_DRAG.moved('Write a KB', 'In progress')).toBe('Write a KB moved to In progress.');
    expect(BOARD_DRAG.stays('Write a KB', 'Later')).toBe('Write a KB stays in Later.');
    expect(BOARD_DRAG.cancelled('Write a KB', 'Later')).toBe('Move cancelled. Write a KB is back in Later.');
  });

  it('counts the alerts the banner stack leaves out', () => {
    expect(BANNERS_MORE(1)).toBe('1 more alert');
    expect(BANNERS_MORE(2)).toBe('2 more alerts');
  });
});

describe('copy pools', () => {
  it('has no line twice in a pool', () => {
    for (const pool of [CELEBRATION_EMOJI, CELEBRATION_PHRASES, STICKER_EMOJI, ...Object.values(PRIORITY_WARNINGS)]) {
      expect(new Set(pool).size).toBe(pool.length);
    }
  });

  it('names no row count in a priority warning: the list starts at priorityCount rows, whatever that is set to', () => {
    const counted = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/i;
    for (const line of Object.values(PRIORITY_WARNINGS).flat()) expect(line).not.toMatch(counted);
  });
});
