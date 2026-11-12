// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 4 (attestations / markets): THE PAGE'S WIN OR LOSS FOLLOWS THE OUTCOME IT VERIFIED, NOT A SEAT'S TABLE.
// The page checks the attestation a seat hands with GET /outcome (checkMarketOutcome) - and then reads "won", "payoutMsat" and
// "netMsat" from the same seat's `table`, unchecked. One seat (of the round's 7, the page keeps the first answer that holds the
// player's row) serves the real, verified attestation of outcome 0 beside a table built for outcome 1: the player who picked 1 and
// lost reads "'above 100k' (2 of 3 attestors, verified) · you won 900 sats".
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

test('a verified outcome 0 with a seat\'s table built for outcome 1: the player who picked 1 is not told he won', async () => {
  const market = marketForRound(CONTRACT);
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const good = toHex(encodeAttestation(signBody({ roundId: ROUND_ID, outcome: 0, observedAtMs: 1n }, [A0, A2])));
  const check = await checkAttestation({ attestationHex: good, market, roundIdHex: rid });
  assert.equal(check.verified, true);
  assert.equal(check.outcome, 0);
  const entries = [{ entryId: 'aa'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 0 },
    { entryId: 'bb'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 1 }];
  // THE ONE SEAT'S ANSWER: the real attestation (outcome 0), a table made for outcome 1
  const forgedTable = asJson(pariMutuelTable({ entries, outcome: 1 }));
  const outcomes = new Map([[rid, { state: 'ATTESTED', label: 'above 100k', final: true, table: forgedTable, check }]]);
  const [line] = marketLines({ picks: [{ roundIdHex: rid, entryIdHex: 'bb'.repeat(32), market, pick: 1, stakeMsat: 1_000_000n, entryCloseMs: 0 }], outcomes });
  console.log('  LINE:', JSON.stringify(line));
  // SAFE: the pick (1) is not the verified outcome (0) - the line never says "won", whatever a seat's table says
  assert.notEqual(line.state, 'won', `the page told the loser he won: ${line.text}`);
  assert.doesNotMatch(line.text, /you won/);
});

test('the reverse (kanban #1615): a verified outcome 0 with a table built for outcome 1 never tells the player who picked 0 he lost; a matching table still reads', async () => {
  const market = marketForRound(CONTRACT);
  const rid = toHex(ROUND_ID);
  const [A0, , A2] = MARKET.attestors;
  const good = toHex(encodeAttestation(signBody({ roundId: ROUND_ID, outcome: 0, observedAtMs: 1n }, [A0, A2])));
  const check = await checkAttestation({ attestationHex: good, market, roundIdHex: rid });
  const entries = [{ entryId: 'aa'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 0 },
    { entryId: 'bb'.repeat(32), stakeMsat: 1_000_000n, feeMsat: 50_000n, donationMsat: 50_000n, pick: 1 }];
  const pick0 = { roundIdHex: rid, entryIdHex: 'aa'.repeat(32), market, pick: 0, stakeMsat: 1_000_000n, entryCloseMs: 0 };
  const forged = asJson(pariMutuelTable({ entries, outcome: 1 }));
  const [bad] = marketLines({ picks: [pick0], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'x', final: true, table: forged, check }]]) });
  assert.equal(bad.state, 'unverified', bad.text);
  assert.doesNotMatch(bad.text, /you lost/);
  const honest = asJson(pariMutuelTable({ entries, outcome: 0 }));
  const [ok] = marketLines({ picks: [pick0], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'x', final: true, table: honest, check }]]) });
  assert.equal(ok.state, 'won', ok.text);
  const [lost] = marketLines({ picks: [{ ...pick0, entryIdHex: 'bb'.repeat(32), pick: 1 }], outcomes: new Map([[rid, { state: 'ATTESTED', label: 'x', final: true, table: honest, check }]]) });
  assert.equal(lost.state, 'lost', lost.text);
});
