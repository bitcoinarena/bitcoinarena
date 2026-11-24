// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT client r3-1: ONE SILENT PEER SEAT HOLDS THE WHOLE JOIN. Client.join posts the entry to every other committee node
// (joinOn -> fetch POST /entry, no deadline) and awaits ALL of them before it starts handing the stake lock (#handLocksUntilTaken)
// and before it returns (arena.jslib: openRound().then(join).then(socket) ...). One committee seat that takes the TCP connection
// for POST /entry and never answers keeps join() from ever returning: no seat is handed the stake lock, the session never opens,
// and the seats void the unstaked entry at the start deadline. Safe behaviour: a silent peer is bounded like every other read,
// join() returns and the lock reaches the six seats that answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '../src/client.js';
import { entryId } from '../../arena-protocol/src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ENTRY = { roundId: b32(0x31), playerPubkey: b32(0x32), sessionPubkey: b32(0x33), stakeCommitment: b32(0x34), stakeMsat: 100000n, feeMsat: 0n,
  donationMsat: 0n, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33).fill(2),
  feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
  claimKeyAttestationRef: new Uint8Array(32) };
const EID = entryId(ENTRY);
const FIELDS = { paymentImage: { kind: 'point', bytes: new Uint8Array(33).fill(2) }, amountMsat: 100000n, claimPk: new Uint8Array(33).fill(3), refundPk: new Uint8Array(33).fill(2), expiration: 900144 };

test('one committee seat that never answers POST /entry does not hold the join or the stake lock hand-off', async () => {
  const held = [], locks = new Set();
  const srv = createServer((req, res) => {
    const m = /^\/n(\d+)\/(entry|lock|fee-lock|lock-claim)/.exec(req.url);
    req.on('data', () => {});
    req.on('end', () => {
      if (!m) { res.writeHead(404); return res.end('no'); }
      const node = Number(m[1]), door = m[2];
      if (door === 'entry') {
        if (node === 6) { held.push(res); return; }          // the attacker seat: takes the request, never answers
        res.writeHead(201); return res.end(Buffer.from(EID));
      }
      if (door === 'lock') locks.add(node);
      res.writeHead(201); return res.end('taken');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = (i) => `http://127.0.0.1:${srv.address().port}/n${i}`;
  const c = new Client({ base: base(0), core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.peers = [1, 2, 3, 4, 5, 6].map(base);
  c.stakeLock = { fields: FIELDS, needed: 5 };
  try {
    const t0 = Date.now();
    const joined = await Promise.race([c.join(ENTRY).then(() => 'joined'), new Promise((r) => setTimeout(() => r('still waiting'), 30000).unref())]);
    console.log(`  join(): ${joined} after ${Date.now() - t0} ms; seats handed the stake lock: ${locks.size}`);
    assert.equal(joined, 'joined', 'join() was still waiting on the one silent seat 30 s later: the session never opens');
    const got = await Promise.race([c.lockHanding, new Promise((r) => setTimeout(() => r(null), 10000).unref())]);
    assert.ok(got && got.lock && got.lock.committed >= 5, 'the stake lock did not reach the five seats the round needs');
  } finally {
    for (const r of held) { try { r.destroy(); } catch { /* gone */ } }
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
