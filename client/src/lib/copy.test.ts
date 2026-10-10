import { describe, expect, it } from 'vitest';
import {
  BANNERS_MORE,
  BOARD,
  BOARD_DRAG,
  BREAK,
  BREAK_SUGGESTION,
  CARD_DRAG,
  CELEBRATION_EMOJI,
  CELEBRATION_PHRASES,
  CONFIRM,
  DAYS_DELETED,
  DONE_STAYS,
  FINISH_CHOICE,
  LEFT_OPEN,
  LOAD_FAILED,
  PRIORITY_WARNINGS,
  PUNCH_ORDER,
  REMOVE_TASK,
  RENAME_HINT,
  BLANK_HINT,
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
  it('names the punch out of place and the one it should come after, or that one missing', () => {
    expect(PUNCH_ORDER('Lunch in', '11:00 AM', 'Lunch out', '12:00 PM')).toBe('Lunch in (11:00 AM) is earlier than Lunch out (12:00 PM).');
    expect(PUNCH_ORDER('Clock out', '5:00 PM', 'Lunch in', null)).toBe('Clock out (5:00 PM) has no Lunch in before it.');
  });

  it('names the user in the delete confirm', () => {
    expect(CONFIRM.deleteUser('sam')).toBe('Delete sam and ALL of their data? This cannot be undone.');
  });

  it('says how far a rename reaches, and what a blank name does', () => {
    expect(RENAME_HINT(3)).toBe('Also renames it on 3 earlier days.');
    expect(RENAME_HINT(1)).toBe('Also renames it on 1 earlier day.');
    expect(BLANK_HINT('Email Bob')).toBe('Left empty, it goes back to “Email Bob”. × takes it off this day.');
  });

  it('asks before × takes a task off a day, with the parts of the body that apply', () => {
    expect(REMOVE_TASK.title('Email Bob')).toBe('Remove Email Bob');
    expect(REMOVE_TASK.body(3, '1h 20m', false)).toBe(
      'It is on 3 other days, and 1h 20m is logged on it. Delete Everywhere takes it off every day. The time stays in the log, unplanned.',
    );
    expect(REMOVE_TASK.body(1, null, false)).toBe('It is on 1 other day. Delete Everywhere takes it off every day.');
    expect(REMOVE_TASK.body(0, '25m', false)).toBe('25m is logged on it. Delete Everywhere takes it off every day. The time stays in the log, unplanned.');
    expect(REMOVE_TASK.body(1, null, true)).toBe('It is on 1 other day. Delete Everywhere takes it off every day. Its note goes with the task.');
    expect(REMOVE_TASK.body(0, null, true)).toBe(
      'It is on no other day, so Off This Day deletes it and its note too, unless the board keeps it in Later or Next.',
    );
  });

  it('names the day the offered priorities were left open on', () => {
    expect(LEFT_OPEN.title('Yesterday')).toBe('Still Open From Yesterday');
  });

  it('names the number a day in the offer', () => {
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
    expect(BREAK.start(20, true)).toBe('Long Break · 20 min');
    expect(BREAK.running('10:35 AM')).toBe('Break until 10:35 AM');
  });

  it('offers the break a session earned and says what it was sized on', () => {
    expect(BREAK_SUGGESTION.kicker(2, 4)).toBe('Long break after 2 more sessions');
    expect(BREAK_SUGGESTION.kicker(3, 4)).toBe('Long break after 1 more session');
    expect(BREAK_SUGGESTION.kicker(4, 4)).toBe('4 sessions in a row');
    expect(BREAK_SUGGESTION.title(5, false)).toBe('Take a 5 min Break');
    expect(BREAK_SUGGESTION.title(20, true)).toBe('Take a Long Break, 20 min');
    expect(BREAK_SUGGESTION.body('25m', false)).toBe('For the 25m you just logged.');
    expect(BREAK_SUGGESTION.body('1h 40m', true)).toBe('For the 1h 40m logged across them.');
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

  it("gives a deleted task's days and logged time, each where it applies", () => {
    expect(CONFIRM.deleteTask(0, null)).toBe('Delete this task?');
    expect(CONFIRM.deleteTask(4, '1h 20m')).toBe(
      'Delete this task everywhere? It is on 4 days, and 1h 20m is logged on it. The time stays in the log, unplanned.',
    );
    expect(CONFIRM.deleteTask(1, null)).toBe('Delete this task everywhere? It is on 1 day.');
    expect(CONFIRM.deleteTask(0, '5m')).toBe('Delete this task everywhere? 5m is logged on it. The time stays in the log, unplanned.');
  });

  it('names the task a first day makes repeat, and says where it goes and that it stays a recurring priority', () => {
    expect(CONFIRM.makeRecurring('Weekly report')).toBe(
      "Make Weekly report repeat? Off today's list it shows under Repeats, not in Later or Next. This cannot be undone.",
    );
  });

  it('names the recurring priority Stop repeating ends, and says its days keep it', () => {
    expect(CONFIRM.deleteRecurring('Follow-ups')).toBe(
      "Stop repeating Follow-ups? It won't show under Repeats or be offered again. The days it was on keep it.",
    );
  });

  it('names the card and the day in the board refusals, and the cap in the full line', () => {
    expect(BOARD.full).toBe('Later and Next hold 300 cards at most.');
    expect(BOARD.recurringStays('Monitor the queue')).toBe('Monitor the queue repeats, so it stays under Repeats.');
    expect(BOARD.removed('Follow-ups')).toBe('Follow-ups stopped repeating.');
    expect(BOARD.doneOn('yesterday')).toBe("Done yesterday. Untick it on that day's sheet.");
    expect(BOARD.doneOn('Mon, Oct 5')).toBe("Done Mon, Oct 5. Untick it on that day's sheet.");
    expect(BOARD.doneAhead('tomorrow')).toBe("Ticked on the list for tomorrow. Untick it on that day's sheet once the day comes.");
  });

  it('says a done item stays done and offers a new card in the lane it was moved to', () => {
    expect(DONE_STAYS.title('Ship the fix')).toBe('Ship the fix is done.');
    expect(DONE_STAYS.body).toBe('More work on it goes on a new card. If it keeps coming back, open it and pick its days under Repeat.');
    expect(DONE_STAYS.add('Next')).toBe('Add a New Card to Next');
    expect(DONE_STAYS.announce('Ship the fix', 'Next')).toBe('Ship the fix stays in Done. The notice can add a new card to Next.');
  });

  it('names the card and the column in what a drag on the board says', () => {
    expect(BOARD_DRAG.instructions).toBe('Enter opens the card. Space picks it up; then the arrow keys move it, Space drops it and Escape puts it back.');
    expect(BOARD_DRAG.pickedUp('Write a KB', 'Later')).toBe('Picked up Write a KB, in Later.');
    expect(BOARD_DRAG.over('Write a KB', 'In Progress')).toBe('Write a KB is over In Progress.');
    expect(BOARD_DRAG.overBefore('Write a KB', 'Next', 'Follow up')).toBe('Write a KB is over Next, before Follow up.');
    expect(BOARD_DRAG.overEnd('Write a KB', 'Next')).toBe('Write a KB is over Next, at the end.');
    expect(BOARD_DRAG.overStart('Write a KB', 'Later')).toBe('Write a KB is over Later, where it started.');
    expect(BOARD_DRAG.moved('Write a KB', 'In Progress')).toBe('Write a KB moved to In Progress.');
    expect(BOARD_DRAG.stays('Write a KB', 'Later')).toBe('Write a KB stays in Later.');
    expect(BOARD_DRAG.cancelled('Write a KB', 'Later')).toBe('Move cancelled. Write a KB is back in Later.');
  });

  it('names the card and its place in what a drag on the sheet says', () => {
    expect(CARD_DRAG.pickedUp('Focus timer')).toBe('Picked up Focus timer.');
    expect(CARD_DRAG.at('Focus timer', 2, 5)).toBe('Focus timer is at position 2 of 5.');
    expect(CARD_DRAG.dropped('Focus timer', 3, 5)).toBe('Dropped Focus timer at position 3 of 5.');
    expect(CARD_DRAG.cancelled('Focus timer', 2, 5)).toBe('Move cancelled. Focus timer is back at position 2 of 5.');
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
