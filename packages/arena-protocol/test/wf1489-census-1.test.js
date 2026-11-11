// kanban #1489: a vote payload is not bound to its transaction, so ANYONE can copy a bond's old vote into a new transaction at a
// later height and it becomes that bond's "last vote" - the operator's change of mind is undone by a stranger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { proposalBodyId, proposalStands, encodeVote, voteMessage, tally, CLASS, CHOICE, SCHEDULES, configHashOf } from '../src/ballot.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const b32 = (n) => new Uint8Array(32).fill(n);

test('a replayed copy of a bond\'s earlier vote does not overwrite the vote the bond key cast last', () => {
  const proposer = key(1);
  const p0 = { networkId: b32(0x4e), parent: b32(0x10), configHash: configHashOf(Uint8Array.of(1)), config: Uint8Array.of(1),
    class: CLASS.DESIGN, activationHeight: 108, proposer: proposer.pubkey, depositTxid: b32(0x30) };
  const p = { ...p0, signature: schnorr.sign(proposalBodyId(p0), proposer.secret) };
  const standing = proposalStands(p, { publishedAt: 100, depositSats: 500, lowestBondMinSats: 50000, schedule: SCHEDULES.regtest, verify });
  assert.equal(standing.ok, true, standing.why);
  const big = key(5), small = key(6);
  const census = [{ pubkey: big.pubkey, outpoint: 'aa:0', bondSats: 60n }, { pubkey: small.pubkey, outpoint: 'bb:0', bondSats: 40n }];
  const vote = (k, choice) => encodeVote({ proposalId: standing.id, choice, signature: schnorr.sign(voteMessage(standing.id, choice), k.secret) });
  const yesBig = vote(big, CHOICE.YES);
  const votes = [
    { payload: yesBig, height: 101, txid: '01'.repeat(32) },               // the big bond votes YES ...
    { payload: vote(big, CHOICE.NO), height: 103, txid: '02'.repeat(32) }, // ... and changes its mind: NO, its last vote
    { payload: vote(small, CHOICE.YES), height: 103, txid: '03'.repeat(32) },
    // the attacker (no bond, no key) copies the big bond's old YES bytes into his own transaction in the last voting block
    { payload: yesBig, height: 106, txid: 'ff'.repeat(32) },
  ];
  const t = tally({ proposal: { class: CLASS.DESIGN }, standing, census, votes, verify });
  console.log('  TALLY:', JSON.stringify({ yes: String(t.yesSats), no: String(t.noSats), passed: t.passed }));
  assert.equal(t.noSats, 60n, 'the big bond\'s last own vote was NO');
  assert.equal(t.passed, false, 'a stranger replaying old vote bytes must not pass the proposal');
});
