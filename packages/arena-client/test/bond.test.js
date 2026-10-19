// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOND HAS TO BE IN A BLOCK SOMEBODY MINED.
//
// Section 25.1's third line: "verify: proof against header, H(advertisement)
// against the bond output's commitment". The second half has been true since
// the endpoint stopped coming off the page. The first half was only as good as
// the header it was checked against - and until the hash was compared to the
// target, a header was four bytes of claimed difficulty and a merkle root the
// provider chose.
//
// So this measures the attack end to end: a fabricated block whose merkle root
// is whatever the attacker wants, holding a bond he wrote himself, must not
// prove anything.
//
// REAL HTTP, LOCAL ONLY, and no fetch beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { blockHashOf, meetsTarget, merkleRootFromProof } from '../../arena-protocol/src/chain.js';
import { hash256, parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../arena-protocol/tools/bond.js';
import { provenBond, askForBond } from '../src/bond.js';
import { reach } from '../src/directory.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const operator = ed25519.utils.randomSecretKey();
const operatorPubkey = schnorr.getPublicKey(operator);

const advertFor = (endpoint) => ({
  nodePubkey: operatorPubkey, operatorId: 'somebody', protocolVersions: [1],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), guardianOf: [], timestamp: 1788700000000n,
});
const bondFor = (a) => bondTransaction(a, { signature: schnorr.sign(advertId(a), operator) });

/** A mined block holding the bond, and a mined block before it. */
function chainWith(transaction, sibling = b32(0x99)) {
  const txid = parseTransaction(transaction).txid;
  const first = blockOf(hash256, [b32(0x01)]).header;
  const { header } = blockOf(hash256, [txid, sibling], { previous: blockHashOf(first) });
  return { chain: [first, header], branch: [sibling], position: 0 };
}

/**
 * The attacker's block: never mined, and its merkle root is simply the root
 * his own bond needs. It is a valid 80 bytes and a valid proof lands in it.
 */
function fabricated(transaction, sibling = b32(0x99)) {
  const txid = parseTransaction(transaction).txid;
  const root = merkleRootFromProof(txid, [sibling], 0);
  const h = new Uint8Array(80);
  h.set([0x00, 0x00, 0x00, 0x20], 0);
  h.set(root, 36);                        // the root his proof needs
  h[72] = 0x01; h[75] = 0x03;             // a target of 1, claimed, not met
  return h;
}

test('an honest bond is proven into the mined chain', () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const { chain, branch, position } = chainWith(transaction);
  const seen = provenBond({ chain, transaction, branch, position });
  assert.equal(seen.ok, true, seen.why);
  assert.deepEqual(seen.header, chain[1]);
  assert.equal(meetsTarget(seen.header), true);
  assert.equal(toHex(seen.txid), toHex(parseTransaction(transaction).txid));
});

/**
 * THE ATTACK, AND IT IS THE SAME ONE AS THE HEADER CUT. He does not need to
 * break a hash: he needs a block whose merkle root is the one his proof
 * rebuilds, and before the target was checked he could simply write it down.
 */
test('a fabricated block with a chosen merkle root proves nothing', () => {
  const transaction = bondFor(advertFor('wss://the-attackers-node:443'));
  const sibling = b32(0x99);
  const his = fabricated(transaction, sibling);
  const txid = parseTransaction(transaction).txid;

  // his proof really does rebuild his header's root - that is the point
  assert.deepEqual(merkleRootFromProof(txid, [sibling], 0), his.slice(36, 68));
  // and his header is not mined
  assert.equal(meetsTarget(his), false);

  const alone = provenBond({ chain: [his], transaction, branch: [sibling], position: 0 });
  assert.equal(alone.ok, false);
  assert.match(alone.why, /not a mined chain: this header was not mined/);

  // nor by hanging it off an honest block: a chain carrying it is not a chain
  const honest = blockOf(hash256, [b32(0x01)]).header;
  const hung = fabricated(transaction, sibling);
  hung.set(blockHashOf(honest), 4);
  const after = provenBond({ chain: [honest, hung], transaction, branch: [sibling], position: 0 });
  assert.equal(after.ok, false);
  assert.match(after.why, /not a mined chain: this header was not mined/);
});

