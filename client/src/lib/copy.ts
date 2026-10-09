/**
 * What the app raises at the user lives here (celebrations, the priority warnings, confirms,
 * alerts, banners, notices), so it can be edited without touching logic. Labels, settings
 * hints and empty-state lines stay beside the control or view they describe. Keep all of it
 * plain: short sentences, no cheerleading, no "gentle reminder" openers. See the Copy
 * convention in AGENTS.md.
 */

import { BOARD_LIMITS } from '../../../shared/api.js';
import { counted } from './format';

/** The day-complete notice picks one per clock-out (pickCelebration); every celebration burst draws its pieces from here (pickBurst). */
export const CELEBRATION_EMOJI = ['🎉', '🥳', '🌟', '✨', '🙌', '💪', '🏆', '🎈', '🚀', '🌈', '🍀', '🎊', '👏', '😎', '🔥', '🥇', '🌻', '🫶', '🏁', '🧠'];

/** The sticker chart's stickers: one per thing a day did, drawn at random from here. */
export const STICKER_EMOJI = ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐨', '🐸', '🦄', '🐥', '🐢', '🦋', '🐝', '🐧', '🦉', '🐹', '🐣', '🌸', '🌷', '🍓'];

/** The Timeclock notice once the day is done; one of the phrases below follows it. */
export const DAY_COMPLETE = 'Day complete.';

/** Follows `DAY_COMPLETE` in the Timeclock notice. One is picked per clock-out. */
export const CELEBRATION_PHRASES = [
  'Log off before another email lands.',
  "That's a wrap.",
  "Clocked out. That's it for today.",
  'Go be a person now.',
  'Done. The rest can wait until tomorrow.',
  'Enough for one day.',
  'Off the clock. Act like it.',
  "Day's done. Go eat something.",
  "That was a day. It's over.",
  'Put the laptop down slowly and step away.',
  "See you tomorrow. Or Monday, if it's Friday.",
  "The work will still be there tomorrow. You don't have to be.",
  'Punched out and logged.',
  "Well, that's today handled.",
  'Nothing more to do here. Really.',
  'Go outside for a bit.',
  'End of the day. Nothing left to punch.',
  'Close the lid.',
  "Leave the tabs open. They'll keep.",
  'Good. Now stop.',
  "Tomorrow's sheet starts blank.",
  'Shut it down before you think of one more thing.',
  "Home time, even if you're already home.",
  'The inbox will refill overnight either way.',
  'Go do literally anything else.',
  'You can drop the work voice now.',
  'Your brain can clock out too.',
  'The rest of today is yours.',
  'Mute the work chat on your way out.',
  'Drink some water. You probably forgot to.',
  'No more meetings today. Probably.',
  'The list is closed until tomorrow.',
  "You don't owe the day anything else.",
  "If something's nagging you, write it down and leave it.",
  'Stand up. Your back has been patient all day.',
  'Eyes off the screen for a while.',
  "Text someone who isn't a coworker.",
  'Leave the half-done thing half done.',
  "Put the work stuff where you can't see it.",
  'Take the long way home, if there is one.',
];

/**
 * Shown when adding a priority past the threshold, by how much of the list is ticked
 * (`nudgeFor`): none, some, all. One is picked per attempt; counts live in the notice header,
 * not here.
 */
