// A CARRIED BOND AT THE PLAYER'S DOOR (kanban #209, 2026-10-10 05:35Z: a paid testnet4 join was refused at the session,
// "no proven endpoint: the bond output commits to a different advertisement"). The seven testnet4 seats hold ANCESTOR bonds:
// re-affirmed for testnet4 and given an Arena endpoint by an advertisement update (§0A.9). Real testnet4 bytes: guardian-1's
// bond (block 154172), re-affirmation (155609) and update (155729), proved into headers 154172..155729 from bitcoind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { reach } from '../src/directory.js';
import { bondProvider } from '../src/join.js';
import { acceptAncestorEndpoint } from '../../arena-protocol/src/ancestor-endpoint.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const F = JSON.parse(readFileSync(new URL('./fixtures/tn4-carried-bond.json', import.meta.url), 'utf8'));
const H = fromHex(F.headers);
const chain = Array.from({ length: H.length / 80 }, (_, i) => H.subarray(i * 80, i * 80 + 80));
const proof = (x) => ({ transaction: fromHex(x.hex), branch: x.merkle.map(fromHex), position: x.pos });
const bond = proof(F.bond), update = proof(F.update), reaffirm = proof(F.reaffirm);
const KEY = fromHex(F.key);

test('a carried bond, re-affirmed and updated, proves its Arena endpoint, and all three signatures are the bond key\'s', () => {
  const seen = reach({ chain, ...bond, update, reaffirm, committee: [KEY] });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.endpoint, F.endpoint);
  assert.equal(Buffer.from(seen.nodePubkey).toString('hex'), F.key);
  assert.ok(schnorr.verify(seen.signature, seen.advertId, seen.nodePubkey), 'the update\'s signature');
  assert.equal(seen.checks.length, 2);
  for (const c of seen.checks) assert.ok(schnorr.verify(c.signature, c.message, c.key), c.what);
});

test('without its re-affirmation or its update, or with a doctored one, the carried bond names no endpoint', () => {
  // the door as it was: the bond alone
  assert.match(reach({ chain, ...bond, committee: [KEY] }).why, /commits to a different advertisement/);
  assert.match(acceptAncestorEndpoint({ chain, ...bond, update }).why, /re-affirmed/);
  assert.match(acceptAncestorEndpoint({ chain, ...bond, reaffirm }).why, /update/);
  // another seat's update for this bond
  assert.match(acceptAncestorEndpoint({ chain, ...bond, reaffirm, update: proof(F.otherUpdate) }).why, /another bond/);
  // a proof into a block not in the chain
  assert.match(acceptAncestorEndpoint({ chain: chain.slice(0, 100), ...bond, reaffirm, update }).why, /re-affirmation is not in any block/);
  // a node not on the round's committee
  assert.match(reach({ chain, ...bond, update, reaffirm, committee: [fromHex(F.otherKey)] }).why, /not on this round's committee/);
  // a re-affirmation signature that is not the bond key's fails the client's check
  const seen = acceptAncestorEndpoint({ chain, ...bond, update, reaffirm });
  const bad = seen.checks[1].signature.slice(); bad[5] ^= 1;
  assert.equal(schnorr.verify(bad, seen.checks[1].message, seen.checks[1].key), false);
});

test('the bond provider reads the update and the re-affirmation beside the bond, and leaves a plain bond as it was', async () => {
  const body = { ...F.bond, update: F.update, reaffirm: F.reaffirm };
  const get = bondProvider('https://seat.example/bond', { fetcher: async () => new Response(JSON.stringify(body)) });
  const got = await get();
  assert.equal(got.update.position, F.update.pos);
  assert.equal(got.reaffirm.branch.length, F.reaffirm.merkle.length);
  const plain = await bondProvider('https://seat.example/bond', { fetcher: async () => new Response(JSON.stringify(F.bond)) })();
  assert.equal(plain.update, undefined);
});
