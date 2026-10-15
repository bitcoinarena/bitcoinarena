// kanban #329, spec §27A.7.3-§27A.7.6: the ballot counted on a seat's own chain (ballot-tally.js), the config it makes live
// (GET /config), the rounds a seat serves under it (POST /round), and a repeal on its short schedule - all on fake chains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33), STRANGER = key(0x34);
// THE BONDS AT THE PUBLICATION: 50 + 30 + 20 = 100 M sat
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });

/** A proposal as proposals.js keeps it (regtest: review 1, voting 6, cooldown 1). */
function kept({ net = H(0x4e), parent = BALLOT_GENESIS.configHash, configHash = H(0x22), config = Uint8Array.of(2), cls = CLASS.DESIGN, publishedAt = 100,
  review = 1, voting = 6, cooldown = 1, repeal = false } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent, configHash, config, class: cls, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(parent), configHash: toHex(configHash), class: Object.keys(CLASS).find((k) => CLASS[k] === cls), proposer: toHex(A.pubkey), publishedAt,
    depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal } };
}
/** proposals.js's list / decide over a plain array, its writes counted. */
function store(records) {
  const held = new Map(records.map((r) => [r.id, r]));
  const s = { writes: 0, list: () => [...held.values()], decide: (id, outcome) => { const h = held.get(id); if (!h || h.decided) return false; held.set(id, { ...h, decided: outcome }); s.writes++; return true; } };
  return s;
}
/** A chain: a tip that moves, the votes of each height, and every read counted. */
function chain(votesByHeight) {
  const c = { tip: 0, reads: [], censusReads: 0 };
  c.tipHeight = async () => c.tip;
  c.votesAt = async (h) => { c.reads.push(h); return votesByHeight.get(h) || []; };
  c.censusAt = async () => { c.censusReads++; return CENSUS; };
  return c;
}

test('the tally from blocks: votes outside the phase ignored, the last vote per bond wins, ABSTAIN counts for turnout only; decided once', async () => {
  const { idBytes, record } = kept();
  const other = kept({ configHash: H(0x23) }).idBytes;
  const votes = new Map([
    [100, [vote(C, idBytes, CHOICE.YES, 100, 'c0')]],                           // the review block: not counted (27A.7.4)
    [101, [vote(A, idBytes, CHOICE.NO, 101, 'a1')]],
    [102, [vote(B, idBytes, CHOICE.ABSTAIN, 102, 'b1'), vote(STRANGER, idBytes, CHOICE.NO, 102, 's1')]],   // a key with no bond: nobody's vote
    [103, [vote(A, idBytes, CHOICE.YES, 103, 'a2'), vote(C, other, CHOICE.NO, 103, 'c1')]],                // A changes its mind; C votes elsewhere
    [107, [vote(C, idBytes, CHOICE.NO, 107, 'c2')]],                            // after the phase (votingUntil is 107): not counted
  ]);
  const ch = chain(votes);
  const proposals = store([record]);
  const t = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, verify, decideDepthFor: () => 1,
    genesisFor: () => BALLOT_GENESIS });
  ch.tip = 100; await t.pass();
  assert.equal(t.list()[0].phase, 'review'); assert.deepEqual(ch.reads, [], 'nothing is read in review');
  ch.tip = 103; await t.pass();
  const running = t.list()[0];
  assert.deepEqual([running.phase, running.tally.running, running.tally.yesSats, running.tally.abstainSats], ['voting', true, '50000000', '30000000']);
  ch.tip = 104; await t.pass();
  ch.tip = 106; await t.pass();                                                 // the last voting block is mined: decided (regtest depth 1)
  const done = t.list()[0];
  console.log('  TALLY:', JSON.stringify(done.tally));
  assert.deepEqual([done.phase, done.tally.yesSats, done.tally.noSats, done.tally.abstainSats, done.tally.totalSats, done.tally.turnoutPct, done.tally.approvalPct, done.tally.passed],
    ['cooldown', '50000000', '0', '30000000', '100000000', 80, 100, true]);
  assert.deepEqual(ch.reads, [101, 102, 103, 104, 105, 106], 'each block of the phase read once, none outside it');
  assert.equal(ch.censusReads, 1, 'the census at the publication read once');
  // CLOSED: never tallied again - not its blocks, not its census - here or after a restart over the same store
  ch.tip = 110; await t.pass(); await t.pass();
  const again = createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, verify });
  await again.pass();
  assert.deepEqual([ch.reads.length, ch.censusReads, proposals.writes], [6, 1, 1]);
  assert.equal(again.list()[0].phase, 'activated');
  assert.equal(t.live(toHex(H(0x4e))).configHash, toHex(H(0x22)));
  assert.equal(t.live(toHex(H(0x4e))).since, 108);
});

