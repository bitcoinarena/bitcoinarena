// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 bypass hunt on #1487 (feedback #009): combine() now drops a word whose signature does not verify - but it still
// counts every key of the daemon's own --attestors list (bin/arena-attestor.mjs: combine(all, { attestors: ATTESTORS })), never
// the attestors the ROUND's market names. The daemon attests every version of the market that names its key (marketsToAttest /
// marketVersions, kanban "every version attested") with the one --attestors list it started with. A version that rotates one
// attestor out (v2 names A, B, D; the daemons still run --attestors A,B,C) lets the dropped attestor C void every v2 round with a
// VALID signature: A and B combine C's good word in, attestationStands refuses the whole attestation on C's key ("signed by key
// ... which game does not name"), A and B retry the same combination each tick, and the round goes VOID at its deadline -
// the effect of #009, one attestor voiding a k-of-n attestation the others signed, through a word the #1487 check passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { attestWindow, combine } from '../src/attestor.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { UPDOWN, UPDOWN_ATTESTOR_KEYS } from '../../arena-node/test/plugins/updown/index.js';

const Q = 1791598500000n;
const WINDOW = { startMs: Q, endMs: Q + 900000n };
const ROUND = new Uint8Array(32).fill(5);
const at = (m, cents) => ({ atMs: Q + BigInt(m) * 60000n, price: BigInt(cents) });
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edVerify = (sig, msg, key) => verify(null, Buffer.from(msg), { key: Buffer.concat([SPKI, Buffer.from(key)]), format: 'der', type: 'spki' }, Buffer.from(sig));
const hex = (b) => Buffer.from(b).toString('hex');

test('#1489 bypass #1487: an attestor the market version dropped still voids its rounds with a valid signature (the daemon combines by --attestors, not the round\'s manifest)', () => {
  const { A, B, C } = UPDOWN_ATTESTOR_KEYS;
  const v1 = UPDOWN.registration.manifest;
  // v2 of the market: C rotated out, D in (D is down or slow - it does not matter here)
  const D = new Uint8Array(32).fill(0x44);
  const v2 = { ...v1, version: v1.version + 1, attestors: [A.pubkey, B.pubkey, D], attestThreshold: 2 };
  // the daemons' flags, unchanged since v1 (the README line: --attestors <hex,hex,hex> --threshold 2)
  const CLI_ATTESTORS = v1.attestors.map(hex);
  assert.ok(CLI_ATTESTORS.includes(hex(C.pubkey)));
  const samples = [at(-1, 8295000), at(5, 8296000)];
  const w = (k) => attestWindow({ samples, roundId: ROUND, window: WINDOW, attestor: k });
  // A (the daemon combining): its own word first, B's, and C's - all three VALID signatures over the honest body
  const mine = w(A);
  const words = [mine, w(B), w(C)];
  // kanban #2635: the daemon now combines by the manifest of the version the round's contract names (bin/arena-attestor.mjs
  // manifestsById.get(c.gameId)); its --attestors flags only stand for a market whose manifest it never read
  const att = combine(words, { attestors: CLI_ATTESTORS, threshold: 2, manifest: v2 });
  assert.ok(att, 'no attestation combined at all');
  const st = attestationStands(decodeAttestation(att.bytes), { manifest: v2, roundIdBytes: ROUND, verify: edVerify });
  // control: without C's word, A and B alone stand on v2
  const ab = combine([mine, w(B)], { attestors: CLI_ATTESTORS, threshold: 2, manifest: v2 });
  const stAB = attestationStands(decodeAttestation(ab.bytes), { manifest: v2, roundIdBytes: ROUND, verify: edVerify });
  console.log('  FACTS: A+B+C combined ->', att.signers, 'signers, v2 seat says', st.ok, st.why, '| A+B alone ->', stAB.ok);
  assert.equal(stAB.ok, true, stAB.why);
  assert.equal(st.ok, true, `one dropped attestor's valid word voided the 2-of-3 on v2: ${st.why}`);
});

test('#2635: combine by the round\'s manifest - its keys and threshold, the flags only without one', () => {
  const { A, B, C } = UPDOWN_ATTESTOR_KEYS;
  const v1 = UPDOWN.registration.manifest;
  const D = new Uint8Array(32).fill(0x44);
  const v2 = { ...v1, version: v1.version + 1, attestors: [A.pubkey, B.pubkey, D], attestThreshold: 2 };
  const CLI = v1.attestors.map(hex);
  const samples = [at(-1, 8295000), at(5, 8296000)];
  const w = (k) => attestWindow({ samples, roundId: ROUND, window: WINDOW, attestor: k });
  // C alone beside A: under v2 only A counts - below the threshold, nothing is combined (C's word never fills a v2 attestation)
  assert.equal(combine([w(A), w(C)], { attestors: CLI, threshold: 2, manifest: v2 }), null);
  // the v1 round still combines A, B and C (C is v1's attestor) and stands on v1
  const v1att = combine([w(A), w(B), w(C)], { attestors: CLI, threshold: 2, manifest: v1 });
  assert.equal(v1att.signers, 3);
  assert.equal(attestationStands(decodeAttestation(v1att.bytes), { manifest: v1, roundIdBytes: ROUND, verify: edVerify }).ok, true);
  // a threshold of 3 in the manifest wins over the flag's 2
  assert.equal(combine([w(A), w(B)], { attestors: CLI, threshold: 2, manifest: { ...v2, attestThreshold: 3 } }), null);
  // no manifest known: the flags, as before
  assert.equal(combine([w(A), w(B), w(C)], { attestors: CLI, threshold: 2 }).signers, 3);
});
