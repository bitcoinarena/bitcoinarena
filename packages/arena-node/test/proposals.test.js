// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//: the proposals a seat keeps and serves - taken when they stand and their deposit is on the seat's chain (option A)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeSourceList, encodeSourceList } from '../../arena-protocol/src/market-check.js';
import { socketStart } from '../src/market-reader.js';
import { tryExample } from '../src/market-test.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);

function proposalWithDeposit(sats, { activationHeight = 200 + 8 } = {}) {
  const want = depositOutputsExpected(sats, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(1, 2, 3)), config: Uint8Array.of(1, 2, 3),
    class: CLASS.DESIGN, activationHeight, proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), secret);
  return { raw, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), txidDisplay: toHex(Uint8Array.from(p.depositTxid).reverse()) };
}

test('a seat keeps a proposal that stands and whose deposit is in the block named, and serves it; anything else by name', async () => {
  const BLOCK = 'bb'.repeat(32);
  const chain = new Map();
  const saved = [];
  const seat = createProposals({ confirmedTx: async (txid, block) => (block === BLOCK && chain.has(txid) ? { raw: chain.get(txid), height: 200 } : null),
    recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    store: { read: () => [], write: (l) => saved.push(l.length) } });
  const good = proposalWithDeposit(1000);
  chain.set(good.txidDisplay, good.raw);
  const got = await seat.add({ proposal: good.hex, blockHash: BLOCK });
  console.log('  KEPT:', JSON.stringify({ status: got.status, id: got.id && got.id.slice(0, 16), publishedAt: got.publishedAt, depositSats: got.depositSats, votingFrom: got.votingFrom, votingUntil: got.votingUntil }));
  assert.equal(got.status, 201, got.why);
  assert.deepEqual([got.publishedAt, got.depositSats, got.votingFrom, got.votingUntil, got.class], [200, '1000', 201, 207, 'DESIGN']);
  assert.equal(seat.list().length, 1); assert.deepEqual(saved, [1]);
  assert.equal((await seat.add({ proposal: good.hex, blockHash: BLOCK })).already, true, 'the same proposal again is the one kept');
  // over the cap (1000 > 100 000 / 100 is not; 1001 is)
  const over = proposalWithDeposit(1001); chain.set(over.txidDisplay, over.raw);
  assert.match((await seat.add({ proposal: over.hex, blockHash: BLOCK })).why, /over the cap of 1000/);
  // activation before the end of cooldown (200 + 1 + 6 + 1 = 208)
  const early = proposalWithDeposit(1000, { activationHeight: 207 }); chain.set(early.txidDisplay, early.raw);
  assert.match((await seat.add({ proposal: early.hex, blockHash: BLOCK })).why, /before the end of cooldown/);
  // a deposit not in the block named
  const elsewhere = proposalWithDeposit(999);
  assert.match((await seat.add({ proposal: elsewhere.hex, blockHash: BLOCK })).why, /does not hold the deposit/);
  assert.equal((await seat.add({ proposal: 'zz', blockHash: BLOCK })).status, 400);
  assert.equal(seat.list().length, 1);
});

