// LIQUIDITY PROVIDERS (§23A.10, kanban #494): signed claims; at least 1 and at most 2 providers per node, chosen the same way by all;
// the weight for the fee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signLiquidityClaim, checkLiquidityClaim, assignLiquidity, liquidityWeight, liquidityTicket, LIQUIDITY_TERMS } from '../src/liquidity.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const prov = (n, over = {}) => { const secret = new Uint8Array(32).fill(n); const node = toHex(schnorr.getPublicKey(secret));
  return signLiquidityClaim({ node, lightningPubkey: `02${String(n).padStart(2, '0').repeat(32)}`, lightningAddr: 'x.onion:9735', freeSats: 500000, atMs: 1, channels: [], ...over }, (h) => schnorr.sign(h, secret)); };
const nodeN = (n) => ({ node: String(n).padStart(2, '0').repeat(32).slice(0, 64), lightningPubkey: `03${String(n).padStart(2, '0').repeat(32)}` });

test('a liquidity claim: signed by its node, checked; changed or malformed, refused', () => {
  const c = prov(1, { channels: [{ peer: nodeN(9).lightningPubkey, capacitySats: 100000 }] });
  assert.equal(checkLiquidityClaim(c, verify).ok, true);
  assert.match(checkLiquidityClaim({ ...c, freeSats: '9000000' }, verify).why, /not signed by its node key/, 'free funds cannot be inflated');
  assert.match(checkLiquidityClaim({ ...c, channels: [{ peer: 'nope', capacitySats: '1' }] }, verify).why, /lists its channels/);
  assert.deepEqual([LIQUIDITY_TERMS.testnet4.channelSats, LIQUIDITY_TERMS.testnet4.depositSats, LIQUIDITY_TERMS.mainnet.channelSats, LIQUIDITY_TERMS.mainnet.depositSats],
    [100000n, 500000n, 250000n, 2500000n], 'L and the deposit: 5 x L testnet4, 10 x L mainnet');
});

test('assignment: the same for every provider, at most 2 per node, the top by ticket, short funds and skipped ones left out', () => {
  const N = nodeN(9);
  const ps = [prov(1), prov(2), prov(3), prov(4, { freeSats: 99999 })];
  const a = assignLiquidity({ needs: [N], claims: ps });
  assert.equal(a[0].open.length, 2, 'two open to a new node');
  const ranked = ps.filter((c) => BigInt(c.freeSats) >= 100000n).sort((x, y) => (liquidityTicket(N.node, x.node) < liquidityTicket(N.node, y.node) ? -1 : 1)).map((c) => c.node);
  assert.deepEqual(a[0].open, ranked.slice(0, 2), 'the two lowest tickets; the provider short of L is no candidate');
  assert.deepEqual(assignLiquidity({ needs: [N], claims: [...ps].reverse() }), a, 'the order the claims arrive in does not matter');
  // one opened: only one more
  const after = ps.map((c) => (c.node === ranked[0] ? { ...c, channels: [{ peer: N.lightningPubkey, capacitySats: '100000' }] } : c));
  const b = assignLiquidity({ needs: [N], claims: after });
  assert.deepEqual([b[0].have, b[0].open], [[ranked[0]], [ranked[1]]]);
  // two opened: nothing
  const full = after.map((c) => (c.node === ranked[1] ? { ...c, channels: [{ peer: N.lightningPubkey, capacitySats: '100000' }] } : c));
  assert.deepEqual(assignLiquidity({ needs: [N], claims: full }), [], 'two providers: the node is served');
  // a ranked provider that did not open is skipped: the next one takes its place
  const c = assignLiquidity({ needs: [N], claims: after, skipped: new Set([`${N.node}:${ranked[1]}`]) });
  assert.deepEqual(c[0].open, [ranked[2]]);
  // never to itself
  const self = { node: ps[0].node, lightningPubkey: ps[0].lightningPubkey };
  assert.ok(!assignLiquidity({ needs: [self], claims: ps })[0].open.includes(ps[0].node));
});

test('the weight: channels to the federation\'s nodes + free balance, floored to 10,000 sat', () => {
  const N = nodeN(9), O = nodeN(8);
  const c = prov(1, { freeSats: 505000, channels: [{ peer: N.lightningPubkey, capacitySats: 100000 }, { peer: O.lightningPubkey, capacitySats: 100000 }] });
  assert.equal(liquidityWeight(c, [N.lightningPubkey]), 600000n, '100,000 in the federation + 505,000 free -> 605,000 floored');
  const poor = prov(2, { freeSats: 499999, channels: [{ peer: N.lightningPubkey, capacitySats: 100000 }] });
  assert.equal(liquidityWeight(poor, [N.lightningPubkey]), 0n, 'below the deposit minimum (500,000 on testnet4): no share, channels or not');
  assert.equal(liquidityWeight({ ...poor, freeSats: '2499999' }, [N.lightningPubkey], 'mainnet'), 0n, 'mainnet minimum 2,500,000');
});
