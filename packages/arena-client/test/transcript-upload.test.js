// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RUN IS SAFE BEFORE THE VICTORY SCREEN (§13A client duty, kanban #315): at least two committee nodes hold the same whole transcript
// (one hash, up to the run's last tick); then the mirror, if configured, is handed bytes checked against that hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureTranscript } from '../src/transcript-upload.js';
import { encodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const T = { roundId: RID, entryId: EID, batches: [], marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));
const answer = (ticks, hash = HASH, bytes = BYTES) => ({ ok: true, status: 200, headers: { get: (k) => (k === 'x-ticks' ? String(ticks) : k === 'x-transcript-hash' ? hash : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

test('safe once two nodes hold the same whole transcript; one, a short one or a different one is not; the mirror gets checked bytes', async () => {
  const posted = [];
  const fetcherFor = (byBase) => async (url, o) => {
    if (o && o.method === 'POST') { posted.push({ url, n: o.body.length }); return { ok: true, status: 201 }; }
    const base = Object.keys(byBase).find((b) => url.startsWith(b));
    const a = byBase[base];
    if (!a) throw new Error('unreachable');
    return a;
  };
  const two = await secureTranscript({ roundId: RID, entryId: EID, nodes: ['http://a', 'http://b', 'http://c'], finalTick: 100, mirror: 'http://mirror',
    fetcher: fetcherFor({ 'http://a': answer(100), 'http://b': answer(120), 'http://c': answer(40) }) });
  assert.equal(two.safe, true, two.why); assert.deepEqual(two.holders, ['http://a', 'http://b']); assert.equal(two.mirrored, true);
  assert.equal(posted.length, 1); assert.match(posted[0].url, /^http:\/\/mirror\/transcript\?round=(01)+&entry=(02)+$/);
  const one = await secureTranscript({ roundId: RID, entryId: EID, nodes: ['http://a', 'http://b'], finalTick: 100,
    fetcher: fetcherFor({ 'http://a': answer(100), 'http://b': answer(99) }) });
  assert.equal(one.safe, false); assert.match(one.why, /1 of the 2 committee nodes/); assert.match(one.why, /holds 99 of 100 ticks/);
  const split = await secureTranscript({ roundId: RID, entryId: EID, nodes: ['http://a', 'http://b'], finalTick: 100,
    fetcher: fetcherFor({ 'http://a': answer(100), 'http://b': answer(100, 'ee'.repeat(32)) }) });
  assert.equal(split.safe, false, 'two different transcripts are not one held twice');
  // bytes that do not hash to the agreed transcript are never mirrored
  posted.length = 0;
  const forged = await secureTranscript({ roundId: RID, entryId: EID, nodes: ['http://a', 'http://b'], finalTick: 1, mirror: 'http://mirror',
    fetcher: fetcherFor({ 'http://a': answer(5, HASH, encodeTranscript({ ...T, entryId: b32(9) })), 'http://b': answer(5, HASH, encodeTranscript({ ...T, entryId: b32(9) })) }) });
  assert.equal(forged.safe, true); assert.equal(forged.mirrored, false); assert.equal(posted.length, 0); assert.match(forged.why, /no node's bytes hash/);
  console.log('  ' + two.why + '\n  ' + one.why);
});
