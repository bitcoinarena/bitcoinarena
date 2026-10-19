// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GHOST IS A PICTURE FROM A TRANSCRIPT, NOT A POSITION A NODE ANNOUNCES.
//
// 0.9: "Other trucks are visible ghosts with no collision." 0.10: "Ghost
// snapshots are never inputs to this calculation."
//
// The second sentence is guarded in `packages/nextblock` by an argument list with
// nowhere to put one - see `private-world.test.js` there. This file guards the
// first: a frame that says where somebody's truck was has to be a picture of a
// run they published inputs for, or a node fans out whatever coordinates it
// likes and paints a competitor who never drove.
//
// That is the same fault a payout table had before `payoutInputsId` and a
// census had before `censusInputsId`, and it takes the same fix: bind the
// thing being shown to the inputs it came from. The binding already existed on
// the wire - §11's input chain - so a ghost names the head it was taken from,
// exactly as a checkpoint does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { TYPE_GHOST, TYPE_INPUT_BATCH, TAG } from '../src/constants.js';
import { batchId } from '../src/batch.js';
import { GENESIS } from '../src/transcript.js';
import { entryId } from '../src/contracts.js';
import {
  encodeGhost, decodeGhost, ghostId, ghostBinds, GHOST_BYTES,
} from '../src/ghost.js';

const b32 = (n) => new Uint8Array(32).fill(n);

/** Four batches of three ticks: ticks 0..11, heads after each. */
const chainOf = (n = 4, per = 3) => {
  const batches = [];
  let prev = GENESIS;
  for (let k = 0; k < n; k++) {
    const first = k * per;
    const b = {
      roundId: b32(1), entryId: b32(2), previousHash: prev, firstTick: first,
      ticks: Array.from({ length: per }, (_, i) => [65536, first + i, 0, 0, 0]),
      liquidations: [],
    };
    batches.push(b);
    prev = batchId(b);
  }
  return { roundId: b32(1), entryId: b32(2), batches };
};

const headAfter = (t, k) => batchId(t.batches[k]);
const ghostAt = (t, k, tick, over = {}) => ({
  roundId: t.roundId, entryId: t.entryId, playerPubkey: b32(7),
  tick, inputChainHash: headAfter(t, k),
  x: 3 * 65536, z: -4 * 65536, heading: 16384, ...over,
});

/**
 * THE SHAPE IS PINNED, in bytes and in order. A frame at 5 Hz whose length
 * moved would be a frame two implementations could disagree about, and the
 * type byte is first so an InputBatch and a Ghost are told apart before a
 * decoder reads anything else - 0.10's rule made a difference of one byte.
 */
