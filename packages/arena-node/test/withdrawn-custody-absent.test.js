// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND UNDER THE WITHDRAWN CUSTODY IS NO ROUND HERE, PAST ROUNDS INCLUDED (RULED 2026-09-22 22:59).
//
// §23.6: "a record from before this ruling that carries the old value is not a round of this network and
// is neither decoded, replayed, settled, listed nor counted; a node that holds such a record treats it as
// it treats bytes that do not parse." Two doors to that: a byte-0 contract posted to `/round` is refused
// as bytes that do not parse - not a custody-specific 409 - and nothing of it is stored; and a store that
// already holds byte-0 rows, from before the ruling, answers them as absent after a restart, while the
// bytes stay where they are (absent, not deleted).
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, OPEN, CLOSED } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, taggedHash } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { HOSTED } from './plugins/hosted.js';

/** The FEDERATION round's bytes with another custody byte - the byte just before federation_id on the wire. */
function underByte(c, byte) {
  const bytes = encodeRoundContract(c);
  const at = Buffer.from(bytes).toString('hex').indexOf(Buffer.from(c.federationId).toString('hex'));
  assert.ok(at > 0 && at % 2 === 0, 'the federation_id is not in the encoding');
  const old = Uint8Array.from(bytes);
  assert.equal(old[at / 2 - 1], 1, 'the custody byte of a FEDERATION round is not 1');
  old[at / 2 - 1] = byte;
  return old;
}
const underByteZero = (c) => underByte(c, 0);

const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;

test('a byte-0 contract posted to /round is refused as bytes that do not parse, and nothing of it is stored', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const c = contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']);
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: underByteZero(c) });
    const why = (await r.text()).trim();
    console.log(`  FACTS: ${r.status} "${why.slice(0, 110)}"; rounds stored ${count(d.round.db)}`);
    assert.equal(r.status, 400, 'a byte-0 round was answered as something other than bytes that do not parse');
    assert.match(why, /^that is not a round this signer node opens: custody byte 0 is not a custody of this network/);
    assert.equal(count(d.round.db), 0, 'something of a byte-0 round was stored');
  } finally { await d.close(); }
});