test('on a running seat: POST /proposal reads the deposit through `ballot`, checks it against the network\'s keyed set in force, GET /proposals serves it', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { TEST_DONATION_SET_KEYS_REGTEST: KEYS } = await import('../../arena-protocol/src/test-donation-set-keys-regtest.js');
  const { NETWORK_ID_REGTEST } = await import('../../arena-protocol/src/genesis-ids.js');
  const want = depositOutputsExpected(700, KEYS.recipients);
  assert.equal(want.ok, true, want.why);
  // regtest is bound from 0 (kanban #2562): the deposit commits to its proposer and the proposal's bytes
  const body = { networkId: NETWORK_ID_REGTEST, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(Uint8Array.of(9)), config: Uint8Array.of(9),
    class: CLASS.MONEY, activationHeight: 300 + 8, proposer };
  const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body) }]);
  const p = { ...body, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  const BLOCK = 'cc'.repeat(32);
  let pairing = null;
  const opStore = (() => { let l = []; return { read: () => l, write: (x) => { l = JSON.parse(JSON.stringify(x)); } }; })();
  const d = await serve(openStore(':memory:'), { port: 0, donationSets: [KEYS], operator: { store: opStore, writePairing: (u) => { pairing = u; }, endpoint: 'https://seat.example' },
    ballot: { confirmedTx: async (txid, block) => (block === BLOCK && txid === toHex(Uint8Array.from(p.depositTxid).reverse()) ? { raw, height: 300 } : null), lowestBondMinSats: 100000n } });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = await fetch(`${base}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: BLOCK }) });
    const got = await post.json();
    const listed = (await (await fetch(`${base}/proposals`)).json()).proposals;
    console.log('  SEAT:', JSON.stringify({ status: post.status, class: got.class, publishedAt: got.publishedAt, depositSats: got.depositSats, listed: listed.length, outputs: want.outputs.map((o) => Number(o.sats)) }));
    assert.equal(post.status, 201, got.why);
    assert.deepEqual([got.class, got.publishedAt, got.depositSats, listed.length], ['MONEY', 300, '700', 1]);
    const wrong = await fetch(`${base}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: 'dd'.repeat(32) }) });
    assert.equal(wrong.status, 200, 'kept already: the same proposal answers the one kept');
    // THE VOTE DOOR ON A BOUND PROPOSAL (kanban #2562): the 80-byte seq vote, seq raised per vote, signed by the node key
    const { readOperatorUri } = await import('../src/operator-tokens.js');
    const { decodeVote, voteMessage, CHOICE } = await import('../../arena-protocol/src/ballot.js');
    const { token } = readOperatorUri(pairing);
    const node = (await (await fetch(`${base}/operator/status`, { headers: { authorization: `Bearer ${token}` } })).json()).node;
    const castVote = async (b) => (await fetch(`${base}/operator/vote`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(b) })).json();
    const v1 = await castVote({ proposalId: got.id, choice: 'YES' }), v2 = await castVote({ proposalId: got.id, choice: 'NO' }), v3 = await castVote({ proposalId: got.id, choice: 'NO', seq: 40 });
    const dec = [v1, v2, v3].map((v) => decodeVote(Uint8Array.from(Buffer.from(v.opReturn, 'hex'))));
    console.log('  DOOR:', JSON.stringify([v1, v2, v3].map((v, i) => ({ bytes: v.opReturn.length / 2, seq: v.seq, decodedSeq: dec[i].seq, bound: dec[i].bound }))));
    assert.deepEqual(dec.map((x) => [x.bound, x.seq]), [[true, 1], [true, 2], [true, 40]]);
    assert.equal(v1.opReturn.length / 2, 80);
    const idb = Uint8Array.from(Buffer.from(got.id, 'hex'));
    assert.equal(schnorr.verify(dec[1].signature, voteMessage(idb, CHOICE.NO, 2), Uint8Array.from(Buffer.from(node, 'hex'))), true, 'H(proposal_id || choice || seq), the node key');
    assert.equal((await castVote({ proposalId: got.id, choice: 'NO', seq: -1 })).ok, false);
  } finally { await d.close(); }
});

test('a proposed source: each seat reads each new host\'s example and keeps what it saw, and keeps the proposal either way', async () => {
  const added = (host) => ({ host, url: `https://${host}/x`, read: 'text', path: '', docs: `https://${host}/docs` });
  const before = encodeSourceList([added('a.example.org')]), config = encodeSourceList([added('a.example.org'), added('b.example.org'), added('c.example.org')]);
  const want = depositOutputsExpected(1000, SET), raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config, class: CLASS.SOURCES, activationHeight: 2000,
    proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  const asked = [];
  const book = createProposals({ confirmedTx: async () => ({ raw, height: 200 }), recipientsFor: () => SET, lowestBondMinSatsFor: () => 200000n, verify, historyFor: () => [{ config: before }],
    exampleCheck: async (e) => { asked.push(e.host); return e.host === 'b.example.org' ? { ok: true, value: '42' } : { ok: false, why: 'answered 403' }; } });
  const got = await book.add({ proposal: hex, blockHash: 'a'.repeat(64) });
  assert.equal(got.status, 201, got.why);
  assert.deepEqual(asked, ['b.example.org', 'c.example.org']);
  assert.deepEqual(got.example, [{ host: 'b.example.org', ok: true, value: '42' }, { host: 'c.example.org', ok: false, why: 'answered 403' }]);
});

