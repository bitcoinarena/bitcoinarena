// THE DEALERLESS GROUP KEY - dkg.js on its own (kanban #145; plan comment 177, Go 2026-10-05). dkg.test.js beside this one
// measures the wire shapes with no curve; until now the rest ran only inside blwp-node's integration tests (57.9% of dkg.js
// from protocol's own suite). Here, on the daemons' curve (blwp-node/src/curve.js): fixed vectors, the proof of knowledge,
// every refusal of accept/open/combine/groupKeyOf by name, the group secret rebuilt from any five combined shares, the
// odd-Y negation, and the agreement. The agreement's signature check is injected, as everywhere in dkg.js; here it is a
// keyed hash, because agreementHolds is measured, not the signature scheme.
//
// Measured before this file, on dkg.js as it stood: dealContribution with an ephemeral public key that is not the point of
// the ephemeral secret returned ok and acceptContribution took it, yet no signer node could open its share (the handout
// hole again - a dealer stalls the key unrefused); openMyContribution on a contribution with no shares list threw
// "Cannot read properties of undefined (reading 'find')"; groupKeyOf over a set with a contribution lacking commitments
// threw "Cannot read properties of undefined (reading '0')".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  epochId, encodeContribution, decodeContribution, contributionId, dealContribution, acceptContribution, openMyContribution,
  groupKeyOf, combineShares, proveKnowledge, knowledgeIsProven, contributionSetOf, encodeAgreement, decodeAgreement,
  agreementId, splitSignedAgreement, agreementHolds, PROOF_BYTES, AGREEMENT_SIGNATURE_BYTES,
} from '../src/dkg.js';
import { reconstruct, scalarFrom32, FIELD } from '../src/shares.js';
import * as curve from '../../blwp-node/src/curve.js';

const KEYS = Array.from({ length: 7 }, (_, i) => new Uint8Array(32).fill(i + 11));   // signer nodes 1..7
const PUBS = KEYS.map((k) => curve.pointX(k));
const EPOCH = epochId(PUBS);
const V = {
  epoch: '3f71e91286632aebb842bcc7ec1bbe61155b6929e04ee3cd302d0a2e9045fd99',
  contribution1: 'd4b4a59db5f35ae90e9e4c734bc71e0d4790c3d8d7948200d27ac81c229d6e66',
  group: '02495841adce0b5e7008a87904f7a86ad4878a59a0564db012f58b8c66dbda0ebe',
  agreement: '084951e888639a8fe36d5848d99e6ccc0bf29df005403515235e19d509cd749d',
  oddGroup: '02f1091a5f7ee953bfa274d366675a97a8c78407f7b2edfe6c60c91eae11947153',
};
const hex = (b) => Buffer.from(b).toString('hex');
const mod = (v) => ((v % FIELD) + FIELD) % FIELD;
const eph = (i) => new Uint8Array(32).fill(0x60 + i);
const deal = (i, base = 0x40, o = {}) => dealContribution({ secret: new Uint8Array(32).fill(base + i), signerNodes: PUBS, epochId: EPOCH,
  from: PUBS[i], ephemeralSecret: eph(i), ephemeralPubkey: curve.pointX(eph(i)), coefficients: [1n + BigInt(i), 2n, 3n, 4n], curve, ...o });
async function dealAll(base = 0x40) {
  const cs = [];
  for (let i = 0; i < 7; i++) { const d = await deal(i, base); assert.equal(d.ok, true, d.why); cs.push(d.contribution); }
  return cs;
}
const groupSecretOf = (base) => mod(Array.from({ length: 7 }, (_, i) => scalarFrom32(new Uint8Array(32).fill(base + i))).reduce((a, b) => a + b, 0n));
const opener = (i) => ({ pubkey: PUBS[i], secret: KEYS[i], curve });
async function combinedFor(cs, i) {
  const opened = [];
  for (const c of cs) { const o = await openMyContribution(c, opener(i)); assert.equal(o.ok, true, o.why); opened.push(o); }
  return opened;
}