export const PRIORITY_WARNINGS = {
  fresh: [
    "That's a full plate already. Sure about one more?",
    'More rows means each one matters a little less.',
    "Everything can't be the most important thing.",
    'A long list is where priorities go to hide.',
    'Is this for today, or for some day?',
    'Fine, but if you could only do one today, which one?',
    'Carrying a few plates is one thing. Juggling them is another.',
    "The list doesn't get shorter by getting longer.",
    'Done beats listed.',
    'Sure? Tomorrow has room too.',
    "That's another promise to yourself. Still want it?",
    'The top of the list is prime real estate. The bottom is the suburbs.',
    'Ambition noted. Energy budget also noted.',
    'You could also just not.',
    'This is where "top" quietly becomes "all".',
    'Short lists get finished more often.',
    'Adding is easy. Crossing off is the fun part.',
    "If it won't make today a win, park it for tomorrow.",
    'Is that a priority, or a worry in a to-do costume?',
  ],
  progress: [
    'Some of this is already done. Are you adding, or avoiding what is left?',
    'You have cleared part of the list. The open rows still need the rest of the day.',
    'A few are ticked. Do the open ones fit before this new one?',
    'There is still an open row. Does this come before it?',
    'You have done real work already. A new row does not count more than that.',
    'Adding now, with rows still open, means one of them slips. Which one?',
    'Part of the plan is done. Is this the rest of it, or a new plan?',
    'Does this belong today, or is it leaking in from tomorrow?',
    "The ticked ones are today's win. Don't bury them under new rows.",
    'The open rows were the plan. Do them first?',
  ],
  complete: [
    'Everything is ticked. Anything you add now is extra.',
    "The plan is done. This one is a bonus, or it is tomorrow's first row.",
    "You finished the list. Adding more means today can't end as a clean win.",
    "All done. Sure you're not just filling the quiet?",
    'Plan complete. A new row now is optional. Treat it that way.',
    'Nothing is open. Is this urgent, or just available?',
    "You did what you said you'd do. Stop there, or add one with a light grip.",
    'List cleared. If you add this, it is allowed to stay unfinished.',
    "Done means done. Tomorrow's sheet has empty rows.",
    "You set the bar this morning. Don't raise it now.",
  ],
};

/** Buttons under the warning, by how much of the list is done. */
export const WARNING_ACTIONS = {
  fresh: { add: 'Add anyway', keep: 'Keep it short' },
  progress: { add: 'Add anyway', keep: "Finish what's open" },
  complete: { add: 'Add a bonus', keep: 'Stop here' },
} as const;

/** Under a Top priorities row being retyped, while earlier days' lists hold its task: the name is one for every day. */
export const RENAME_NOTE = (earlier: number) => `Also renames it on ${counted(earlier, 'earlier day')}.`;

/** Under a Top priorities row whose box was emptied: a blank name isn't saved. */
export const BLANK_NOTE = (name: string) => `Left empty, it goes back to “${name}”. × takes it off this day.`;

/** Where a task is and the time logged on it, for a question that deletes it everywhere: "It is on 3 days, and 1h 20m is logged on it." */
const taskFacts = (where: string, logged: string | null) => {
  const time = logged ? `${logged} is logged on it` : '';
  return where && time ? `${where}, and ${time}.` : `${where || time}.`;
};
/** After `taskFacts` once time is logged: a full delete keeps it. */
const unplanned = (logged: string | null) => (logged ? ' The time stays in the log, unplanned.' : '');

/**
 * The question × on a Top priorities row asks when its task is on other days or has time logged
 * on it. `logged` is null with no time; each part of the body shows only when it applies.
 */
export const REMOVE_TASK = {
  title: (name: string) => `Remove ${name}`,
  body: (otherDays: number, logged: string | null) =>
    `${taskFacts(otherDays ? `It is on ${counted(otherDays, 'other day')}` : '', logged)} Delete everywhere takes it off every day.${unplanned(logged)}`,
  offDay: 'Off this day',
  everywhere: 'Delete everywhere',
  cancel: 'Cancel',
} as const;

/** On today's empty priorities, when the last day with a plan left rows unticked. */
export const LEFT_OPEN = {
  title: (from: string) => `Still open from ${from}`,
  add: 'Add to today',
  dismiss: 'Start fresh',
};

/**
 * The morning notice's recurring group (with the board on): its heading, the button that answers
 * it, and the line when more are ticked than Recurring rows per day.
 */
export const TODAY_OFFER = {
  recurring: 'Repeats today',
  notToday: 'Not today',
  over: (n: number) => `More than ${counted(n, 'recurring row')} today.`,
} as const;

