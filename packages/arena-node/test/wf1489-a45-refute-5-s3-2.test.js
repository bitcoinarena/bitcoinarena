// kanban #1489 a45 refute 5, skeptic 3 (#2245 second copy): keepCert `supersede` replaces the held seating in seat_certs, the agent's certs,
// the table's reseat list and (settlement) the round's signer nodes - but server.js keeps a SECOND COPY of every round's seated committees,
// committeeDrawn (committeeOf: "kept only once both roles are seated", never dropped while the round is held). A seat that held M's S for the
// few seconds before its confirm read, and answered one GET /rounds / liveNow / GET /round in them, keeps listing S's seated set for the
// round's life after it moved to T: the listing, the live check and the round door name S. Only reseatTable (a table's later check-in)
// clears that cache; onSeated with `replaced` does not. Checked on the source: the `replaced` branch must drop that round's kept draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('a45 refute 5 s3-4: a seating that replaced the one held (kanban #2245) drops the round\'s kept committee (committeeDrawn)', () => {
  assert.match(src, /const committeeDrawn = new Map\(\)/, 'the kept draw exists');
  assert.match(src, /if \(drawn\.drawn && \(!seating \|\| \(drawn\.seated && drawn\.seated\.game && drawn\.seated\.settlement\)\)\) committeeDrawn\.set/, 'kept once both roles are seated');
  const at = src.indexOf('onSeated: (rid, role, seated, contract = null, { replaced = false } = {}) => {');
  assert.ok(at > 0, 'onSeated takes `replaced`');
  const body = src.slice(at, src.indexOf('} }) : null;', at));
  // the game role returns before anything is done, and the settlement branch drops only tablesSeated
  assert.ok(!/^\s*if \(role !== 'settlement'\) return;/m.test(body.split('replaced')[0]) || /committeeDrawn\.delete/.test(body),
    'a replaced GAME seating returns at once: the kept committee (and its game list) still names the seating left behind');
  assert.match(body, /committeeDrawn\.(delete|clear)/, 'a replaced seating must drop the kept committee, or GET /rounds keeps naming S');
});