test('a DESIGN proposal under 30 % turnout fails, and the config stays the genesis', async () => {
  const { idBytes, record } = kept();
  const ch = chain(new Map([[101, [vote(C, idBytes, CHOICE.YES, 101, 'c')]]]));         // 20 % of the bonded capital
  const t = createBallotTally({ proposals: store([record]), tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, verify, decideDepthFor: () => 1 });
  ch.tip = 120; await t.pass();
  const got = t.list()[0];
  assert.deepEqual([got.phase, got.tally.turnoutPct, got.tally.quorum, got.tally.passed], ['failed', 20, false, false]);
  assert.equal(t.live(toHex(H(0x4e))).configHash, toHex(BALLOT_GENESIS.configHash));
});

test('a pass reads at most maxBlocksPerPass blocks, and goes on from there the next pass', async () => {
  const { record } = kept({ voting: 40 });
  const ch = chain(new Map());
  const t = createBallotTally({ proposals: store([record]), tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, verify, maxBlocksPerPass: 16 });
  ch.tip = 200;
  assert.equal((await t.pass()).read, 16); assert.equal((await t.pass()).read, 16); assert.equal((await t.pass()).read, 8);
  assert.equal((await t.pass()).read, 0);
  assert.equal(new Set(ch.reads).size, ch.reads.length, 'no height read twice');
});

