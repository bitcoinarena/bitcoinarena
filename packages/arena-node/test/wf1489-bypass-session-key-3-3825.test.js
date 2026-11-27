// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 on #1479's rule as #1597 left it (item 6 + item 5, the fix's own first-wins rule used to block honest users): A LOCKED COPY OF AN
// HONEST ENTRY'S PUBLIC SESSION KEY SHUTS THE HONEST ENTRY OUT OF A PAYING ROUND.
// #1597 answered bypass-session-key-2 (a lockless copy of the key) by letting an earlier entry of the key hold it only when it is backed by a lock
// at this seat (seatedEntriesOf). The copier simply locks: his own stake lock and fee lock, from his own player key, refundable (his copy can never
// win a payout - its address must be signed by the session key - so it ends VOID and the locks come back by their timelock). He reads the honest
// entry at the seat it reached first (GET /entry, public), posts an entry of his own naming the same session key, with his own commitment (a
// commit needs only the public key), to a seat the honest page has not reached yet, and hands its locks there. That seat then refuses the honest
// entry and its resend for good ("one entry per session key"); with fewer than the threshold of seats holding it, the honest entry is no member.
// Before #1479 both entries were taken. Safe behaviour: an entry naming someone else's session key cannot shut the real one out, locked or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { STAKE_LOCK_HEADER } from '../src/server.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xc0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

// THE RELAY'S OWN 700-1200 ms (entry-relay.js): seat-to-seat posts (x-arena-relayed) are held until the test lets them go, as the relay's wait does live
let hold = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const h = init && init.headers ? (init.headers['x-arena-relayed'] || (typeof init.headers.get === 'function' && init.headers.get('x-arena-relayed'))) : null;
  if (h && hold) await hold.p;
  return realFetch(url, init);
};
const holdRelay = () => { let r; hold = { p: new Promise((x) => { r = x; }), release: () => { const q = hold; hold = null; r(); return q; } }; };

test('#1489 bypass-session-key-3: a LOCKED copy of the honest session key at the second seat shuts the honest paid entry out there', async () => {
  holdRelay();
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 60000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const [s0, s1] = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    // the honest page's entry (and its locks) have reached seat 0; its post to seat 1 is still on its way
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true, unreached: [1] });
    const seen = await fetch(`${s0}/entry?id=${toHex(honest.eid)}`);
    assert.equal(seen.status, 200);
    // the copier: his own player key, his own locks (refundable), the honest PUBLIC session key, his own commitment - to seat 1 only
    let copy;
    try { copy = await lockAndPlay(w, mk(2), { session: honest.session, hidden: { move: PAPER, salt: salt() }, noMarks: true, unreached: [0] }); copy = 'taken+locked'; }
    catch (e) { copy = String(e.message).split('\n')[0].slice(0, 160); }
    // the honest page's post lands at seat 1: its handout (with its lock shown), its entry - and its resend
    const h = await fetch(`${s0}/handout?id=${toHex(honest.entry.vssSharesRef)}`);
    const hb = new Uint8Array(await h.arrayBuffer());
    const shown = { [STAKE_LOCK_HEADER]: JSON.stringify({ outpoint: `${toHex(honest.outpoint.txid)}:${honest.outpoint.outIdx}`, fields: lockFieldsToJson(honest.fields) }) };
    const ph = await fetch(`${s1}/handout`, { method: 'POST', body: hb, headers: shown });
    const answers = [];
    for (let i = 0; i < 2; i++) { const r = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(honest.entry) }); answers.push(`${r.status} ${(await r.text()).slice(0, 120)}`); }
    hold.release();
    await new Promise((r) => setTimeout(r, 1500));   // the relay's copy of the honest entry arrives too
    const held = !!w.nodes[1].round.entry(honest.eid);
    console.log('  FACTS (#1489 bypass-session-key-3):', JSON.stringify({ copy, handout: ph.status, answers, heldAtSeat1: held }));
    assert.equal(copy, 'taken+locked', 'the locked copy was not taken (the denial needs it)');
    assert.ok(held && answers.every((a) => a.startsWith('201')), `the honest paid entry was refused at the seat a locked copy of its session key reached first: ${JSON.stringify(answers)}`);
  } finally { await w.close(); }
});
