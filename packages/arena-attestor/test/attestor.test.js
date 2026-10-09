// THE ATTESTOR'S CORE (kanban #236): one window's word from its readings, nothing signed without a price at the start, and
// the words combining into an attestation a seat takes - the market's threshold of its attestors over one body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { attestWindow, combine, wordToJson, wordFromJson, attestorKey } from '../src/attestor.js';
import { centsOf, medianOf } from '../src/sources.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { UPDOWN, UPDOWN_ATTESTOR_KEYS } from '../../arena-node/test/plugins/updown/index.js';
import { UP, DOWN } from '../../arena-protocol/src/up-down.js';

const Q = 1791598500000n;
const WINDOW = { startMs: Q, endMs: Q + 900000n };
const ROUND = new Uint8Array(32).fill(5);
const MIN = 60000n;
const at = (m, cents) => ({ atMs: Q + BigInt(m) * MIN, price: BigInt(cents) });
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edVerify = (sig, msg, key) => verify(null, Buffer.from(msg), { key: Buffer.concat([SPKI, Buffer.from(key)]), format: 'der', type: 'spki' }, Buffer.from(sig));
const ATTESTORS = UPDOWN.attestors.map((a) => Buffer.from(a.pubkey).toString('hex'));

test('prices to whole cents, the median of the readings, a window\'s word - and no price at the start signs nothing', () => {
  assert.equal(centsOf('82950.448'), 8295044n);
  assert.equal(centsOf('82950'), 8295000n);
  assert.equal(centsOf('-1'), null);
  assert.equal(medianOf([8295356n, 8294922n, 8295000n]), 8295000n);
  const A = UPDOWN_ATTESTOR_KEYS.A;
  // the minute before the window (the price to beat), then higher at its end: Up
  const up = attestWindow({ samples: [at(-1, 8295000), at(3, 8296000), at(9, 8299000)], roundId: ROUND, window: WINDOW, attestor: A });
  console.log('  WORD:', JSON.stringify(wordToJson(up)));
  assert.equal(up.ok, true);
  assert.equal(up.body.outcome, UP);
  assert.equal(up.body.observedAtMs, WINDOW.endMs, 'observed_at is not the window\'s end');
  assert.equal(up.priceToBeat, 8295000n);
  assert.equal(up.endPrice, 8299000n);
  // lower at the end: Down
  assert.equal(attestWindow({ samples: [at(-1, 8295000), at(1, 8290000)], roundId: ROUND, window: WINDOW, attestor: A }).body.outcome, DOWN);
  // NO READING AT OR BEFORE THE START (the daemon came up inside the window): signs nothing
  const none = attestWindow({ samples: [at(2, 8295000), at(9, 8296000)], roundId: ROUND, window: WINDOW, attestor: A });
  assert.equal(none.ok, false);
  assert.match(none.why, /price to beat is not known/);
  // a word round-trips the wire
  assert.deepEqual(wordFromJson(wordToJson(up)).body, up.body);
});

test('two attestors that saw the same outcome sign the same bytes: their words combine into an attestation every seat takes; one alone does not', () => {
  const samples = [at(-1, 8295000), at(5, 8296000)];
  const words = Object.fromEntries(['A', 'B', 'C'].map((l) => [l, attestWindow({ samples, roundId: ROUND, window: WINDOW, attestor: UPDOWN_ATTESTOR_KEYS[l] })]));
  assert.equal(combine([words.A], { attestors: ATTESTORS, threshold: 2 }), null, 'one attestor alone made an attestation');
  const att = combine([words.A, wordFromJson(wordToJson(words.B))], { attestors: ATTESTORS, threshold: 2 });
  assert.ok(att && att.signers === 2);
  const decoded = decodeAttestation(att.bytes);
  const stands = attestationStands(decoded, { manifest: UPDOWN.registration.manifest, roundIdBytes: ROUND, verify: edVerify });
  console.log('  COMBINED:', JSON.stringify({ signers: att.signers, outcome: att.body.outcome, stands: stands.ok, why: stands.why || null }));
  assert.equal(stands.ok, true, stands.why);
  // A DISSENT: C read a lower price (Down) - A and B still combine on Up, C's word is left out
  const cDown = attestWindow({ samples: [at(-1, 8295000), at(5, 8290000)], roundId: ROUND, window: WINDOW, attestor: UPDOWN_ATTESTOR_KEYS.C });
  const mixed = combine([words.A, words.B, cDown], { attestors: ATTESTORS, threshold: 2 });
  assert.equal(mixed.body.outcome, UP);
  assert.equal(mixed.signers, 2);
  // a key the market does not name is not counted
  const stranger = attestWindow({ samples, roundId: ROUND, window: WINDOW, attestor: attestorKey(new Uint8Array(32).fill(9)) });
  assert.equal(combine([words.A, stranger], { attestors: ATTESTORS, threshold: 2 }), null);
});
