// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute 75, skeptic 2, test 2 (a bypass of #2174, the fix of #1745's lockout): THE ONE FEDERATION READ PER STAKE POINT A SECOND IS
// TAKEN BY WHOEVER ASKS FIRST. An entry held aside past the lockless cap is entered at POST /lock once stakeLockHeldAtEntry finds its lock - but a stake
// point is asked at most once per LOCKLESS_PROBE_MS (1 s), keyed by round and stake point, not by entry. A copier holds an entry of its own aside under
// the honest handout's stake point (3 more are allowed after the honest one) and hands a junk lock for IT just before each of the honest client's
// hand-overs: its read fails (another refund key), the stake point is spent for a second, and the honest POST /lock finds "no such entry" (404) every
// time. The client hands its lock until LOCK_HAND_MS and stops; the honest locked player is never seated.
// (test 1's header follows)
// THE HELD-ASIDE SLOTS OF A STAKE POINT GO TO WHOEVER COMES FIRST.
// Past the lockless cap an entry is held aside only while its stake point has fewer than PENDING_PER_POINT (4) held entries - "the first ones". A
// handout is public bytes that every seat of the round takes before the entry (the page posts it to every seat first and waits for their answers),
// and its A0 is the entry's stake point. A seat of the round (or anyone handed the handout) posts 4 entries of its own - fresh player and session
// keys, no lock - naming that handout and that stake point to every other seat while it holds its own handout answer. The honest entry that follows is
// then refused there with the cap's "try again in a minute", though its stake lock is already made, and its lock hand-over finds no entry (404).
// SAFE: an honest player whose stake lock is made is seated past the cap, whatever entries others posted naming its handout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { LOCKLESS_PER_SEAT, LOCKLESS_HOLD_MS } from '../src/round.js';
import { STAKE_LOCK_HEADER } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { pluginForRound } from '../src/plugins.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const OPEN_MS = 3n * BigInt(LOCKLESS_HOLD_MS);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE,
  committeeTimeMs: 500n, entryCloseMs: 500n + OPEN_MS, startTimeMs: 60500n + OPEN_MS };
const mk = (n) => ({ name: `p${n}`, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const hid = (i) => ({ hidden: { move: i % 3, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });
const base = (d) => `http://127.0.0.1:${d.port}`;

// an entry into the round, as lockAndPlay builds one, naming `stakePoint` and handout `ref`
function entryOf(w, { playerKey, stakePoint, ref }) {
  const f = pluginForRound(w.c, w.nodes[0].round.plugins);
  const session = ed25519.utils.randomSecretKey();
  const entry = {
    roundId: w.rid, playerPubkey: playerKey, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(rand(32)), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat, f.ok ? entryFeeBpsOf(f.plugin.manifest) : undefined), donationMsat: 0n,
    joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: ref, stakePoint,
    feePreimage: rand(32), stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: rand(32), outIdx: 1n },
    claimKeyAttestationRef: b32(0x9a),
  };
  entry.commit = headToHeadCommit({ roundId: w.rid, entryKey: entry.sessionPubkey, move: 0, salt: rand(32) });
  return entry;
}

test('#1489 a44-75 s2-2: a copier spending the stake point\'s federation read does not keep the honest locked player\'s lock out', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 5 * LOCKLESS_HOLD_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const cap = LOCKLESS_PER_SEAT * 2;
    for (let i = 0; i < cap; i++) { try { await lockAndPlay(w, mk(0x41 + i), { ...hid(i), only: [] }); } catch { /* refused */ } }

    const who = mk(0x20);
    const preimage = secretScalar(), e = rand(32);
    const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: w.needed || 2, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const ref = handoutId(dealt.handout), stakePoint = dealt.handout.commitments[0];
    const entry = entryOf(w, { playerKey: who.key, stakePoint, ref });
    const eid = entryId(entry);
    const fields = { paymentImage: { kind: 'point', bytes: stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk, refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
    await w.port.put(entry.stakeLockOutpoint, fields);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(entry.feePreimage) }, amountMsat: entry.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
    await w.port.put(entry.feeLockOutpoint, feeFields);
    const shown = { [STAKE_LOCK_HEADER]: JSON.stringify({ outpoint: `${toHex(entry.stakeLockOutpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) };
    const first = [];
    for (const d of w.nodes) {
      const h = await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout), headers: shown });
      assert.equal(h.status, 201, await h.text());
      const j = await fetch(`${base(d)}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      first.push(`${j.status}:${j.headers.get('x-arena-entry') || (await j.text()).slice(0, 80)}`);
    }
    // the honest entry is held aside at every seat (#2174 working); now the copier's own entry under the same stake point, held aside too
    const copy = entryOf(w, { playerKey: b32(0x70), stakePoint, ref });
    const copied = [];
    for (const d of w.nodes) { const r = await fetch(`${base(d)}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); copied.push(`${r.status}:${r.headers.get('x-arena-entry') || ''}`); }

    // the client hands its lock again and again (#handLocksUntilTaken); before each hand-over the copier hands a junk lock for its own entry
    const tries = [];
    for (let t = 0; t < 5; t++) {
      for (const d of w.nodes) await fetch(`${base(d)}/lock?entry=${toHex(entryId(copy))}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      const st = [];
      for (const d of w.nodes) { const l = await fetch(`${base(d)}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) }); st.push(l.status); }
      tries.push(st);
      skipTo(testNow() + 1100);
    }
    const held = w.nodes.map((d) => !!d.round.entry(eid));
    console.log('  FACTS (a44-75 s2-2):', JSON.stringify({ cap, first, copied, tries, held }));
    assert.deepEqual(held, w.nodes.map(() => true), `the honest entry, its stake lock made and handed 5 times, was entered at no seat that a copier probed first: ${JSON.stringify(tries)}`);
  } finally { await w.close(); }
});
