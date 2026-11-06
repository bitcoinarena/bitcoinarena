// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1152: AN RPC ERROR FORGOT AN ACTIVATED CONFIG. The reorg check read "the chain did not answer" as "the block changed":
// a getblockhash that failed (work queue full, a timeout, a reindex) gave null, the publication re-check gave null too, so a PASSED
// proposal was forgotten and DELETEd from ballot_proposals, and the seat dropped the live config the network serves.
// Here, on a fake chain and the real proposals.js: the RPC error skips the pass and moves nothing; a real reorg ORPHANS a proposal
// (kept with its bytes, never deleted) and the chain coming back restores it; a seat that never heard of a proposal pulls it
// from a peer, checked as if posted to it; an outcome is written no less than 3 deep; and each move is a compare-and-set,
// persisted before it is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const NET = toHex(H(0x4e));
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

/** A proposal record as proposals.js keeps it (review 1, voting 6, cooldown 1 unless named). */
function kept({ publishedAt = 100, review = 1, voting = 6, cooldown = 1, configHash = H(0x22), config = Uint8Array.of(2) } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash, config, class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, body: p, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), record: { id: toHex(idBytes),
    proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: NET, parent: toHex(p.parent), configHash: toHex(configHash),
    class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting,
    activationHeight, repeal: false } };
}
/** A chain that forks, and whose RPC can be made to fail: `down = true` -> every getblockhash throws as bitcoind's would. */
function forkable(votesByHeight, top = 140) {
  const c = { tip: 0, down: false, blocks: new Map(), byHash: new Map(), branch: 0 };
  const put = (h, votes) => { const hash = `${String(c.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); c.blocks.set(h, hash); c.byHash.set(hash, votes || []); };
  for (let h = 0; h <= top; h++) put(h, votesByHeight.get(h));
  c.fork = (at, votes = new Map()) => { c.branch++; for (let h = at; h <= top; h++) put(h, votes.get(h)); };
  c.back = (at, branch, votes) => { const was = c.branch; c.branch = branch; for (let h = at; h <= top; h++) put(h, votes.get(h)); c.branch = was; };
  c.tipHeight = async () => c.tip;
  c.blockHashAt = async (h) => {
    if (c.down) throw new Error('bitcoind answered 500: {"result":null,"error":{"code":-32603,"message":"Work queue depth exceeded"}}');
    return h <= c.tip ? c.blocks.get(h) : null;
  };
  c.votesAt = async (h, hash) => c.byHash.get(hash || c.blocks.get(h)) || [];
  c.censusAt = async () => CENSUS;
  return c;
}
/** The real proposals.js over a store that keeps rows as server.js's ballot_proposals does, every DELETE counted. */
function seatStore(records = []) {
  const rows = new Map(records.map((r) => [r.id, JSON.stringify(r)]));
  return { rows, deletes: [], failNext: false,
    read() { return [...rows.values()].map((j) => JSON.parse(j)); },
    write(list) { if (this.failNext) { this.failNext = false; throw new Error('SQLITE_BUSY: database is locked'); } for (const x of list) rows.set(x.id, JSON.stringify(x)); },
    remove(id) { this.deletes.push(id); rows.delete(id); } };
}
const seatProposals = (store, extra = {}) => createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify, store, ...extra });

/** A PASSED, activated proposal on a seat: published at 100, voting 101-106, decided, live from 108. */
async function passedSeat() {
  const k = kept();
  const ch = forkable(new Map([[101, [vote(A, k.idBytes, CHOICE.YES, 101, 'a1')]], [102, [vote(B, k.idBytes, CHOICE.YES, 102, 'b1')]]]));
  const store = seatStore([{ ...k.record, blockHash: ch.blocks.get(100) }]);
  const proposals = seatProposals(store);
  const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  ch.tip = 106; await t.pass();
  ch.tip = 110; await t.pass();
  return { k, ch, store, proposals, t };
}

test('#1152 the scenario: an RPC error during the reorg check forgets nothing, deletes nothing, and the live config stays', async () => {
  const { k, ch, store, proposals, t } = await passedSeat();
  const before = { live: t.live(NET).configHash, phase: t.list()[0].phase, passed: proposals.list()[0].decided && proposals.list()[0].decided.passed, rows: store.rows.size };
  assert.deepEqual(before, { live: toHex(H(0x22)), phase: 'activated', passed: true, rows: 1 }, 'passed and live from 108');
  // THE RPC FAILS for one pass (work queue full): before kanban #1152 this pass forgot the proposal and DELETEd its row
  ch.down = true;
  const r = await t.pass();
  const during = { live: t.live(NET).configHash, kept: proposals.list().length, deletes: store.deletes.length, rows: store.rows.size,
    passed: !!(proposals.list()[0] && proposals.list()[0].decided && proposals.list()[0].decided.passed) };
  console.log('  #1152 RPC DOWN:', JSON.stringify({ pass: r, ...during, live: during.live.slice(0, 16) }));
  assert.equal(during.deletes, 0, 'no DELETE from ballot_proposals');
  assert.equal(during.kept, 1, 'the proposal is still kept');
  assert.equal(during.passed, true, 'still PASSED');
  assert.equal(during.live, toHex(H(0x22)), 'the live config did not drop');
  assert.equal(r.skipped, 'rpc', 'the pass was skipped');
  assert.equal(r.reorged, 0);
  // THE RPC ANSWERS AGAIN: nothing to follow, nothing moved
  ch.down = false; ch.tip = 112;
  assert.equal((await t.pass()).reorged, 0);
  assert.deepEqual([t.live(NET).configHash, t.list()[0].phase, proposals.list()[0].state], [toHex(H(0x22)), 'activated', 'PASSED']);
  // and after a restart over the same rows: the same
  const again = createBallotTally({ proposals: seatProposals(store), tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify });
  await again.pass();
  assert.equal(again.live(NET).configHash, toHex(H(0x22)));
  assert.equal(k.record.id, proposals.list()[0].id);
});

test('#1152 a height above the tip (a shorter chain, a reindex) is no evidence: nothing moves until the chain is there again', async () => {
  const { ch, store, proposals, t } = await passedSeat();
  ch.tip = 103;                                                          // the anchor (106) is above this seat's tip now
  const r = await t.pass();
  assert.deepEqual([r.reorged, proposals.list()[0].state, t.list()[0].phase, store.deletes.length], [0, 'PASSED', 'cooldown', 0]);
  ch.tip = 112;
  assert.deepEqual([(await t.pass()).reorged, t.live(NET).configHash], [0, toHex(H(0x22))]);
});

test('#1152 a real reorg under the publication ORPHANS a passed proposal (bytes kept, no DELETE); the block back restores it, counted again', async () => {
  const { k, ch, store, proposals, t } = await passedSeat();
  const votes = new Map([[101, [vote(A, k.idBytes, CHOICE.YES, 101, 'a1')]], [102, [vote(B, k.idBytes, CHOICE.YES, 102, 'b1')]]]);
  ch.fork(99); ch.tip = 112;                                             // the publication block (100) is another block now
  const r = await t.pass();
  const row = JSON.parse(store.rows.get(k.record.id));
  console.log('  #1152 ORPHANED:', JSON.stringify({ pass: r, state: row.state, was: row.orphaned.was, keptBytes: row.proposal === k.record.proposal, live: t.live(NET).configHash.slice(0, 16), deletes: store.deletes.length }));
  assert.deepEqual([r.reorged, row.state, row.orphaned.was, row.orphaned.outcome.passed, row.proposal, store.deletes.length], [1, 'ORPHANED', 'PASSED', true, k.record.proposal, 0]);
  assert.equal(t.list()[0].phase, 'orphaned');
  assert.equal(t.live(NET).configHash, toHex(BALLOT_GENESIS.configHash), 'not published on this chain: its config is not live here');
  assert.equal((await t.pass()).reorged, 0, 'an orphan stays an orphan while its block is not on this chain');
  // THE OLD CHAIN WINS AGAIN: the same blocks back - restored, counted again from its phase's first block, PASSED again
  ch.back(99, 0, votes); ch.tip = 113;
  const back = await t.pass();
  assert.equal(back.reorged, 1);
  assert.match(t.reorgs().at(-1).what, /on this chain again/);
  ch.tip = 114; await t.pass();
  assert.deepEqual([proposals.list()[0].state, t.list()[0].phase, t.live(NET).configHash], ['PASSED', 'activated', toHex(H(0x22))]);
});

test('#1152 the peer pull: a seat that never heard of a proposal takes it from a peer\'s GET /proposals, checked by add as if posted', async () => {
  const k = kept({ publishedAt: 300 });
  const BLOCK = 'ab'.repeat(32);
  const asked = [];
  // add() needs the deposit in the named block of THIS seat's chain; the fake answers only for BLOCK
  const store = seatStore();
  const raw = new Uint8Array(0);
  const proposals = seatProposals(store, { confirmedTx: async (txid, block) => { asked.push(block); return block === BLOCK ? { raw, height: 300 } : null; },
    recipientsFor: () => [] });
  // what a peer's GET /proposals carries: the record, its phase and tally, the bytes and the block
  const peer = [{ ...k.record, blockHash: BLOCK, phase: 'voting', tally: null }, { ...k.record, id: 'ff'.repeat(32), blockHash: 'cd'.repeat(32) }, { junk: true }];
  const took = await proposals.pull(peer);
  // the deposit check in ballot-chain.js depositOf refuses an empty tx: the pull TAKES NOTHING ON TRUST
  assert.equal(took, 0);
  assert.deepEqual(asked, [BLOCK, 'cd'.repeat(32)], 'each one checked against this seat\'s chain');
  assert.equal(proposals.list().length, 0);
  // with add() standing (a stand-in for a deposit this seat reads), the one in BLOCK is taken, once
  const real = seatProposals(seatStore());
  const calls = [];
  real.add = async (b) => { calls.push(b.blockHash); return { ok: true, status: 201 }; };
  assert.equal(await real.pull(peer), 2);
  assert.deepEqual(calls, [BLOCK, 'cd'.repeat(32)]);
});

test('#1152 an outcome is written no less than 3 deep (MIN_DECIDE_DEPTH), a repeal\'s too', async () => {
  const run = async (cooldown) => {
    // a repeal's shape: review 0, voting 100-106 (until 107), activation 107 + cooldown
    const k = kept({ review: 0, voting: 7, cooldown });
    const ch = forkable(new Map([[101, [vote(A, k.idBytes, CHOICE.YES, 101, 'a1')]]]));
    const proposals = seatProposals(seatStore([{ ...k.record, blockHash: ch.blocks.get(100) }]));
    const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify });
    const seen = [];
    for (ch.tip = 105; ch.tip <= 109; ch.tip++) { await t.pass(); seen.push(`${ch.tip}:${proposals.list()[0].state || (proposals.list()[0].decided ? 'decided' : 'COUNTING')}`); }
    return { seen, decidedAt: proposals.list()[0].decided ? proposals.list()[0].decided.decidedAt : null, activation: k.record.activationHeight };
  };
  // COOLDOWN 0 (§27A.7.6 before the #1196 ruling): before kanban #1152 decided at the last voting block itself - 1 deep; under the
  // #1196 rule (the gate at 0 here) its activation leaves 1 block after its last voting block: invalid on its face, never decided
  // (kanban #1199; below the gate it keeps depth 1, ballot-depth-1199.test.js)
  const zero = await run(0);
  // COOLDOWN 2 (the cooldown kanban #1152 gives a repeal): 3 deep at 108, the block before its activation at 109
  const two = await run(2);
  console.log('  #1152 DEPTH:', JSON.stringify({ cooldown0: zero, cooldown2: two }));
  assert.equal(zero.decidedAt, null, 'fewer than 3 blocks after the last voting block (106): never decided');
  assert.deepEqual([two.decidedAt, two.activation], [108, 109], 'decided the block before its activation');
});

test('#1152 the seat\'s hash read (main.js chainHashAt): the hash, null above the tip, and an RPC error THROWS', async () => {
  const { chainHashReader } = await import('../src/ballot-tally.js');
  const answers = { tip: 200, fail: null };
  // what chain-rpc.js throws: the HTTP status and bitcoind's body
  const call = async (method, [h] = []) => {
    if (method === 'getblockcount') { if (answers.fail === 'all') throw new Error('bitcoind at http://127.0.0.1:48332 did not answer getblockcount: fetch failed'); return answers.tip; }
    if (answers.fail === 'queue') throw new Error('bitcoind answered 500: {"result":null,"error":{"code":-32603,"message":"Work queue depth exceeded"},"id":"arena"}');
    if (answers.fail === 'all') throw new Error('bitcoind at http://127.0.0.1:48332 did not answer getblockhash: fetch failed');
    if (h > answers.tip) throw new Error('bitcoind answered 500: {"result":null,"error":{"code":-8,"message":"Block height out of range"},"id":"arena"}');
    return 'ab'.repeat(32);
  };
  const at = chainHashReader(call);
  assert.equal(await at(150), 'ab'.repeat(32));
  assert.equal(await at(201), null, 'above the tip: null');
  answers.fail = 'queue';
  await assert.rejects(at(150), /Work queue depth exceeded/, 'a full work queue is no answer');
  answers.fail = 'all';
  await assert.rejects(at(150), /did not answer/, 'a bitcoind that is down is no answer');
});

test('#1152 one transition function: compare-and-set on the state it leaves, written before it is taken', async () => {
  const k = kept();
  const store = seatStore([{ ...k.record, blockHash: 'aa'.repeat(32) }]);
  const p = seatProposals(store);
  const outcome = { passed: true, decidedAt: 108, anchor: { height: 106, hash: 'bb'.repeat(32) } };
  assert.equal(p.transition(k.record.id, 'PASSED', 'COUNTING'), false, 'not in PASSED: refused');
  assert.equal(p.transition(k.record.id, 'COUNTING', 'PASSED', { outcome: { ...outcome, passed: false } }), false, 'an outcome that says FAILED cannot pass it');
  // the store refuses the write: the seat's memory does not move either
  store.failNext = true;
  assert.equal(p.decide(k.record.id, outcome), false);
  assert.equal(p.list()[0].state, 'COUNTING');
  assert.equal(JSON.parse(store.rows.get(k.record.id)).state, undefined);
  assert.equal(p.decide(k.record.id, outcome), true);
  assert.equal(p.decide(k.record.id, outcome), false, 'decided once');
  assert.equal(JSON.parse(store.rows.get(k.record.id)).state, 'PASSED');
  assert.equal(p.transition(k.record.id, 'PASSED', 'FAILED', { outcome: { ...outcome, passed: false } }), false, 'PASSED -> FAILED is no move: only through COUNTING');
  assert.equal(p.orphan(k.record.id, { at: 120 }), true);
  assert.equal(p.orphan(k.record.id, { at: 121 }), false);
  assert.equal(p.decide(k.record.id, outcome), false, 'an orphan is not decided');
  assert.equal(p.restore(k.record.id), true);
  assert.deepEqual([p.list()[0].state, store.deletes.length, store.rows.size], ['COUNTING', 0, 1]);
  // records written before kanban #1152 carry no state: read from what they hold
  const legacy = seatProposals(seatStore([{ ...k.record, id: 'ee'.repeat(32), decided: { ...outcome } }]));
  assert.equal(legacy.list()[0].state, 'PASSED');
});

test('#1152 on two running seats: seat B never got the POST /proposal, and pulls it from seat A (GET /proposals), checked on its own chain', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { TEST_DONATION_SET_KEYS_REGTEST: KEYS } = await import('../../arena-protocol/src/test-donation-set-keys-regtest.js');
  const { NETWORK_ID_REGTEST } = await import('../../arena-protocol/src/genesis-ids.js');
  const { depositOutputsExpected } = await import('../../arena-protocol/src/ballot-chain.js');
  const { parseTransaction } = await import('../../arena-protocol/src/tx.js');
  const { configHashOf } = await import('../../arena-protocol/src/ballot.js');
  const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
  const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
    outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
  const raw = tx(depositOutputsExpected(700, KEYS.recipients).outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NETWORK_ID_REGTEST, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(Uint8Array.of(9)), config: Uint8Array.of(9),
    class: CLASS.MONEY, activationHeight: 300 + 8, proposer: A.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), A.secret)]));
  const BLOCK = 'cc'.repeat(32), TXID = toHex(Uint8Array.from(p.depositTxid).reverse());
  // ONE CHAIN BOTH SEATS READ: the deposit is in BLOCK at 300
  const ballot = () => ({ confirmedTx: async (txid, block) => (block === BLOCK && txid === TXID ? { raw, height: 300 } : null), lowestBondMinSats: 100000n });
  const a = await serve(openStore(':memory:'), { port: 0, donationSets: [KEYS], ballot: ballot() });
  const b = await serve(openStore(':memory:'), { port: 0, donationSets: [KEYS], ballot: ballot(), peers: [`http://127.0.0.1:${a.port}`] });
  try {
    const posted = await fetch(`http://127.0.0.1:${a.port}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: BLOCK }) });
    assert.equal(posted.status, 201);
    const listB = async () => (await (await fetch(`http://127.0.0.1:${b.port}/proposals`)).json()).proposals;
    assert.equal((await listB()).length, 0, 'B never got the post');
    const took = await b.pullProposals();
    const got = await listB();
    console.log('  #1152 PULL:', JSON.stringify({ took, kept: got.length, id: got[0] && got[0].id.slice(0, 16), publishedAt: got[0] && got[0].publishedAt, state: got[0] && got[0].state }));
    assert.deepEqual([took, got.length, got[0].publishedAt, got[0].blockHash, got[0].state], [1, 1, 300, BLOCK, 'COUNTING']);
    assert.equal(await b.pullProposals(), 0, 'kept already: nothing pulled again');
  } finally { await b.close(); await a.close(); }
});
