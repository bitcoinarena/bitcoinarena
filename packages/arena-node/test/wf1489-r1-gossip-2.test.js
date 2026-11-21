// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-gossip-2 (P5, a bypass of #2637): server.js builds federationRecords without a `fetcher`, so the mirror pass (gatherAll ->
// mirror) and closedAtGuardians read every guardian's node and up to MIRROR_PEERS census seats at GET /federations with the process's own
// fetch (no size cap) and a bare r.json(). MIRROR_ROWS_PER_ANSWER bounds the rows looked at, not the bytes: ONE census seat answering tens
// of MB is buffered and parsed whole by every seat that mirrors from it, every pass, for every federation.
// Safe behaviour: a /federations answer is read to at most PEER_ANSWER_BYTES (8 MiB) and then dropped, as every other peer read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { PEER_ANSWER_BYTES } from '../src/peer-read.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('#1489 r1-gossip-2: one guardian node\'s 64 MiB GET /federations answer is not read whole by federationRecords as server.js wires it', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const TOTAL = 64 * 1048576, CHUNK = 65536;
  const pulled = new Map();
  const filler = new TextEncoder().encode(' '.repeat(CHUNK));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/federations') return new Response('no', { status: 404 });
    let sent = 0, head = false, tail = false;
    const enc = new TextEncoder();
    const body = new ReadableStream({
      pull(ctl) {
        if (!head) { head = true; const h = enc.encode('{"federations":['); sent += h.length; pulled.set(u.host, sent); ctl.enqueue(h); return; }
        if (sent < TOTAL) { sent += filler.length; pulled.set(u.host, sent); ctl.enqueue(filler); return; }
        if (!tail) { tail = true; ctl.enqueue(enc.encode(`{"federation":"${toHex(FED)}","record":"00"}]}`)); return; }
        ctl.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const me = { secret: new Uint8Array(32).fill(0x57) }; me.pubkey = schnorr.getPublicKey(me.secret);
    // as server.js builds it: no `fetcher`
    const o = federationRecords({
      round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
      roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET,
    });
    await o.gatherAll(inviteFederationId);
    const most = Math.max(0, ...pulled.values());
    assert.ok(pulled.size > 0, 'the guardians\' nodes were asked');
    assert.ok(most <= PEER_ANSWER_BYTES + 4 * CHUNK, `a /federations answer is read to at most ${PEER_ANSWER_BYTES} bytes; read ${most} bytes from one node (${pulled.size} nodes)`);
  } finally { globalThis.fetch = real; }
});
