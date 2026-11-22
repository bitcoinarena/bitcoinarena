// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 21 (attestations / markets): ONE ATTESTOR OF A SCALAR MARKET VOIDS ANY ROUND IT LIKES.
// A scalar market's attestors sign the 60 s average at the window's end in whole cents (attestor.js attestValue). Two honest
// attestors sampling their sources on their own 10 s clocks read different cents almost always, so they sign DIFFERENT bodies.
// Their words are public (GET /attestation?round=). One attestor C of a 2-of-3 market signs BOTH honest values: {A, C} on A's
// value and {B, C} on B's value each carry the threshold and stand at every seat (valueAttestationStands), and two standing values
// that differ make the round DISPUTED -> VOID (attested.js marketTransition). C sees the value before it decides, so it voids
// exactly the rounds its own side loses (stake back, fee back): a free option paid by the honest winners - or it posts only the one
// of the two honest values that pays it more. Neither needs a second bad attestor.
// SAFE: one attestor's equivocation over honest values that disagree by a cent does not void the round.
// Fixed from protocol 33 (kanban #3260, owner 2026-11-22 option A): a dispute counts only between disjoint signer sets; C is flagged as an
// equivocator and its signatures count toward neither value. A round below 33 keeps the old reading (control below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attestorKey, attestValue, combine, wordToJson, wordFromJson, verifyEd25519Word } from '../src/attestor.js';
import { valueAttestationStands, decodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { marketTransition } from '../../arena-protocol/src/attested.js';
import { SCALAR_SIDES } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { sign } from 'node:crypto';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = attestorKey(b32(0x11)), B = attestorKey(b32(0x22)), C = attestorKey(b32(0x33));
const MANIFEST = { gameName: 'btc-at-18', attestors: [A.pubkey, B.pubkey, C.pubkey], attestThreshold: 2, outcomes: [...SCALAR_SIDES],
  resultType: 1, scalar: { low: 9000000n, high: 11000000n, unit: 'cents' } };
// isScalar(manifest) reads the scalar field; resultType of an attested game
import { RESULT_TYPE, isScalar } from '../../arena-protocol/src/manifest.js';
import { DISJOINT_RULES_VERSION, TIE_SPLIT_VERSION } from '../../arena-protocol/src/constants.js';
MANIFEST.resultType = RESULT_TYPE.ATTESTED;

const ROUND = b32(0x77);
const END = 1788203660000n;
const window = { startMs: END - 900000n, endMs: END };
// two honest attestors' medians of the same sources, each read on its own 10 s clock (4 s apart): the exchanges' last trade at
// each reading differs, so their medians differ by a few cents now and then (here: one reading, 12 cents)
const READINGS = [10250010n, 10250012n, 10250009n, 10250015n, 10250011n, 10250013n, 10250014n, 10250012n, 10250016n, 10250018n, 10250017n, 10250019n];
const samplesOf = (phase, bump) => READINGS.map((price, i) => ({ atMs: END - 120000n + phase + BigInt(i) * 10000n, price: i === 10 ? price + bump : price }));

test('one attestor signing both honest values of a scalar round does not void it', () => {
  assert.equal(isScalar(MANIFEST), true);
  const a = attestValue({ samples: samplesOf(0n, 0n), roundId: ROUND, window, attestor: A });
  const b = attestValue({ samples: samplesOf(4000n, 12n), roundId: ROUND, window, attestor: B });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value, b.value, 'the two honest attestors read different cents');
  // their public words, as GET /attestation serves them
  const wa = wordFromJson(wordToJson(a)), wb = wordFromJson(wordToJson(b));
  // C signs each honest body
  const cWord = (w) => ({ body: w.body, key: toHex(C.pubkey), signature: toHex(new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(w.body)), C.key))) });
  const att1 = combine([wa, cWord(wa)], { manifest: MANIFEST });
  const att2 = combine([wb, cWord(wb)], { manifest: MANIFEST });
  assert.ok(att1 && att2);
  // both stand at a seat
  const s1 = valueAttestationStands(decodeValueAttestation(att1.bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify: verifyEd25519Word });
  const s2 = valueAttestationStands(decodeValueAttestation(att2.bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify: verifyEd25519Word });
  console.log(`  A ${a.value}, B ${b.value}; {A,C} stands ${s1.ok}, {B,C} stands ${s2.ok}`);
  const held = [{ ...decodeValueAttestation(att1.bytes), receivedMs: 1000 }, { ...decodeValueAttestation(att2.bytes), receivedMs: 2000 }];
  const at = { deadlineMs: 10 ** 9, windowMs: 600000n, nowMs: 3000, attestThreshold: MANIFEST.attestThreshold };
  const st = marketTransition(null, held, { ...at, protocolVersion: DISJOINT_RULES_VERSION });
  console.log(`  market state after C posts both: ${st.state}${st.reason ? ` (${st.reason})` : ''}; equivocators ${JSON.stringify(st.equivocators || [])}`);
  assert.notEqual(st.state, 'VOID', `one attestor of 3 voided the round: ${st.why}`);
  assert.deepEqual(st.equivocators, [toHex(C.pubkey)], 'the key that signed both values is flagged');
  // a seat that read {A,C} alone first (ATTESTED on A's value) goes back to OPEN once C's second value is held: C's signature counts for neither
  const first = marketTransition(null, held.slice(0, 1), { ...at, protocolVersion: DISJOINT_RULES_VERSION });
  assert.equal(first.state, 'ATTESTED');
  assert.equal(marketTransition(first, held, { ...at, protocolVersion: DISJOINT_RULES_VERSION }).state, 'OPEN');
  // control: a round below 33 reads the pair as before - VOID 'dispute'
  assert.equal(marketTransition(null, held, { ...at, protocolVersion: TIE_SPLIT_VERSION }).reason, 'dispute');
});
