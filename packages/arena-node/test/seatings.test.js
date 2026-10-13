// A NODE THAT KEEPS MISSING ITS SEATS IS WARNED (§5A.3, kanban #302): drawn and not seated, three times in a row, newest first - and the
// serving = false update is offered. A round it was not drawn for is no seating it missed; one it sat ends the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missedInARow, seatingWarning } from '../src/seatings.js';

test('missed seatings count in a row from the newest, skip rounds not drawn for, and warn from three', () => {
  const r = (atMs, drawn, seated) => ({ atMs, drawn, seated });
  assert.equal(missedInARow([r(1, true, true), r(2, true, false), r(3, false, false), r(4, true, false)]), 2);
  assert.equal(missedInARow([r(4, true, false), r(1, true, false), r(3, true, false), r(2, true, true)]), 2, 'ordered by time, not by the list');
  assert.equal(missedInARow([r(1, true, false), r(2, true, false), r(3, true, false)]), 3);
  assert.equal(seatingWarning(2), null);
  const w = seatingWarning(3);
  assert.match(w.says, /drawn and not seated 3 times in a row/); assert.match(w.says, /serving = false/); assert.match(w.update, /ARENA_ADVERT_SERVING=false/);
});
