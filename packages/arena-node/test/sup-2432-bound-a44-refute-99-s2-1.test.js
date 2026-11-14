// kanban #1489 fix-refute audit44 item 99, skeptic 2 (#2194 on 7b18757a6): the late-proposal vouch counts SEAT URLs and trusts each
// seat's own `seenAt`. Three seats one bonded operator runs (or any 3 colluding seats of a 14-seat network) list the withheld proposal
// with a forged seenAt below its voting; every honest seat, which kept it LATE, then counts it - and the #1608 attack (a proposal
// revealed after its voting and activation, passed on the proposer's own vote, live retroactively) works again.
// Adapted to 1.9 by #2536 (kanban #2432): 1.9 has no "three seats vouch" door and no seenAt; it reads deposits BOUND (#2125 / #2012 (c),
// regtest and mainnet from block 0): the deposit commits to the proposer and H(proposal), and a bound proposal is taken at any time.
// The same withheld proposal on the bound reading: committed at 200, the proposer's seq vote at 202, the bytes shown only at tip 250.
// Measured on 1.9: taken 201, passed on the proposer's own 35 %, activated, the round at 220 on genesis refused after the fact. Kept as
// todo: closing it means refusing a bound proposal shown after its voting (or activation), which the #2012 (c) ruling does not do.
// DECIDED 2026-11-14 (kanban #2432, "a text counts only if a seat majority held it before voting ended"): a bound proposal a seat first
// holds after its voting ended is kept LATE and not counted until bonds holding more than half of the census weight (the proposer's
// left out) signed that they held it before its voting ended. No longer todo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals, seenMessage } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const ATTACKER = key(0x51), H1 = key(0x52), H2 = key(0x53);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e), NETHEX = toHex(NET);
// the attacker's bond is 35 % of the census: alone above DESIGN's 30 % turnout; the two honest bonds hold 65 % and would vote NO
const CENSUS = [{ pubkey: ATTACKER.pubkey, outpoint: 'aa:0', bondSats: 35000000n }, { pubkey: H1.pubkey, outpoint: 'bb:0', bondSats: 35000000n },
  { pubkey: H2.pubkey, outpoint: 'cc:0', bondSats: 30000000n }];


const fromHexT = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
async function setUp({ tip = 250, seenSigner = null } = {}) {
  const DEP_HEIGHT = 200;
  const want = depositOutputsExpected(1000, SET);
  const config = Uint8Array.of(9, 9, 9);
  const body0 = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: DEP_HEIGHT + 8, proposer: ATTACKER.pubkey };
  const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body0) }]);
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: DEP_HEIGHT + 8, proposer: ATTACKER.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), ATTACKER.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  const txid = toHex(Uint8Array.from(p.depositTxid).reverse());
  const BLOCK = 'dd'.repeat(32);
  const votes = new Map([[202, [{ payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, seq: 1, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES, 1), ATTACKER.secret) }), height: 202, txid: 'a1' }]]]);
  const tipRef = { tip };
  let tally = null;
  const proposals = createProposals({ bindHeightFor: () => 0, confirmedTx: async (t, b) => (t === txid && b === BLOCK ? { raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} }, ...(seenSigner ? { seenSigner } : {}) });
  tally = createBallotTally({ proposals, tipHeight: async () => tipRef.tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  await tally.pass();
  assert.equal(configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 220, history: tally.spans(NETHEX) }).ok, true);
  tally.tipRef = tipRef;
  return { proposals, tally, hex, BLOCK, idBytes };
}

test('#2432 (1.9, bound) wf1489-a44-refute-99-s2-1: three colluding seats forge seenAt and the #1608 late-reveal attack passes again, retroactively', async () => {
  const { proposals, tally, hex, BLOCK } = await setUp();
  // THE REVEAL at tip 250 (voting 201..206 and activation 208 behind): on the bound reading taken at any time (#2012 (c))
  const got = await proposals.add({ proposal: hex, blockHash: BLOCK });
  console.log('  REVEAL at tip 250:', got.status, got.why || '');
  await tally.pass(); await tally.pass();
  const listed = tally.list()[0];
  const after = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 220, history: tally.spans(NETHEX) });
  console.log('  FORGED VOUCHES:', JSON.stringify({ counts: proposals.counts(got.id), phase: listed && listed.phase,
    tally: listed && listed.tally && { yes: String(listed.tally.yesSats), turnout: listed.tally.turnoutPct, passed: listed.tally.passed }, roundAt220OnGenesis: after }));
  assert.ok(!(listed && listed.tally && listed.tally.passed), 'a proposal nobody honest saw during its voting must not pass on the proposer\'s own vote because 3 of his seats say they saw it');
  assert.equal(after.ok, true, 'a round created at 220 under the config live then is still served');
});

test('#2432: the same late reveal counts once bonds holding a census majority signed that they held it before its voting ended', async () => {
  const { proposals, tally, hex, BLOCK, idBytes } = await setUp();
  await tally.pass();
  const got = await proposals.add({ proposal: hex, blockHash: BLOCK });
  assert.equal(proposals.counts(got.id), false, 'kept late: not counted on its own');
  assert.equal(tally.list()[0].phase, 'late');
  const id = toHex(idBytes);
  const sight = (k, at) => ({ by: toHex(k.pubkey), at, sig: toHex(schnorr.sign(seenMessage(id, at), k.secret)) });
  // the proposer's own sighting, one held after the voting (207), a forged signature, and H2 (30 of 65) alone: not a majority
  assert.equal(await proposals.vouch(id, { sightings: [sight(ATTACKER, 201), sight(H1, 207), { ...sight(H1, 203), sig: 'ab'.repeat(64) }, sight(H2, 203)] }), false);
  assert.equal(proposals.counts(id), false, 'counted on the proposer\'s own word, a late or forged sighting, or a minority');
  // H1 (35 of 65) signed it in time too: a majority - counted, relayed with its sightings
  assert.equal(await proposals.vouch(id, { sightings: [sight(H1, 204)] }), true);
  assert.equal(proposals.counts(id), true);
  assert.deepEqual(proposals.list()[0].sightings.map((x) => x.by).sort(), [toHex(H1.pubkey), toHex(H2.pubkey)].sort());
});

test('#2432: a seat that holds the proposal before its voting ends counts it and signs its own sighting', async () => {
  const signer = key(0x60);
  const { proposals, tally, hex, BLOCK } = await setUp({ tip: 203, seenSigner: { pubkey: signer.pubkey, sign: (m) => schnorr.sign(m, signer.secret) } });
  const got = await proposals.add({ proposal: hex, blockHash: BLOCK });
  assert.equal(got.status, 201);
  assert.equal(proposals.counts(got.id), true, 'held in time: counted');
  assert.equal(got.sightings.length, 1);
  assert.equal(verify(fromHexT(got.sightings[0].sig), seenMessage(got.id, 203), signer.pubkey), true);
  void tally;
});
