// kanban #1489 v1-refute-7 skeptic 2 (after #1670 f70433f6e): the reload path. A seat restarts with a BONDED proposer's PASSED
// proposal in its store. Before #1670 its outcome was live from the first pass with no census read ("a decided proposal's blocks
// and census are not read again, not after a restart either", ballot-tally.js). Now every kept record reads ORPHANED until the
// census at its publication height is read again - so while that read fails (a bitcoind still warming up, the 60 s hold after a
// failed block read, a full work queue, a height whose census can no longer be derived) the seat rolls the activated config
// back to genesis: GET /config answers the old hash, a round under the superseded config is served, new rounds name it, and
// every new proposal of that network gets 503.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS, configServesRound, configForNewRound } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const A = { secret: H(0x31), pubkey: schnorr.getPublicKey(H(0x31)) };
const NET = H(0x4e), net = toHex(NET);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }];
const NEW_CONFIG = Uint8Array.of(2), NEW_HASH = configHashOf(NEW_CONFIG);

// the bonded proposer's proposal, PASSED and stored before the restart (regtest: review 1, voting 6, cooldown 1)
function passedRecord() {
  const publishedAt = 100, activationHeight = 108;
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW_HASH, config: NEW_CONFIG, class: CLASS.DESIGN, activationHeight,
    proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const id = toHex(proposalId({ ...p, signature }));
  return { id, proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: net, parent: toHex(p.parent),
    configHash: toHex(NEW_HASH), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: 101, votingUntil: 107,
    activationHeight, repeal: false, depositTxid: toHex(H(0x77)), blockHash: 'bb'.repeat(32), state: 'PASSED',
    decided: { passed: true, yesSats: '50000000', noSats: '0', abstainSats: '0', totalSats: '50000000', turnoutPct: 100, approvalPct: 100, decidedAt: 107, census: 1, anchor: null } };
}

function restartedSeat(censusAt, extraTx = null) {
  const proposals = createProposals({ confirmedTx: async (txid) => (extraTx && txid === extraTx.display ? { raw: extraTx.raw, height: 200 } : null),
    recipientsFor: () => extraTx.set, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt,
    store: { read: () => [passedRecord()], write: () => {} } });
  const tally = createBallotTally({ proposals, tipHeight: async () => 150, votesAt: async () => [], censusAt, verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  proposals.historyFor = (n, h) => tally.historyAt(n, h);
  return { proposals, tally };
}
const settle = () => new Promise((r) => setImmediate(r));

test('control: census readable at the restart - the activated config is live after the first pass', async () => {
  const { tally } = restartedSeat(async () => CENSUS);
  await settle(); await tally.pass();
  assert.equal(tally.live(net).configHash, toHex(NEW_HASH));
});

test('a bonded PASSED proposal stays live across a restart while the census read fails (the reload path)', async () => {
  const { tally } = restartedSeat(async () => null);            // e.g. main.js chainCensusKept: "a block read failed less than a minute ago"
  await settle(); await tally.pass(); await tally.pass();
  const live = tally.live(net);
  const listed = tally.list()[0];
  const old = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 140, history: tally.spans(net) });
  const named = configForNewRound({ wanted: BALLOT_GENESIS.configHash, height: 140, history: tally.spans(net) });
  console.log('  after restart: GET /config', live.configHash.slice(0, 16), '| phase', listed.phase, '| genesis round at 140 served:', old.ok, '| new round names', toHex(named).slice(0, 16));
  assert.equal(listed.phase, 'activated', 'the passed proposal of a bonded proposer reads as activated');
  assert.equal(live.configHash, toHex(NEW_HASH), 'GET /config rolled back to the genesis config after a restart');
  assert.equal(old.ok, false, 'a round created at 140 under the superseded genesis config is served again');
  assert.equal(toHex(named), toHex(NEW_HASH), 'a new round at 140 names the superseded config');
});

test('a bonded PASSED record whose old census cannot be derived any more blocks every new proposal of that network (503 for good)', async () => {
  // the census at 100 (the old record's height) never comes back; the census at 200 (the new deposit's) is there
  const SET = [{ recipientPk: Uint8Array.from([0x02, ...schnorr.getPublicKey(H(2))]), shareBps: 10000, label: 'a' }];
  const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
  const outs = depositOutputsExpected(1, SET).outputs;
  const raw = Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
    outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const extra = { raw, set: SET, display: toHex(Uint8Array.from(depositTxid).reverse()) };
  const census = async (n, h) => (h === 100 ? null : CENSUS);
  const { proposals, tally } = restartedSeat(census, extra);
  // historyFor is wired the way server.js wires it (the tally's historyAt) - rebuild the store with it
  const seat = createProposals({ confirmedTx: async (txid) => (txid === extra.display ? { raw, height: 200 } : null), recipientsFor: () => SET,
    lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, censusAt: census, historyFor: (n, h) => t2.historyAt(n, h),
    store: { read: () => [passedRecord()], write: () => {} } });
  const t2 = createBallotTally({ proposals: seat, tipHeight: async () => 199, votesAt: async () => [], censusAt: census, verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  void proposals; void tally;
  await settle(); await t2.pass(); await t2.pass();
  const p = { networkId: NET, parent: NEW_HASH, configHash: configHashOf(Uint8Array.of(3)), config: Uint8Array.of(3), class: CLASS.DESIGN, activationHeight: 230,
    proposer: A.pubkey, depositTxid };
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), A.secret)]));
  const got = await seat.add({ proposal: hex, blockHash: 'dd'.repeat(32) });
  console.log('  new bonded proposal:', got.status, got.why || '');
  assert.notEqual(got.status, 503, 'a bonded node can never publish a proposal on this seat again');
});
