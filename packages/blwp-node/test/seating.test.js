// WHO SITS, AND WHERE THAT ANSWER CAME FROM.
//
// `POST /round` seats a round from the chain census (letter 26) using the
// committee seed (letter 27), and the seed is a block hash published after
// committee_time (5A.5). Until this slice the 2-of-2 path seated NOBODY:
// `server.js` seats only when it has a chain view, and the tool gave none, so
// the beacon was read and never asked who sits. Measured before the fix -
// "node A seats NOBODY, node B seats NOBODY" with the beacon held at block 26.
//
// No bitcoind here: the chain is mined in-process and served over the three
// RPC calls the reader makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standUpRound } from '../tools/round-2of2.mjs';
import { blockOf } from '../../protocol/tools/bond.js';
import { hash256, blockHashOf } from '../../protocol/src/chain.js';
import { toHex } from '../../protocol/src/hash.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';

const b32 = (n) => new Uint8Array(32).fill(n);

/**
 * A CHAIN THAT CANNOT BE READ. The only header source these tests still hand
 * in: with no bitcoind the tool builds ONE chain that carries the bonds and
 * names the beacon, so a separate header source is the two-chain fault this
 * letter closed - a census on one chain and a seed on another. What is worth
 *测 measuring is what happens when the source is broken.
 */
const brokenNode = () => async () => { throw new Error('connect ECONNREFUSED'); };

const seatsOf = (node, id) =>
  node.round.seats(Buffer.from(id, 'hex')).map(toHex).sort();

test('a round posted through the 2-of-2 path seats the committee its chain names', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18120, portB: 18121 });
  try {
    assert.equal(round.beacon.ok, true, round.beacon.why);
    assert.ok(round.beacon.height > 0, 'the beacon has no height');
    assert.ok(round.beacon.depth >= 1);

    const named = round.contract.nodes.map(toHex).sort();
    for (const [which, node] of [['A', round.a], ['B', round.b]]) {
      const seated = seatsOf(node, round.id);
      assert.equal(seated.length, 2, `node ${which} seated ${seated.length}, not two`);
      assert.deepEqual(seated, named,
        `node ${which} seated somebody the contract does not name`);
    }

    // BOTH DAEMONS AGREE, which is the whole property: one chain, one census,
    // one beacon, one committee.
    assert.deepEqual(seatsOf(round.a, round.id), seatsOf(round.b, round.id));

    // and the seed those seats were drawn with is the block's, not a constant
    const seeded = round.a.roster
      ? round.a.roster.seedFor(Buffer.from(round.id, 'hex'), round.contract)
      : null;
    if (seeded) assert.equal(seeded.ok, true, seeded.why);
  } finally { await round.close(); }
});

test('asked twice, one round names one block and one seed', async () => {
  // WHAT THIS USED TO COMPARE NO LONGER EXISTS. It stood the tool up twice and
  // asserted both runs named one block - true while a caller handed in the
  // header chain, and meaningless now that each run builds its own chain
  // carrying its own bonds. Two chains name two blocks, correctly.
  //
  // What is worth measuring is the property the letter is about: one chain,
  // asked twice, gives one answer - and both daemons of that round agree.
  const round = await standUpRound({ host: '127.0.0.1', portA: 18122, portB: 18123 });
  try {
    const id = Buffer.from(round.id, 'hex');
    const contract = decodeRoundContract(new Uint8Array(round.a.round.get(id).contract));

    const one = round.a.roster.seedFor(id, contract);
    const two = round.a.roster.seedFor(id, contract);
    assert.equal(one.ok, true, one.why);
    assert.equal(toHex(one.seed), toHex(two.seed), 'one chain gave two seeds');
    assert.equal(one.checkedAgainstChain, true);

    const alsoB = round.b.roster.seedFor(id, contract);
    assert.equal(toHex(alsoB.seed), toHex(one.seed),
      'the two daemons of one round seeded from different blocks');
    assert.deepEqual(seatsOf(round.a, round.id), seatsOf(round.b, round.id));
  } finally { await round.close(); }
});

test('a header source that is not the chain the bonds are on is refused', async () => {
  // TWO CHAINS, WHICH IS THE FAULT THIS LETTER CLOSED. The bonds are on the
  // tool's own chain; this hands the beacon reader a DIFFERENT one. The block
  // it names is not a block the census chain has, so seating refuses rather
  // than seeding a committee from a chain nobody's census came off.
  const other = [];
  let previous = new Uint8Array(32);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 40; i++) {
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time: now + (i - 20) * 600 });
    other.push(header); previous = blockHashOf(header);
  }
  const foreign = async (method, params = []) => {
    if (method === 'getblockcount') return other.length - 1;
    if (method === 'getblockhash') return toHex(blockHashOf(other[params[0]]));
    if (method === 'getblockheader')
      return toHex(other[other.findIndex((h) => toHex(blockHashOf(h)) === params[0])]);
    throw new Error('asked ' + method);
  };
  await assert.rejects(
    standUpRound({ host: '127.0.0.1', portA: 18124, portB: 18125, rpc: foreign }),
    /refused the round/,
    'a beacon from another chain seated a committee');
});

test('a chain that cannot be read is not a beacon either', async () => {
  await assert.rejects(
    standUpRound({ host: '127.0.0.1', portA: 18126, portB: 18127, rpc: brokenNode() }),
    /has no beacon for that round/);
});
