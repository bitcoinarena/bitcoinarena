// A PICTURE CARRIES NO AUTHORITY, AND IT IS THE FIRST THING SHED.
//
// 0.9 / 0.10: other trucks are ghosts, and "ghost snapshots are never inputs
// to this calculation". The core keeps the "never an input" half by having no
// argument one could arrive through. This file keeps the rest: a ghost must
// not stand in for anything that DECIDES something - a batch that becomes a
// tick, a mark that becomes a receipt, a leaf that becomes a signer node, an
// advertisement that becomes a bond - and when a queue is full it is a picture
// that goes, never the evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPE_GHOST, TYPE_INPUT_BATCH, TYPE_CHECKPOINT, TYPE_CHECKPOINT_RECEIPT,
  TYPE_CENSUS_LEAF, TYPE_ADVERT, TYPE_RESULT, TYPE_PAYOUT_TABLE, TYPE_OBJECTION,
  TYPE_SLASH_PROOF, TYPE_ROUND_CONTRACT, TYPE_VSS_HANDOUT,
} from '../src/constants.js';
import { FRAMES, frameOf, bearsAuthority, droppable, admit } from '../src/frames.js';
import { encodeGhost } from '../src/ghost.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const GHOST = encodeGhost({
  roundId: b32(1), entryId: b32(2), playerPubkey: b32(7), tick: 4,
  inputChainHash: b32(3), x: 1, z: 2, heading: 3,
});
const framed = (type) => new Uint8Array([type, 0, 1]);

/**
 * EXACTLY ONE FRAME IN THE PROTOCOL IS A PICTURE. Asserted as a count, not as
 * a spot check: a new type that forgot to say what it decides would show up
 * here rather than in whatever accepted it first.
 */
test('one type carries no authority, and it is the ghost', () => {
  const pictures = [...FRAMES.entries()].filter(([, f]) => !f.authority);
  assert.equal(pictures.length, 1, 'something else became a picture');
  assert.equal(pictures[0][0], TYPE_GHOST);
  assert.equal(pictures[0][1].name, 'Ghost');

  // and every other type this package has is in the map, deciding something
  for (const type of [TYPE_ROUND_CONTRACT, TYPE_INPUT_BATCH, TYPE_CHECKPOINT,
                      TYPE_CHECKPOINT_RECEIPT, TYPE_CENSUS_LEAF, TYPE_ADVERT,
                      TYPE_RESULT, TYPE_PAYOUT_TABLE, TYPE_OBJECTION, TYPE_SLASH_PROOF,
                      TYPE_VSS_HANDOUT])
    assert.equal(FRAMES.get(type).authority, true, 'type 0x' + type.toString(16));

  // 18 since the VSS handout: a signer node refuses an entry whose handout it cannot
  // check, so that object gates play and carries authority. Saying so here is
  // the whole point of this guard - the count is not a number to keep green,
  // it is the question "what does the new one decide" asked out loud.
  // 28 since the game manifest (kanban #202, §0A.3): its developer's signature decides which cores, configs, run length,
  // rank curve and min_score a round of that game may name - so it carries authority.
  // 29 since the outcome attestation (kanban #206, §0A.7a): k of an attested game's attestors decide which picks win, so
  // which entries the pari-mutuel table pays - it carries authority.
  // 31 since the price sample and tape (kanban #311, §11): the committee's word on the price a market run plays decides
  // its outcome. 32 since the federation record (kanban #321, §23A.4): its guardians' signed status decides whether a
  // client may deposit into a federation and whether a new round may name it.
  // 34 since reserve seats (kanban #301, §5A.7): a node's PRESENT and the seated nodes' SEATING decide which nodes serve a
  // round - a seating its certificate's signers did not all sign seats nobody.
  // 35 since the config proposal (kanban #329, §27A.7.2): tallied, it decides the configuration rounds run under. 37 since the
  // absence attestation and the departure notice (kanban #322, §23A.4-5): they make a guardian ABANDONED or DEPARTED. 38 since the
  // spent-note set (kanban #323, §23A.5): it decides which notes a halted federation's liquidation pays.
  assert.equal(FRAMES.size, 38, 'a type was added without saying what it decides');
});

/**
 * EVERY TYPE THE PROTOCOL DECLARES IS IN THE MAP (the spec audit of 2026-10-04: nine declared after the handout, 0x13 -
 * 0x1b, were never entered, and the count above was the only guard - it can only see the map it counts). Read off
 * constants.js itself, so a tenth cannot be declared and forgotten.
 */
test('every TYPE_ the protocol declares has its entry, and no two share a byte', async () => {
  const constants = await import('../src/constants.js');
  const declared = Object.entries(constants).filter(([k, v]) => k.startsWith('TYPE_') && Number.isInteger(v));
  assert.ok(declared.length >= 27);
  for (const [name, byte] of declared) assert.ok(FRAMES.has(byte), `${name} (0x${byte.toString(16)}) has no entry in FRAMES`);
  assert.equal(new Set(declared.map(([, v]) => v)).size, declared.length, 'two TYPE_ constants share a byte');
});

