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

// OPEN (kanban #1668, #1734): no tally rule over the §27A.7.3 bytes can tell a mempool-only YES mined late by a stranger from the
// bond's own later vote - the signature covers H(proposal_id || choice) only. Closing it binds the vote to the bond holder (a signed
// sequence number, or a vote tx spending a bond-tied key): a protocol change that needs a spec ticket. Kept as todo until then.
test('a vote replaced by RBF before it was mined cannot be mined later by a stranger to undo the replacement', { todo: 'protocol change, spec 27A.7.3 (kanban #1734)' }, () => {
  const proposer = key(1);
  const p0 = { networkId: b32(0x4e), parent: b32(0x10), configHash: configHashOf(Uint8Array.of(1)), config: Uint8Array.of(1),
    class: CLASS.DESIGN, activationHeight: 108, proposer: proposer.pubkey, depositTxid: b32(0x30) };
  const p = { ...p0, signature: schnorr.sign(proposalBodyId(p0), proposer.secret) };
  const standing = proposalStands(p, { publishedAt: 100, depositSats: 500, lowestBondMinSats: 50000, schedule: SCHEDULES.regtest, verify });
  assert.equal(standing.ok, true, standing.why);
  const big = key(5), small = key(6);
  const census = [{ pubkey: big.pubkey, outpoint: 'aa:0', bondSats: 60n }, { pubkey: small.pubkey, outpoint: 'bb:0', bondSats: 40n }];
  const vote = (k, choice) => encodeVote({ proposalId: standing.id, choice, signature: schnorr.sign(voteMessage(standing.id, choice), k.secret) });
  const yesBigNeverMined = vote(big, CHOICE.YES);  // broadcast, then replaced by RBF (same input) with the NO below
  const votes = [
    { payload: vote(big, CHOICE.NO), height: 103, txid: '02'.repeat(32) },     // the replacement: the big bond's only mined vote
    { payload: vote(small, CHOICE.YES), height: 103, txid: '03'.repeat(32) },
    { payload: yesBigNeverMined, height: 105, txid: 'ff'.repeat(32) },          // stranger mines the replaced bytes later
  ];
  const t = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify });
  console.log('  TALLY:', JSON.stringify({ yes: String(t.yesSats), no: String(t.noSats), passed: t.passed }));
  assert.equal(t.noSats, 60n, 'the big bond\'s last own (mined) vote was NO');
  assert.equal(t.passed, false);
});