test('a ghost survives the wire unchanged, at a fixed size', () => {
  const t = chainOf();
  const g = ghostAt(t, 1, 4);
  const bytes = encodeGhost(g);

  assert.equal(bytes.length, GHOST_BYTES);
  assert.equal(bytes.length, 147, 'the frame changed size');
  assert.equal(bytes[0], TYPE_GHOST);
  assert.notEqual(TYPE_GHOST, TYPE_INPUT_BATCH, 'a picture and an input share a first byte');

  const back = decodeGhost(bytes);
  assert.equal(toHex(back.roundId), toHex(g.roundId));
  assert.equal(toHex(back.entryId), toHex(g.entryId));
  assert.equal(toHex(back.playerPubkey), toHex(g.playerPubkey));
  assert.equal(back.tick, 4);
  assert.equal(toHex(back.inputChainHash), toHex(g.inputChainHash));
  assert.deepEqual([back.x, back.z, back.heading], [g.x, g.z, g.heading]);

  // signed words, because a truck west or south of the origin is ordinary
  const negative = decodeGhost(encodeGhost({ ...g, x: -65536, z: -1, heading: -16384 }));
  assert.deepEqual([negative.x, negative.z, negative.heading], [-65536, -1, -16384]);

  // and the id moves if any field does, so a frame cannot be edited in flight
  const was = toHex(ghostId(g));
  for (const over of [{ tick: 5 }, { x: g.x + 1 }, { z: g.z + 1 }, { heading: 0 },
                      { playerPubkey: b32(8) }, { inputChainHash: headAfter(t, 2) },
                      { roundId: b32(9) }, { entryId: b32(9) }])
    assert.notEqual(toHex(ghostId({ ...g, ...over })), was, Object.keys(over)[0]);

  assert.equal(TAG.ghost, 'ARENA/v1/Ghost');
  assert.throws(() => decodeGhost(bytes.slice(0, GHOST_BYTES - 1)), /ran off the end/);
  assert.throws(() => decodeGhost(new Uint8Array([...bytes, 0])), /trailing/);

  // AND THE FIRST BYTE IS READ, NOT ONLY WRITTEN. A decoder that skipped it
  // would take an InputBatch's bytes as a picture and hand back coordinates
  // made of somebody's steering - the one confusion 0.10 cannot afford, and
  // the reason a ghost has a type byte of its own.
  const mistyped = bytes.slice();
  mistyped[0] = TYPE_INPUT_BATCH;
  assert.throws(() => decodeGhost(mistyped), /not a ghost/,
    'a frame that is not a ghost decoded as one');
  for (const wrong of [0x00, 0x05, 0x09, 0xff]) {
    const other = bytes.slice();
    other[0] = wrong;
    assert.throws(() => decodeGhost(other), /not a ghost/);
  }
});

/**
 * A PICTURE OF A RUN THAT HAPPENED. The head it names has to be one the
 * transcript reaches - §11's "a transcript whose inputs were never published
 * cannot be replayed", applied to a picture instead of a mark.
 */
test('a ghost bound to a head the transcript reaches is a picture; an invented one is not', () => {
  const t = chainOf();

  for (let k = 0; k < 4; k++) {
    const seen = ghostBinds(ghostAt(t, k, k * 3), t);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.throughTick, k * 3 + 2);
  }

  // A HEAD NOBODY PUBLISHED. This is the fabricated competitor: a node with a
  // position it likes and no inputs behind it.
  const invented = ghostBinds(ghostAt(t, 0, 1, { inputChainHash: b32(0xee) }), t);
  assert.equal(invented.ok, false, 'a ghost was accepted with no inputs behind it');
  assert.match(invented.why, /so that picture was taken from inputs nobody published/);

  // A HEAD FROM SOMEBODY ELSE'S RUN is the same answer: it is not this
  // transcript's chain, however real it is elsewhere.
  const other = chainOf(4, 5);
  assert.equal(ghostBinds(ghostAt(t, 0, 1, { inputChainHash: headAfter(other, 0) }), t).ok, false);

  // and GENESIS - the head before any input went out - is not a picture of
  // anything, which is the frame a node would fabricate for a player who never
  // entered
  const before = ghostBinds(ghostAt(t, 0, 0, { inputChainHash: GENESIS }), t);
  assert.equal(before.ok, false);
  assert.match(before.why, /before any input went out/);
});

/**
 * AND THE TICK HAS TO BE ONE THOSE INPUTS COVER. A head after batch 1 reaches
 * tick 5; a picture at tick 9 taken from it is a picture of ticks that head
 * has not seen.
 */
test('a ghost at a tick its inputs do not cover is refused, and the range is named', () => {
  const t = chainOf();

  assert.equal(ghostBinds(ghostAt(t, 1, 5), t).ok, true, 'the last tick of the head is covered');
  const ahead = ghostBinds(ghostAt(t, 1, 6), t);
  assert.equal(ahead.ok, false, 'a picture ran ahead of the inputs behind it');
  assert.match(ahead.why, /at tick 6, and the inputs it names cover 0 to 5/);

  assert.equal(ghostBinds(ghostAt(t, 3, 11), t).ok, true);
  assert.equal(ghostBinds(ghostAt(t, 3, 12), t).ok, false);

  // an earlier tick under a later head is fine: those inputs produced it too
  assert.equal(ghostBinds(ghostAt(t, 3, 0), t).ok, true);
});