test('a list adds at most 8 hosts at once', async () => {
  const added = (host) => ({ host, url: `https://${host}/x`, read: 'text', path: '', docs: `https://${host}/docs` });
  const config = encodeSourceList(Array.from({ length: 9 }, (_, i) => added(`h${i}.example.org`)));
  const want = depositOutputsExpected(1000, SET), raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config, class: CLASS.SOURCES, activationHeight: 2000,
    proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
  const book = createProposals({ confirmedTx: async () => ({ raw, height: 200 }), recipientsFor: () => SET, lowestBondMinSatsFor: () => 200000n, verify, historyFor: () => [{ config: encodeSourceList([added('a.example.org')]) }] });
  const got = await book.add({ proposal: hex, blockHash: 'a'.repeat(64) });
  assert.equal(got.status, 422);
  assert.match(got.why, /at most 8 hosts/);
});

test('an example is read as a market reads: the field, in the sandbox', async () => {
  const entry = { host: 'a.example.org', url: 'https://a.example.org/x', read: 'json', path: 'data.rate', docs: 'https://a.example.org/docs' };
  const read = async () => ({ reads: { page: { data: { rate: 1.25 } } } });
  assert.deepEqual(await tryExample(entry, { read }), { ok: true, value: '1.25' });
  assert.equal((await tryExample({ ...entry, path: 'data.none.more' }, { read })).ok, false);
  assert.match((await tryExample(entry, { read: async () => ({ why: 'page: answered 403' }) })).why, /403/);
  assert.match((await tryExample({ ...entry, read: 'text' }, { read: async () => ({ reads: { page: '  ' } }) })).why, /found nothing/);
});

test('a socket\'s init code: the check every seat gives the same answer on, the sandbox, what it sends', async () => {
  const good = 'function init(message, step) {\n  if (step > 0) return null;\n  return JSON.stringify({ subscribe: message });\n}\n';
  assert.deepEqual(await socketStart(good, 'x', 0), { ok: true, send: ['{"subscribe":"x"}'] });
  assert.deepEqual(await socketStart(good, 'x', 1), { ok: true, send: [] });
  assert.match((await socketStart("function init() {\n  return fetch('https://a.example/');\n}\n", null, 0)).why, /not allowed/);
  assert.match((await socketStart('function init() {\n  return 7;\n}\n', null, 0)).why, /answers text/);
  assert.match((await socketStart('function other() {\n  return 7;\n}\n', null, 0)).why, /one function init/);
  const entry = (init) => ({ host: 'b.example.org', url: 'wss://b.example.org/x', read: 'text', path: '', docs: 'https://b.example.org/docs', init });
  const a = { host: 'a.example.org', url: 'https://a.example.org/x', read: 'text', path: '', docs: 'https://a.example.org/docs' };
  const before = encodeSourceList([a]);
  for (const [init, status] of [[good, 201], ["function init() {\n  return eval('1');\n}\n", 422]]) {
    const config = encodeSourceList([a, entry(init)]);
    assert.equal(decodeSourceList(config).find((e) => e.host === 'b.example.org').init, init);
    const want = depositOutputsExpected(1000, SET), raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
    const p = { networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config, class: CLASS.SOURCES, activationHeight: 2000, proposer, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
    const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)]));
    const book = createProposals({ confirmedTx: async () => ({ raw, height: 200 }), recipientsFor: () => SET, lowestBondMinSatsFor: () => 200000n, verify, historyFor: () => [{ config: before }] });
    assert.equal((await book.add({ proposal: hex, blockHash: 'a'.repeat(64) })).status, status);
  }
});
