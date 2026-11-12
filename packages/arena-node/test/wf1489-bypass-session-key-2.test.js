// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 on #1479's own new rule (item 6, the fix opens a denial): AN HONEST ENTRY IS SHUT OUT BY A COPY OF ITS PUBLIC SESSION KEY.
// The /entry door now refuses an entry whose session key another entry of the round already names - but an entry carries no signature of
// its session key (the key is a plain public field, GET /entry hands it to anyone), so whoever sees an honest entry at one seat posts an entry
// of his own naming the same session key to a seat the honest one has not reached yet. That seat then refuses the honest entry for good
// ("one entry per session key"), its resend too, and with fewer than the threshold of seats holding it the honest entry is no member (§17).
// Before #1479 both entries were taken. Safe behaviour: a forged entry naming someone else's session key cannot shut the real one out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const mk = (n) => ({ name: `p${n}`, key: b32(0x30 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

// THE RELAY'S OWN 700-1200 ms (entry-relay.js AFTER_MS + SPREAD_MS): live, a seat hands a client's entry on only after that. The fixture's
// skipping clock puts the round's entry close at "now" for the relay (it reads Date.now), so it goes at once here; seat-to-seat posts
// (x-arena-relayed) are held until the test lets them go, as the relay's wait does live.
let hold = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const h = init && init.headers ? (init.headers['x-arena-relayed'] || (typeof init.headers.get === 'function' && init.headers.get('x-arena-relayed'))) : null;
  if (h && hold) await hold.p;
  return realFetch(url, init);
};
const holdRelay = () => { let r; hold = { p: new Promise((x) => { r = x; }), release: () => { const q = hold; hold = null; r(); return q; } }; };

test('#1489 bypass-session-key-2: a copied session key at the second seat shuts the honest entry out there', async () => {
  holdRelay();
  const w = await lockRound({ stakeMsat: 0n, minScore: 2, endMs: testNow() + 60000 });   // entry close far off: the relay waits its 700 ms (CLOSE_MARGIN_MS sends at once near the close)
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const [s0, s1] = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    // the honest page's entry has reached seat 0 (its post to seat 1 is still on its way)
    const honest = await lockAndPlay(w, mk(1), { noMarks: true, only: [], feeLock: false, unreached: [1] });
    // the copier reads it at seat 0 (public) and posts an entry of his own under the same session key to seat 1 only.
    // Only the PUBLIC key reaches the door: the fixture builds the entry from the key pair, and with noMarks and no address nothing is signed.
    const seen = await fetch(`${s0}/entry?id=${toHex(honest.eid)}`);
    assert.equal(seen.status, 200);
    let copy;
    try { copy = await lockAndPlay(w, mk(2), { session: honest.session, noMarks: true, only: [], feeLock: false, unreached: [0] }); copy = 'taken'; }
    catch (e) { copy = String(e.message).split('\n')[0].slice(0, 160); }
    // the honest page's post lands at seat 1: its handout, then its entry - and its resend
    const h = await fetch(`${s0}/handout?id=${toHex(honest.entry.vssSharesRef)}`);
    const hb = new Uint8Array(await h.arrayBuffer());
    const ph = await fetch(`${s1}/handout`, { method: 'POST', body: hb });
    const answers = [];
    for (let i = 0; i < 2; i++) { const r = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(honest.entry) }); answers.push(`${r.status} ${(await r.text()).slice(0, 120)}`); }
    hold.release();
    await new Promise((r) => setTimeout(r, 1500));   // the relay's copy of the honest entry now arrives too
    const held = !!w.nodes[1].round.entry(honest.eid);
    console.log('  FACTS (#1489 bypass-session-key-2):', JSON.stringify({ copy, handout: ph.status, answers, heldAtSeat1: held }));
    assert.equal(copy, 'taken', 'the copy was not even taken (the denial needs it)');
    assert.ok(held && answers.every((a) => a.startsWith('201')), `the honest entry was refused at the seat a copy of its session key reached first: ${JSON.stringify(answers)}`);
  } finally { await w.close(); }
});
