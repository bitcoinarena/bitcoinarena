// THE SERIES EDGES - series.js's untested functions (kanban #146, fourth surface; plan comment 193, Go 2026-10-05): the run
// that fits its 90 s slot (seriesRunFits, series-writer.js), the rounds a window holds (seriesRoundsWithin, series-writer.js),
// the first and the last round with and without late join, and the series publication - its payload, its output, and where
// a chain view carries it (findSeriesPublication, roster.js). series-round.test.js and series-tail.test.js keep derivation
// and the tail. No defect was read from the source before this file; it pins the edges the card names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seriesTemplate, seriesRound, seriesIndexAt, seriesRunFits, seriesRoundsWithin, seriesPublicationPayload,
  seriesPublicationOutput, findSeriesPublication, seriesId, ROUND_PERIOD_MS, LATE_JOIN_MS, ROUNDS_PER_SERIES,
  SERIES_RESULT_CARD_MS, PUBLICATION_KIND_SERIES,
} from '../src/series.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const base = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)],
};
const T = seriesTemplate(base, seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000));
const LATE = { ...T, entryCloseMs: T.startTimeMs + LATE_JOIN_MS };
const S = T.startTimeMs, P = ROUND_PERIOD_MS;

test('seriesRunFits: a run ending at most 8 s before the next start fits; one tick more is refused by name', () => {
  assert.equal(SERIES_RESULT_CARD_MS, 8000n);
  assert.deepEqual(seriesRunFits({ ...T, blockTicks: 4921 }), { ok: true, runMs: 81996n });       // 4921 ticks: 81 996 ms <= 82 000
  assert.deepEqual(seriesRunFits({ ...T, blockTicks: 4922 }), { ok: false,
    why: 'a run of 4922 ticks is 82013 ms, and a round of a 90000 ms series runs at most 82000 ms (its next start less 8000 ms)' });
  const none = seriesRunFits({ ...T, blockTicks: undefined });
  assert.equal(none.ok, false);
  assert.match(none.why, /^the series names no run length: /);
  // a custom period: a 4921-tick run does not fit a 60 s series
  assert.equal(seriesRunFits({ ...T, blockTicks: 4921 }, { periodMs: 60000n }).ok, false);
  assert.equal(seriesRunFits({ ...T, blockTicks: 1000 }, { periodMs: 60000 }).ok, true);
});

test('seriesRoundsWithin: rounds by their start inside [from, to]; the first round, the window edges, the last round, reversed', () => {
  assert.deepEqual(seriesRoundsWithin(T, S - 500000n, S + 2n * P), [0, 1, 2], 'a window from before the series starts at round 0');
  assert.deepEqual(seriesRoundsWithin(T, S - 500000n, S - 1n), [], 'a window ending before the start holds nothing');
  assert.deepEqual(seriesRoundsWithin(T, S + 3n * P, S + 4n * P), [3, 4], 'a round starting exactly at from is in');
  assert.deepEqual(seriesRoundsWithin(T, S + 3n * P + 1n, S + 4n * P), [4], 'a round starting 1 ms before from is out');
  assert.deepEqual(seriesRoundsWithin(T, S + 3n * P, S + 4n * P - 1n), [3], 'a round starting 1 ms after to is out');
  const end = seriesRoundsWithin(T, S + BigInt(ROUNDS_PER_SERIES - 2) * P, S + 10_000n * P);
  assert.deepEqual(end, [ROUNDS_PER_SERIES - 2, ROUNDS_PER_SERIES - 1], 'the list does not stop at the last round');
  assert.deepEqual(seriesRoundsWithin(T, S, S + 100n * P, { count: 3 }), [0, 1, 2]);
  assert.deepEqual(seriesRoundsWithin({ ...T, seriesCount: 2 }, S, S + 100n * P), [0, 1]);
  assert.deepEqual(seriesRoundsWithin(T, S + 5n * P, S + 2n * P), [], 'a reversed window holds rounds');
  assert.deepEqual(seriesRoundsWithin(T, Number(S), Number(S + P)), [0, 1], 'number bounds');
  assert.deepEqual(seriesRoundsWithin(T, S, S + 2n * 60000n, { periodMs: 60000n }), [0, 1, 2], 'a custom period');
});

