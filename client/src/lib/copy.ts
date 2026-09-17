/**
 * Every phrase the app says to the user that is not a plain label lives here, so they can be
 * edited without touching logic. Keep them plain: short sentences, no cheerleading, no
 * "gentle reminder" openers. See the Copy convention in AGENTS.md.
 */

/** Shown once the day is done. One is picked per clock-out. */
export const CELEBRATION_EMOJI = ['🎉', '🥳', '🌟', '✨', '🙌', '💪', '🏆', '🎈', '🚀', '🌈', '🍀', '🎊', '👏', '😎', '🔥', '🥇', '🌻', '🫶', '🏁', '🧠'];

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
