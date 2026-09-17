/**
 * Every phrase the app says to the user that is not a plain label lives here, so they can be
 * edited without touching logic. Keep them plain: short sentences, no cheerleading, no
 * "gentle reminder" openers. See the Copy convention in AGENTS.md.
 */

/** Shown once the day is done. One is picked per clock-out. */
export const CELEBRATION_EMOJI = ['🎉', '🥳', '🌟', '✨', '🙌', '💪', '🏆', '🎈', '🚀', '🌈', '🍀', '🎊', '👏', '😎', '🔥', '🥇', '🌻', '🫶', '🏁', '🧠'];

/** The sticker chart's stickers: one per thing a day did, drawn at random from here. */
export const STICKER_EMOJI = ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐨', '🐸', '🦄', '🐥', '🐢', '🦋', '🐝', '🐧', '🦉', '🐹', '🐣', '🌸', '🌷', '🍓'];

/** The sticker chart before any day in its window has earned one. */
export const STICKERS_EMPTY = 'Nothing here yet. Stickers appear as days get logged.';

export const CELEBRATION_PHRASES = [
  'Nice work today.',
  "That's a wrap.",
  'You showed up. That counts.',
  'Go be a person now.',
  'Done. The rest can wait until tomorrow.',
  'Enough for one day. Good job.',
  'Off the clock. Act like it.',
  "Day's done. Go eat something.",
  'That was a day. You did it anyway.',
  'Put the laptop down slowly and step away.',
  "See you tomorrow. Or Monday, if it's Friday.",
  "The work will still be there tomorrow. You don't have to be.",
  'Logged, punched, done.',
  "Well, that's today handled.",
  'Nothing more to do here. Really.',
  'Solid day. Now go outside.',
  "You made it to the end. That's the whole job.",
  'Close the lid.',
  "Leave the tabs open. They'll keep.",
  'Good. Now stop.',
];

/** Shown when adding a priority past the threshold. One is picked per attempt. */
export const GENTLE_WARNINGS = [
  'Three is already a full plate. Sure about a fourth?',
  'More rows means each one matters a little less.',
  "Everything can't be the most important thing.",
  'A long list is where priorities go to hide.',
  'Is this for today, or for some day?',
  'Fine, but if you could only do one today, which one?',
  'Three plates is carrying. Six is juggling.',
  "The list doesn't get shorter by getting longer.",
  'Bold move. Today thing or someday thing?',
  'Done beats listed.',
  'Sure? Tomorrow has room too.',
  "That's another promise to yourself. Still want it?",
  'The top of the list is prime real estate. Row six is the suburbs.',
  'Ambition noted. Energy budget also noted.',
  'You could also just not.',
  'This is where "top" quietly becomes "all".',
  'Fewer, finished, feels better. Just saying.',
  'Adding is easy. Crossing off is the fun part.',
  "If it won't make today a win, park it for tomorrow.",
  'Is that a priority, or a worry in a to-do costume?',
];

/** Shown instead when some rows are already ticked. Counts live in the notice header, not here. */
export const PROGRESS_WARNINGS = [
  'Some of this is already done. Are you adding, or avoiding what is left?',
  'You have cleared part of the list. The open rows still need the rest of the day.',
  'A few are ticked. Do the open ones fit before this new one?',
  'There is still an open row. Is this more important than it?',
  'You have done real work already. A new row does not count more than that.',
  'Adding now, with rows still open, means one of them slips. Which one?',
  'Part of the plan is done. Is this the rest of it, or a new plan?',
  'Good progress. Does this belong today, or is it leaking in from tomorrow?',
  "The ticked ones are today's win. Don't bury them under new rows.",
  'You have momentum. Spend it on the open rows first?',
];

/** Shown when every row is ticked. */
export const COMPLETE_WARNINGS = [
  'Everything is ticked. Anything you add now is extra, not owed.',
  "The plan is done. This one is a bonus, or it is tomorrow's first row.",
  "You finished the list. Adding more means today can't end as a clean win.",
  "All done. Sure you're not just filling the quiet?",
  'Plan complete. A new row now is optional. Treat it that way.',
  'Nothing is open. Is this urgent, or just available?',
  "You did what you said you'd do. Stop there, or add one with a light grip.",
  'List cleared. If you add this, it is allowed to stay unfinished.',
  "Done means done. Tomorrow's sheet has empty rows.",
  "The day is already a win. Don't renegotiate it.",
];

/** Buttons under the warning, by how much of the list is done. */
export const WARNING_ACTIONS = {
  fresh: { add: 'Add anyway', keep: 'Keep it short' },
  progress: { add: 'Add anyway', keep: "Finish what's open" },
  complete: { add: 'Add a bonus', keep: 'Stop here' },
} as const;

/** Confirm dialogs. Each names what goes and that it stays gone. */
export const CONFIRM = {
  cancelSession: 'Cancel this session? It will not be logged.',
  deleteSession: 'Delete this session from the log?',
  deleteUser: (name: string) => `Delete ${name} and ALL of their data? This cannot be undone.`,
} as const;

/** The alert when a focus timer reaches zero. */
export const TIMER_DONE = {
  title: 'Focus session complete',
  body: (label: string, duration: string) => (label ? `${label} · ${duration}` : `${duration} logged.`),
} as const;

/** Placeholder for the day's retrospective note. */
export const RETRO_PROMPT = 'What got in the way? What went to plan?';

/** Banner when a punch, priority, note, log edit, timer action or layout change fails to reach the server. */
export const SAVE_FAILED = {
  title: 'Change not saved',
  body: 'The server did not answer. The sheet shows what is stored.',
} as const;

/** In place of a sheet whose day could not be fetched; the button asks again. */
export const LOAD_FAILED = {
  title: 'Could not load this day',
  body: 'The server did not answer.',
  retry: 'Try again',
} as const;

/** The whole page, when something threw while rendering. */
export const RENDER_FAILED = {
  title: 'Something went wrong',
  body: 'The page hit an error it could not recover from. Reloading usually clears it.',
  reload: 'Reload',
} as const;

/** Settings dialog save indicator, shown in the dialog header. */
export const SAVE_STATUS = {
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Not saved',
  failedDetail: "The last change didn't save and was put back.",
} as const;

/** Settings dialog footer: the button and the confirm before every setting goes back to default. */
export const RESET_SETTINGS = {
  button: 'Reset all settings',
  confirm: 'Reset every setting to its default? Days, punches and sessions are kept.',
} as const;

/** Settings → Data: the confirm before old days are deleted, and the result line. */
export const DELETE_DAYS = {
  confirm: (n: number, before: string) => `Delete ${days(n)} before ${before}? This cannot be undone.`,
  done: (n: number) => `Deleted ${days(n)}.`,
} as const;

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}
