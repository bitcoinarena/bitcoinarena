// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a7-2-1: GAP IN #3359 / #3377. The #3359 fix spares a second signature check only for a copy of an event the relay KEEPS
// (hasSigned) or verified LATELY (checkedSigs: an in-memory FIFO of 4096 pairs, empty after every restart). A seat's own signed events
// that the relay does NOT keep - its older round results (kind 30762) rolled out by the author quota (500 events), its replaced badge
// definitions - are public (GET /nostr-results on the seat, any other relay) and carry the seat's `keep` key. A stranger who re-sends them
// gets each one BIP-340-checked from the #3377 keep reserve (the signature is good, so the token is never given back), and only then is it
// refused ('blocked: older than all this author already has'). With the shared bucket held empty (#3145), the seat's next round result is
// 'rate-limited'. At production sizes the FIFO turns over in ~14 s (300 good checks/s), so ~700 not-kept seat events in rotation keep the
// 50/s keep reserve empty; right after a restart, every not-kept seat event is unchecked.
// SAFE: re-sent copies of a seat's own events that the relay will not keep never spend the reserve its next round result needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, fields, at) => {
  const e = { pubkey: k.pk, created_at: at, tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 5)); };
const answers = (sock, id) => sock.inbox.filter((m) => m[0] === 'OK' && m[1] === id);

const seat = keyOf(5), stranger = keyOf(9);

test('a7-2-1: re-sent copies of a seat\'s own not-kept (rolled out) round results do not spend the reserve its next result needs', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'audit-nostr-a7-2-1-')), 'relay.db');
  const now = Math.floor(Date.now() / 1000);
  // the seat's published round results, oldest first (in production: hundreds of rounds; here the author quota is 2)
  const results = Array.from({ length: 8 }, (_, i) => sign(seat, { kind: 30762, tags: [['d', `arena:result:r${i}`]], content: `{"round":"r${i}"}` }, now - 10000 + i));
  // 1. the relay as it ran: the seat publishes them; the author quota keeps the newest 2, the older 6 are rolled out
  {
    const r = await startRelay({ port: 0, dbPath, keep: [seat.pk], limits: { authorEvents: 2 } });
    const s = await open(r.port);
    for (const e of results) { s.send(['EVENT', e]); await until(() => answers(s, e.id).length); }
    const keptIds = new Set(r.events().map((e) => e.id));
    assert.equal(keptIds.size, 2, 'the relay keeps the seat\'s newest 2 results');
    s.ws.terminate();
    await r.close();
  }
  // 2. the relay after a restart (a deploy): checkedSigs is empty. The shared bucket held empty (#3145: here one token, spent by the
  // stranger's own fresh ephemeral frame), the seat's keep reserve 3 tokens, no refill
  const r = await startRelay({ port: 0, dbPath, keep: [seat.pk],
    limits: { authorEvents: 2, verifyBurst: 1, verifyPerS: 0, verifyStandingBurst: 3, verifyStandingPerS: 0, verifyCleanBurst: 3, verifyCleanPerS: 0 } });
  try {
    const a = await open(r.port);
    const own = sign(stranger, { kind: 24133, tags: [['p', seat.pk]], content: 'x' }, now);
    a.send(['EVENT', own]);
    await until(() => answers(a, own.id).length);
    // 3. the stranger re-sends 3 of the seat's rolled-out round results (public, signed by the seat): valid signatures, never kept
    const replays = results.slice(0, 3);
    for (const e of replays) a.send(['EVENT', e]);
    await until(() => replays.every((e) => answers(a, e.id).length));
    console.log('  replayed rolled-out seat results:', replays.map((e) => { const m = answers(a, e.id)[0]; return `${m[2]} ${m[3]}`; }).join(' | '));
    // 4. the seat's next round result
    const seatSock = await open(r.port);
    const next = sign(seat, { kind: 30762, tags: [['d', 'arena:result:r9']], content: '{"round":"r9"}' }, now);
    seatSock.send(['EVENT', next]);
    await until(() => answers(seatSock, next.id).length);
    const ans = answers(seatSock, next.id)[0];
    console.log(`  FACTS: seat's next round result: ${ans ? (ans[2] ? 'kept' : `refused: ${ans[3]}`) : 'no answer'}`);
    seatSock.ws.terminate(); a.ws.terminate();
    assert.ok(ans && ans[2] === true, `the seat's signed round result was refused after a stranger re-sent 3 of its rolled-out results: ${ans && ans[3]}`);
  } finally { await r.close(); }
});

test('a7-2-1: the kept seat signatures are bounded, and a copy with another signature is still checked', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'audit-nostr-a7-2-1b-')), 'relay.db');
  const now = Math.floor(Date.now() / 1000);
  const r = await startRelay({ port: 0, dbPath, keep: [seat.pk], limits: { keepSigsKept: 3 } });
  try {
    const s = await open(r.port);
    const evs = Array.from({ length: 5 }, (_, i) => sign(seat, { kind: 30762, tags: [['d', `arena:result:b${i}`]], content: `{"round":"b${i}"}` }, now - 100 + i));
    for (const e of evs) { s.send(['EVENT', e]); await until(() => answers(s, e.id).length); }
    const { DatabaseSync } = await import('node:sqlite');
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const rows = ro.prepare('SELECT id FROM keep_sigs ORDER BY rowid').all().map((x) => x.id);
    ro.close();
    assert.deepEqual(rows, evs.slice(2).map((e) => e.id), 'only the newest 3 seat signatures are kept');
    const forged = { ...evs[4], sig: '00'.repeat(64) };
    s.send(['EVENT', forged]);
    await until(() => answers(s, forged.id).length > 1);
    const ans = answers(s, forged.id).at(-1);
    assert.equal(ans[2], false, 'a copy with a junk signature is checked and refused');
    assert.match(ans[3], /^invalid/);
    s.ws.terminate();
  } finally { await r.close(); }
});
