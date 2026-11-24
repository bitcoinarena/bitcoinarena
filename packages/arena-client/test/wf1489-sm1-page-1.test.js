// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE AUDIT #1489 sm1-page-1 (release audit #2, 2026.1.9.30, regression of #3596 80e8d73e8): the HOME seat's POST /entry is now cut at
// ENTRY_ANSWER_MS (15 s) and postEntry throws - "a seat silent past the bound did not take the entry". But the seat's door runs its federation
// checks (gateways, guardian bonds, fees) BEFORE round.enter and answers 201 after: an honest seat that is 16 s slow STORES the entry (and relays it
// to every seat, #1068/#1216) while Client.join has already thrown. The page goes ARENA_ENTRY_REFUSED -> "Not joined", the stake lock stays named
// in an entry every seat holds (bindLockEntry, #1839: it is never let go of), no seat is ever handed the lock, the entry is voided at the start
// deadline and the stake waits for the unentered return. Before #3596 the same slow seat simply made a slow, successful join.
// Invariant: an entry the home seat took and answered 201 for is a joined entry (join resolves and the lock goes to the seats).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '../src/client.js';
import { entryId, encodeEntryContract } from '../../arena-protocol/src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ENTRY = { roundId: b32(0x41), playerPubkey: b32(0x42), sessionPubkey: b32(0x43), stakeCommitment: b32(0x44), stakeMsat: 100000n, feeMsat: 0n,
  donationMsat: 0n, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33).fill(2),
  feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  claimKeyAttestationRef: new Uint8Array(32) };
const EID = entryId(ENTRY);
const FIELDS = { paymentImage: { kind: 'point', bytes: new Uint8Array(33).fill(2) }, amountMsat: 100000n, claimPk: new Uint8Array(33).fill(3), refundPk: new Uint8Array(33).fill(2), expiration: 900144 };

test('sm1-page-1: a home seat that takes the entry 16 s after the post is a joined entry, not a refused join with the stake locked', async () => {
  const stored = new Set(), locks = new Set();
  const srv = createServer((req, res) => {
    const m = /^\/n(\d+)\/(entry|lock|fee-lock|lock-claim)/.exec(req.url);
    req.on('data', () => {});
    req.on('end', () => {
      if (!m) { res.writeHead(404); return res.end('no'); }
      const node = Number(m[1]), door = m[2];
      if (door === 'entry' && req.method === 'GET') {
        // the seat's GET /entry?id= (server.js): 200 with the entry it holds, 404 'no such entry' (kanban #3673)
        if (!stored.has(node)) { res.writeHead(404); return res.end('no such entry'); }
        res.writeHead(200); return res.end(Buffer.from(encodeEntryContract(ENTRY)));
      }
      if (door === 'entry') {
        // the home seat's door: its federation checks take 16 s, then round.enter stores it and the 201 goes out (the socket closed or not)
        const slow = node === 0 ? 16000 : 0;
        setTimeout(() => { stored.add(node); try { res.writeHead(201); res.end(Buffer.from(EID)); } catch { /* the client went */ } }, slow);
        return;
      }
      if (door === 'lock') { if (stored.has(node)) locks.add(node); else { res.writeHead(404); return res.end('no such entry'); } }
      res.writeHead(201); return res.end('taken');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = (i) => `http://127.0.0.1:${srv.address().port}/n${i}`;
  const c = new Client({ base: base(0), core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.peers = [1, 2].map(base);
  c.stakeLock = { fields: FIELDS, needed: 2 };
  try {
    let threw = null;
    try { await c.join(ENTRY); } catch (e) { threw = e.message; }
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`  join threw: ${threw}; the home seat stored the entry: ${stored.has(0)}; seats handed the stake lock: ${locks.size}`);
    assert.ok(stored.has(0), 'fixture: the home seat stored the entry');
    assert.equal(threw, null, `the home seat took the entry (201), yet join() threw "${threw}": the page shows "Not joined" while the entry stands at the seats with the stake lock named in it and handed to none`);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
