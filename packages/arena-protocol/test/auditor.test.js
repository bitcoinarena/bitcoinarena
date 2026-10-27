// The round's auditors (spec §13A.1, kanban #725, protocol 22): who may audit, the secret draw (about three a round, bond-weighted,
// checkable by anyone, not by the committee in advance), the AUDIT and a seat's check of it, the 10 % line, and an advertisement
// naming a role an older build does not know.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVrf, SUITE_SECP256K1_TAI } from '../src/vrf.js';
import { auditAlpha, vrfPublicKey, vrfSecretFor, auditEligible, isAuditor, auditResultsHash, encodeAudit, decodeAudit, auditId,
  auditStands, auditorShares, AUDITORS } from '../src/auditor.js';
import { taggedHash, toHex } from '../src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const node = (i) => {
  const secret = taggedHash('test/auditor-node', Uint8Array.of(i >> 8, i & 255));
  return { secret, pubkey: schnorr.getPublicKey(secret) };
};
const BOND_MIN = 50_000n;
const census = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ pubkey: node(i).pubkey, roles: ['game', 'verify', 'settlement', 'audit'],
  bondSats: BOND_MIN, operatorId: `op${i}`, ...(extra[i] || {}) }));
const drawsOf = (roundId, entries, nodes) => {
  const { eligible, total } = auditEligible({ entries, bondMinSats: BOND_MIN });
  return nodes.filter((nd) => {
    const w = eligible.get(toHex(nd.pubkey)); if (!w) return false;
    const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(roundId));
    return isAuditor({ beta: vrf.proofToHash(pi), weight: w, total });   // the proof's own output; its check is the AUDIT test's
  });
};

test('a node proves under its x-only key, whichever y its secret gives', () => {
  for (let i = 0; i < 6; i++) {
    const nd = node(i);
    const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(new Uint8Array(32).fill(i)));
    assert.ok(vrf.verify(vrfPublicKey(nd.pubkey), auditAlpha(new Uint8Array(32).fill(i)), pi), `node ${i}`);
  }
});

test('who may audit: the audit role, no drawn seat, no player node or operator, bonds summed per key, the floor applies', () => {
  const entries = census(6, { 1: { roles: ['game', 'verify'] }, 5: { bondSats: 10_000n } });
  entries.push({ pubkey: node(0).pubkey, roles: ['audit'], bondSats: 100_000n, operatorId: 'op0' });   // a second bond of node 0
  const { eligible, total } = auditEligible({ entries, bondMinSats: BOND_MIN, drawn: [toHex(node(2).pubkey)], operators: ['op3'] });
  assert.deepEqual([...eligible.keys()].sort(), [toHex(node(0).pubkey), toHex(node(4).pubkey)].sort());
  assert.equal(eligible.get(toHex(node(0).pubkey)), 3n, '150,000 over a 50,000 floor');
  assert.equal(total, 4n);
});

test('the draw: about three a round over 60 rounds of 25 nodes, and the same answer for everybody', () => {
  const nodes = Array.from({ length: 25 }, (_, i) => node(i)), entries = census(25);
  let sum = 0, none = 0;
  for (let r = 0; r < 60; r++) {
    const n = drawsOf(taggedHash('test/round', Uint8Array.of(r)), entries, nodes).length;
    sum += n; if (n === 0) none++;
  }
  const mean = sum / 60;
  assert.ok(mean > 2.3 && mean < 3.7, `mean ${mean}`);
  assert.ok(none < 10, `${none} rounds without an auditor (about e^-3 = 5 % expected)`);
  assert.equal(AUDITORS, 3n);
});

test('weight counts: a node with four times the bond is drawn about four times as often', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => node(i)), entries = census(10, { 0: { bondSats: 4n * BOND_MIN } });
  let heavy = 0, light = 0;
  for (let r = 0; r < 100; r++) {
    const d = drawsOf(taggedHash('test/round-w', Uint8Array.of(r >> 8, r & 255)), entries, nodes).map((x) => toHex(x.pubkey));
    if (d.includes(toHex(nodes[0].pubkey))) heavy++;
    if (d.includes(toHex(nodes[1].pubkey))) light++;
  }
  assert.ok(heavy > 2 * light, `heavy ${heavy}, light ${light}`);
});

