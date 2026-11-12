// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute 75, skeptic 2 (a bypass of #2174, the fix of #1745's lockout): THE HELD-ASIDE SLOTS OF A STAKE POINT GO TO WHOEVER COMES FIRST.
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

test('#1489 a44-75 s2: entries copying an honest handout\'s stake point do not keep the honest locked player out past the lockless cap', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 5 * LOCKLESS_HOLD_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the lockless cap filled, as in s1 (a stranger, no sats)
    const cap = LOCKLESS_PER_SEAT * 2;
    for (let i = 0; i < cap; i++) { try { await lockAndPlay(w, mk(0x41 + i), { ...hid(i), only: [] }); } catch { /* refused */ } }

    // THE HONEST PLAYER: its stake lock made in the federation first, its handout posted to every seat with that lock shown (kanban #1596)
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
    for (const d of w.nodes) {
      const h = await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout), headers: shown });
      assert.equal(h.status, 201, await h.text());
    }

    // THE COPIER (seat 0 holding its handout answer, or anyone the handout reached): 4 entries of its own naming that handout and stake point
    const copied = [];
    for (const d of w.nodes) for (let i = 0; i < 4; i++) {
      const c = entryOf(w, { playerKey: b32(0x70 + i), stakePoint, ref });
      const r = await fetch(`${base(d)}/entry`, { method: 'POST', body: encodeEntryContract(c) });
      copied.push(`${r.status}${r.headers.get('x-arena-entry') ? ':' + r.headers.get('x-arena-entry') : ''}`);
    }

    // the honest entry, then its locks, at every seat - as the client hands them
    const said = [];
    for (const d of w.nodes) {
      const j = await fetch(`${base(d)}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      const jt = (await j.text()).slice(0, 120);
      const l = await fetch(`${base(d)}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      const lt = (await l.text()).slice(0, 120);
      said.push({ entry: j.status, entryWhy: j.status === 201 ? '' : jt, lock: l.status, lockWhy: l.status === 201 ? '' : lt });
    }
    const held = w.nodes.map((d) => !!d.round.entry(eid));
    console.log('  FACTS (a44-75 s2-1):', JSON.stringify({ cap, copied, said, held }));
    for (const s of said) assert.equal(s.entry, 201, `the honest entry, its stake lock made, was refused after 4 copies of its handout's stake point: ${s.entryWhy}`);
    for (const s of said) assert.equal(s.lock, 201, `the honest stake lock was not taken: ${s.lockWhy}`);
    assert.deepEqual(held, w.nodes.map(() => true), 'a seat holds no honest entry');
  } finally { await w.close(); }
});