test('a proof that lands in no block of the chain is refused by name', () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const { chain, branch } = chainWith(transaction);
  // the right proof, the wrong side of the tree
  const wrongSide = provenBond({ chain, transaction, branch, position: 1 });
  assert.equal(wrongSide.ok, false);
  assert.match(wrongSide.why, /is not proven into any block of that chain/);

  // a chain that simply does not hold it
  const elsewhere = [blockOf(hash256, [b32(0x07)]).header];
  assert.equal(provenBond({ chain: elsewhere, transaction, branch, position: 0 }).ok, false);

  // and bytes that are not a transaction
  const rubbish = provenBond({ chain, transaction: transaction.slice(0, 30), branch, position: 0 });
  assert.match(rubbish.why, /not a transaction/);
});

/**
 * ONE PROVIDER IS ENOUGH FOR A PROOF, and that is not the same rule as for
 * headers. A proof carries its own proof, so a provider cannot forge one at
 * any price; the only lie is silence, and silence is answered by asking the
 * next one rather than by taking a vote.
 */
test('providers are asked in turn until one proves the bond', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const { chain, branch, position } = chainWith(transaction);

  const empty = () => { throw new Error('no such transaction'); };
  const lying = () => ({ transaction, branch: [b32(0x55)], position: 0 });
  const honest = () => ({ transaction, branch, position });

  const seen = await askForBond([empty, lying, honest], { chain });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.from, 2);
  assert.equal(seen.refused.length, 2);
  assert.match(seen.refused[0], /provider 0: no such transaction/);
  assert.match(seen.refused[1], /provider 1: .*not proven into any block/);

  const none = await askForBond([empty, lying], { chain });
  assert.equal(none.ok, false);
  assert.match(none.why, /no provider proved that bond into the chain/);
  assert.equal((await askForBond([], { chain })).why, 'no providers to ask for the bond');
});

test('a provider that never answers is not waited for', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const { chain, branch, position } = chainWith(transaction);
  const silent = () => new Promise(() => {});
  const seen = await askForBond([silent, () => ({ transaction, branch, position })],
    { chain, timeoutMs: 50 });
  assert.equal(seen.ok, true, seen.why);
  assert.match(seen.refused[0], /provider 0: no answer in 50 ms/);
});

/**
 * AND THE DOOR ITSELF. `reach` takes the chain two providers already agreed on
 * rather than a list handed over by one party - and re-checks it, so a
 * fabricated block cannot be the one an endpoint is proven into whichever way
 * it arrived.
 */
test('the door takes an agreed chain, and refuses one that was not mined', async () => {
  const endpoint = 'wss://node.example:443';
  const transaction = bondFor(advertFor(endpoint));
  const { chain, branch, position } = chainWith(transaction);
  const committee = [operatorPubkey];

  const ok = reach({ chain, transaction, branch, position, committee });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.endpoint, endpoint);

  // the attacker's block, offered as the agreed chain
  const his = fabricated(transaction);
  const no = reach({ chain: [his], transaction, branch, position, committee });
  assert.equal(no.ok, false);
  assert.match(no.why, /not a mined chain: this header was not mined/);

  // and offered the old way, as a list to weigh, it is still refused
  const weighed = reach({ chains: [[his]], transaction, branch, position, committee });
  assert.equal(weighed.ok, false);
  assert.match(weighed.why, /no chain of headers to check against/);
});

test('a bond fetched over HTTP proves into the agreed chain', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const { chain, branch, position } = chainWith(transaction);

  // The envelope is the TEST's, not the client's: the shape a chain API puts a
  // merkle proof in is nobody's standard, and writing one API's field names
  // into the client would be adopting a second protocol without saying so.
  const api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      hex: toHex(transaction),
      merkle: branch.map((b) => toHex(b)),
      pos: position,
    }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${api.address().port}/`;
  try {
    const provider = async () => {
      const said = await (await fetch(url)).json();
      return {
        transaction: fromHex(said.hex),
        branch: said.merkle.map((h) => fromHex(h)),
        position: said.pos,
      };
    };
    const seen = await askForBond([provider], { chain });
    assert.equal(seen.ok, true, seen.why);
    assert.equal(toHex(seen.blockHash), toHex(blockHashOf(chain[1])));
  } finally { api.closeAllConnections(); api.close(); }
});