// THE FIRST CHECK (plan 177): a dealer key pair that does not match is refused when dealt.
test('dealContribution refuses an ephemeral public key that is not the point of the ephemeral secret, naming it', async () => {
  const wrong = curve.pointX(new Uint8Array(32).fill(0x7f));
  const got = await deal(0, 0x40, { ephemeralPubkey: wrong });
  assert.equal(got.ok, false, 'a contribution no signer node can open was dealt');
  assert.match(got.why, new RegExp(hex(wrong).slice(0, 16)), 'the refusal does not name the key');
  assert.equal(got.contribution, undefined);
});

test('fixed vectors: the epoch, contribution 1, the group key and an agreement are pinned, and equal on a second run', async () => {
  assert.equal(hex(EPOCH), V.epoch);
  assert.equal(hex(epochId([...PUBS].reverse())), V.epoch, 'the epoch depends on the order of the committee');
  const a = await dealAll(), b = await dealAll();
  assert.equal(hex(contributionId(a[0])), V.contribution1);
  assert.equal(hex(contributionId(b[0])), V.contribution1, 'a second deal of the same inputs differs');
  assert.equal(hex(groupKeyOf(a, curve).groupPublicKey), V.group);
  assert.equal(hex(groupKeyOf(b, curve).groupPublicKey), V.group);
  assert.equal(hex(agreementId({ epochId: EPOCH, signerNode: PUBS[0], held: contributionSetOf(a) })), V.agreement);
});

test('epochId refuses an empty committee, a short key and two nodes on one key', () => {
  assert.throws(() => epochId([]), { message: 'an epoch is a committee, and that is nobody' });
  assert.throws(() => epochId(undefined), { message: 'an epoch is a committee, and that is nobody' });
  assert.throws(() => epochId([PUBS[0].subarray(0, 31)]), { message: 'a signer node is a 32-byte key' });
  assert.throws(() => epochId([PUBS[0], PUBS[1], PUBS[0]]), { message: 'two signer nodes of that committee are one key' });
});

test('encode/decode keeps the contribution id; a trailing byte, another type or version is refused', async () => {
  const [c] = await dealAll();
  const bytes = encodeContribution(c);
  assert.deepEqual(decodeContribution(bytes), c);
  assert.equal(hex(contributionId(decodeContribution(bytes))), V.contribution1);
  const flip = (at) => { const x = Uint8Array.from(bytes); x[at] ^= 1; return x; };
  assert.throws(() => decodeContribution(Uint8Array.from([...bytes, 0])), /trailing bytes/);
  assert.throws(() => decodeContribution(flip(0)), /not a DkgContribution/);
  assert.throws(() => decodeContribution(flip(2)), /protocol version/);
});

test('the proof of knowledge verifies for every dealer and is refused by name when bent', async () => {
  const cs = await dealAll();
  for (let i = 0; i < 7; i++)
    assert.deepEqual(knowledgeIsProven({ id: i + 1, commitment: cs[i].commitments[0], proof: cs[i].proof, curve }), { ok: true });
  const c = cs[0];
  const bad = /signer node \d+'s proof of knowledge does not verify/;
  const flipped = Uint8Array.from(c.proof); flipped[40] ^= 1;
  assert.match(knowledgeIsProven({ id: 1, commitment: c.commitments[0], proof: flipped, curve }).why, bad);
  assert.match(knowledgeIsProven({ id: 2, commitment: c.commitments[0], proof: c.proof, curve }).why, bad, 'a proof under another id verified');
  const muZero = Uint8Array.from(c.proof); muZero.fill(0, 32);
  assert.match(knowledgeIsProven({ id: 1, commitment: c.commitments[0], proof: muZero, curve }).why, bad);
  const notAPoint = Uint8Array.from(c.proof); notAPoint.fill(0xff, 0, 32);
  assert.match(knowledgeIsProven({ id: 1, commitment: c.commitments[0], proof: notAPoint, curve }).why, bad);
  assert.deepEqual(knowledgeIsProven({ id: 1, commitment: c.commitments[0], proof: c.proof.subarray(0, 63), curve }),
    { ok: false, why: 'that contribution carries no 64-byte proof of knowledge' });
  assert.deepEqual(knowledgeIsProven({ id: 1, commitment: c.commitments[0], proof: c.proof }),
    { ok: false, why: 'checking a proof of knowledge needs a curve, and none was injected' });
  assert.equal(c.proof.length, PROOF_BYTES);
  assert.throws(() => proveKnowledge({ id: 1, secret: 5n, commitment: curve.pointFromScalar(5n), nonce: 0n, curve }),
    { message: 'a proof nonce of zero proves nothing' });
  // an odd nonce point is flipped to the even one, and the proof still verifies
  for (const nonce of [3n, 4n, 5n, 6n]) {
    const proof = proveKnowledge({ id: 3, secret: 9n, commitment: curve.pointFromScalar(9n), nonce, curve });
    assert.deepEqual(knowledgeIsProven({ id: 3, commitment: curve.pointFromScalar(9n), proof, curve }), { ok: true });
  }
});

