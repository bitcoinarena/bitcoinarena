// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2200): the test read server.js's halted() wiring with a regex fitted to the card's own form (try/catch);
// 1.9 writes it as (f) => (liquidations ? liquidations.haltOf(...) : null) (#1577). The wiring is read from the source as before.
// wf1489 sm8 federation 1: the e-cash exchange's "no exchange out of or into a federation being liquidated" (kanban #1244) is wired in
// server.js as `halted: (f) => liquidations.haltOf(...)`, but createLiquidations (liquidations.js) answers only { offer, list } - no
// haltOf. The call throws, the catch answers null, and a federation this very seat lists as liquidating at GET /liquidations is
// exchanged as if it were OPEN: none -> receiving -> taken -> sending -> paid, while its notes are claimed at the arbitration set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createLiquidations } from '../src/liquidations.js';
import * as ex from '../src/ecash-exchange.js';
import { TESTNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// e-cash the exchange reads as notes (1.9 refuses a string that does not decode first; fedimint-core base32, as ecash-exchange-res3.test.js)
const B32 = '0123456789abcdefghijklmnopqrstuv';
function notes(seed) {
  let out = '', buf = 0, bits = 0;
  for (const b of Uint8Array.from({ length: 41 }, (_, i) => (i * 37 + seed) & 0xff)) { buf |= b << bits; bits += 8; while (bits >= 5) { out += B32[buf & 31]; buf >>>= 5; bits -= 5; } }
  if (bits > 0) out += B32[buf & 31];
  return `fedimint${out}`;
}
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0xaa); const A = toHex(FED); const B = 'bb'.repeat(32);
const record = { federationId: FED, guardians: [] };
// the federation records as liquidations.test.js holds them: A HALTED at 880
const records = { recordOf: (f) => (f === A ? { record, status: 'HALTED', height: 900 } : null),
  haltOf: (f) => (f === A ? { height: 880, bytes: Uint8Array.of(0xab) } : null), haltedFederations: () => [A] };

// THE PRODUCTION WIRING, as server.js writes it (read from the source, not copied)
function serverHalted(liquidations) {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // 1.9's line (#1577): halted: (f) => (liquidations ? liquidations.haltOf(...) : null) - read as written, whatever its exact form
  const m = src.match(/halted: (\(f\) => [^\n]*liquidations\.haltOf\([^\n]*?),\n/);
  assert.ok(m, 'server.js wires the exchange\'s halted() through liquidations.haltOf');
  return new Function('liquidations', `return ${m[1]};`)(liquidations);
}

test('a federation this seat lists as liquidating is not exchanged out of (kanban #1244, through the server wiring)', async () => {
  const liquidations = createLiquidations({ records, clocks: TESTNET_CLOCKS, verify });
  assert.deepEqual(liquidations.list().map((l) => [l.federation, l.haltHeight]), [[A, 880]], 'GET /liquidations lists A as halted at 880');
  const calls = [];
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashReceive: async () => { calls.push('receive'); return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashBalance: async () => 500_000n, ecashSend: async (m) => { calls.push('send'); return { ecash: `fedimintB-${m}`, msat: m }; },
      ecashSent: async () => ({ found: false }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null, halted: serverHalted(liquidations) });
  const got = await x.exchange({ from: A, to: B, ecash: notes(11), amountMsat: '100000' });
  console.log('  MEASURED exchange out of a liquidating federation:', JSON.stringify(got), 'calls', JSON.stringify(calls));
  assert.equal(got.ok, false, 'the exchange is refused: A is being liquidated here');
  assert.equal(got.status, 409);
  assert.match(String(got.why), /being liquidated/);
  assert.deepEqual(calls, [], 'the liquidating federation\'s notes are not reissued, and nothing is paid out of B');
});

test('nor into one (the same wiring, `to` liquidating)', async () => {
  const liquidations = createLiquidations({ records, clocks: TESTNET_CLOCKS, verify });
  const calls = [];
  const ports = {
    [B]: { ecashBalance: async () => 0n, ecashReceive: async () => { calls.push('receive'); return { state: 'Success', msat: 100_000n }; } },
    [A]: { ecashBalance: async () => 500_000n, ecashSend: async (m) => { calls.push('send'); return { ecash: `fedimintA-${m}`, msat: m }; },
      ecashSent: async () => ({ found: false }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null, halted: serverHalted(liquidations) });
  const got = await x.exchange({ from: B, to: A, ecash: notes(13), amountMsat: '100000' });
  console.log('  MEASURED exchange into a liquidating federation:', JSON.stringify(got), 'calls', JSON.stringify(calls));
  assert.equal(got.ok, false, 'the player is not handed notes of a federation being liquidated');
  assert.deepEqual(calls, []);
});
