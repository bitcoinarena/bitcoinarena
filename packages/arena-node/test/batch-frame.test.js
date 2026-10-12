// NO BATCH A TRANSCRIPT CANNOT FRAME (kanban #342): the transcript frames each batch with a u16 length, so a seat refuses at
// intake a batch longer than 65,535 bytes, naming the limit - measured live: a 97,309-byte batch was taken by all seven seats
// and every close then failed "u16 out of range", replayed again and again without end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round, TRANSCRIPT_BATCH_MAX_BYTES } from '../src/round.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const batchOf = (ticks) => encodeInputBatch({ roundId: b32(1), entryId: b32(2), previousHash: b32(0), firstTick: 0,
  ticks: Array.from({ length: ticks }, () => [0, 0, 0, 0, 0]), liquidations: [] });

test('a batch longer than a transcript frame is refused at intake, by name; one that fits goes on to the usual checks', () => {
  const r = new Round(openStore(), () => 1000, { plugins: HOSTED });
  let n = 1000; while (batchOf(n).length <= TRANSCRIPT_BATCH_MAX_BYTES) n += 500;
  const big = batchOf(n), fits = batchOf(n - 500);
  assert.ok(big.length > 65535 && fits.length <= 65535, `${big.length} / ${fits.length}`);
  assert.throws(() => r.batch(big), new RegExp(`^Error: a batch is at most 65535 bytes - a transcript frames each with a u16 length - and that one is ${big.length}: send its ticks as several batches$`));
  assert.throws(() => r.batch(fits), /^Error: no such round$/, 'one that fits is checked as before');
  assert.equal(r.largestBatch(b32(1), b32(2)), 0, 'nothing held for that run');
  console.log(`  FRAME: refused ${big.length} bytes (${n} ticks); ${fits.length} bytes went on`);
});
