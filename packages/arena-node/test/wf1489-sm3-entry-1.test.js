// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm3-find-entry 1 (state machine audit, entry), fixed as kanban #1839: THE PAGE LETS GO OF A LOCK THE SEATS STILL HOLD FOR ITS FIRST ENTRY.
// A tab posts its entry to every seat (201) and is reloaded (or its /lock post fails) before the lock reaches them. The new tab asks the seats
// where the lock is (findLock = GET /stake-lock, which lists only VERIFIED locks), every seat answers "none", and releaseUntakenEntry (#1254) let
// the entry go: the lock was "reuse" again, and the tab sent a new entry (new session key) naming the same lock. Since the #1489 entry-1 fix every
// seat refuses that lock ("named first by another entry"), and no seat ever verifies it for the first entry either (that tab is gone). The
// player's stake and fee were locked, no entry of his staked, and the refused-lock return refused too (he entered at the seat): his sats waited
// for the lock's expiry and he never played.
// Safe behaviour (#1839): the page is not told the lock is free while a seat holds the entry naming it (entryHeldAt, GET /entry), and such an
// entry - one holding no verified lock at a seat - counts as entered nothing there: after the close plus grace every seat keeps its stake and
// fee lock for their return (POST /refused-lock) and the forfeit returns them at once. A lock kept so is never verified for an entry afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { findLock, entryHeldAt, releaseUntakenEntry, lockRecordOf } from '../../arena-client/src/page-lock.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const memStorage = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };

test('#1489 sm3-entry-1 / #1839: a lock whose entry the seats hold is not let go of after a reload, and it comes back after the close', { timeout: 120000 }, async () => {
  const GRACE = 600000;
  const w = await lockRound({ serveOpts: { unenteredGraceMs: GRACE } });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const who = player('reloader', 0x71);
    // tab 1: the entry reaches every seat, then the tab is gone before its locks are handed
    const first = await lockAndPlay(w, who, { only: [], noMarks: true });
    const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    // tab 1 had bound the lock to its entry (bindLockEntry) before posting it
    const storage = memStorage();
    storage.setItem(`arena.lock.saved.${toHex(w.rid)}.${toHex(who.key).slice(0, 16)}`, JSON.stringify({ state: 'accepted', entry: toHex(first.eid),
      outpoint: { txid: toHex(first.outpoint.txid), outIdx: String(first.outpoint.outIdx) }, fields: lockFieldsToJson(first.fields) }));
    // tab 2 (the reload): asks the seats, as index.html does (#1254, #1839)
    const locks = await findLock({ roundId: w.rid, playerPubkey: who.key, nodes });
    const entries = await entryHeldAt({ entryId: first.eid, nodes });
    const releasedLocksOnly = releaseUntakenEntry(storage, { roundId: w.rid, playerPubkey: who.key, locks });
    const released = releaseUntakenEntry(storage, { roundId: w.rid, playerPubkey: who.key, locks, entries });
    const after = lockRecordOf(storage, { roundId: w.rid, playerPubkey: who.key }).record;
    // a page that let go of it anyway (an old bundle) sends a second entry naming the same lock: still refused at every seat (#1489-1 stands)
    const second = { ...first.entry, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const eid2 = entryId(second);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(first.entry.feePreimage) }, amountMsat: first.entry.feeMsat,
      claimPk: first.fields.claimPk, refundPk: first.fields.refundPk, expiration: first.fields.expiration };
    const said = [];
    for (const base of nodes) {
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(second) });
      const l = await fetch(`${base}/lock?entry=${toHex(eid2)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(first.fields)) });
      said.push({ entry: e.status, lock: l.status });
      await e.text(); await l.text();
    }
    // THE RETURN PATH: past the close and its grace, each seat keeps the stake and the fee lock (no entry of his holds a verified lock there)
    skipTo(Number(w.c.entryCloseMs) + GRACE + 1000);
    const hand = (base, fields, at) => fetch(`${base}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
      body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(fields) }) });
    const kept = [], feeKept = [];
    for (const base of nodes) {
      const r = await hand(base, first.fields, first.outpoint); kept.push([r.status, (await r.text()).slice(0, 120)]);
      const f = await hand(base, feeFields, first.feeOutpoint); feeKept.push([f.status, (await f.text()).slice(0, 120)]);
    }
    const hid = toHex(first.entry.vssSharesRef);
    const fo = await fetch(`${nodes[0]}/forfeit?round=${toHex(w.rid)}&entry=${hid}`);
    const fj = fo.status === 200 ? await fo.json() : { why: await fo.text() };
    const verifies = !!fj.signature && schnorr.verify(fromHex(fj.signature), fromHex(fj.contractId), w.claimPk.subarray(1));
    const listed = await (await fetch(`${nodes[0]}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(who.key))}`)).json();
    const feeRow = listed.find((l) => l.outpoint === `${toHex(first.feeOutpoint.txid)}:${first.feeOutpoint.outIdx}`);
    const ff = feeRow ? await fetch(`${nodes[0]}/forfeit?round=${toHex(w.rid)}&entry=${feeRow.entryId}`) : null;
    const ffj = ff && ff.status === 200 ? await ff.json() : { why: ff ? await ff.text() : 'not listed' };
    const feeVerifies = !!ffj.signature && schnorr.verify(fromHex(ffj.signature), fromHex(ffj.contractId), w.claimPk.subarray(1));
    // and the kept lock is not verified for the first entry afterwards (it would come back AND back a run)
    const late = await fetch(`${nodes[0]}/lock?entry=${toHex(first.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(first.fields)) });
    const lateWhy = await late.text();
    console.log('  FACTS sm3-entry-1:', JSON.stringify({ seatsAnswered: `${locks.answered}/${locks.asked}`, locksListed: locks.length,
      entryHeldBy: `${entries.heldBy.length}/${entries.asked}`, releasedLocksOnly, released, entryAfter: after.entry ?? null, said, kept, feeKept,
      forfeit: [fo.status, verifies, String(fj.why || '').slice(0, 100)], feeForfeit: [ff && ff.status, feeVerifies, String(ffj.why || '').slice(0, 100)],
      lateLock: [late.status, lateWhy.slice(0, 100)] }));
    assert.equal(locks.length, 0, 'the path needs every seat to list no verified lock');
    assert.equal(entries.heldBy.length, nodes.length, 'every seat holds the first entry');
    assert.equal(releasedLocksOnly, false, 'the page let go of a lock on the locks\' answer alone');
    assert.equal(released, false, 'the page let go of a lock whose entry every seat holds');
    assert.equal(after.entry, toHex(first.eid));
    for (const s of said) assert.equal(s.lock, 409, 'a second entry took the lock another entry named first (#1489-1 reopened)');
    for (const [s, why] of kept) assert.equal(s, 201, `the stake lock of an entry with no verified lock is not kept for its return: ${why}`);
    for (const [s, why] of feeKept) assert.equal(s, 201, `the fee lock of an entry with no verified lock is not kept for its return: ${why}`);
    assert.equal(fo.status, 200, fj.why); assert.equal(verifies, true, 'the stake\'s forfeit does not verify under the round\'s claim key');
    assert.equal(ff && ff.status, 200, ffj.why); assert.equal(feeVerifies, true, 'the fee lock\'s forfeit does not verify');
    assert.equal(late.status, 409, 'a lock kept for its return was verified for an entry afterwards');
  } finally { await w.close(); }
});
