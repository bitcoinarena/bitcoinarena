// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2847 (ruling 2026-11-16): the game's relay asks an author it has never kept for NIP-13 proof of work while a pool is over 90 % full.
// The page's first profile and seed answer it: mined to the difficulty asked, signed again, and the relay running that rule keeps them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { getPow, minePow } from 'nostr-tools/nip13';
import { SimplePool } from 'nostr-tools/pool';
import { localSigner, publishWithPow, publishProfile } from '../nostr/nostr-login.js';

test('#2847: a relay that asks "pow: difficulty N required" gets the profile mined to N; the first try without it is refused', async () => {
  // a relay with proof of work on, nearly full of strangers (each mined so they get in), difficulty 8-10 for the test's speed
  const r = await startRelay({ port: 0, pow: true, limits: { totalEvents: 20, powBase: 8, powMax: 10 } });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  try {
    for (let i = 0; i < 20; i++) {
      const sk = generateSecretKey();
      const m = minePow({ kind: 0, created_at: Math.floor(Date.now() / 1000) - 100 + i, tags: [], content: '{}', pubkey: getPublicKey(sk) }, 10);
      await Promise.allSettled(pool.publish([url], finalizeEvent({ kind: m.kind, created_at: m.created_at, tags: m.tags, content: m.content }, sk)));
    }
    const signer = localSigner(generateSecretKey());
    const said = [];
    const took = await publishWithPow(pool, [url], await signer.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: '{"name":"new"}' }), signer,
      { onMining: (n) => said.push(n) });
    assert.deepEqual(took, [url]);
    assert.deepEqual(said, [10], 'the relay asked for 10 and the page mined it');
    const kept = await pool.querySync([url], { kinds: [0], authors: [signer.pubkey] }, { maxWait: 2000 });
    assert.equal(kept.length, 1);
    assert.ok(getPow(kept[0].id) >= 10);
    // the profile helper takes the same way
    const other = localSigner(generateSecretKey());
    assert.equal(await publishProfile(other, 'second', { pool, relays: [url] }), 1);
  } finally { pool.close([url]); await r.close(); }
});
