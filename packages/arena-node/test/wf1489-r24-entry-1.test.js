// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r24 entry-1: THE HELD-ASIDE MAP IS ONE GLOBAL MAP OF PENDING_MAX (4096) ENTRIES, FILLED BY STRANGERS FOR FREE (a bypass of #2174/#2438).
// Past the lockless cap an entry is held aside for its lock (pendingLockless), but the map holds at most 4096 entries for the whole seat, each
// live for LOCKLESS_HOLD_MS. A stranger deals 1024 handouts of its own fresh player keys (free, kept up to HANDOUTS_LOOSE_CEILING per round) and
// posts 4 lockless entries per handout: 4096 held-aside entries, no sat locked. From then on every honest entry that meets the lockless cap is
// refused ('too many held aside' -> the cap's refusal) - even one whose stake lock the federation already holds - so the honest lock is 404.
// SAFE: an honest player whose stake lock is made is seated past the cap, however many lockless entries strangers hold aside.
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


test('#1489 r24 entry-1: strangers filling the global held-aside map do not keep an honest locked player out past the lockless cap', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 5 * LOCKLESS_HOLD_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const cap = LOCKLESS_PER_SEAT * 2;
    for (let i = 0; i < cap; i++) { try { await lockAndPlay(w, mk(0x41 + i), { ...hid(i), only: [] }); } catch { /* refused */ } }
    const d0 = w.nodes[0];
    // THE STRANGER: 1024 handouts of fresh player keys, 4 lockless entries each, at seat 0 only - no sat locked
    const counts = {};
    const HANDOUTS = 1024;
    for (let b = 0; b < HANDOUTS; b += 32) {
      await Promise.all(Array.from({ length: 32 }, async (_, j) => {
        const key = rand(32); const e = rand(32);
        const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
          coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: w.needed || 2, curve: feldmanGroup });
        if (!dealt.ok) { counts.deal = (counts.deal || 0) + 1; return; }
        const h = await fetch(`${base(d0)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
        await h.arrayBuffer();
        const hk = `h${h.status}`; counts[hk] = (counts[hk] || 0) + 1;
        if (h.status !== 201) return;
        const ref = handoutId(dealt.handout), stakePoint = dealt.handout.commitments[0];
        for (let i = 0; i < 4; i++) {
          const r = await fetch(`${base(d0)}/entry`, { method: 'POST', body: encodeEntryContract(entryOf(w, { playerKey: key, stakePoint, ref })) });
          await r.arrayBuffer();
          const k = `e${r.status}${r.headers.get('x-arena-entry') ? ':' + r.headers.get('x-arena-entry') : ''}`; counts[k] = (counts[k] || 0) + 1;
        }
      }));
    }

    // THE HONEST PLAYER, as in a44-75 s2-1: its stake and fee locks made first, its handout shown with its lock
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
    const h = await fetch(`${base(d0)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout), headers: shown });
    assert.equal(h.status, 201, await h.text());
    const j = await fetch(`${base(d0)}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const jt = (await j.text()).slice(0, 160);
    const l = await fetch(`${base(d0)}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    const lt = (await l.text()).slice(0, 160);
    console.log('  FACTS (r24 entry-1):', JSON.stringify({ cap, counts, entry: j.status, hdr: j.headers.get('x-arena-entry'), entryWhy: jt, lock: l.status, lockWhy: lt, held: !!d0.round.entry(eid) }));
    assert.equal(j.status, 201, `the honest entry, its stake lock made, was refused after strangers filled the held-aside map: ${jt}`);
    assert.equal(l.status, 201, `the honest stake lock was not taken: ${lt}`);
    assert.equal(!!d0.round.entry(eid), true, 'seat 0 holds no honest entry');
  } finally { await w.close(); }
});