test('dealContribution refuses by name: too few nodes, no curve, no epoch, no dealer, a dealer off the committee, a bad secret', async () => {
  assert.deepEqual(await deal(0, 0x40, { signerNodes: PUBS.slice(0, 4) }), { ok: false, why: 'a threshold of 5 cannot be dealt to 4 signer nodes' });
  assert.deepEqual(await deal(0, 0x40, { signerNodes: undefined }), { ok: false, why: 'a threshold of 5 cannot be dealt to 0 signer nodes' });
  assert.deepEqual(await deal(0, 0x40, { curve: undefined }), { ok: false, why: 'dealing needs a curve, and none was injected' });
  assert.deepEqual(await deal(0, 0x40, { epochId: EPOCH.subarray(0, 31) }), { ok: false, why: 'a contribution names the epoch it belongs to' });
  assert.deepEqual(await deal(0, 0x40, { from: undefined }), { ok: false, why: 'a contribution names the signer node that dealt it' });
  assert.deepEqual(await deal(0, 0x40, { from: curve.pointX(new Uint8Array(32).fill(0x55)) }),
    { ok: false, why: 'that signer node is not on the committee it is dealing to' });
  assert.deepEqual(await deal(0, 0x40, { coefficients: [1n, 2n] }), { ok: false, why: 'a threshold of 5 needs 4 coefficients' });
  assert.deepEqual(await deal(0, 0x40, { secret: new Uint8Array(32).fill(0xff) }), { ok: false,
    why: 'that preimage is not below the group order: generate another, because reducing it would change the number its payment hash commits to' });
});

test('acceptContribution takes each deal and refuses each malformed one by name', async () => {
  const cs = await dealAll();
  const c = cs[0];
  assert.deepEqual(acceptContribution(c, { curve }), { ok: true, why: '7 sealed shares, threshold 5' });
  const no = (x, why) => assert.deepEqual(acceptContribution(x, { curve }), { ok: false, why });
  no(undefined, 'a contribution of no shares is not a contribution');
  no({ ...c, shares: [] }, 'a contribution of no shares is not a contribution');
  no({ ...c, commitments: [] }, 'a contribution that publishes no polynomial cannot be checked');
  no({ ...c, needed: 4 }, 'a threshold of 4 is a polynomial of 4 coefficients, and this contribution publishes 5');
  no({ ...c, shares: c.shares.slice(0, 4) }, '4 shares cannot carry a threshold of 5');
  no({ ...c, shares: c.shares.map((s, i) => (i === 1 ? { ...s, signerNode: 0 } : s)) }, 'a share of signer node zero is a share of the secret itself');
  no({ ...c, shares: c.shares.map((s, i) => (i === 1 ? { ...s, signerNode: 1 } : s)) }, 'two shares for signer node 1 are one share');
  no({ ...c, shares: c.shares.map((s, i) => (i === 2 ? { ...s, signerNodePubkey: s.signerNodePubkey.subarray(0, 31) } : s)) }, 'signer node 3 is not addressed to a key');
  no({ ...c, shares: c.shares.map((s, i) => (i === 3 ? { ...s, sealed: s.sealed.subarray(0, 47) } : s)) }, 'signer node 4\'s envelope is not a sealed share');
  no({ ...c, shares: c.shares.map((s, i) => (i === 4 ? { ...s, signerNodePubkey: PUBS[1] } : s)) }, 'two signer nodes of that contribution are one key');
  no({ ...c, from: curve.pointX(new Uint8Array(32).fill(0x55)) }, 'that signer node dealt to a committee it is not on');
  const flipped = Uint8Array.from(c.proof); flipped[40] ^= 1;
  assert.match(acceptContribution({ ...c, proof: flipped }, { curve }).why, /proof of knowledge does not verify/);
  assert.deepEqual(acceptContribution(c), { ok: false, why: 'checking a proof of knowledge needs a curve, and none was injected' });
});

