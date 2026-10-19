// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REFUSED ROUND'S TWO PLAYER LOCKS ARE REDEEMED TOGETHER (kanban #191, measured live 07:58Z on 0.0.2809, round 422ecd2e of
// series a69552a0): the seats kept both - the stake (out 0, 96000 msat, image a point) and the node-fee lock (out 1, 2000 msat,
// image H(F), kept under H(handout id || "fee")) - the page counted 98000 msat owed, and the collect put 96000 in: the lock
// client's redeem refused every lock whose image is not a point ("only a stake lock, whose image is a point, is redeemed
// here"), so out 1 stays to its expiry. The page's real lock client (dist wasm) builds each lock's contract from its fields -
// LockClient.outgoingContractId, the builder its redeem uses - and the ids must be the ones the live federation holds (the
// seats stored them from it). Then redeemStake over the seats' two rows redeems both, each through that builder; the round's
// two donation outputs (out 2, 3: paid to the recipients' keys) are not player locks and are never redeemed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redeemStake, lookOwed, collectOwed } from '../src/page-lock.js';
import { lockFieldsFromJson, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pageCurve } from '../src/page-curve.js';

const DIST = new URL('../dist/', import.meta.url);
const wasmModule = async () => {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-redeem-${process.pid}.mjs`);
  copyFileSync(new URL('blwp_lock_client.js', DIST), esm);
  const w = await import(esm);
  await w.default({ module_or_path: readFileSync(new URL('blwp_lock_client_bg.wasm', DIST)) });
  return w;
};
// LIVE, round 422ecd2e (seat 1's refused_locks rows, contract ids as the federation holds them)
const TX = '8d76b951ccca50e29e4477def7e73c32294bac0c388d892b99f7dfb2523299b9';
const STAKE = { outpoint: `${TX}:0`, contractId: 'ef2d5f62cbd61dc0a2cb3af36a830914043732a3230cb9c632e3f0647c6e9232',
  fields: { paymentImage: { kind: 'point', bytes: '02c00c84d8316cf3e9ab37c8d3a769148834957509e2439771385211a8d77b0c0d' }, amountMsat: '96000',
    claimPk: '0289369ed4db42ce14c953eb78dd1a9fa0c0e24e00763a65d9f8bebb6724e607d3', refundPk: '02ba5bf0815b2e5929c576b1966d156b43e62389d25c1174a26dd20b60474ffbbd', expiration: 155489 } };
const FEE = { outpoint: `${TX}:1`, contractId: '9dbb8d78db3208b2c21954a1096d9a919630aac6256c29e11842c42fa62da897',
  fields: { paymentImage: { kind: 'hash', bytes: 'f5568d41f09f3781ce0ff8fa9edf9ea35b9e2a3b3c76f384eb3f9f91f369f37e' }, amountMsat: '2000',
    claimPk: '0289369ed4db42ce14c953eb78dd1a9fa0c0e24e00763a65d9f8bebb6724e607d3', refundPk: '02ba5bf0815b2e5929c576b1966d156b43e62389d25c1174a26dd20b60474ffbbd', expiration: 155489 } };

test('the lock client builds the stake and the node-fee lock contracts the live federation holds - a point image and a hash image alike', async () => {
  const w = await wasmModule();
  assert.equal(typeof w.LockClient.outgoingContractId, 'function', 'the lock client has no contract builder a test can reach');
  const ids = [STAKE, FEE].map((l) => { try { return w.LockClient.outgoingContractId(JSON.stringify(l.fields)); } catch (e) { return `ERR ${e.message || e}`; } });
  console.log(`  FACTS: stake ${ids[0]}, fee ${ids[1]}`);
  assert.equal(ids[0], STAKE.contractId, 'the stake contract is not the one the federation holds');
  assert.equal(ids[1], FEE.contractId, 'the node-fee lock contract is not the one the federation holds');
});

test('redeemStake over a refused round\'s two rows redeems the stake and the node-fee lock in one step, never a donation output', async () => {
  const w = await wasmModule();
  const roundId = fromHex('422ecd2eedd4de65299010e17ae929aabbd59de032465932284aeff72e2c614a');
  const rows = [{ entryId: '60'.repeat(32), outpoint: STAKE.outpoint, fields: STAKE.fields, contractId: STAKE.contractId, refused: true },
    { entryId: '59'.repeat(32), outpoint: FEE.outpoint, fields: FEE.fields, contractId: FEE.contractId, refused: true }];
  const fetcher = async (url) => {
    if (url.includes('/stake-lock')) return new Response(JSON.stringify(rows), { status: 200 });
    if (url.includes('/forfeit')) return new Response(JSON.stringify({ signature: 'ab'.repeat(64), contractId: url.includes('59'.repeat(32)) ? FEE.contractId : STAKE.contractId, claimPk: STAKE.fields.claimPk }), { status: 200 });
    return new Response('no', { status: 404 });
  };
  // THE PLAYER WALLET: each redeem builds its contract with the real lock client's builder, as the wasm redeem does
  const redeemed = [];
  const client = { async redeem(txid, idx, fieldsJson) {
    const id = w.LockClient.outgoingContractId(fieldsJson);
    redeemed.push({ at: `${txid.slice(0, 8)}:${idx}`, id, msat: JSON.parse(fieldsJson).amountMsat });
    return JSON.stringify({ forfeit_verifies: true, accepted: true, amount_msat: Number(JSON.parse(fieldsJson).amountMsat) });
  } };
  // a round whose player key the fixture does not derive: the seats' rows are what redeemStake redeems (findLock by refund key)
  const round = { federationId: new Uint8Array(32).fill(7), stakeMsat: 100000n, custody: 'FEDERATION' };
  let got = null, why = null;
  try { got = await redeemStake({ round, roundId, seed: new Uint8Array(32).fill(1), curve: pageCurve, nodes: ['http://a.test'], fetcher, client }); }
  catch (e) { why = e.message; }
  console.log(`  FACTS: redeemed ${JSON.stringify(redeemed)}${why ? `; threw: ${why}` : ''}`);
  assert.equal(why, null, why);
  assert.deepEqual(redeemed.map((r) => r.at).sort(), [`${TX.slice(0, 8)}:0`, `${TX.slice(0, 8)}:1`], 'not both player locks were redeemed');
  assert.deepEqual(redeemed.map((r) => r.id).sort(), [STAKE.contractId, FEE.contractId].sort());
  assert.equal(redeemed.reduce((t, r) => t + Number(r.msat), 0), 98000);
  assert.ok(got.redeems.every((r) => r.accepted === true));
});
