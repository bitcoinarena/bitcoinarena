// kanban #1489 #1668 #1734 refute (fix:census:1, 74ec37bcd): the fix keeps the FIRST ON-CHAIN occurrence of identical bytes. Vote bytes
// that were broadcast but never mined (the operator replaced its YES by RBF with a NO before a block took it - the normal way to
// change one's mind before confirmation; the vote door answers bytes, the operator's wallet sends them) have no earlier
// occurrence: a stranger who saw them in the mempool mines them after the NO, and they become the bond's "last vote".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { proposalBodyId, proposalStands, encodeVote, voteMessage, tally, CLASS, CHOICE, SCHEDULES, configHashOf } from '../src/ballot.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const b32 = (n) => new Uint8Array(32).fill(n);

// CLOSED BY THE BINDING (ruled 2026-11-12, kanban #2125, built #2562): the bond key signs H(proposal_id || choice || seq) and the
// highest seq mined inside the phase counts - the replaced YES (seq 1) loses to the NO (seq 2) in whatever block it lands. Below
// BALLOT_BIND_HEIGHT the old reading stands byte for byte, hole included (the second test shows it).
function fixture() {
  const proposer = key(1);
  const p0 = { networkId: b32(0x4e), parent: b32(0x10), configHash: configHashOf(Uint8Array.of(1)), config: Uint8Array.of(1),
    class: CLASS.DESIGN, activationHeight: 108, proposer: proposer.pubkey, depositTxid: b32(0x30) };
  const p = { ...p0, signature: schnorr.sign(proposalBodyId(p0), proposer.secret) };
  const standing = proposalStands(p, { publishedAt: 100, depositSats: 500, lowestBondMinSats: 50000, schedule: SCHEDULES.regtest, verify });
  assert.equal(standing.ok, true, standing.why);
  const big = key(5), small = key(6);
  const census = [{ pubkey: big.pubkey, outpoint: 'aa:0', bondSats: 60n }, { pubkey: small.pubkey, outpoint: 'bb:0', bondSats: 40n }];
  const vote = (k, choice, seq = null) => encodeVote({ proposalId: standing.id, choice, seq, signature: schnorr.sign(voteMessage(standing.id, choice, seq), k.secret) });
  return { standing, census, vote, big, small };
}
test('a vote replaced by RBF before it was mined cannot be mined later by a stranger to undo the replacement (bound: highest seq wins, kanban #1734 #2125)', () => {
  const { standing, census, vote, big, small } = fixture();
  const yesBigNeverMined = vote(big, CHOICE.YES, 1);  // broadcast, then replaced by RBF (same input) with the NO below
  const votes = [
    { payload: vote(big, CHOICE.NO, 2), height: 103, txid: '02'.repeat(32) },     // the replacement: the big bond's only mined vote
    { payload: vote(small, CHOICE.YES, 1), height: 103, txid: '03'.repeat(32) },
    { payload: yesBigNeverMined, height: 105, txid: 'ff'.repeat(32) },             // stranger mines the replaced bytes later
  ];
  const t = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify, bound: true });
  console.log('  TALLY (bound):', JSON.stringify({ yes: String(t.yesSats), no: String(t.noSats), passed: t.passed }));
  assert.equal(t.noSats, 60n, 'the big bond\'s last own (mined) vote was NO');
  assert.equal(t.passed, false);
});
test('below the gate the old reading stands byte for byte: the 77-byte votes, last by height (the residual #1734 named)', () => {
  const { standing, census, vote, big, small } = fixture();
  const votes = [
    { payload: vote(big, CHOICE.NO), height: 103, txid: '02'.repeat(32) },
    { payload: vote(small, CHOICE.YES), height: 103, txid: '03'.repeat(32) },
    { payload: vote(big, CHOICE.YES), height: 105, txid: 'ff'.repeat(32) },
    { payload: vote(big, CHOICE.NO, 9), height: 106, txid: 'ee'.repeat(32) },      // a bound vote: not read under the old reading
  ];
  const t = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify });
  console.log('  TALLY (old reading):', JSON.stringify({ yes: String(t.yesSats), no: String(t.noSats), passed: t.passed }));
  assert.equal(t.yesSats, 100n); assert.equal(t.passed, true);
  // and the bound reading ignores the 77-byte votes
  const tb = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify, bound: true });
  assert.equal(tb.bondsVoted, 1); assert.equal(tb.noSats, 60n);
});
test('bound: two votes of one bond with the same seq and different choices count as ABSTAIN; the same seq and choice twice is one vote', () => {
  const { standing, census, vote, big, small } = fixture();
  const votes = [
    { payload: vote(big, CHOICE.YES, 7), height: 101, txid: '01'.repeat(32) },
    { payload: vote(big, CHOICE.NO, 7), height: 104, txid: '04'.repeat(32) },
    { payload: vote(big, CHOICE.YES, 6), height: 106, txid: '06'.repeat(32) },     // a lower seq later: does not count
    { payload: vote(small, CHOICE.YES, 3), height: 102, txid: '02'.repeat(32) },
    { payload: vote(small, CHOICE.YES, 3), height: 105, txid: '05'.repeat(32) },   // the same seq and choice again (a re-sign)
    { payload: vote(small, CHOICE.NO, 4), height: 107, txid: '07'.repeat(32) },    // outside [101, 107): not counted
  ];
  const t = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify, bound: true });
  assert.equal(t.abstainSats, 60n, 'the big bond signed YES and NO under seq 7');
  assert.equal(t.yesSats, 40n); assert.equal(t.noSats, 0n); assert.equal(t.bondsVoted, 2);
});
