// kanban #3061: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r4-2 #1: every new EVENT the relay takes (any non-ephemeral kind, pool full or not, PoW on or off) first runs
//   const ids = identities();                                        // a new Set of every standing identity
//   const standingJson = JSON.stringify([...new Set([...keepList, ...ids])]);   // and all of them as one JSON string
// (nostr-relay.js:658-659). The work is linear in the number of identities with standing (tools/nostr-relay.mjs readStanding: every counted
// identity of 90 days of the host's seats, and #3034's free-round identities), on the relay's one event loop, paid for each frame a stranger
// sends with a fresh key. SAFE: one write costs about the same whether 20,000 identities have standing or none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, open, ask } from './_r22-common.mjs';

async function msPerWrite(n) {
  const standing = new Set(Array.from({ length: n }, () => randomBytes(32).toString('hex')));
  const r = await startRelay({ port: 0, dbPath: ':memory:', standing: () => standing, pow: true });
  const ws = await open(r.port);
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const next = Array.from({ length: 50 }, (_, i) => ev(key(), { kind: 0, at: t0 + i, content: '{}' }));
    const start = performance.now();
    for (const e of next) { const [ok] = await ask(ws, ['EVENT', e], (m) => m[0] === 'OK'); assert.equal(ok[2], true, ok[3]); }
    return (performance.now() - start) / next.length;
  } finally { ws.terminate(); await r.close(); }
}

test('audit nostr r4-2 #1: a write costs no more with 20,000 standing identities than with none', async () => {
  const base = await msPerWrite(0);
  const many = await msPerWrite(20000);
  console.log(`ms per write: no standing ${base.toFixed(2)}, 20,000 standing ${many.toFixed(2)}`);
  assert.ok(many < Math.max(2 * base, base + 2), `one EVENT took ${many.toFixed(2)} ms with 20,000 standing identities (${base.toFixed(2)} ms with none): `
    + 'each write copies the whole standing set into a new Set and one JSON string on the relay\'s event loop');
});
