// THE ATTESTOR'S CORE (kanban #236): one window's word from its readings, nothing signed without a price at the start, and
// the words combining into an attestation a seat takes - the market's threshold of its attestors over one body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { attestWindow, attestValue, combine, wordToJson, wordFromJson, attestorKey } from '../src/attestor.js';
import { decodeValueAttestation, valueAttestationStands, isValueAttestationBytes } from '../../arena-protocol/src/scalar.js';
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

// THE VALUE MODE (kanban #362 feature 8): a scalar market's attestors sign the value they observed - the 60 s average at the
// window's end, whole cents - and their words combine into a value attestation a seat takes (scalar.js valueAttestationStands).
const SCALAR = { ...UPDOWN.registration.manifest, scalar: { low: 8000000n, high: 9000000n, unit: 'USD cents' } };

test('a value word: the 60 s average at the window\'s end, signed as a value attestation body; no reading at the end signs nothing', () => {
  const A = UPDOWN_ATTESTOR_KEYS.A;
  // no price to beat needed: the readings start inside the window. 30 s at 8 299 000, 30 s at 8 301 000 -> 8 300 000
  const v = attestValue({ samples: [at(5, 8290000), { atMs: WINDOW.endMs - 60000n, price: 8299000n }, { atMs: WINDOW.endMs - 30000n, price: 8301000n }], roundId: ROUND, window: WINDOW, attestor: A });
  console.log('  VALUE WORD:', JSON.stringify(wordToJson(v)));
  assert.equal(v.ok, true);
  assert.deepEqual([v.body.value, v.body.observedAtMs, v.value], [8300000n, WINDOW.endMs, 8300000n]);
  assert.equal(v.body.outcome, undefined, 'a value word names no outcome');
  // the word round-trips the wire as a value, and an outcome word stays an outcome word
  assert.deepEqual(wordFromJson(wordToJson(v)).body, v.body);
  assert.equal(wordFromJson({ ...wordToJson(v), body: { ...wordToJson(v).body, outcome: 0 } }), null, 'a word naming a value and an outcome is no word');
  // NO READING A MINUTE BEFORE THE END: signs nothing
  const none = attestValue({ samples: [{ atMs: WINDOW.endMs - 30000n, price: 8301000n }], roundId: ROUND, window: WINDOW, attestor: A });
  assert.deepEqual([none.ok, /value is not known/.test(none.why)], [false, true]);
});

test('value words over one value combine into a value attestation a scalar market\'s seat takes; two values do not, and never with outcome words', () => {
  const samples = [at(-1, 8295000), at(5, 8296000)];
  const words = Object.fromEntries(['A', 'B', 'C'].map((l) => [l, attestValue({ samples, roundId: ROUND, window: WINDOW, attestor: UPDOWN_ATTESTOR_KEYS[l] })]));
  assert.equal(combine([words.A], { attestors: ATTESTORS, threshold: 2 }), null, 'one attestor alone made an attestation');
  const att = combine([words.A, wordFromJson(wordToJson(words.B))], { attestors: ATTESTORS, threshold: 2 });
  assert.ok(att && att.signers === 2);
  assert.equal(isValueAttestationBytes(att.bytes), true, 'the bytes are a value attestation (type 0x2a)');
  const decoded = decodeValueAttestation(att.bytes);
  const stands = valueAttestationStands(decoded, { manifest: SCALAR, roundIdBytes: ROUND, verify: edVerify });
  console.log('  VALUE COMBINED:', JSON.stringify({ signers: att.signers, value: String(decoded.value), stands: stands.ok, why: stands.why }));
  assert.equal(stands.ok, true, stands.why);
  assert.equal(decoded.value, 8296000n);
  // the same bytes are no outcome attestation: an Up/Down market's door refuses them by kind (decodeAttestation throws)
  assert.throws(() => decodeAttestation(att.bytes));
  // A DISSENT BY ONE CENT: C saw 8 296 001 - A and B still combine on 8 296 000, C's word is left out
  const cOff = attestValue({ samples: [at(-1, 8295000), at(5, 8296001)], roundId: ROUND, window: WINDOW, attestor: UPDOWN_ATTESTOR_KEYS.C });
  const mixed = combine([words.A, cOff, words.B], { attestors: ATTESTORS, threshold: 2 });
  assert.deepEqual([mixed.body.value, mixed.signers], [8296000n, 2]);
  // two attestors on two different values: no attestation at threshold 2
  assert.equal(combine([words.A, cOff], { attestors: ATTESTORS, threshold: 2 }), null);
  // an outcome word and a value word over the same round never count together
  const outcomeB = attestWindow({ samples, roundId: ROUND, window: WINDOW, attestor: UPDOWN_ATTESTOR_KEYS.B });
  assert.equal(combine([words.A, outcomeB], { attestors: ATTESTORS, threshold: 2 }), null);
});
