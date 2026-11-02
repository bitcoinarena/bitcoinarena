// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN READS A HELD LOCK, AND A GATEWAY RUNS THE PROOF (spec §23A.3a, kanban #998, rulings #1030).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createHeldReads, withHeldLock, heldLockFileOf } from '../src/held-read.js';
import { runHeldProof } from '../src/held-proof-run.js';
import { signHeldAsk, heldLockCounted, HELD_CLAIM_PK, heldPaymentImage } from '../../arena-protocol/src/held-proof.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const keyOf = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const guardians = [1, 2, 3, 4].map(keyOf), gateway = keyOf(1), other = keyOf(2), stranger = keyOf(9);
const fid = 'f0'.repeat(32), epoch = 40, inWindow = 144 * 40 + 70, outpoint = 'aa'.repeat(32) + ':0';
const set = { seated: guardians.map((g) => g.hex), threshold: 3 };
const askOf = (over = {}, key = gateway) => signHeldAsk({ federationId: fid, epoch, node: key.hex, outpoint, amountMsat: '100000000', expiration: 300, ...over }, (h) => schnorr.sign(h, key.secret));
const portOf = (blocksLeft = 8, { id = 'cc'.repeat(32), storedId = id, stored = true } = {}) => { const calls = { id: [], status: 0 };
  return { calls, contractId: async (f) => { calls.id.push(f); return id; }, status: async () => { calls.status++; return { blockCount: 292, stored: stored ? { contractId: storedId, blocksLeft } : null }; } }; };
const doorOf = ({ me = other, tip = inWindow, port = portOf(), setFor = async () => set, rulesOn } = {}) => ({ port, door: createHeldReads({ me: me.hex, sign: (h) => schnorr.sign(h, me.secret), tip: async () => tip, portOf: async () => port, setFor, verify, ...(rulesOn ? { rulesOn } : {}) }) });

test('a lock of the fixed shape with 6 left is read and signed, the id recomputed from the fixed fields', async () => {
  const { door, port } = doorOf({ port: portOf(6) });
  const a = await door.answer(askOf());
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.equal(a.body.guardian, other.hex);
  assert.deepEqual([a.body.blocksLeft, a.body.tipHeight, a.body.contractId, a.body.gateway], [6, inWindow, 'cc'.repeat(32), gateway.hex]);
  const f = port.calls.id[0];
  assert.deepEqual([toHex(f.claimPk), toHex(f.refundPk), f.amountMsat, f.expiration, toHex(f.paymentImage.bytes)], [HELD_CLAIM_PK, '02' + gateway.hex, 100000000n, 300, toHex(heldPaymentImage(gateway.hex, epoch))]);
});

