// A GUARDIAN WATCHES ITS FEDERATION'S GATEWAYS (spec §23A.9, kanban #471): only signed claims of seated guardians, for this federation,
// stand; a gateway that serves the federation (routing_info not null) counts as up; the ranking follows the probes; a forged or
// foreign claim is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createGatewayWatch } from '../src/gateway-watch.js';
import { signGatewayClaim, checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const fid = 'f0'.repeat(32);
const keys = [1, 2, 3, 4].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const claimOf = (i, over = {}) => signGatewayClaim({ node: keys[i].hex, federationId: fid, gatewayUrl: `https://n${i}.example/gateway/`, lightningPubkey: '02' + 'ab'.repeat(32),
  capacitySats: 300000, pegInSats: 60000, atMs: 1, ...over }, (h) => schnorr.sign(h, keys[i].secret));

test('claims: signed by their node, checked; a forged one refused', () => {
  const c = claimOf(0);
  assert.equal(checkGatewayClaim(c, verify).ok, true);
  assert.match(checkGatewayClaim({ ...c, capacitySats: '9000000' }, verify).why, /not signed by its node key/);
  assert.match(checkGatewayClaim({ ...c, gatewayUrl: 'https://n0.example/gateway' }, verify).why, /ending in \//);
});

test('the watch: seated guardians\' claims probed per epoch, ranked; a foreign federation and a forged claim stand nowhere', async () => {
  const claims = { 0: claimOf(0), 1: claimOf(1, { capacitySats: 900000 }), 2: claimOf(2, { federationId: 'aa'.repeat(32) }), 3: { ...claimOf(3), pegInSats: '999999' } };
  const up = { 0: true, 1: false };
  let height = 144 * 10 + 5;
  const entries = keys.map((k, i) => ({ pubkey: Uint8Array.from(Buffer.from(k.hex, 'hex')), bondSats: 50000n, advert: { endpoint: `https://seat${i}.example`, operatorId: `op${i}` } }));
  const fetcher = async (url, o = {}) => {
    const seat = /^https:\/\/seat(\d)\.example\/gateway-claim$/.exec(url);
    if (seat) return { status: 200, json: async () => claims[seat[1]] };
    const gw = /^https:\/\/n(\d)\.example\/gateway\/routing_info$/.exec(url);
    if (gw) { assert.equal(o.body, JSON.stringify(fid)); return { status: 200, text: async () => (up[gw[1]] ? '{"lightning_public_key":"02.."}' : 'null') }; }
    throw new Error(`unexpected ${url}`);
  };
  const w = createGatewayWatch({ federationId: async () => fid, seated: async () => [keys[0].hex, keys[1].hex, keys[2].hex, keys[3].hex].slice(0, 4), entries: async () => entries,
    tip: async () => height, beaconAt: async () => new Uint8Array(32).fill(7), verify, fetcher });
  for (let i = 0; i < 4; i++) await w.probe();
  up[1] = true; await w.probe();
  const v = await w.view();
  assert.equal(v.measuredEpoch, 'running');
  assert.deepEqual(Object.keys(v.gateways).sort(), [keys[0].hex, keys[1].hex].sort(), 'only the two valid claims for this federation stand');
  assert.deepEqual(v.seated, [keys[0].hex], 'node 2 answered 1 of 5 probes (20 %): not eligible; node 1 was up 5 of 5');
  assert.match(v.ineligible.find((x) => x.node === keys[1].hex).why, /available 20 %/);
  height += 144; await w.probe();
  const next = await w.view();
  assert.deepEqual([next.measuredEpoch, next.epoch], ['whole', 10], 'the last whole epoch is ranked once there is one');
});