/** Confirm dialogs. Each names what it does; the two that delete a user or many days say it cannot be undone. */
export const CONFIRM = {
  cancelSession: 'Cancel this session? It will not be logged.',
  deleteSession: 'Delete this session from the log?',
  deleteBreak: 'Delete this break from the log?',
  deleteUser: (name: string) => `Delete ${name} and ALL of their data? This cannot be undone.`,
  signOut: 'Sign out of Clockspan on this device?',
  resetSettings: 'Reset every setting to its default? Days, punches and sessions are kept.',
  deleteDays: (n: number, before: string) => `Delete ${counted(n, 'day')} before ${before}? This cannot be undone.`,
  /** The board's Delete: how many days' lists hold the task, and the time logged on it (null with none). */
  deleteTask: (days: number, logged: string | null) =>
    days || logged
      ? `Delete this task everywhere? ${taskFacts(days ? `It is on ${counted(days, 'day')}` : '', logged)}${unplanned(logged)}`
      : 'Delete this task?',
  deleteRecurring: (title: string) => `Remove ${title}? It stops repeating. Days it was on keep it.`,
} as const;

/** A timer line, with the session's name (`useTimer().name`) in front when it has one. */
const named = (name: string, text: string) => (name ? `${name} · ${text}` : text);

/**
 * The alert when a focus timer reaches zero: the session stays open until it is finished or
 * given more time. `more` is the banner button.
 */
export const TIMER_DUE = {
  title: "Time's up",
  body: (name: string, planned: string) => named(name, `${planned}. Finish, or add more time.`),
  more: (minutes: number) => `Add ${minutes} min`,
} as const;

/** The dialog when Finish is pressed a whole minute or more past the end: which length to log. */
export const FINISH_CHOICE = {
  title: 'How much to log?',
  body: (over: string | null) => (over ? `The timer ran out ${over} ago.` : 'The timer just ran out.'),
  planned: (duration: string) => `Planned · ${duration}`,
  worked: (duration: string) => `Worked · ${duration}`,
  back: 'Back',
} as const;

/** The alert when a timer that ran out got no answer and was logged at its planned length. */
export const TIMER_DONE = {
  title: 'Focus session complete',
  body: (name: string, duration: string) => named(name, `${duration} logged.`),
} as const;

/** Banner when a pause was left for an hour: the session was closed where the pause began. */
export const TIMER_PAUSED_OUT = {
  title: 'Focus session closed',
  body: (name: string, duration: string) => named(name, `${duration} logged. It sat paused for an hour, so it ended where the pause began.`),
} as const;

/** The focus timer's break: the button, the line while it runs, and the banner when it's over. */
export const BREAK = {
  start: (minutes: number, long: boolean) => `${long ? 'Long break' : 'Break'} · ${minutes} min`,
  running: (until: string) => `Break until ${until}`,
  end: 'End break',
  over: "Break's over",
  overBody: 'Pick the next thing, or start a timer.',
} as const;

/**
 * With Suggest breaks on, the banner after a session is finished by hand: the break it earned
 * (`lib/breaks.ts`) and a button that starts it. `of` is the number of sessions in a set.
 */
export const BREAK_SUGGESTION = {
  kicker: (position: number, of: number) => `Session ${position} of ${of}`,
  title: (minutes: number, long: boolean) => (long ? `Take a long break, ${minutes} min` : `Take a ${minutes} min break`),
  body: (focus: string, long: boolean, of: number) => (long ? `For the ${focus} logged over all ${of}.` : `For the ${focus} you just logged.`),
  start: 'Start break',
} as const;

/** The one button an alarm banner can carry: clock-out's and the retrospective's. */
export const ALARM_ACTIONS = {
  approveOvertime: 'Overtime approved',
  openRetro: 'Open retrospective',
} as const;

/** Banner when a start finds a timer already running, started on another device. */
export const TIMER_ELSEWHERE = {
  title: 'A timer is already running',
  body: 'It was started on another device. This sheet now shows that one.',
} as const;

/** Above the banner stack when more are raised than it draws; closing one brings the next back. */
export const BANNERS_MORE = (n: number) => counted(n, 'more alert');

/** Under the timeclock's tiles while the second meal period applies: when it is due, and after how long. */
export const SECOND_MEAL_NOTE = (overdue: boolean, at: string, worked: string) =>
  `Second meal period ${overdue ? 'was due' : 'due'} by ${at} (${worked} worked)`;

/**
 * Above the sheet when set punch times don't alternate in, out, in, out: the row out of place and
 * the one it should come after, as the card names them, with their times (`afterAt` null: empty).
 */
export const PUNCH_ORDER = (row: string, at: string, after: string, afterAt: string | null) =>
  afterAt == null ? `${row} (${at}) has no ${after} before it.` : `${row} (${at}) is earlier than ${after} (${afterAt}).`;

