// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 4 (attestations / markets): THE PAGE REFUSES A PADDED ATTESTATION BEFORE IT CHECKS ITS SIGNATURES.
// #1546 made a seat refuse an attestation carrying more signatures than the market has attestors before any check (attested.js);
// the page's checkAttestation (and checkMarketOutcome's value branch) still verifies EVERY signature first - WebCrypto Ed25519,
// one await each - and only then asks attestationStands. One seat answering GET /outcome with a public attestation padded to the
// u16 limit (65,535 signatures) makes the market page of every player in that round run 65,535 verifications every 10 s.
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

test('a seat\'s GET /outcome attestation padded with 3,000 copies of its signatures costs the page no more checks than the market has attestors', async () => {
  const market = marketForRound(CONTRACT);
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const signedOnce = signBody({ roundId: ROUND_ID, outcome: 0, observedAtMs: 1n }, [A0, A2]);
  const padded = { ...signedOnce, signatures: Array.from({ length: 3000 }, () => signedOnce.signatures).flat() };
  const hex = toHex(encodeAttestation(padded));
  let calls = 0;
  const verify = async () => { calls++; return true; };
  const got = await checkAttestation({ attestationHex: hex, market, roundIdHex: rid, verify });
  console.log('  CHECKS:', calls, JSON.stringify(got));
  assert.equal(got.verified, false);
  // SAFE: refused on its length before any signature is checked (attested.js does so at the seat since #1546); at most one check per attestor
  assert.ok(calls <= MARKET.attestors.length, `the page checked ${calls} signatures of one padded attestation (${MARKET.attestors.length} attestors)`);
});
