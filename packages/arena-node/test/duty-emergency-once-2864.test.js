// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2864 (the owner 2026-11-15: "Fuer Morgen posten"): POST /duty/emergency-once runs the round poster's emergency publishing once, of one
// version. Off unless ARENA_DUTY_ONCE_FILE names the secret; the secret in x-duty-once; dry runs may repeat; one send, then refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts } from './window-fixture.js';

const V11 = '71036e7a85aad1ed25e549bdcea82ce7479ab349294af74b90f7f827f0904116';

test('#2864 the emergency-once door: off without its file, the secret checked, dry runs repeat, one send', async () => {
  const calls = [];
  const duty = { attach: () => {}, stop: () => {}, status: () => ({ ok: true }), postOnce: async (o) => { calls.push(o); return o.dry ? { ok: true, dry: true, rounds: 3 } : { ok: true, txid: 'ab'.repeat(32), series: ['cd'.repeat(32)] }; } };
  const dir = mkdtempSync(join(tmpdir(), 'once-')), f = join(dir, 'secret'), secret = 's'.repeat(40);
  writeFileSync(f, secret);
  delete process.env.ARENA_DUTY_ONCE_FILE;
  const a = await serve(openStore(':memory:'), { port: 0, duty, ...opts });
  try {
    const base = `http://127.0.0.1:${a.port}/duty/emergency-once`;
    const post = (body, key = secret) => fetch(base, { method: 'POST', headers: { 'x-duty-once': key }, body: JSON.stringify(body) });
    assert.equal((await post({ game: 'rps', slot: 1, gameId: V11, dry: true })).status, 404, 'off without ARENA_DUTY_ONCE_FILE');
    process.env.ARENA_DUTY_ONCE_FILE = f;
    assert.equal((await post({ game: 'rps', slot: 1, gameId: V11, dry: true }, 'x'.repeat(40))).status, 403);
    assert.equal((await post({ game: 'rps', slot: 1, gameId: 'zz', dry: true })).status, 400);
    for (let i = 0; i < 2; i++) { const r = await post({ game: 'rps', slot: 20407, gameId: V11, dry: true }); assert.equal(r.status, 200); assert.equal((await r.json()).dry, true); }
    const sent = await post({ game: 'rps', slot: 20407, gameId: V11 });
    assert.equal(sent.status, 200); assert.equal((await sent.json()).txid, 'ab'.repeat(32));
    assert.ok(existsSync(`${f}.done`));
    assert.equal((await post({ game: 'rps', slot: 20407, gameId: V11 })).status, 409, 'a second send is refused');
    assert.deepEqual(calls.map((c) => [c.game, c.slot, c.gameIdHex, c.dry]), [['rps', 20407, V11, true], ['rps', 20407, V11, true], ['rps', 20407, V11, false]]);
  } finally { delete process.env.ARENA_DUTY_ONCE_FILE; await a.close?.(); }
});