test('an AUDIT: bytes round trip, and a seat counts it only signed, drawn, eligible and for these results', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => node(i)), entries = census(30);
  let roundId, drawn;
  for (let r = 0; r < 50 && !drawn; r++) { roundId = taggedHash('test/round-a', Uint8Array.of(r)); [drawn] = drawsOf(roundId, entries, nodes); }
  assert.ok(drawn, 'some round in 50 draws an auditor');
  const resultsHash = auditResultsHash([{ entryId: new Uint8Array(32).fill(2), resultDigest: new Uint8Array(32).fill(9) },
    { entryId: new Uint8Array(32).fill(1), resultDigest: new Uint8Array(32).fill(8) }]);
  const a = { roundId, resultsHash, nodePubkey: drawn.pubkey, vrfProof: vrf.prove(vrfSecretFor(drawn.secret, secp256k1.Point), auditAlpha(roundId)) };
  assert.deepEqual(decodeAudit(encodeAudit(a)), a);
  const signature = schnorr.sign(auditId(a), drawn.secret);
  const { eligible, total } = auditEligible({ entries, bondMinSats: BOND_MIN });
  const ctx = { signature, vrf, verify, eligible, total, resultsHash };
  assert.equal(auditStands(a, ctx).ok, true);
  assert.match(auditStands(a, { ...ctx, signature: schnorr.sign(auditId(a), nodes.find((x) => x !== drawn).secret) }).why, /not signed/);
  assert.match(auditStands(a, { ...ctx, resultsHash: new Uint8Array(32) }).why, /other results/);
  assert.match(auditStands(a, { ...ctx, ...auditEligible({ entries, bondMinSats: BOND_MIN, drawn: [toHex(drawn.pubkey)] }) }).why, /may not audit/);
  const undrawn = nodes.find((nd) => !drawsOf(roundId, entries, [nd]).length);
  const b = { ...a, nodePubkey: undrawn.pubkey, vrfProof: vrf.prove(vrfSecretFor(undrawn.secret, secp256k1.Point), auditAlpha(roundId)) };
  assert.match(auditStands(b, { ...ctx, signature: schnorr.sign(auditId(b), undrawn.secret) }).why, /not drawn/);
  const c = { ...a, vrfProof: vrf.prove(vrfSecretFor(drawn.secret, secp256k1.Point), auditAlpha(new Uint8Array(32).fill(7))) };
  assert.match(auditStands(c, { ...ctx, signature: schnorr.sign(auditId(c), drawn.secret) }).why, /does not verify/);
});

test('the line: 10 % of the nodes\' part after the website, equally; nobody published, all of it stays in the pools', () => {
  assert.deepEqual(auditorShares({ nodesMsat: 360_000n, auditors: ['bb', 'aa', 'cc'] }),
    { each: [{ key: 'aa', msat: 12_000n }, { key: 'bb', msat: 12_000n }, { key: 'cc', msat: 12_000n }], backMsat: 324_000n });
  assert.deepEqual(auditorShares({ nodesMsat: 1000n, auditors: ['aa', 'bb', 'cc'] }), { each: [{ key: 'aa', msat: 33n }, { key: 'bb', msat: 33n }, { key: 'cc', msat: 33n }], backMsat: 901n });
  assert.deepEqual(auditorShares({ nodesMsat: 360_000n, auditors: [] }), { each: [], backMsat: 360_000n });
  assert.equal(auditorShares({ nodesMsat: 360_000n, auditors: ['aa', 'aa'] }).each.length, 1, 'one key, one share');
});

test('an advertisement naming a role this build does not know is read, that role skipped', async () => {
  const { encodeAdvert, decodeAdvert } = await import('../src/advert.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const a = { nodePubkey: b32(1), operatorId: '2of2', protocolVersions: [1], hostedGames: [], roles: ['audit', 'verify'],
    endpoint: 'wss://example.invalid/n1', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0,
    lightningCapabilities: 0, bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [],
    timestamp: 1788700000000n, guardianCapable: false, guardianEndpoint: '' };
  assert.deepEqual(decodeAdvert(encodeAdvert(a)).roles.sort(), ['audit', 'verify']);
  // the role bytes sit after type, version, key, operator id and protocol versions: 1 + 2 + 32 + (2 + 4) + (2 + 2) + 2 = 47
  const bytes = encodeAdvert({ ...a, roles: ['relay'] });
  assert.equal(bytes[47], 3, 'relay is role index 3');
  bytes[47] = 9;
  assert.deepEqual(decodeAdvert(bytes).roles, [], 'role index 9 is skipped, the advertisement still read');
});
