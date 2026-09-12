// THE START DEADLINE THE SETTLING FIXTURE ROUNDS NAME (§16, ENTRY_VOID).
//
// These fixtures plant ONE first mark, at the end of a player's run - the
// winner at 1320, the loser at 1000 - where the page marks from tick 60. Under
// the page's own window (START_DEADLINE_TICKS, 900, what a round that names
// none gets) each of those first marks is after the line, and the entry is
// ENTRY_VOID: the run never settles. They are runs that must settle, so each
// such round NAMES a start deadline past its latest plant, explicitly. The
// omitted default is not moved for them, and a test that wants a Void builds a
// round that names none (entry-void.test.js).
export const PLANTED_FIRST_MARK_DEADLINE = 1400;