test('openMyContribution: every node opens every deal; refused by name otherwise', async () => {
  const cs = await dealAll();
  for (let i = 0; i < 7; i++) for (const c of cs) {
    const got = await openMyContribution(c, opener(i));
    assert.equal(got.ok, true, got.why);
    assert.equal(got.signerNode, i + 1);
  }
  const c = cs[0];
  const stranger = new Uint8Array(32).fill(0x44);
  assert.deepEqual(await openMyContribution(c, { pubkey: curve.pointX(stranger), secret: stranger, curve }),
    { ok: false, why: 'this node is not one of the signer nodes that contribution was dealt to' });
  assert.deepEqual(await openMyContribution(c, { ...opener(0), pubkey: PUBS[0].subarray(0, 31) }),
    { ok: false, why: 'a signer node opens a share with its own 32-byte key, and that is not one' });
  assert.deepEqual(await openMyContribution(c, { ...opener(0), secret: KEYS[1] }),
    { ok: false, why: 'signer node 1\'s share does not open under this key: it was sealed to somebody else' });
  // A CROOKED POLYNOMIAL: node 2's envelope from another dealer's deal (same ephemeral key) does not lie on these commitments
  const other = await deal(0, 0x50);
  const crooked = { ...c, shares: c.shares.map((s, i) => (i === 1 ? other.contribution.shares[1] : s)) };
  assert.deepEqual(await openMyContribution(crooked, opener(1)), { ok: false,
    why: 'signer node 2 was handed a share that is not on the polynomial the dealer published - that signer node dealt a crooked polynomial' });
  const flipped = Uint8Array.from(c.proof); flipped[40] ^= 1;
  assert.match((await openMyContribution({ ...c, proof: flipped }, opener(1))).why, /proof of knowledge does not verify/);
  // no shares list: refused by name, not a TypeError
  const none = await openMyContribution({ ...c, shares: undefined }, opener(1));
  assert.equal(none.ok, false);
  assert.match(none.why, /no shares/);
  assert.deepEqual(await openMyContribution(undefined, opener(1)), none);
});

test('combineShares: any 5 combined shares rebuild the group secret, whose point is the group key - even and odd Y', async () => {
  for (const [base, key, negated] of [[0x40, V.group, false], [0x42, V.oddGroup, true]]) {
    const cs = await dealAll(base);
    const g = groupKeyOf(cs, curve);
    assert.deepEqual({ key: hex(g.groupPublicKey), negated: g.negated }, { key, negated });
    assert.equal(g.summed[0], negated ? 0x03 : 0x02);
    const shares = [];
    for (let i = 0; i < 7; i++) {
      const got = combineShares({ opened: await combinedFor(cs, i), signerNodes: PUBS, contributions: cs, curve });
      assert.equal(got.ok, true, got.why);
      assert.deepEqual({ node: got.signerNode, key: hex(got.groupPublicKey), negated: got.negated }, { node: i + 1, key, negated });
      shares.push({ signerNode: got.signerNode, value: got.share });
    }
    const secret = negated ? mod(FIELD - groupSecretOf(base)) : groupSecretOf(base);
    assert.equal(hex(curve.pointFromScalar(secret)), key, 'the group key is not the point of the summed secrets');
    for (const five of [[0, 1, 2, 3, 4], [2, 3, 4, 5, 6], [6, 0, 3, 1, 5]])
      assert.equal(scalarFrom32(reconstruct(five.map((i) => shares[i]))), secret);
  }
});

