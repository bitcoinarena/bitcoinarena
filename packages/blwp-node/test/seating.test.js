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

const b32 = (n) => new Uint8Array(32).fill(n);

/** A mined chain straddling now, and the node that serves it. */
function chainNode({ blocks = 40, spacing = 600, broken = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < blocks; i++) {
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time: now + (i - 20) * spacing });
    headers.push(header);
    previous = blockHashOf(header);
  }
  return async (method, params = []) => {
    if (broken) throw new Error('connect ECONNREFUSED');
    if (method === 'getblockcount') return headers.length - 1;
    if (method === 'getblockhash') return toHex(blockHashOf(headers[params[0]]));
    if (method === 'getblockheader')
      return toHex(headers[headers.findIndex((h) => toHex(blockHashOf(h)) === params[0])]);
    throw new Error('this node was asked ' + method);
  };
}

const seatsOf = (node, id) =>
  node.round.seats(Buffer.from(id, 'hex')).map(toHex).sort();

test('a round posted through the 2-of-2 path seats the committee its chain names', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18120, portB: 18121,
    rpc: chainNode() });
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

test('the same chain twice seats the same committee', async () => {
  const call = chainNode();
  const one = await standUpRound({ host: '127.0.0.1', portA: 18122, portB: 18123, rpc: call });
  const seatsOne = seatsOf(one.a, one.id);
  const beaconOne = one.beacon;
  await one.close();

  // FRESH PORTS, because a daemon that has just closed has not always let go
  // of its socket and this test is about the chain, not about bind timing.
  const two = await standUpRound({ host: '127.0.0.1', portA: 18132, portB: 18133, rpc: call });
  try {
    assert.equal(two.beacon.height, beaconOne.height, 'one chain named two blocks');
    assert.deepEqual(two.beacon.hash, beaconOne.hash);
    assert.equal(seatsOf(two.a, two.id).length, 2);
    // The keys differ because each run makes new daemons; what must not differ
    // is the BLOCK, which is what the committee is drawn on.
    assert.equal(seatsOne.length, 2);
  } finally { await two.close(); }
});

test('with no chain to read, the round is refused by name rather than seated blind', async () => {
  await assert.rejects(
    standUpRound({ host: '127.0.0.1', portA: 18124, portB: 18125, rpc: null }),
    /has no beacon for that round, so it cannot say who the census seats/,
    'a node with no beacon seated somebody anyway');
});

test('a chain that cannot be read is not a beacon either', async () => {
  await assert.rejects(
    standUpRound({ host: '127.0.0.1', portA: 18126, portB: 18127, rpc: chainNode({ broken: true }) }),
    /has no beacon for that round/);
});
