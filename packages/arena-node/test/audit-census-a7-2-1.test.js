// Audit census r2 (a7-2-1): POST /funding { kind: 'fee-approval' } keeps any self-signed "protocol developer's answer" to a fee proposal
// the seat holds - the `dev` key is the signer's own, never checked against the developers' keys, and nothing bounds how many are kept
// (#2522 / #2722 bound proposals per author and unsignalled in total; approvals have neither). Every fresh one is forwarded to every seat
// (server.js POST /funding, kanban #2431). And GET /fees -> feeList re-reads every approval of every fee row, a BIP-340 check each, on
// every public request (approvalsOf; the #3317 fix caches the fee rows only). A stranger posts N approvals under N fresh keys to one
// public fee proposal: each GET /fees then costs N signature checks on every seat's thread, for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeFeeProposal, feeProposalId, encodeFeeApproval, feeApprovalId } from '../../arena-protocol/src/fee-proposal.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const S = FUNDING_SCHEDULES.short;
const sk = (n) => { const b = new Uint8Array(32); b[0] = 5; b[30] = (n >> 8) & 0xff; b[31] = n & 0xff; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const FP = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, activationHeight: 100 + S.signal + S.vote + S.decideDepth + 10,
  changes: [{ fee: 'roundNodeBps', value: 350 }, { fee: 'roundDonationBps', value: 450 }], purpose: 'a donation change: the developers answer it' };
const ID = feeProposalId(FP);
const DEVS = [30, 31, 32];

test('a stranger\'s self-signed fee approvals under fresh keys are not kept without bound, and GET /fees does not re-verify each on every read', async () => {
  let checks = 0;
  const verify = (s, m, k) => { checks++; return schnorr.verify(s, m, k); };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => 100, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), devKeysOf: async () => DEVS.map((n) => toHex(pk(n))) });
  const fk = await b.add('fee', hexOf(encodeFeeProposal(FP), ID, 1));
  assert.equal(fk.ok, true, fk.why);

  // the stranger: 600 approvals, each under its own fresh key (none of them a developer's)
  const N = 600;
  let kept = 0;
  for (let i = 0; i < N; i++) {
    const a = { proposalId: ID, dev: pk(1000 + i), approve: i % 2 === 0 };
    const r = await b.add('fee-approval', hexOf(encodeFeeApproval(a), feeApprovalId(a), 1000 + i));
    if (r.ok && r.fresh) kept++;
  }

  checks = 0;
  const list = b.feeList(100);             // what one public GET /fees runs
  const perRead = checks;
  const shown = list.find((x) => x.id === toHex(ID));
  assert.ok(shown, 'the fee proposal is listed');
  assert.ok(kept <= 64 && perRead <= 64,
    `a stranger's ${N} fresh-key approvals (no developer key among them): ${kept} kept and forwarded, `
    + `${shown.devs.length} shown as the developers' answers, and ONE GET /fees ran ${perRead} BIP-340 checks`);
});

test('the developers\' own approvals are still kept and shown, checked once at add and never again per GET /fees; unread keys refuse (503)', async () => {
  let checks = 0;
  const verify = (s, m, k) => { checks++; return schnorr.verify(s, m, k); };
  let keys = null;
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => 100, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), devKeysOf: async () => keys });
  assert.equal((await b.add('fee', hexOf(encodeFeeProposal(FP), ID, 1))).ok, true);
  const answer = (n, approve) => { const a = { proposalId: ID, dev: pk(n), approve }; return hexOf(encodeFeeApproval(a), feeApprovalId(a), n); };
  const early = await b.add('fee-approval', answer(30, true));
  assert.equal(early.ok, false); assert.equal(early.status, 503, 'the developers\' keys not read yet: nothing kept');
  keys = DEVS.map((n) => toHex(pk(n)));
  for (const n of DEVS) assert.equal((await b.add('fee-approval', answer(n, true))).fresh, true, `developer ${n}'s yes is kept`);
  assert.equal((await b.add('fee-approval', answer(31, false))).fresh, true, 'a developer\'s no is kept beside its yes (a no stands over a yes)');
  const stranger = await b.add('fee-approval', answer(77, true));
  assert.equal(stranger.ok, false); assert.equal(stranger.status, 422);
  checks = 0;
  for (let i = 0; i < 5; i++) b.feeList(100);
  const shown = b.feeList(100).find((x) => x.id === toHex(ID));
  assert.equal(shown.devs.length, 4);
  assert.deepEqual(b.devMajorityOf(toHex(ID), keys), { yes: 2, no: 1, of: 3, majority: true });
  assert.ok(checks <= 6 * 2 + 1, `six GET /fees and one majority ran ${checks} signature checks: none of them on an approval`);
});