test('a store holding byte-0 rows from before the ruling answers them as absent after a restart: not listed, not read, not closed-over - and their bytes stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-withdrawn-'));
  const path = join(dir, 'node.db');
  try {
    // BEFORE THE RULING: a node that ran under the old decoder kept a byte-0 round open and one closed,
    // beside a FEDERATION round. Written straight into the table, as that node's store holds them.
    const first = openStore(path);
    const nodes = [b32(0x11), b32(0x33)];
    const fed = contractFor(nodes, 3000n, ['wss://r.example']);
    const oldOpen = underByteZero({ ...fed, slashMinimumServed: 21 });
    const oldClosed = underByteZero({ ...fed, slashMinimumServed: 22 });
    const put = first.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)');
    put.run(roundId(fed), encodeRoundContract(fed), OPEN, 1);
    put.run(b32(0xa0), oldOpen, OPEN, 2);
    put.run(b32(0xa1), oldClosed, CLOSED, 3);
    const before = first.prepare('SELECT round_id, contract FROM rounds ORDER BY opened_ms').all()
      .map((r) => [toHex(r.round_id), toHex(r.contract)]);
    first.close();

    // RESTARTED ON THAT STORE under this decoder. Starting at all is part of the claim: a close-resume or
    // a listing that decoded the old rows would throw here.
    const d = await serve(openStore(path), { plugins: HOSTED, port: 0, ...opts });
    try {
      const listed = d.round.openRounds().map((r) => toHex(r.roundId));
      const closed = d.round.closedRounds().map(toHex);
      const asked = {};
      for (const [name, id] of [['federation', roundId(fed)], ['old open', b32(0xa0)], ['old closed', b32(0xa1)]])
        asked[name] = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(id)}`)).status;
      const after = d.round.db.prepare('SELECT round_id, contract FROM rounds ORDER BY opened_ms').all()
        .map((r) => [toHex(r.round_id), toHex(r.contract)]);
      console.log('  FACTS:', JSON.stringify({ listed: listed.map((x) => x.slice(0, 8)), closed, asked, rowsBefore: before.length, rowsAfter: after.length }));

      assert.deepEqual(listed, [toHex(roundId(fed))], 'an old byte-0 round is listed as open');
      assert.deepEqual(closed, [], 'an old byte-0 round is listed as closed');
      assert.deepEqual(asked, { federation: 200, 'old open': 404, 'old closed': 404 });
      assert.equal(d.round.get(b32(0xa0)), null);
      assert.equal(d.round.get(b32(0xa1)), null);
      // ABSENT, NOT DELETED: every row and every byte is where it was.
      assert.deepEqual(after, before, 'the store was written to');
    } finally { await d.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// THE SAME CONTRACT, TWO CUSTODY BYTES (the enum slice's first cut, 2026-09-24): a new paying round is FEDERATION, byte
// 1, and is taken; the same fields under byte 0 are bytes that do not parse, nothing of them is stored, and the id those
// bytes would have is absent.
test('the same contract is taken under byte 1 (201) and refused under byte 0 as unparseable; nothing of it is stored and its id is absent', async () => {
  // ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): the one daemon and a keyless placeholder, so the claim
  // key is claimKeyFor's. A node with a chain view checks every round's census; only censusRoot changes.
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: slot.port, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const bonded = (c) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot });
    const c = bonded(contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']));
    const zero = underByteZero(c);
    const zeroId = taggedHash(TAG.roundContract, zero);
    const refused = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: zero });
    const refusedWhy = (await refused.text()).trim();
    const zeroAsked = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(zeroId)}`)).status;
    const storedAfterZero = count(d.round.db);
    const taken = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const takenStatus = taken.status; await taken.text();
    const oneAsked = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(c))}`)).status;
    console.log('  FACTS:', JSON.stringify({ byte0: [refused.status, refusedWhy.slice(0, 80)], byte0Id: zeroAsked, storedAfterZero, byte1: takenStatus, byte1Id: oneAsked, stored: count(d.round.db) }));
    assert.equal(refused.status, 400);
    assert.match(refusedWhy, /custody byte 0 is not a custody of this network/);
    assert.equal(zeroAsked, 404, 'the id of the byte-0 bytes is answered as a round');
    assert.equal(storedAfterZero, 0);
    assert.equal(takenStatus, 201, 'the same contract under FEDERATION was not taken');
    assert.equal(oneAsked, 200);
    assert.equal(count(d.round.db), 1);
  } finally { await d.close(); }
});

// A STORED BYTE-0 ROUND IS NEVER REPLAYED, SETTLED OR COUNTED (§23.6, past rounds included): the lobby's list, the
// settled list and the rounds a restart settles again do not name it, and a settle or a close asked of it is "no such
// round" - the answer bytes that do not parse get.
test('a stored byte-0 round is never replayed, settled or counted: not in the lobby list, not in /settled, and a settle or close of it is no such round', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-withdrawn-'));
  const path = join(dir, 'node.db');
  try {
    const first = openStore(path);
    const fed = contractFor([b32(0x11), b32(0x33)], 3000n, ['wss://r.example']);
    const put = first.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)');
    put.run(b32(0xa2), underByteZero({ ...fed, slashMinimumServed: 23 }), OPEN, 2);
    put.run(b32(0xa3), underByteZero({ ...fed, slashMinimumServed: 24 }), CLOSED, 3);
    first.close();
    const d = await serve(openStore(path), { plugins: HOSTED, port: 0, ...opts });
    try {
      const lobby = await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).text();
      const settled = await (await fetch(`http://127.0.0.1:${d.port}/settled?since=0`)).json();
      const settle = [await d.settlements.settle(b32(0xa2)), await d.settlements.settle(b32(0xa3))];
      const close = [await d.verifier.retryClose(b32(0xa2), b32(1)), await d.verifier.retryClose(b32(0xa3), b32(1))];
      const named = (s) => s.includes(toHex(b32(0xa2))) || s.includes(toHex(b32(0xa3)));
      console.log('  FACTS:', JSON.stringify({ lobbyNames: named(lobby), settledRounds: settled.rounds.length, settle: settle.map((x) => x.why), close: close.map((x) => x.why) }));
      assert.equal(named(lobby), false, 'the lobby lists a byte-0 round');
      assert.equal(settled.rounds.length, 0, '/settled names a byte-0 round');
      for (const s of settle) { assert.equal(s.ok, false); assert.match(s.why, /no such round/); }
      for (const r of close) { assert.equal(r.stored, false); assert.match(r.why, /no such round/); }
    } finally { await d.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// BYTE 0 IS BYTE 2 (RULED 2026-09-24, the enum slice's second cut): no door answers the withdrawn custody's byte any
// differently from a byte this network never had. The same contract posted under each is one refusal with only the
// digit changed, naming nothing.
test('a byte-0 and a byte-2 post of the same contract are one refusal, only the digit changed; nothing stored, nothing named', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const c = contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']);
    const post = async (b) => { const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: underByte(c, b) }); return [r.status, (await r.text()).trim()]; };
    const [[s0, w0], [s2, w2]] = [await post(0), await post(2)];
    console.log('  FACTS:', JSON.stringify({ byte0: [s0, w0], byte2: [s2, w2], stored: count(d.round.db) }));
    assert.deepEqual([s0, s2], [400, 400]);
    assert.equal(w0, 'that is not a round this signer node opens: custody byte 0 is not a custody of this network: the one value is FEDERATION');
    assert.equal(w2, w0.replace('byte 0', 'byte 2'), 'the two bodies differ beyond the digit');
    for (const w of [w0, w2]) assert.equal(w.includes('THRESHOLD_LN'), false, `the refusal names the withdrawn custody: ${w}`);
    assert.equal(count(d.round.db), 0, 'something of either post was stored');
  } finally { await d.close(); }
});