/** The Worked and Clock out at tiles' line while the punches are out of order, where any number would be a guess. */
export const CHECK_PUNCHES = 'Check punches';

/** A session logged without a label, wherever sessions are listed. */
export const UNTITLED_SESSION = 'Untitled session';

/** The retrospective's planner for the next work day (`name` is "tomorrow" or a date). */
export const PLAN_NEXT = {
  open: (name: string) => `Plan ${name}`,
  title: (name: string) => `Plan for ${name}`,
  already: (n: number) => `${n} already on the list`,
  placeholder: 'Something else for the list',
  save: (name: string) => `Add to ${name}`,
  done: (n: number, name: string) => `${counted(n, 'row')} added for ${name}.`,
  nothing: 'Nothing new to add.',
} as const;

/** Placeholder for the day's retrospective note. */
export const RETRO_PROMPT = 'What got in the way? What went to plan?';

/**
 * Banner when a punch, priority, note, log edit, timer action, layout change, board move, new
 * category, Delete everywhere or settings save isn't saved.
 * One banner covers a request that got no answer and one the server turned down (a break
 * started while a timer runs, a session another device deleted), so the body names both.
 * It says nothing of what the sheet shows: the change is gone from it, except a retro note,
 * which stays in its box to send again (`useDebouncedDraft`).
 */
export const SAVE_FAILED = {
  title: 'Change not saved',
  body: 'The server refused it or did not answer.',
} as const;

/**
 * Under the timer's Start buttons when "Also add to today's priorities" can't add the row, and the
 * board's banner when the store refuses a move onto today's list (`MoveRefused`).
 */
export const ADD_PRIORITY_FAILED = {
  full: 'The priorities list is full.',
  notLoaded: "This day's priorities have not loaded yet.",
} as const;

/**
 * The board's refusals: a banner when the store turns a move down (`full`), and the board
 * notice's lines for a move refused before anything is sent (`recurringStays`, `planned`,
 * `removed`), with `close` its button. `full` is also the capture box's line while it is shut at the cap.
 * `nameTaken` is Settings → Board's line under a category named like another in use. `doneOn` is
 * the editor's line on a task ticked on an earlier day, which the board doesn't untick; `when`
 * is `dayName`'s in-sentence word or date. `plannedSheet` is the editor's line on a task a later
 * day's list holds, in place of Move to.
 */
export const BOARD = {
  full: `Later and Next hold ${BOARD_LIMITS.openCards} cards at most.`,
  recurringStays: (title: string) => `${title} stays on today's list. Use Remove from today.`,
  planned: (title: string, when: string) => `${title} is planned for ${when}. Tick it or take it off on that day's sheet.`,
  removed: (title: string) => `${title} was removed from the recurring priorities.`,
  close: 'Close',
  nameTaken: 'There is already a category with that name.',
  doneOn: (when: string) => `Done ${when}. Untick it on that day's sheet.`,
  plannedSheet: "Tick it or take it off on that day's sheet.",
} as const;

/**
 * The board notice when a done item is moved into Later or Next: it stays done, more work goes on
 * a new card, and work that keeps coming back can be a recurring priority. `announce` is what a
 * screen reader hears as such a drag ends.
 */
export const DONE_STAYS = {
  title: (title: string) => `${title} is done.`,
  body: 'More work on it goes on a new card. If it keeps coming back, make it a recurring priority in Settings → Board.',
  add: (lane: string) => `Add a new card to ${lane}`,
  leave: 'Leave it',
  announce: (title: string, lane: string) => `${title} stays in Done. The notice can add a new card to ${lane}.`,
} as const;

/**
 * What a screen reader hears while a card is dragged on the board: picked up, where it would land
 * (in Later or Next, before which card, or back where it started), and how it ended. A drop that changes something, or is
 * turned down, says so through `moveAnnouncement` (`lib/board.ts`).
 */