test('the first and the last round derive; count and -1 are refused; late join closes entry at start + 45 s', () => {
  const first = seriesRound(T, 0), last = seriesRound(T, ROUNDS_PER_SERIES - 1);
  assert.deepEqual({ start: first.startTimeMs, close: first.entryCloseMs, i: first.roundIndex }, { start: S, close: S, i: 0 });
  assert.equal(last.startTimeMs, S + BigInt(ROUNDS_PER_SERIES - 1) * P);
  assert.equal(last.roundIndex, ROUNDS_PER_SERIES - 1);
  assert.throws(() => seriesRound(T, ROUNDS_PER_SERIES), { message: `round ${ROUNDS_PER_SERIES} is outside the series' 0 .. ${ROUNDS_PER_SERIES - 1}` });
  assert.throws(() => seriesRound(T, -1), { message: `round -1 is outside the series' 0 .. ${ROUNDS_PER_SERIES - 1}` });
  assert.equal(LATE_JOIN_MS, 45000n);
  const late0 = seriesRound(LATE, 0), lateLast = seriesRound(LATE, ROUNDS_PER_SERIES - 1);
  assert.equal(late0.entryCloseMs, S + 45000n);
  assert.equal(lateLast.entryCloseMs, lateLast.startTimeMs + 45000n);
  assert.notEqual(hex(seriesId(LATE)), hex(seriesId(T)), 'a late-join series and a closed-at-start one are one series');
});

test('the series publication: "ARN" S || id, 36 bytes, refused for a 31-byte id; a zero-value output with one direct push', () => {
  const id = seriesId(T);
  const p = seriesPublicationPayload(id);
  assert.equal(p.length, 36);
  assert.equal(PUBLICATION_KIND_SERIES, 0x53);
  assert.equal(hex(p), '41524e53' + hex(id));
  for (const bad of [id.subarray(0, 31), undefined])
    assert.throws(() => seriesPublicationPayload(bad), { name: 'TypeError', message: 'a series publication commits to a 32-byte series id' });
  const out = seriesPublicationOutput(id);
  assert.equal(out.value, 0n);
  assert.equal(hex(out.script), '6a24' + hex(p));
});

// a minimal legacy transaction: one input, the given outputs
const le = (n, bytes) => { const o = new Uint8Array(bytes); let v = BigInt(n); for (let i = 0; i < bytes; i++) { o[i] = Number(v & 255n); v >>= 8n; } return o; };
const txWith = (outputs, salt = 0) => Uint8Array.from([...le(2, 4), 1, ...b32(salt), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outputs.length, ...outputs.flatMap((o) => [...le(o.value, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const payTo = { value: 1000n, script: Uint8Array.from([0x51, 0x20, ...b32(0x77)]) };

test('findSeriesPublication: the lowest block carrying it with its height; nothing, no view, unparsable and foreign ones skipped', () => {
  const id = seriesId(T), other = seriesId(LATE);
  const pub = txWith([payTo, seriesPublicationOutput(id)], 1);
  const view = { firstHeight: 500, blocks: [
    { transactions: [Uint8Array.from([1, 2, 3]), txWith([payTo], 2)] },                         // 500: garbage, an unrelated tx
    { transactions: [txWith([seriesPublicationOutput(other)], 3)] },                            // 501: another series
    { transactions: [pub] },                                                                    // 502: the publication
    { transactions: [txWith([seriesPublicationOutput(id)], 4)] },                               // 503: a later copy
  ] };
  const got = findSeriesPublication(view, id);
  assert.equal(got.height, 502);
  assert.equal(got.tx.outputs.length, 2);
  assert.equal(findSeriesPublication(view, other).height, 501);
  assert.equal(findSeriesPublication({ ...view, blocks: view.blocks.slice(0, 2) }, id), null, 'found in a view that does not carry it');
  assert.equal(findSeriesPublication(undefined, id), null);
  assert.equal(findSeriesPublication({ firstHeight: 500 }, id), null);
  assert.equal(findSeriesPublication({ ...view, firstHeight: 500.5 }, id), null);
  assert.equal(findSeriesPublication({ firstHeight: 500, blocks: [{}] }, id), null, 'a block with no transactions');
});