test('a restart on a store holding byte-0 and byte-2 rows answers every one the same: unlisted, unsettled, 404, no such round, counted nowhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-withdrawn-'));
  const path = join(dir, 'node.db');
  try {
    const first = openStore(path);
    const fed = contractFor([b32(0x11), b32(0x33)], 3000n, ['wss://r.example']);
    const put = first.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)');
    put.run(roundId(fed), encodeRoundContract(fed), OPEN, 1);
    const rows = [];
    for (const [byte, state, served] of [[0, OPEN, 31], [0, CLOSED, 32], [2, OPEN, 33], [2, CLOSED, 34]]) {
      const bytes = underByte({ ...fed, slashMinimumServed: served }, byte);
      const id = taggedHash(TAG.roundContract, bytes);
      put.run(id, bytes, state, served);
      rows.push({ byte, state, id });
    }
    first.close();
    const d = await serve(openStore(path), { plugins: HOSTED, port: 0, ...opts });
    try {
      const lobby = await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).text();
      const settled = await (await fetch(`http://127.0.0.1:${d.port}/settled?since=0`)).json();
      const listed = [...d.round.openRounds(), ...d.round.closedRounds()].map((x) => toHex(x.roundId ?? x.id ?? x));
      const answers = [];
      for (const r of rows) {
        const hex = toHex(r.id);
        answers.push({
          byte: r.byte, state: r.state,
          lobby: lobby.includes(hex), listed: listed.some((x) => x.includes(hex)),
          get: (await fetch(`http://127.0.0.1:${d.port}/round?id=${hex}`)).status,
          read: d.round.get(r.id),
          settle: (await d.settlements.settle(r.id)).why,
          close: (await d.verifier.retryClose(r.id, b32(1))).why,
        });
      }
      const fedAsked = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(fed))}`)).status;
      console.log('  FACTS:', JSON.stringify({ answers, settledRounds: settled.rounds.length, listedCount: listed.length, fedAsked, rowsAfter: count(d.round.db) }));
      const shape = ({ lobby: l, listed: li, get, read, settle, close }) => JSON.stringify({ l, li, get, read, settle, close });
      for (const a of answers) {
        assert.equal(a.lobby, false, `the lobby lists the byte-${a.byte} ${a.state} round`);
        assert.equal(a.listed, false, `the store lists the byte-${a.byte} ${a.state} round`);
        assert.equal(a.get, 404);
        assert.equal(a.read, null);
        assert.match(a.settle, /no such round/);
        assert.match(a.close, /no such round/);
        assert.equal(shape(a), shape(answers[0]), 'a byte-0 row and a byte-2 row are answered differently');
      }
      assert.equal(settled.rounds.length, 0, '/settled counts a withdrawn-byte round');
      assert.equal(listed.length, 1, 'the store counts a round beyond the FEDERATION one');
      assert.equal(fedAsked, 200);
      assert.equal(count(d.round.db), 5, 'a row was deleted');
    } finally { await d.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