/**
 * AND THE TRANSCRIPT IT IS CHECKED AGAINST HAS TO BE A CHAIN.
 *
 * A mutant survived on this: the link walk was there, nothing tested it, and
 * dropping it still passed. A list of batches that do not follow one another
 * is not a run - it is a bag of inputs - and a head found in such a list is a
 * head of nothing. §11 is the same rule `checkTranscript` applies to marks;
 * a picture gets it too, or the binding is satisfied by a transcript somebody
 * assembled after the fact.
 */
test('a ghost taken from a transcript whose chain is broken is refused', () => {
  const t = chainOf();
  const good = ghostBinds(ghostAt(t, 2, 7), t);
  assert.equal(good.ok, true, good.why);

  const broken = { ...t, batches: t.batches.map((b, i) => (i === 1 ? { ...b, previousHash: b32(9) } : b)) };
  const no = ghostBinds(ghostAt(t, 2, 7), broken);
  assert.equal(no.ok, false, 'a picture was taken from a chain that is not one');
  assert.match(no.why, /input chain is broken/);

  // the break is upstream of the head the ghost names, and it still counts:
  // a chain broken anywhere before the picture is a run that did not happen
  const later = { ...t, batches: t.batches.map((b, i) => (i === 3 ? { ...b, previousHash: b32(9) } : b)) };
  assert.equal(ghostBinds(ghostAt(t, 2, 7), later).ok, true,
    'a break AFTER the head is not this picture\'s problem');
});

/**
 * A GHOST IS FOR ONE ROUND AND ONE ENTRY, and the transcript it is checked
 * against is not the asker's to choose - the same discipline
 * `censusRootMatchesRound` needed for its entries.
 */
test('a ghost for another round or another entry is refused', () => {
  const t = chainOf();

  assert.match(ghostBinds(ghostAt(t, 1, 4, { roundId: b32(9) }), t).why, /another round/);
  assert.match(ghostBinds(ghostAt(t, 1, 4, { entryId: b32(9) }), t).why, /another entry/);
  assert.match(ghostBinds(ghostAt(t, 1, 4), undefined).why, /no transcript/);
  assert.match(ghostBinds({ ...ghostAt(t, 1, 4), inputChainHash: undefined }, t).why,
    /names no input chain head/);
});

/**
 * THE PLAYER KEY IS CHECKED WHEN THERE IS SOMETHING TO CHECK IT AGAINST, and
 * NAMED as unchecked when there is not. A label nobody verifies is a label a
 * node writes.
 */
test('the key a ghost names is the entry\'s, or it is reported unchecked', () => {
  const t = chainOf();
  const entry = {
    roundId: b32(1), playerPubkey: b32(7), sessionPubkey: b32(8), stakeCommitment: b32(9),
    stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const bound = { ...ghostAt(t, 1, 4), entryId: entryId(entry) };
  const withEntry = { ...bound, roundId: t.roundId };
  const t2 = { ...t, entryId: entryId(entry) };

  const ok = ghostBinds(withEntry, t2, entry);
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual(ok.unchecked, [], 'the key was checked, so nothing is unchecked');

  const wrongKey = ghostBinds({ ...withEntry, playerPubkey: b32(0x55) }, t2, entry);
  assert.equal(wrongKey.ok, false, 'a ghost wore a key that entry was not signed for');
  assert.match(wrongKey.why, /names a key that entry was not signed for/);

  const wrongEntry = ghostBinds(withEntry, t2, { ...entry, joinTick: 1 });
  assert.equal(wrongEntry.ok, false);
  assert.match(wrongEntry.why, /a different entry than the ghost names/);

  // and with no entry offered the answer says so rather than implying a check
  const alone = ghostBinds(withEntry, t2);
  assert.equal(alone.ok, true);
  assert.equal(alone.unchecked.length, 1);
  assert.match(alone.unchecked[0], /player key/);
});