test('combineShares refuses by name: nothing opened, no committee, a subset, one dealer twice, one missing, a partial open, mixed numbers, a non-share, zero, a bad proof', async () => {
  const cs = await dealAll();
  const opened = await combinedFor(cs, 2);
  const no = (o, why) => assert.deepEqual(combineShares({ opened, signerNodes: PUBS, contributions: cs, curve, ...o }), { ok: false, why });
  no({ opened: [] }, 'this signer node opened nothing, so it has no share');
  no({ signerNodes: [] }, 'a combine needs the committee it is over');
  no({ contributions: cs.slice(0, 6) }, '6 of the committee\'s 7 signer nodes contributed, and a key a subset chose is a key that subset can steer');
  no({ contributions: undefined }, '0 of the committee\'s 7 signer nodes contributed, and a key a subset chose is a key that subset can steer');
  no({ contributions: [...cs.slice(0, 6), cs[0]] }, 'one signer node contributed twice, so it dealt after seeing the others');
  const outsider = { ...cs[6], from: curve.pointX(new Uint8Array(32).fill(0x55)) };
  no({ contributions: [...cs.slice(0, 6), outsider] }, `signer node ${hex(PUBS[6]).slice(0, 16)} contributed nothing`);
  no({ opened: opened.slice(0, 6) }, 'this signer node opened 6 of 7 contributions, so its share would be a sum of some of them');
  no({ opened: opened.map((o, i) => (i === 0 ? { ...o, signerNode: 4 } : o)) }, 'this signer node was dealt different signer node numbers by different dealers');
  no({ opened: opened.map((o, i) => (i === 0 ? { ...o, share: null } : o)) }, 'one of those is not an opened share');
  const zero = opened.map((o, i) => ({ ...o, share: { signerNode: 3, value: i === 0 ? FIELD - 6n : 1n } }));
  no({ opened: zero }, 'this signer node\'s share summed to zero, which is no share at all');
  const flipped = Uint8Array.from(cs[3].proof); flipped[40] ^= 1;
  assert.match(combineShares({ opened, signerNodes: PUBS, contributions: cs.map((c, i) => (i === 3 ? { ...c, proof: flipped } : c)), curve }).why,
    /proof of knowledge does not verify/);
  // without a curve the sum is handed back un-normalised, with no key
  const bare = combineShares({ opened, signerNodes: PUBS, contributions: cs });
  assert.deepEqual(Object.keys(bare).sort(), ['ok', 'share', 'signerNode']);
});

test('groupKeyOf refuses by name: no contributions, no curve, a contribution without its first commitment', async () => {
  const cs = await dealAll();
  assert.deepEqual(groupKeyOf([], curve), { ok: false, why: 'no contributions, so there is no key to compute' });
  assert.deepEqual(groupKeyOf(undefined, curve), { ok: false, why: 'no contributions, so there is no key to compute' });
  assert.deepEqual(groupKeyOf(cs), { ok: false, why: 'summing commitments needs a curve, and none was injected' });
  const got = groupKeyOf([cs[0], { ...cs[1], commitments: undefined }], curve);
  assert.equal(got.ok, false);
  assert.match(got.why, /commitment/);
  assert.equal(groupKeyOf([cs[0], { ...cs[1], commitments: [] }], curve).ok, false);
});

// THE AGREEMENT. The signature check is injected (`verify`); here a keyed hash stands in for it.
const signFor = (key, digest) => createHash('sha256').update(Buffer.concat([Buffer.from(key), Buffer.from(digest)])).digest().subarray(0, 32);
const sig = (key, digest) => Uint8Array.from([...signFor(key, digest), ...signFor(digest, key)]);
const verify = (s, digest, key) => hex(s) === hex(sig(key, digest));