/**
 * A GHOST OFFERED AS AN INPUT, A VOTE, A CENSUS ENTRY OR A BOND IS REFUSED,
 * and the refusal says what it is rather than what it is not.
 */
test('a ghost cannot stand as an input, a receipt, a census entry or a bond', () => {
  for (const as of ['an input', 'a receipt', 'a census entry', 'a bond',
                    'an objection', 'a result', 'a payout table']) {
    const no = bearsAuthority(GHOST, as);
    assert.equal(no.ok, false, `a ghost was accepted as ${as}`);
    assert.equal(no.name, 'Ghost');
    assert.equal(no.why, `a Ghost is a picture and carries no authority, so it cannot be ${as}`);

    // the refusal names the frame, not the absence of another one
    assert.equal(/not an input batch|not a checkpoint/.test(no.why), false);
  }

  // and the things that do decide something are admitted, so the check is not
  // simply refusing everything
  for (const type of [TYPE_INPUT_BATCH, TYPE_CHECKPOINT, TYPE_CHECKPOINT_RECEIPT,
                      TYPE_CENSUS_LEAF, TYPE_ADVERT])
    assert.equal(bearsAuthority(framed(type), 'an input').ok, true, 'type 0x' + type.toString(16));

  // a byte this protocol does not use is refused by number, not assumed safe
  const unknown = bearsAuthority(framed(0x7f), 'an input');
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /no frame of this protocol begins with 0x7f/);
  assert.equal(bearsAuthority(new Uint8Array(0), 'an input').ok, false);
  assert.equal(frameOf(undefined), undefined);
});

/**
 * WHEN THE QUEUE IS FULL, THE PICTURE GOES.
 *
 * IMPLEMENTATION section 7: "above a threshold drop ghost frames first - they
 * are non-authoritative by definition - and never receipts." §11 says why the
 * order is not a preference: "publishing is the client's duty, and unpublished
 * inputs cost the player the run", so a node that shed a batch to make room
 * for a picture would be taking a run away over rendering.
 */
test('a full mixed queue sheds ghosts and keeps every frame that decides something', () => {
  const q = [framed(TYPE_INPUT_BATCH), GHOST, framed(TYPE_CHECKPOINT), GHOST,
             framed(TYPE_CHECKPOINT_RECEIPT)];

  const { queue, dropped } = admit(q, framed(TYPE_INPUT_BATCH), 4);
  const names = (list) => list.map((f) => FRAMES.get(f[0]).name);

  assert.deepEqual(names(dropped), ['Ghost', 'Ghost'], 'the drop order was not pictures first');
  assert.deepEqual(names(queue),
    ['InputBatch', 'Checkpoint', 'CheckpointReceipt', 'InputBatch']);
  assert.equal(queue.some((f) => f[0] === TYPE_GHOST), false);
  assert.equal(queue.length, 4);

  // the oldest picture goes first, so a queue under sustained pressure sheds
  // in arrival order rather than by whichever the scan happened to reach
  const two = admit([GHOST, framed(TYPE_CHECKPOINT), GHOST], framed(TYPE_INPUT_BATCH), 3);
  assert.deepEqual(names(two.dropped), ['Ghost']);
  assert.deepEqual(names(two.queue), ['Checkpoint', 'Ghost', 'InputBatch']);

  // under the limit nothing is shed at all
  const room = admit([framed(TYPE_CHECKPOINT)], GHOST, 4);
  assert.deepEqual(room.dropped, []);
  assert.equal(room.queue.length, 2);
});

/**
 * AND WITH NO PICTURE LEFT TO SHED, THE NEWCOMER IS REFUSED RATHER THAN
 * EVIDENCE DISCARDED. A queue that made room by throwing away a batch it had
 * already accepted would lose a run to relieve pressure.
 */
test('a queue of nothing but evidence refuses the newcomer instead of shedding it', () => {
  const full = [framed(TYPE_CHECKPOINT), framed(TYPE_INPUT_BATCH),
                framed(TYPE_CHECKPOINT_RECEIPT)];

  const late = admit(full, framed(TYPE_INPUT_BATCH), 3);
  assert.equal(late.queue.length, 3);
  assert.deepEqual(late.queue, full, 'an accepted frame was discarded to make room');
  assert.equal(late.dropped.length, 1);
  assert.equal(late.dropped[0][0], TYPE_INPUT_BATCH, 'the newcomer should be the one refused');

  // a ghost arriving at a full queue of evidence is refused too - it does not
  // get to displace a receipt just because it is newer
  const picture = admit(full, GHOST, 3);
  assert.deepEqual(picture.queue, full);
  assert.equal(picture.dropped[0][0], TYPE_GHOST);

  assert.equal(droppable(GHOST), true);
  assert.equal(droppable(framed(TYPE_CHECKPOINT_RECEIPT)), false);
  assert.equal(droppable(framed(0x7f)), false, 'an unknown frame is not assumed sheddable');
  assert.throws(() => admit([], GHOST, 0), /positive limit/);
});
