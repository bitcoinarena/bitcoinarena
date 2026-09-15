// THE CLAIM KEY IS THE COMMITTEE'S ONLY WITH ITS THRESHOLD OF SIGNER NODES
// (§23.1 step 0, v4.6.2, F3). Signed with real BIP-340 keys, so what is counted
// is signatures a signer node could actually produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../protocol/src/hash.js';
import {
  encodeClaimKeyAttestation, decodeClaimKeyAttestation, claimKeyAttestationId,
  claimKeyAttestationRef, claimKeyIsAttested,
} from '../../protocol/src/claim-key.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x0d);
const CLAIM = Uint8Array.from([0x02, ...b32(0x44)]);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x10 + i));
const signerNodes = secrets.map((s) => schnorr.getPublicKey(s));
const verify = (sig, digest, key) => schnorr.verify(sig, digest, key);
const signed = (i, claimPk = CLAIM, roundId = RID) => ({
  signerNodePubkey: signerNodes[i],
  signature: schnorr.sign(claimKeyAttestationId({ roundId, claimPk, signerNodePubkey: signerNodes[i] }), secrets[i]),
});

test('an attestation round-trips and names its signer node in the signed bytes', () => {
  const a = { roundId: RID, claimPk: CLAIM, signerNodePubkey: signerNodes[0] };
  assert.deepEqual(decodeClaimKeyAttestation(encodeClaimKeyAttestation(a)), a);
  assert.notDeepEqual(claimKeyAttestationId(a), claimKeyAttestationId({ ...a, signerNodePubkey: signerNodes[1] }));
  assert.throws(() => encodeClaimKeyAttestation({ ...a, claimPk: b32(0x44) }));
});

test('five of seven signer nodes make the key the round\'s; four do not', () => {
  const five = [0, 1, 2, 3, 4].map((i) => signed(i));
  const ok = claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: five, signerNodes, settlementSlots: 7, verify });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.needed, 5);
  const sorted = [...five].sort((a, b) => (toHex(a.signerNodePubkey) < toHex(b.signerNodePubkey) ? -1 : 1));
  assert.equal(toHex(ok.ref), toHex(claimKeyAttestationRef({ roundId: RID, claimPk: CLAIM, signatures: sorted })));

  const four = claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: five.slice(0, 4), signerNodes, settlementSlots: 7, verify });
  assert.equal(four.ok, false);
  assert.match(four.why, /4 of 7 signer nodes attest this claim key, and this round needs 5/);
});

test('a signer node\'s own key, a stranger, a repeat and a signature for another round count for nothing', () => {
  // ONE SIGNER NODE SERVING ITS OWN KEY - F3's attack - gets one signature, its own.
  const ownKey = Uint8Array.from([0x03, ...b32(0x66)]);
  assert.equal(claimKeyIsAttested({ roundId: RID, claimPk: ownKey, signatures: [signed(0, ownKey)],
    signerNodes, settlementSlots: 7, verify }).attested, 1);

  const stranger = b32(0x7e);
  const strangerSig = { signerNodePubkey: schnorr.getPublicKey(stranger),
    signature: schnorr.sign(claimKeyAttestationId({ roundId: RID, claimPk: CLAIM,
      signerNodePubkey: schnorr.getPublicKey(stranger) }), stranger) };
  const mixed = [signed(0), signed(0), signed(1), strangerSig, signed(2, CLAIM, b32(0x0e)), signed(3)];
  const out = claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: mixed, signerNodes, settlementSlots: 7, verify });
  assert.equal(out.attested, 3, 'a stranger, a repeat or another round\'s signature was counted');
  assert.equal(out.ok, false);
});

test('the threshold is the round\'s: two of two on a test net, and no caller-named number', () => {
  const two = signerNodes.slice(0, 2);
  const both = [signed(0), signed(1)];
  assert.equal(claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: both, signerNodes: two, settlementSlots: 2, verify }).ok, true);
  assert.match(claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: both.slice(0, 1), signerNodes: two, settlementSlots: 2, verify }).why,
    /1 of 2 signer nodes attest this claim key, and this round needs 2/);
  assert.match(claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: both, signerNodes: two, settlementSlots: 3, verify }).why,
    /no committee threshold for 3 slots/);
  assert.match(claimKeyIsAttested({ roundId: RID, claimPk: CLAIM, signatures: both, signerNodes: two, settlementSlots: 2 }).why,
    /needs a verifier/);
});
