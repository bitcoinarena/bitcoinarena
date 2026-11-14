// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-gossip-1 (P5, a bypass of #2637): "server.js reads every peer through answersUpTo" - but server.js builds the seating
// agent without a `fetcher`, so seating-agent.js reads every drawn seat's GET /seating-batch, /present, /seating and /seating-sig with the
// process's own fetch (main.js installFetchRoutes: routed, lanes, no size cap) and a bare r.json(). ONE drawn seat answers its batch with
// tens of MB of JSON: every honest drawn seat buffers and parses all of it, every 2 s tick, for every round it is drawn with that seat.
// Safe behaviour: a seating peer answer is read to at most PEER_ANSWER_BYTES (8 MiB) and then dropped, as every other peer read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { PEER_ANSWER_BYTES } from '../src/peer-read.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const START = 60500n;

test('#1489 r1-gossip-1: one drawn seat\'s 64 MiB /seating-batch answer is not read whole by the seating agent as server.js wires it', async () => {
  const c = { ...contractFor(nodes.map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const TOTAL = 64 * 1048576, CHUNK = 65536;
  const pulled = new Map();   // seat -> bytes the agent pulled from that seat's answer
  const filler = new TextEncoder().encode('{"role":"x"},'.repeat(Math.floor(CHUNK / 13)));
  const real = globalThis.fetch;
  // the process's fetch as main.js installs it: an answer is handed on with its body, nothing caps it
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const seat = u.host;
    if (u.pathname !== '/seating-batch') return new Response('no', { status: 404 });
    let sent = 0, head = false, tail = false;
    const enc = new TextEncoder();
    const body = new ReadableStream({
      pull(ctl) {
        if (!head) { head = true; const h = enc.encode(`{"rounds":{"${toHex(rid)}":{"presents":[`); sent += h.length; pulled.set(seat, sent); ctl.enqueue(h); return; }
        if (sent < TOTAL) { sent += filler.length; pulled.set(seat, sent); ctl.enqueue(filler); return; }
        if (!tail) { tail = true; ctl.enqueue(enc.encode('{}]}}}')); return; }
        ctl.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const me = nodes[0];
    const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    const now = Number(START - 120000n) - 30000;   // inside the PRESENT window, before the close
    // as server.js builds it: no `fetcher`
    const agent = seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: (m) => schnorr.sign(m, me.secret), nowMs: () => now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } });
    await agent.tick();
    const most = Math.max(0, ...pulled.values());
    assert.ok(pulled.size > 0, 'the agent asked the drawn seats for their batch');
    assert.ok(most <= PEER_ANSWER_BYTES + 4 * CHUNK, `a seat's /seating-batch answer is read to at most ${PEER_ANSWER_BYTES} bytes; read ${most} bytes from one seat (${pulled.size} seats)`);
  } finally { globalThis.fetch = real; }
});
