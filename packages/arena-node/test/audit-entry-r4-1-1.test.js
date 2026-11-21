// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT entry r4-1 #1: a paying entry that names NO handout (vssSharesRef = 32 zero bytes) is taken at POST /entry, its stake
// lock verified at POST /lock, and it is seated - but no seat holds shares of its stake point P. When it loses (here: walks
// away, FORFEIT 0), the round's settlement must open the loser's P to claim its lock, and cannot: "a loser's P could not be
// opened: that entry published no shares". The whole settlement is refused, the winner is never paid, and the loser's lock
// expires back to him - a free roll that also holds every honest payout of the round.
// SAFE: either the seats refuse such a paying entry (or its lock) at the door, or the round settles with its lock claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, nameAddress } from './lock-round-fixture.js';
import { WINNER, LOSER, b32, wait, rand, secretScalar } from './window-fixture.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { entryGiftsInFee, entryFeeBpsForRound } from '../../arena-protocol/src/reserves.js';
import { pluginForRound } from '../src/plugins.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';

const gameFeeBps = (w) => { const f = pluginForRound(w.c, w.a.round.plugins); if (!f.ok) return undefined;
  return entryGiftsInFee(w.c, f.plugin.manifest) ? entryFeeBpsForRound(w.c, f.plugin.manifest) : entryFeeBpsOf(f.plugin.manifest); };

test('a paying entry with no handout (vssSharesRef zero) is refused, or its lost stake is claimed at settlement', async () => {
  const port = lockPort();
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 500 } });
  try {
    const won = await lockAndPlay(w, WINNER);
    await nameAddress([w.a, w.b], won);
    // THE ATTACKER'S ENTRY: a real stake point P (he knows p), a real stake and fee lock - but no handout posted, no shares named
    const who = { ...LOSER, name: 'noshares', key: b32(0x21) };
    const session = ed25519.utils.randomSecretKey();
    const preimage = secretScalar();
    const e = rand(32);
    const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed || 2, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const feeSecret = rand(32);
    const outpoint = { txid: rand(32), outIdx: 0n }, feeOutpoint = { txid: rand(32), outIdx: 1n };
    const entry = {
      roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat, gameFeeBps(w)), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0xc1), vssSharesRef: new Uint8Array(32), stakePoint: dealt.handout.commitments[0],
      feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint, claimKeyAttestationRef: b32(0x9a),
    };
    const eid = entryId(entry);
    const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    await w.port.put(feeOutpoint, feeFields);
    const doors = [];
    for (const d of [w.a, w.b]) {
      const base = `http://127.0.0.1:${d.port}`;
      const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      const j = [joined.status, (await joined.text()).slice(0, 120)];
      const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
      const l = [locked.status, (await locked.text()).slice(0, 120)];
      const fee = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      const f = [fee.status, (await fee.text()).slice(0, 120)];
      doors.push({ entry: j, lock: l, fee: f, seen: !!d.round.stakeSeen(eid) });
    }
    console.log('  FACTS (doors):', JSON.stringify(doors));
    const refused = doors.every((x) => !x.seen);
    if (refused) return;   // the safe answer at the door: no seat staked an entry whose P it can never open
    const results = (d) => d.round.results(w.rid, eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
    for (const stop = Date.now() + 60000; Date.now() < stop && !(results(w.a).length && results(w.b).length); await wait(250));
    console.log('  FACTS (walk-away):', JSON.stringify({ a: results(w.a).map((r) => [r.outcome, r.score]), b: results(w.b).map((r) => [r.outcome, r.score]) }));
    await closeRound(w);
    const st = await untilSettled(w, 60000);
    const key = `${toHex(outpoint.txid)}:${outpoint.outIdx}`;
    const claimed = port.settlements.some((x) => (x.claims || []).some((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}` === key));
    console.log('  FACTS (settled):', JSON.stringify({ state: st.state, why: String(st.why).slice(0, 200), lockClaimed: claimed, lockStillHeld: port.locks.has(key) }));
    assert.equal(st.state, 'ACCEPTED', `a staked entry with no shares holds the whole round's settlement: ${st.why}`);
    assert.ok(claimed, 'the no-shares loser\'s stake lock is not claimed');
  } finally { await w.close(); }
});
