// audit 2026-11-22b entry r3-1: THE #3320 FIX BRINGS BACK THE #2477 SPLIT IN HEAD-TO-HEAD (AND MARKET) ROUNDS.
// #3320 made a stake seen here "built on" in every round with no receipts (head-to-head, attested): round.stakePlayedOn answers true as
// soon as stake_seen holds the entry, so yieldEntryLocks never lets it go and a LOWER entry of the same player key is refused. That is the
// per-seat first-come rule #2477 removed: two entries of one player key (a reload mid-join, the seed on two devices, or a player on purpose)
// whose locks land in another order at two seats are staked one at one seat and the other at the other, for good.
// Invariant (#2477): seats of one round stake the same entries of a player key, whatever order the locks came in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });

test('audit entry a6-3-1: two head-to-head entries of one player key whose locks cross between seats are staked alike at both seats', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // one player key, two entries (a reload mid-join: the old tab's entry and the new PLAY's), both at both seats, no lock yet
    const one = await lockAndPlay(w, { ...mk(1), name: 'tab-1' }, { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const two = await lockAndPlay(w, { ...mk(1), name: 'tab-2' }, { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const hand = async (d, p) => {
      const l = await fetch(`${base(d)}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
      const lw = (await l.text()).slice(0, 90);
      const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(p))) });
      const fw = (await f.text()).slice(0, 90);
      return { lock: [l.status, lw], fee: [f.status, fw] };
    };
    // entry one's locks land at seat 0 first and entry two's at seat 1 first ...
    const first = await Promise.all([hand(w.a, one), hand(w.b, two)]);
    // ... then each reaches the other seat too
    const late = [await hand(w.b, one), await hand(w.a, two)];
    for (let i = 0; i < 20; i++) await wait(10);
    const staked = (d) => ({ one: !!d.round.stakeSeen(one.eid), two: !!d.round.stakeSeen(two.eid),
      seated: d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 16)) });
    const at = { seat0: staked(w.a), seat1: staked(w.b) };
    console.log('  FACTS a6-3-1:', JSON.stringify({ one: toHex(one.eid).slice(0, 16), two: toHex(two.eid).slice(0, 16),
      lower: Buffer.compare(Buffer.from(one.eid), Buffer.from(two.eid)) < 0 ? 'one' : 'two', first, late, at }));
    assert.deepEqual(at.seat0, at.seat1, 'the two seats of the head-to-head round stake (and seat) different entries of one player key');
  } finally { await w.close(); }
});
