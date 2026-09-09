// THE CHAIN, ASKED WHICH OUTPUT HOLDS THE POOL.
//
// The shapes below are not remembered: they were recorded off a running
// bitcoin-31.1 regtest and pasted in, so a test that passes here is a test
// against what a node actually answers. `pool-regtest` puts the same questions
// to a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolWatch, satsOf, txidToRpc, txidFromRpc } from '../src/pool-watch.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { dealThePool, curve, b32 } from './pool-fixture.js';

const dealt = dealThePool();
const pool = { groupPublicKey: dealt.groupPublicKey };
const mine = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
const TXID = b32(0xab);

/** A bitcoind that answers exactly what one answered, and counts the asks. */
function chain({ gettxout = () => null, scan = null } = {}) {
  const asked = [];
  const call = async (method, params) => {
    asked.push({ method, params });
    if (method === 'gettxout') return gettxout(params[0], params[1]);
    if (method === 'scantxoutset') return scan ? scan(params) : { success: true, unspents: [], height: 211 };
    throw new Error(`this fixture answers no ${method}`);
  };
  return { call, asked };
}

const anOutput = (value, script = toHex(mine.script), confirmations = 6) => ({
  bestblock: '0fca06368c2d87c5515abfb55be1f5da4ebca115187f6079e3c8c48084aad15e',
  confirmations, value,
  scriptPubKey: {
    asm: '1 …', desc: 'rawtr(…)', hex: script,
    address: 'bcrt1p…', type: 'witness_v1_taproot',
  },
  coinbase: false,
});

test('BTC off the wire becomes satoshis without losing one', () => {
  // The two the node actually answered, and the awkward one.
  assert.equal(satsOf(0.00001200), 1200n);
  assert.equal(satsOf(49.99997250), 4999997250n);
  assert.equal(satsOf(0.1), 10000000n, '0.1 * 1e8 is 10000000.000000002 and flooring loses a satoshi');
  assert.equal(satsOf(21000000), 2100000000000000n, 'every satoshi there will ever be');
  assert.equal(satsOf('1200'), null);
  assert.equal(satsOf(NaN), null);
});

test('a txid is spoken to the chain the way the chain prints it, and kept the way an input carries it', () => {
  const printed = txidToRpc(TXID);
  assert.equal(printed.length, 64);
  assert.deepEqual(txidFromRpc(printed), TXID, 'the round trip lost the order');
  // Not a symmetry that holds by accident: an asymmetric id must come back.
  const walking = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  assert.notEqual(txidToRpc(walking), toHex(walking), 'the id was not reversed for the RPC at all');
  assert.deepEqual(txidFromRpc(txidToRpc(walking)), walking);
});

test('a named outpoint comes back with the chain\'s own value, not the caller\'s', async () => {
  const c = chain({ gettxout: () => anOutput(0.00001200) });
  const w = new PoolWatch({ call: c.call, pool, curve });
  const got = await w.outpoint({ txid: TXID, vout: 0 });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.utxo.value, 1200n);
  assert.equal(got.confirmations, 6);
  assert.deepEqual(got.utxo.script, mine.script);
  assert.deepEqual(got.utxo.txid, TXID);
  assert.deepEqual(c.asked, [{ method: 'gettxout', params: [txidToRpc(TXID), 0] }]);
});

test('an output the chain does not hold is refused, and so is one that pays somebody else', async () => {
  const gone = new PoolWatch({ call: chain({ gettxout: () => null }).call, pool, curve });
  const a = await gone.outpoint({ txid: TXID, vout: 0 });
  assert.equal(a.ok, false);
  assert.match(a.why, /holds no such unspent output/);

  const theirs = new PoolWatch({
    call: chain({ gettxout: () => anOutput(1.0, '5120' + 'ee'.repeat(32)) }).call, pool, curve,
  });
  const b = await theirs.outpoint({ txid: TXID, vout: 0 });
  assert.equal(b.ok, false);
  assert.match(b.why, /pays a different key than this pool/);
});

test('a watch with no chain reaches nothing and says so', async () => {
  const w = new PoolWatch({});
  assert.equal(w.reaches, false);
  assert.equal((await w.outpoint({ txid: TXID, vout: 0 })).ok, false);
  assert.match((await w.unspent()).why, /watches no pool/);
});

const scanning = (unspents) => ({
  success: true, txouts: 212, height: 211,
  bestblock: '0fca…', total_amount: 0, unspents,
});
const unspent = (txidHex, vout, amount, confirmations = 6) => ({
  txid: txidHex, vout, scriptPubKey: toHex(mine.script), desc: 'rawtr(…)',
  amount, coinbase: false, height: 211, blockhash: '0fca…', confirmations,
});

test('the pool\'s unspent outputs come back in the protocol\'s own byte order', async () => {
  const printed = txidToRpc(TXID);
  const c = chain({ scan: () => scanning([unspent(printed, 1, 0.00001200)]) });
  const w = new PoolWatch({ call: c.call, pool, curve });
  const got = await w.unspent();
  assert.equal(got.ok, true, got.why);
  assert.equal(got.outputs.length, 1);
  assert.deepEqual(got.outputs[0].txid, TXID, 'the txid came back printed rather than internal');
  assert.equal(got.outputs[0].value, 1200n);
  assert.equal(c.asked[0].method, 'scantxoutset');
  assert.deepEqual(c.asked[0].params, ['start', [{ desc: `raw(${toHex(mine.script)})` }]]);
});

/**
 * THE OWNER'S RULE, AND IT IS A RULE: pick only when exactly one output covers
 * what the round owes. Zero refuses by name, several refuses by name, nothing
 * is combined and nothing quietly takes the largest.
 */
test('one covering output is a choice; none and several are refusals by name', async () => {
  const one = new PoolWatch({
    call: chain({ scan: () => scanning([unspent(txidToRpc(TXID), 0, 0.00002000)]) }).call, pool, curve,
  });
  const picked = await one.forRound({ owedSats: 1000n });
  assert.equal(picked.ok, true, picked.why);
  assert.equal(picked.utxo.value, 2000n);

  const none = new PoolWatch({
    call: chain({ scan: () => scanning([unspent(txidToRpc(TXID), 0, 0.00000500)]) }).call, pool, curve,
  });
  const short = await none.forRound({ owedSats: 1000n });
  assert.equal(short.ok, false);
  assert.match(short.why, /none of them covers the 1000 sats/);

  const two = new PoolWatch({
    call: chain({ scan: () => scanning([
      unspent(txidToRpc(TXID), 0, 0.00002000),
      unspent(txidToRpc(b32(0xcd)), 1, 0.00003000),
    ]) }).call, pool, curve,
  });
  const several = await two.forRound({ owedSats: 1000n });
  assert.equal(several.ok, false);
  assert.match(several.why, /2 outputs that cover 1000 sats: name the one to spend/);
  // AND IT DID NOT TAKE THE LARGEST, which is the thing a helpful version does.
  assert.equal(several.utxo, undefined);
});

test('an output too shallow to spend does not count as covering', async () => {
  const w = new PoolWatch({
    call: chain({ scan: () => scanning([unspent(txidToRpc(TXID), 0, 0.00002000, 0)]) }).call, pool, curve,
  });
  const got = await w.forRound({ owedSats: 1000n });
  assert.equal(got.ok, false);
  assert.match(got.why, /0 confirmed output\(s\)/);
});
