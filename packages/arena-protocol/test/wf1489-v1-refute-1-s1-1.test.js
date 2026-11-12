// kanban #1489 #1668 #1734 refute (fix:census:1, 74ec37bcd): the replayed-vote fix went into ballot.js tally() only. fundingTally
// (funding.js, §27A.9.3 stage 2 - the bond-weighted vote that releases funding money, used by arena-node funding-book.js)
// reads the SAME "ARN" 'V' payloads under the SAME signature H(proposal_id || choice) and the same last-vote rule, without the
// dedupe: a stranger copies a bond's old YES bytes into a later transaction and undoes the bond's final NO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { fundingTally, votePeriodOf, fundingProposalId } from '../src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../src/ballot.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 2; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay' };
const ID = fundingProposalId(P);
const bond = (n, bondSats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(bondSats) });
const period = votePeriodOf({ proposal: P, signal: { state: 'passed' } });

test('fundingTally: a replayed copy of a bond\'s earlier YES does not overwrite its final NO', () => {
  const sign = (n, c) => encodeVote({ proposalId: ID, choice: c, signature: schnorr.sign(voteMessage(ID, c), sk(n)) });
  const yesBig = sign(5, CHOICE.YES);
  const votes = [
    { payload: yesBig, height: period.from + 1, txid: '01'.repeat(32) },            // big bond: YES ...
    { payload: sign(5, CHOICE.NO), height: period.from + 3, txid: '02'.repeat(32) },  // ... then NO, its last own vote
    { payload: sign(6, CHOICE.YES), height: period.from + 3, txid: '03'.repeat(32) },
    { payload: yesBig, height: period.from + 9, txid: 'ff'.repeat(32) },            // stranger replays the old YES bytes
  ];
  const t = fundingTally({ proposalId: ID, census: [bond(5, 6000), bond(6, 4000)], votes, from: period.from, until: period.until, verify });
  console.log('  FUNDING TALLY:', JSON.stringify({ yes: t.yesSats, no: t.noSats, passed: t.passed }));
  assert.equal(t.noSats, '6000', 'the big bond\'s last own vote was NO');
  assert.equal(t.passed, false, 'a stranger replaying old vote bytes must not pass the funding proposal');
});