test('the agreement: encode/decode, its id, a signed statement split, and it holds when all 7 sign one set', async () => {
  const cs = await dealAll();
  const held = contributionSetOf(cs);
  const a = { epochId: EPOCH, signerNode: PUBS[0], held };
  assert.deepEqual(decodeAgreement(encodeAgreement(a)), a);
  assert.equal(hex(agreementId(decodeAgreement(encodeAgreement(a)))), V.agreement);
  const bytes = encodeAgreement(a);
  assert.throws(() => decodeAgreement(Uint8Array.from([...bytes, 0])), /trailing bytes/);
  assert.throws(() => decodeAgreement(Uint8Array.from([bytes[0] ^ 1, ...bytes.subarray(1)])), /not a DKG agreement/);
  assert.throws(() => decodeAgreement(Uint8Array.from([bytes[0], bytes[1], bytes[2] ^ 1, ...bytes.subarray(3)])), /protocol version/);
  const s = sig(PUBS[0], agreementId(a));
  const split = splitSignedAgreement(Uint8Array.from([...bytes, ...s]));
  assert.deepEqual(split.agreement, a);
  assert.equal(hex(split.signature), hex(s));
  assert.equal(split.signature.length, AGREEMENT_SIGNATURE_BYTES);
  assert.throws(() => splitSignedAgreement(new Uint8Array(64)), { message: 'that is not a signed DKG agreement' });
  assert.throws(() => splitSignedAgreement(undefined), { message: 'that is not a signed DKG agreement' });
  const statements = PUBS.map((k) => { const x = { epochId: EPOCH, signerNode: k, held }; return { agreement: x, signature: sig(k, agreementId(x)) }; });
  assert.deepEqual(agreementHolds({ epochId: EPOCH, signerNodes: PUBS, statements, verify }), { ok: true, of: 7 });
});

test('the agreement is refused by name: another set, a node signing two, a missing node, a bad signature, a short set, no verifier', async () => {
  const cs = await dealAll();
  const held = contributionSetOf(cs);
  const say = (k, h = held) => { const x = { epochId: EPOCH, signerNode: k, held: h }; return { agreement: x, signature: sig(k, agreementId(x)) }; };
  const all = PUBS.map((k) => say(k));
  const holds = (statements, o = {}) => agreementHolds({ epochId: EPOCH, signerNodes: PUBS, statements, verify, ...o });
  // dealer 1 sent another contribution to node 7: the sets differ on dealer 1
  const otherDeal = (await deal(0, 0x50)).contribution;
  const otherSet = contributionSetOf([otherDeal, ...cs.slice(1)]);
  const split = holds([...all.slice(0, 6), say(PUBS[6], otherSet)]);
  assert.equal(split.ok, false);
  assert.match(split.why, /the signer nodes hold different contribution sets - they differ on the deal of /);
  assert.match(split.why, new RegExp(hex(PUBS[0]).slice(0, 16)));
  assert.deepEqual(holds([...all, say(PUBS[2], otherSet)]), { ok: false, why: `signer node ${hex(PUBS[2]).slice(0, 16)} signed two different contribution sets` });
  assert.deepEqual(holds(all.slice(0, 6)), { ok: false, have: 6, of: 7,
    why: '6 of the committee\'s 7 signer nodes have said which contributions they combined; all must agree before a share is kept' });
  const forged = all.map((s, i) => (i === 4 ? { ...s, signature: new Uint8Array(64) } : s));
  assert.equal(holds(forged).have, 6, 'a statement with a bad signature was counted');
  const throwing = holds(all, { verify: (s, d, k) => { if (hex(k) === hex(PUBS[5])) throw new Error('bad'); return verify(s, d, k); } });
  assert.equal(throwing.have, 6, 'a statement whose check threw was counted');
  assert.equal(holds([...all.slice(0, 6), { agreement: { ...all[6].agreement, epochId: new Uint8Array(32) }, signature: all[6].signature }]).have, 6);
  const short = held.slice(0, 6);
  assert.deepEqual(holds(PUBS.map((k) => say(k, short))), { ok: false, why: 'the agreed set is not one contribution from every signer node of the committee' });
  assert.deepEqual(holds(all, { verify: undefined }), { ok: false, why: 'checking an agreement needs a verifier, and none was injected' });
  assert.deepEqual(holds(all, { signerNodes: [] }), { ok: false, why: 'an agreement is over a committee, and that is nobody' });
  assert.equal(holds(undefined).have, 0);
});
