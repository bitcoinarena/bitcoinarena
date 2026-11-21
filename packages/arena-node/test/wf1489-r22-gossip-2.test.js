// wf1489 r22: ONE SEAT'S GET /donation-ballots ANSWER IS PULLED BY EVERY SEAT (server.js pullDonationBallots, every 10 min). donationBallots.pull
// takes up to 512 items x 256 approvals each - repeats of the same proposal included - and add() runs a full ballots() read of the table and a
// secp256k1 verify for each one. Safe behaviour: what one peer answer costs is bounded by what an honest list can hold (one item per proposal,
// at most one approval per recipient of its parent set), not 131,072 verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDonationBallots } from '../src/donation-ballots.js';
import { encodeDonationProposal, donationProposalId, encodeDonationApproval } from '../../arena-protocol/src/donation-vote.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sk = (n) => { const b = new Uint8Array(32); b[31] = n; b[0] = 2; return b; };
const pk = (n) => secp256k1.getPublicKey(sk(n), true);
const NET = new Uint8Array(32).fill(5);
const ROOT = { networkId: NET, serial: 3n, validFrom: 100, recipients: [{ recipientPk: pk(1), shareBps: 6667, label: 'dev a' }, { recipientPk: pk(2), shareBps: 3333, label: 'dev b' }], signature: new Uint8Array(64) };

test('one peer\'s padded /donation-ballots list costs a bounded number of signature checks', async () => {
  let verifies = 0, realMs = 0, real = 0;
  const verifySecp256k1 = (s, d, k) => {
    verifies++;
    if (real < 500) { const t = performance.now(); let ok; try { ok = secp256k1.verify(s, d, k); } catch { ok = false; } realMs += performance.now() - t; real++; return ok; }
    return false;
  };
  const seat = createDonationBallots({ db: new DatabaseSync(':memory:'), knownSets: () => [ROOT], verifySecp256k1 });
  const p = { networkId: NET, serial: 4n, parentSetId: donationSetId(ROOT.recipients), proposer: pk(2), recipients: [{ recipientPk: pk(1), shareBps: 5000, label: 'a' }, { recipientPk: pk(2), shareBps: 5000, label: 'b' }] };
  const hex = toHex(encodeDonationProposal(p)) + toHex(secp256k1.sign(donationProposalId(p), sk(2)));
  assert.equal((await seat.add('proposal', hex)).ok, true);
  verifies = 0;
  // junk approvals in dev a's name (a recipient of the parent), each a different height, the signature made up
  const junk = Array.from({ length: 256 }, (_, i) => toHex(encodeDonationApproval({ proposalId: donationProposalId(p), atHeight: 1000 + i, accept: false, signer: pk(1) })) + '11'.repeat(64));
  const list = Array.from({ length: 512 }, () => ({ hex, serial: '4', approvals: junk }));
  const t0 = performance.now();
  await seat.pull(list);
  const ms = performance.now() - t0;
  const perVerify = realMs / Math.max(1, real);
  assert.ok(verifies <= 4096, `one peer answer cost ${verifies} secp256k1 verifies (${Math.round(ms)} ms here with ${real} real ones; at ${perVerify.toFixed(2)} ms a real verify, ~${Math.round(verifies * perVerify / 1000)} s of the seat's loop each pull)`);
});