// ON A RUNNING SEAT: POST /proposal, the count, GET /proposals, GET /config, POST /round under the live config, and a repeal
test('on a seat: a proposal passes and activates, rounds are served under the config of their creation, and a repeal goes back on its short schedule', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { TEST_DONATION_SET_KEYS_REGTEST: KEYS } = await import('../../arena-protocol/src/test-donation-set-keys-regtest.js');
  const { NETWORK_ID_REGTEST } = await import('../../arena-protocol/src/genesis-ids.js');
  const { NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH } = await import('../../nextblock/plugin/nextblock.js');
  const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
  const tx = (outs, salt) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(salt), ...le(0, 4), 0, ...le(0xffffffff, 4),
    outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
  const NEW = { hash: H(0x5e), bytes: Uint8Array.of(3, 1, 4) };
  const deposits = new Map();                                                    // txid (display) -> { raw, height }
  /** A proposal with its deposit confirmed at `at`, posted to the seat. */
  const propose = async (base, { parent, configHash, config, at, activationHeight, salt }) => {
    const raw = tx(depositOutputsExpected(1000, KEYS.recipients).outputs.map((o) => ({ sats: o.sats, script: o.script })), salt);
    const p = { networkId: NETWORK_ID_REGTEST, parent, configHash, config, class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
    deposits.set(toHex(Uint8Array.from(p.depositTxid).reverse()), { raw, height: at });
    const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), A.secret)]));
    const r = await fetch(`${base}/proposal`, { method: 'POST', body: JSON.stringify({ proposal: hex, blockHash: 'ab'.repeat(32) }) });
    return { status: r.status, body: await r.json() };
  };
  const votes = new Map();
  const cast = (who, idHex, choice, height) => { const id = Uint8Array.from(Buffer.from(idHex, 'hex')); votes.set(height, [...(votes.get(height) || []), vote(who, id, choice, height, `${height}${who === A ? 'a' : 'b'}`)]); };
  let tip = 300;
  const d = await serve(openStore(':memory:'), { port: 0, donationSets: [KEYS],
    ballot: { confirmedTx: async (txid) => deposits.get(txid) || null, lowestBondMinSats: 100000n, tipHeight: async () => tip,
      votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, everyMs: 3600000 } });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const net = toHex(NETWORK_ID_REGTEST);
    const config = async () => (await fetch(`${base}/config?network=${net}`)).json();
    const listed = async () => (await (await fetch(`${base}/proposals`)).json()).proposals;
    assert.equal((await config()).configHash, toHex(BALLOT_GENESIS.configHash), 'before any proposal: the genesis');
    // THE PROPOSAL: genesis -> NEW, published at 300, activation 308 (regtest 1 / 6 / 1)
    const first = await propose(base, { parent: BALLOT_GENESIS.configHash, configHash: NEW.hash, config: NEW.bytes, at: 300, activationHeight: 308, salt: 1 });
    assert.equal(first.status, 201, first.body.why);
    assert.deepEqual([first.body.repeal, first.body.votingFrom, first.body.votingUntil], [false, 301, 307]);
    cast(A, first.body.id, CHOICE.YES, 302); cast(B, first.body.id, CHOICE.NO, 303);
    for (tip = 300; tip <= 306; tip++) await d.ballotPass();
    tip = 306;
    const decided = (await listed())[0];
    console.log('  SEAT TALLY:', JSON.stringify({ phase: decided.phase, ...decided.tally }));
    assert.deepEqual([decided.phase, decided.tally.yesSats, decided.tally.noSats, decided.tally.turnoutPct, decided.tally.approvalPct, decided.tally.passed],
      ['cooldown', '50000000', '30000000', 80, 62.5, true]);
    assert.equal((await config()).configHash, toHex(BALLOT_GENESIS.configHash), 'passed, not live before its activation height');
    tip = 308; await d.ballotPass();
    const live = await config();
    console.log('  GET /config at 308:', JSON.stringify({ configHash: live.configHash.slice(0, 16), since: live.since, by: live.by.slice(0, 16), history: live.history.length }));
    assert.deepEqual([live.configHash, live.since, live.by, live.history.length], [toHex(NEW.hash), 308, first.body.id, 2]);
    assert.equal((await listed())[0].phase, 'activated');

    // THE ROUNDS: posted with a census height; only the config refusal is read here (the seat holds no chain view for the rest)
    const round = (configHash, censusHeight) => encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
      gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 1n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 60001n,
      entryCloseMs: 1860001n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
      federationId: H(5), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:1'], donationSetId: H(6), censusHeight,
      censusRoot: H(9), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40,
      spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [H(7), H(8)] });
    const post = async (configHash, h) => { const r = await fetch(`${base}/round`, { method: 'POST', body: round(configHash, h) }); return { status: r.status, text: await r.text() }; };
    const BOUND = /a round is bound to the config it was created under/;
    const oldAfter = await post(BALLOT_GENESIS.configHash, 308);
    console.log('  POST /round old config at 308:', oldAfter.status, oldAfter.text.slice(0, 140));
    assert.equal(oldAfter.status, 409); assert.match(oldAfter.text, BOUND);
    assert.doesNotMatch((await post(NEW.hash, 308)).text, BOUND, 'a round created after the activation names the new hash, and is not refused for it');
    assert.doesNotMatch((await post(BALLOT_GENESIS.configHash, 307)).text, BOUND, 'a round created before keeps its own config');
    assert.match((await post(NEW.hash, 307)).text, BOUND, 'and could not name the new one');

    // THE REPEAL (27A.7.6): NEW -> the genesis bytes again, at 310: review 0, voting 6, cooldown 0 - activation from 316
    const forward = await propose(base, { parent: NEW.hash, configHash: H(0x6f), config: Uint8Array.of(7), at: 310, activationHeight: 316, salt: 2 });
    assert.equal(forward.status, 422); assert.match(forward.body.why, /before the end of cooldown \(318\)/, 'a new config never runs on the short schedule');
    const back = await propose(base, { parent: NEW.hash, configHash: BALLOT_GENESIS.configHash, config: BALLOT_GENESIS.config, at: 310, activationHeight: 316, salt: 3 });
    assert.equal(back.status, 201, back.body.why);
    assert.deepEqual([back.body.repeal, back.body.votingFrom, back.body.votingUntil, back.body.activationHeight], [true, 310, 316, 316]);
    cast(A, back.body.id, CHOICE.YES, 311); cast(B, back.body.id, CHOICE.YES, 312);
    for (tip = 310; tip <= 316; tip++) await d.ballotPass();
    const after = await config();
    console.log('  GET /config at 316:', JSON.stringify({ configHash: after.configHash.slice(0, 16), since: after.since, history: after.history.map((x) => `${x.configHash.slice(0, 8)}@${x.since}`) }));
    assert.deepEqual([after.configHash, after.since, after.by, after.history.map((x) => x.since)], [toHex(BALLOT_GENESIS.configHash), 316, back.body.id, [0, 308, 316]]);
    assert.doesNotMatch((await post(BALLOT_GENESIS.configHash, 316)).text, BOUND);
    assert.match((await post(NEW.hash, 316)).text, BOUND);
    assert.doesNotMatch((await post(NEW.hash, 312)).text, BOUND, 'a round created while NEW was live keeps NEW');
  } finally { await d.close(); }
});
