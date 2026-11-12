// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm7-find-entry 1: ONE DONATION OUTPUT IS ONE ENTRY'S - ALSO WHEN TWO LOCKS ARRIVE AT ONCE. verifyDonationOutputs
// (stake-lock-signer-node.js) reads donationOutputAt(outpoint) before it asks the federation (awaits), and verifyStakeLock writes the rows
// (putDonationOutputs, INSERT OR REPLACE by outpoint) after more awaits; the re-check at the write (#1214) re-reads the stake outpoint only.
// Two /lock hand-overs of two entries naming the same donation outputs, in flight together, both pass: both stakes are kept and counted, and
// one entry's developers' (and on protocol 11 the reserves') share was never paid - the second entry plays on the first one's donation.
// Sequentially the second is refused ("that donation output already pays for another entry"), so the only gap is the interleaving.
// (Test shortcut: entry B reuses A's handout and stake point; a real second entry would carry its own - nothing here reads it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const STAKE = 100_000_000n;
const DONATION = STAKE * 500n / 10000n;
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 sm7-entry-1 two stake locks handed at once for two entries naming the same donation outputs: only one entry is staked', async () => {
  const w = await lockRound({ stakeMsat: STAKE, serveOpts: { plugins: [NEXTBLOCK], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] }, round: { donationSetId: donationSetId(NETWORK) } });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // ENTRY A: posted to every seat with its donation outputs paid; its locks not handed yet
    const a = await lockAndPlay(w, player('a', 0x41), { only: [], noMarks: true, donation: { msat: DONATION, target: { network: NETWORK, game: NEXTBLOCK.donationSet } } });
    assert.ok(a.donated.length > 0, 'the fixture made no donation output');
    // ENTRY B: another player key and session key, its own stake and fee lock, and A's donation outpoints - it pays no donation of its own
    const bKey = b32(0x42);
    const bSession = ed25519.utils.randomSecretKey();
    const bFee = rand(32);
    const b = { ...a.entry, playerPubkey: bKey, sessionPubkey: ed25519.getPublicKey(bSession), feePreimage: bFee,
      stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: rand(32), outIdx: 1n } };
    const bId = entryId(b);
    const bFields = { ...a.fields, refundPk: refundKeyOf(bKey) };
    await w.port.put(b.stakeLockOutpoint, bFields);
    const bFeeFields = { paymentImage: { kind: 'hash', bytes: sha256(bFee) }, amountMsat: b.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(bKey), expiration: a.fields.expiration };
    await w.port.put(b.feeLockOutpoint, bFeeFields);
    const aFeeFields = { paymentImage: { kind: 'hash', bytes: sha256(a.entry.feePreimage) }, amountMsat: a.entry.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(a.entry.playerPubkey), expiration: a.fields.expiration };
    const d = w.a, base = `http://127.0.0.1:${d.port}`;
    const posted = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(b) });
    assert.equal(posted.status, 201, await posted.text());
    // fee locks first (the stake then counts at once)
    for (const [eid, f] of [[a.eid, aFeeFields], [bId, bFeeFields]]) {
      const r = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(f)) });
      assert.equal(r.status, 201, await r.text());
    }
    // A FEDERATION THAT TAKES A MOMENT TO ANSWER, as every real one does: both hand-overs are in flight together
    const status = w.port.status.bind(w.port);
    w.port.status = async (o) => { await new Promise((r) => setTimeout(r, 150)); return status(o); };
    const [la, lb] = await Promise.all([[a.eid, a.fields], [bId, bFields]].map(async ([eid, f]) => {
      const r = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(f)) });
      return { status: r.status, why: (await r.text()).slice(0, 160) };
    }));
    const staked = { a: !!d.round.stakeSeen(a.eid), b: !!d.round.stakeSeen(bId), aLock: !!d.round.stakeLock(a.eid), bLock: !!d.round.stakeLock(bId) };
    const owners = a.donated.map((x) => { const t = d.round.donationOutputAt(x.outpoint); return t ? toHex(t.entryId).slice(0, 8) : null; });
    console.log('  FACTS sm7-entry-1:', JSON.stringify({ lockA: la, lockB: lb, staked, donationOwners: owners, a: toHex(a.eid).slice(0, 8), b: toHex(bId).slice(0, 8) }));
    assert.ok(!(staked.a && staked.b), 'both entries are staked and counted on one set of donation outputs: one of them paid no donation');
    assert.ok(!(la.status === 201 && lb.status === 201), 'both /lock answered 201 for two entries over the same donation outputs');
  } finally { await w.close(); }
});
