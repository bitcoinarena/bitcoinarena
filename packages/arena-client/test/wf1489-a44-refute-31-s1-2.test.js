// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { marketForRound, checkAttestation, marketLines } from '../src/market.js';
import { MARKET } from '../../arena-node/test/plugins/market/index.js';
import { encodeAttestation, attestationBodyId, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND_ID = b32(0x77);
const CONTRACT = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), networkId: NETWORK_ID_REGTEST, stakeMsat: 1_000_000n };
const signBody = (body, keys) => ({ ...body, signatures: keys.map((k) => ({ key: k.pubkey, signature: new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), k.key)) })) });
const asJson = (t) => JSON.parse(JSON.stringify(t, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const entries = [{ entryId: 'aa'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 0 },
  { entryId: 'bb'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 1 }];
async function setup() {
  const market = marketForRound(CONTRACT);
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const check = await checkAttestation({ attestationHex: toHex(encodeAttestation(signBody({ roundId: ROUND_ID, outcome: 0, observedAtMs: 1n }, [A0, A2]))), market, roundIdHex: rid });
  assert.equal(check.verified, true); assert.equal(check.outcome, 0);
  return { market, rid, check };
}

// kanban #1615 refute: the guard checks only the direction of won, never the amount. A seat's table with the true winner's
// won: true and a payoutMsat a thousand times the pool tells the winner "you won 999,999,100 sats" under "verified".
test('a winner\'s verified line never pays more than the table\'s own pool', async () => {
  const { market, rid, check } = await setup();
  const t = asJson(pariMutuelTable({ entries, outcome: 0 }));
  t.rows.find((r) => r.entryId === 'aa'.repeat(32)).payoutMsat = '1000000900000';
  const [line] = marketLines({ picks: [{ roundIdHex: rid, entryIdHex: 'aa'.repeat(32), market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: 0 }],
    outcomes: new Map([[rid, { state: 'ATTESTED', label: 'x', final: true, table: t, check }]]) });
  console.log('  LINE:', line.state, line.text);
  // the whole gross staked into this round is 2,000 sats: no verified line may say more was won
  assert.ok(!(line.state === 'won' && BigInt(line.gainMsat) > 2_000_000n), 'told a forged gain as verified: ' + line.text);
});