export const BOARD_DRAG = {
  pickedUp: (title: string, column: string) => `Picked up ${title}, in ${column}.`,
  over: (title: string, column: string) => `${title} is over ${column}.`,
  overBefore: (title: string, column: string, next: string) => `${title} is over ${column}, before ${next}.`,
  overEnd: (title: string, column: string) => `${title} is over ${column}, at the end.`,
  overStart: (title: string, column: string) => `${title} is over ${column}, where it started.`,
  moved: (title: string, column: string) => `${title} moved to ${column}.`,
  stays: (title: string, column: string) => `${title} stays in ${column}.`,
  cancelled: (title: string, column: string) => `Move cancelled. ${title} is back in ${column}.`,
} as const;

/**
 * What a screen reader hears while a sheet card is dragged in Customize: picked up, its place
 * in the list (`n` of `total`) as it moves, and where it was dropped or put back.
 */
export const CARD_DRAG = {
  pickedUp: (title: string) => `Picked up ${title}.`,
  at: (title: string, n: number, total: number) => `${title} is at position ${n} of ${total}.`,
  dropped: (title: string, n: number, total: number) => `Dropped ${title} at position ${n} of ${total}.`,
  cancelled: (title: string, n: number, total: number) => `Move cancelled. ${title} is back at position ${n} of ${total}.`,
} as const;

/** A request that got no answer within `REQUEST_TIMEOUT_MS` (`api.ts`), where a form shows its error. */
export const REQUEST_TIMEOUT = 'The server did not answer in time.';

/** A refusal whose body has no `{ error }` to show (`api.ts`), such as a proxy's error page. */
export const REQUEST_FAILED = (status: number) => `Request failed (${status})`;

/** A 2xx answer that isn't JSON (`api.ts`): a page from something in between, such as a proxy's sign-in page. */
export const UNREADABLE_ANSWER = (status: number) => `Unreadable answer (${status})`;

/**
 * The banner when the server names a version other than this page's build (`api.ts`): the page
 * was loaded before an update, and its saves may not suit the new server. The button reloads.
 */
export const UPDATED = {
  title: 'Clockspan was updated',
  body: 'Reload the page so your changes keep saving.',
  reload: 'Reload',
} as const;

/**
 * In place of what could not be fetched, and the banner a failed day load raises; the button
 * asks again. Covers a refusal too, like `SAVE_FAILED`.
 */
export const LOAD_FAILED = {
  title: 'Could not load this day',
  range: 'Could not load these days',
  board: 'Could not load the board',
  body: 'The server refused the request or did not answer.',
  retry: 'Try again',
} as const;

/**
 * Sign-in pages. `hint` shows when the server marks its cookie Secure and the page was opened
 * over plain http; `notKept` when a sign-in answered 2xx but the next request had no session.
 */
export const HTTPS_ONLY = {
  hint: 'This server keeps sessions over https only. Open the app through its https address before signing in.',
  notKept: 'Signed in, but the browser did not keep the session cookie. Open the app through its https address and try again.',
} as const;

/** Under the new-password fields (setup, a temporary password, Settings → Account) when the two differ. */
export const PASSWORD_MISMATCH = 'The two passwords do not match.';

/** Settings → Account, once the password was changed. */
export const PASSWORD_CHANGED = 'Password updated.';

/** After signing in on a temporary password (an admin's, or one the CLI generated), before the app. */
export const NEW_PASSWORD = {
  title: 'Choose your own password',
  body: 'The password you signed in with was set for you. Pick one of your own to continue.',
} as const;

/** The whole page, when `/api/auth/me` got no answer before the app opened. */
export const SERVER_UNREACHABLE = {
  body: (error: string) => `Can't reach the server: ${error}`,
  retry: 'Retry',
} as const;

/** A sign-out that did not go through: a banner over the app, the error line on the new-password page. */
export const SIGN_OUT_FAILED = 'Not signed out: the server refused the request or did not answer.';

/** The whole page, when something threw while rendering. */
export const RENDER_FAILED = {
  title: 'Something went wrong',
  body: 'The page hit an error it could not recover from. Reloading usually clears it.',
  reload: 'Reload',
} as const;

/** The settings dialog's save indicator in its header, and the line at the top of the dialog body when a save fails. */
export const SAVE_STATUS = {
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Not saved',
  failedDetail: "The last change didn't save and was put back.",
} as const;

/** Settings → Data: the line after old days are deleted. */
export const DAYS_DELETED = (n: number) => `Deleted ${counted(n, 'day')}.`;