test('any other lock counts 0: another contract at the outpoint, none there, or 5 left are refused', async () => {
  assert.match((await doorOf({ port: portOf(8, { storedId: 'dd'.repeat(32) }) }).door.answer(askOf())).body.why, /not the held proof's contract/);
  assert.match((await doorOf({ port: portOf(8, { stored: false }) }).door.answer(askOf())).body.why, /holds no lock/);
  assert.match((await doorOf({ port: portOf(5) }).door.answer(askOf())).body.why, /5 blocks left/);
});

test('the window both ways, and the tip names the epoch', async () => {
  for (const t of [144 * 40 + 68, 144 * 40 + 73]) assert.equal((await doorOf({ tip: t }).door.answer(askOf())).code, 409, `tip ${t}`);
  for (const t of [144 * 40 + 69, 144 * 40 + 72]) assert.equal((await doorOf({ tip: t }).door.answer(askOf())).code, 200, `tip ${t}`);
  assert.equal((await doorOf({ tip: 144 * 41 + 70 }).door.answer(askOf())).code, 409, 'last epoch\'s ask in the next window');
});

test('only a signed ask from a seated guardian, to a seated guardian, on a network with the rules', async () => {
  assert.equal((await doorOf().door.answer({ ...askOf(), expiration: 301 })).code, 400);
  assert.match((await doorOf().door.answer(askOf({}, stranger))).body.why, /only a seated guardian/);
  assert.match((await doorOf({ me: stranger }).door.answer(askOf())).body.why, /not a seated guardian/);
  assert.equal((await doorOf({ setFor: async () => null }).door.answer(askOf())).code, 503);
  const off = doorOf({ rulesOn: () => false });
  assert.equal((await off.door.answer(askOf())).code, 409);
  assert.equal(off.port.calls.status, 0, 'no read where the rules are off');
});

test('a lock is read once, and a refused gateway stops being read after 12 asks', async () => {
  const { door, port } = doorOf();
  const [x, y] = [await door.answer(askOf()), await door.answer(askOf())];
  assert.deepEqual(x.body, y.body);
  assert.equal(port.calls.status, 1);
  const none = doorOf({ port: portOf(8, { stored: false }) });
  const codes = []; for (let i = 0; i < 14; i++) codes.push((await none.door.answer(askOf({ outpoint: `${'bb'.repeat(32)}:${i}` }))).code);
  assert.deepEqual(codes, [...Array(12).fill(409), 429, 429]);
  assert.equal(none.port.calls.status, 12);
});

test('a federation that does not answer is said as such, and the read is not used up', async () => {
  const port = { contractId: async () => 'cc'.repeat(32), status: async () => { throw new Error('quorum'); } };
  assert.match((await doorOf({ port }).door.answer(askOf())).body.why, /did not answer: quorum/);
});

test('the claim door joins the held lock of its own federation, and a claim file with none is as it was', () => {
  const claim = { federationId: fid, node: 'x' }, file = '/c.json';
  assert.equal(heldLockFileOf(file), '/c.json.held-lock.json');
  assert.deepEqual(withHeldLock(claim, file, () => ({ federationId: fid, outpoint })).heldLock, { federationId: fid, outpoint });
  assert.equal(withHeldLock(claim, file, () => ({ federationId: 'ee'.repeat(32) })), claim);
  assert.equal(withHeldLock(claim, file, () => { throw new Error('no file'); }), claim);
});

// THE GATEWAY'S RUN, on fakes that keep the money's books
function world({ tip = inWindow, lockFails = false, lockLandsThenFails = false, refundSlow = 0, blocksToExpiry = 2, stopAt = null, refundRefusedOnce = false } = {}) {
  const b = { gatewayd: 1_000_000_000n, client: 0n, locked: 0n, count: 290 }, calls = [], saved = [];
  let refused = refundRefusedOnce, stored = null, slow = refundSlow, doors = guardians.map((g) => doorOf({ me: g, tip, port: { contractId: async () => 'cc'.repeat(32), status: async () => ({ blockCount: b.count, stored: stored ? { contractId: 'cc'.repeat(32), blocksLeft: stored.expiration - b.count } : null }) } }).door);
  const hit = (s) => { calls.push(s); if (s === stopAt) { stopAt = null; throw new Error(`stopped at ${s}`); } };
  const gatewayd = { sendEcash: async (m) => { hit('send'); b.gatewayd -= m; return `notes-${m}`; }, receiveEcash: async (n) => { hit('home'); b.gatewayd += BigInt(n.split('-')[1]); } };
  const client = { receive: async (n) => { hit('receive'); b.client += BigInt(n.split('-')[1]); return { state: 'Success' }; },
    lock: async (l) => { hit('lock'); if (lockFails) throw new Error('refused'); b.client -= l.amountMsat; b.locked += l.amountMsat; stored = { expiration: b.count + l.expiryDelta }; if (lockLandsThenFails) throw new Error('killed at its timeout'); return { outpoint, expiration: stored.expiration, contractId: 'cc'.repeat(32) }; },
    blockCount: async () => { b.count += blocksToExpiry; return b.count; },
    refund: async (r) => { hit('refund'); assert.ok(b.count >= r.expiration, 'never before expiry'); if (refused) { refused = false; return { accepted: false, error: 'not yet' }; } b.owed = b.locked - 512n; b.locked = 0n; stored = null; if (!slow) { b.client += b.owed; b.owed = 0n; } return { accepted: true }; },
    settle: async () => { hit('settle'); if (--slow <= 0 && b.owed) { b.client += b.owed; b.owed = 0n; } },
    balance: async () => b.client, send: async (m) => { hit('sendback'); b.client -= m; return `notes-${m}`; } };
  const seats = { info: async () => ({ tip, epoch: Math.floor(tip / 144), open: tip >= 144 * 40 + 69 && tip <= 144 * 40 + 72, window: { from: 144 * 40 + 69, to: 144 * 40 + 72 }, threshold: 3,
    guardians: guardians.map((g, i) => ({ node: g.hex, url: `https://g${i}` })) }),
    ask: async (url, ask) => { const i = Number(url.at(-1)); const a = await doors[i].answer(ask); if (a.code !== 200) throw new Error(a.body.why); return a.body; } };
  const box = { j: null }, journal = { load: () => (box.j ? JSON.parse(box.j) : null), save: (x) => { box.j = JSON.stringify(x); } };
  const go = () => runHeldProof({ journal, gatewayd, client, seats, node: gateway.hex, federationId: fid, amountMsat: 100000000n, sign: (h) => schnorr.sign(h, gateway.secret), verify, saveProof: (p) => saved.push(p), sleep: async () => {} });
  return { b, calls, saved, go, box, seats, setDoors: (d) => { doors = d; } };
}

test('send, lock, read, wait, refund, home: the proof counts, and the money is back but for the lock\'s cost', async () => {
  const w = world();
  const j = await w.go();
  assert.equal(j.step, 'done');
  assert.deepEqual(w.calls, ['send', 'receive', 'lock', 'refund', 'sendback', 'home']);
  assert.equal(w.saved.length, 1);
  assert.equal(heldLockCounted({ heldLock: w.saved[0], federationId: fid, epoch, node: gateway.hex, seated: set.seated, threshold: 3, verify }).sats, 100000n);
  assert.equal(w.b.gatewayd, 1_000_000_000n - 512n - 256n, 'the cost, and the dust the client keeps');
  assert.equal(w.b.locked, 0n);
});

test('stopped at any step, the same command carries on, and no money is left behind or moved twice', async () => {
  for (const stopAt of ['receive', 'refund', 'sendback', 'home']) {
    const w = world({ stopAt });
    await assert.rejects(w.go(), new RegExp(`stopped at ${stopAt}`));
    assert.equal((await w.go()).step, 'done', stopAt);
    assert.equal(w.calls.filter((c) => c === 'send').length, 1, `${stopAt}: gatewayd sends once`);
    assert.equal(w.b.gatewayd, 1_000_000_000n - 512n - 256n, stopAt);
    assert.equal(w.saved.length, 1, stopAt);
  }
});

test('a stop while gatewayd sends is said, not sent twice', async () => {
  const w = world({ stopAt: 'send' });
  await assert.rejects(w.go(), /stopped at send/);
  await assert.rejects(w.go(), /stopped while gatewayd was sending/);
});

test('before the window it waits, and after the window it moves nothing', async () => {
  const late = world({ tip: 144 * 40 + 73 });
  assert.match((await late.go()).why, /has passed: nothing was moved/);
  assert.deepEqual(late.calls, []);
});

test('a lock that fails sends the money home, and too few reads save no proof but still refund', async () => {
  const w = world({ lockFails: true });
  assert.equal((await w.go()).step, 'done');
  assert.equal(w.b.gatewayd, 1_000_000_000n - 256n);
  assert.equal(w.saved.length, 0);
  const few = world();
  few.setDoors(guardians.map(() => ({ answer: async () => ({ code: 503, body: { why: 'down' } }) })));
  const j = await few.go();
  assert.equal(j.step, 'done');
  assert.equal(j.heldSats, '0');
  assert.equal(few.saved.length, 0);
  assert.ok(few.calls.includes('refund'));
  assert.equal(few.b.locked, 0n);
});

test('a lock tool that fails after the lock landed stops the run, and a second run never locks again', async () => {
  const w = world({ lockLandsThenFails: true });
  await assert.rejects(w.go(), /a lock may stand \(killed at its timeout\)/);
  assert.equal(JSON.parse(w.box.j).step, 'locking');
  await assert.rejects(w.go(), /a lock may stand \(found before locking\)/);
  assert.equal(w.calls.filter((c) => c === 'lock').length, 1);
  assert.equal(w.calls.includes('sendback'), false, 'nothing sent home as if the lock had failed');
});

test('an accepted refund is not money yet: the run waits for the notes, and never says done without them', async () => {
  const w = world({ refundSlow: 3 });
  assert.equal((await w.go()).step, 'done');
  assert.equal(w.calls.filter((c) => c === 'settle').length, 3);
  assert.equal(w.b.gatewayd, 1_000_000_000n - 512n - 256n, 'home');
  const never = world({ refundSlow: 1000 });
  await assert.rejects(never.go(), /refund was accepted and this client holds 4096 msat of 99995904/);
  assert.equal(JSON.parse(never.box.j).step, 'sendback', 'the journal stays, to carry on');
  assert.ok(never.b.owed > 0n);
  assert.equal(never.calls.includes('home'), false);
});

test('a refused refund stops the run with the lock named in the journal, and the next run takes it back', async () => {
  const w = world({ refundRefusedOnce: true });
  await assert.rejects(w.go(), /the refund was refused: not yet/);
  assert.equal(JSON.parse(w.box.j).step, 'refunding');
  assert.equal((await w.go()).step, 'done');
  assert.equal(w.b.locked, 0n);
});
