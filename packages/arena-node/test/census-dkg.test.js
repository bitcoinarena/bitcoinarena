// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY, MADE (spec 5A.3B, kanban #1021, #972), on the daemon's own curve and CensusDkg: several shares for one node, a node absent, one
// nonce per node, a reshare that keeps the public key, and the attacks the batched check has to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { CensusDkg } from '../src/dkg.js';
import { feldmanGroup } from '../src/curve.js';
import { censusKeyShares, censusKeyRecordStands, censusKeyRecordId } from '../../arena-protocol/src/census-key.js';
import {
  censusRunId, dealCensusKey, decodeCensusDeal, encodeCensusDeal, acceptCensusDeal, checkDealsBatched, censusComplaintHolds, encodeCensusComplaint, decodeCensusComplaint,
  makeCensusComplaint, censusSetAgreed, censusStatementId, reshareDealers, reshareConstant, lagrangeOf, censusPublicShare, censusRecordOf,
} from '../../arena-protocol/src/census-dkg.js';
import { signNodeShare340, verifyNodeShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { sealShare } from '../../arena-protocol/src/seal.js';
import { scalarFrom32, scalarTo32, FIELD } from '../../arena-protocol/src/shares.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const curve = feldmanGroup;
const random = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const v = scalarFrom32(random(32)); if (v > 0n && v < FIELD) return v; } };
const NET = new Uint8Array(32).fill(9);

function census(bonds) {
  const nodes = bonds.map((bond) => { const secret = scalarTo32(scalar()); return { secret, key: schnorr.getPublicKey(secret), bond }; });
  const shares = censusKeyShares({ entries: nodes.map((n) => ({ pubkey: n.key, bondSats: n.bond })), lowestBondMinSats: 100000n, sharesMax: 1024 });
  return { nodes, shares };
}
const bonds15 = Array.from({ length: 15 }, (_, i) => BigInt(Math.max(1, Math.floor(10 / (i + 1)))) * 100000n);

function runOf({ shares }, extra = {}) {
  const { total, threshold, holders } = shares;
  const runId = censusRunId({ networkId: NET, epoch: 1, censusHeight: 4320, holders, threshold, ...extra });
  return { runId, holders, threshold, needed: threshold, total };
}

/** Everyone but `absent` deals, hears every deal, checks, says its set; every present node finishes. */
async function keygen(c, { absent = [] } = {}) {
  const run = runOf(c);
  const up = c.nodes.filter((_, i) => !absent.includes(i));
  const live = up.map((n) => new CensusDkg({ key: n.key, secret: n.secret, run, curve, random }));
  const bytes = [];
  for (const d of live) bytes.push((await d.deal()).bytes);
  for (const d of live) for (const b of bytes) assert.equal((await d.accept(b)).ok, true);
  for (const d of live) assert.equal(d.check().ok, true);
  const statements = live.map((d) => d.statement());
  const done = live.map((d) => d.finish(statements));
  for (const f of done) assert.equal(f.ok, true, f.why);
  return { run, live, up, done, statements, bytes };
}

/** One nonce per node, by frost-bip340.js, from the shares of `who` [{ id, held: Map x -> share }]. */
function signAs(key, who, message) {
  const lambda = lagrangeOf(who.flatMap((w) => [...w.held.keys()]), who.flatMap((w) => [...w.held.keys()]));
  const nonces = who.map((w) => { const share = [...w.held.values()][0]; return { hiding: nonceGenerate340(random(32), share), binding: nonceGenerate340(random(32), share) }; });
  const commitments = who.map((w, i) => ({ id: w.id, hiding: curve.pointFromScalar(nonces[i].hiding), binding: curve.pointFromScalar(nonces[i].binding) }));
  const shares = who.map((w, i) => signNodeShare340({ id: w.id, held: w.held, lambda, groupPublicKey: key, nonces: nonces[i], message, commitments, curve }));
  return { ...aggregate340({ commitments, message, groupPublicKey: key, shares, curve }), commitments, parts: shares, lambda };
}
const holdersUpTo = (done, up, holders, threshold) => {
  const who = []; let have = 0;
  done.forEach((f, i) => { if (have < threshold) { who.push({ id: i + 1, held: f.shares }); have += f.shares.size; } });
  return who;
};

test('unit and shares from the census: several shares for one node, all of them a key that BIP-340 takes', async () => {
  const c = census(bonds15);
  assert.deepEqual([c.shares.total, c.shares.threshold], [32, 22]);
  const { done, up, run } = await keygen(c);
  const key = done[0].groupPublicKey;
  for (const f of done) assert.equal(toHex(f.groupPublicKey), toHex(key));
  const message = random(32);
  const who = holdersUpTo(done, up, run.holders, run.threshold);
  const sig = signAs(key, who, message);
  assert.equal(schnorr.verify(sig.signature, message, sig.publicKey), true);
  assert.ok(who.length < 22, `${who.length} nodes signed for 22 shares`);
  console.log(`  FACTS: ${c.shares.total} shares, threshold ${c.shares.threshold}: ${who.length} commitment pairs on the list, not ${[...who].reduce((a, w) => a + w.held.size, 0)}`);
});

test('a node absent: the key stands on the rest, the absent node\'s shares are unused, and it can still fetch them later', async () => {
  const c = census(bonds15);
  const { done, up, run, statements, bytes } = await keygen(c, { absent: [14] });
  const message = random(32);
  const who = holdersUpTo(done, up, run.holders, run.threshold);
  assert.equal(schnorr.verify(signAs(done[0].groupPublicKey, who, message).signature, message, done[0].groupPublicKey.subarray(1)), true);
  const late = new CensusDkg({ key: c.nodes[14].key, secret: c.nodes[14].secret, run, curve, random });
  for (const b of bytes) await late.accept(b);
  assert.equal(late.check().ok, true);
  const f = late.finish(statements);
  assert.equal(f.ok, true, f.why);
  assert.equal(toHex(f.groupPublicKey), toHex(done[0].groupPublicKey));
  assert.equal(f.shares.size, run.holders.find((h) => h.key === toHex(c.nodes[14].key)).shares, 'it holds its own shares after all');
});

test('absent nodes holding more than a third stop the key by name, and leave the newest key standing', async () => {
  const c = census(Array.from({ length: 9 }, () => 100000n));
  const run = runOf(c);
  const live = c.nodes.slice(0, 5).map((n) => new CensusDkg({ key: n.key, secret: n.secret, run, curve, random }));
  const bytes = []; for (const d of live) bytes.push((await d.deal()).bytes);
  for (const d of live) for (const b of bytes) await d.accept(b);
  for (const d of live) d.check();
  const f = live[0].finish(live.map((d) => d.statement()));
  assert.equal(f.ok, false);
  assert.match(f.why, /holders of 5 shares signed one set of deals, and the threshold is 7/);
});

/** A deal with one wrong envelope: `shift` moves the share at x. */
async function crooked(run, node, x, shift) {
  const ephemeralSecret = scalarTo32(scalar());
  const coefficients = Array.from({ length: run.needed - 1 }, scalar);
  const secret = scalarTo32(scalar());
  const made = await dealCensusKey({ holders: run.holders, runId: run.runId, from: node.key, needed: run.needed, secret, coefficients, ephemeralSecret, proofNonce: scalar(), curve });
  const a = [scalarFrom32(secret), ...coefficients];
  let value = 0n;
  for (let j = a.length - 1; j >= 0; j--) value = (value * BigInt(x) + a[j]) % FIELD;
  const owner = run.holders.find((h) => h.ids.includes(x));
  made.deal.sealed[x - 1].bytes = await sealShare({ value: (value + shift) % FIELD, signerNode: x, signerNodePubkey: Uint8Array.from(Buffer.from(owner.key, 'hex')), ephemeralSecret, curve });
  return made.deal;
}

test('a bad share is found by the batch, the deal named, the x named, and any stranger can check the complaint', async () => {
  const c = census(bonds15);
  const run = runOf(c);
  const live = c.nodes.map((n) => new CensusDkg({ key: n.key, secret: n.secret, run, curve, random }));
  const victim = live[0];                                 // the top node, ten shares
  const x = victim.me.ids[7];
  const bad = encodeCensusDeal(await crooked(run, c.nodes[3], x, 5n));
  const others = []; for (const d of live) if (d !== live[3]) others.push((await d.deal()).bytes);
  for (const b of [bad, ...others]) assert.equal((await victim.accept(b)).ok, true, 'a bad share passes the shape');
  const seen = victim.check();
  assert.equal(seen.ok, false);
  assert.equal(seen.complaints.length, 1);
  assert.ok(seen.checks > 1 && seen.checks <= 2 * Math.ceil(Math.log2(15)) + 1, `${seen.checks} batches`);
  const complaint = decodeCensusComplaint(encodeCensusComplaint(seen.complaints[0]));
  assert.equal(toHex(complaint.dealer), toHex(c.nodes[3].key));
  assert.equal(complaint.x, x);
  const proven = await censusComplaintHolds({ complaint, deal: decodeCensusDeal(bad), holders: run.holders, curve });
  assert.equal(proven.ok, true, proven.why);
  const other = live[1];
  for (const b of [bad, ...others]) await other.accept(b);
  assert.equal((await other.hearComplaint(complaint)).ok, true, 'a node the dealer treated well drops it too');
  assert.equal(other.deals.has(toHex(c.nodes[3].key)), false);
});

test('two dealers shifting one share by +e and -e cancel in a plain sum: the random batch names both', async () => {
  const c = census(bonds15);
  const run = runOf(c);
  const me = c.nodes[0];
  const d = new CensusDkg({ key: me.key, secret: me.secret, run, curve, random });
  const x = d.me.ids[0];
  const e = scalar();
  await d.accept(encodeCensusDeal(await crooked(run, c.nodes[1], x, e)));
  await d.accept(encodeCensusDeal(await crooked(run, c.nodes[2], x, FIELD - e)));
  const named = d.check();
  assert.equal(named.complaints.length, 2);
  assert.deepEqual(named.complaints.map((k) => toHex(k.dealer)).sort(), [toHex(c.nodes[1].key), toHex(c.nodes[2].key)].sort());
});

test('a false complaint does not stand, and it cannot be made for a share the node does not hold', async () => {
  const c = census(bonds15);
  const run = runOf(c);
  const d = new CensusDkg({ key: c.nodes[1].key, secret: c.nodes[1].secret, run, curve, random });
  const deal = decodeCensusDeal((await d.deal()).bytes);
  const me = c.nodes[0], mine = run.holders.find((h) => h.key === toHex(me.key));
  const honest = makeCensusComplaint({ deal, x: mine.ids[0], secret: me.secret, nonce: scalar(), curve });
  assert.match((await censusComplaintHolds({ complaint: honest, deal, holders: run.holders, curve })).why, /lies on its polynomial/);
  const notMine = run.holders.find((h) => h.key !== toHex(me.key)).ids[0];
  const stolen = makeCensusComplaint({ deal, x: notMine, secret: me.secret, nonce: scalar(), curve });
  assert.match((await censusComplaintHolds({ complaint: stolen, deal, holders: run.holders, curve })).why, /does not hold share/);
  assert.match((await censusComplaintHolds({ complaint: { ...honest, z: 5n }, deal, holders: run.holders, curve })).why, /does not verify/);
});

test('a deal is bound to its run and its dealer', async () => {
  const c = census(bonds15);
  const run = runOf(c);
  const deal = decodeCensusDeal((await new CensusDkg({ key: c.nodes[0].key, secret: c.nodes[0].secret, run, curve, random }).deal()).bytes);
  const ask = (d, over = {}) => acceptCensusDeal(d, { holders: run.holders, runId: run.runId, needed: run.needed, curve, ...over });
  assert.equal(ask(deal).ok, true);
  assert.match(ask(deal, { runId: random(32) }).why, /another run/);
  assert.match(ask({ ...deal, from: random(32) }).why, /not a dealer/);
  assert.match(ask({ ...deal, from: c.nodes[1].key }).why, /proof of knowledge/);
  assert.match(ask(deal, { needed: run.needed + 1 }).why, /threshold of/);
  assert.match(ask({ ...deal, sealed: deal.sealed.slice(1) }).why, /one share for each x/);
});

test('a node that signs two sets is named and counted for neither', () => {
  const c = census(Array.from({ length: 4 }, () => 100000n));
  const run = runOf(c);
  const say = (n, setId) => { const s = { runId: run.runId, node: n.key, setId }; return { ...s, signature: schnorr.sign(censusStatementId(s), n.secret) }; };
  const A = new Uint8Array(32).fill(1), B = new Uint8Array(32).fill(2);
  const [a, b, x] = c.nodes;
  const r = censusSetAgreed({ runId: run.runId, holders: run.holders, threshold: run.threshold, verify: (s, d, k) => schnorr.verify(s, d, k), statements: [say(a, A), say(b, A), say(x, A), say(x, B)] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.equivocated, [toHex(x.key)]);
});

test('a bad signature share is pinned on its node by its public shares', async () => {
  const c = census(bonds15);
  const { done, up, run } = await keygen(c);
  const key = done[0].groupPublicKey, commitments = done[0].commitments;
  const message = random(32);
  const who = holdersUpTo(done, up, run.holders, run.threshold);
  const sig = signAs(key, who, message);
  const publicPart = (w) => curve.combinePoints([...w.held.keys()].map((x) => ({ point: censusPublicShare({ commitments, x, curve }), coefficient: sig.lambda.get(x) })));
  who.forEach((w, i) => assert.equal(verifyNodeShare340({ id: w.id, share: sig.parts[i], publicPart: publicPart(w), groupPublicKey: key, message, commitments: sig.commitments, curve }), true, `node ${i}`));
  assert.equal(verifyNodeShare340({ id: who[0].id, share: (sig.parts[0] + 1n) % FIELD, publicPart: publicPart(who[0]), groupPublicKey: key, message, commitments: sig.commitments, curve }), false);
});

test('a share short of the threshold signs nothing', async () => {
  const c = census(bonds15);
  const { done, up, run } = await keygen(c);
  const message = random(32);
  const who = holdersUpTo(done, up, run.holders, run.threshold).map((w) => ({ ...w, held: new Map(w.held) }));
  let count = who.reduce((a, w) => a + w.held.size, 0);
  while (count >= run.threshold) { const last = who[who.length - 1]; last.held.delete([...last.held.keys()].pop()); if (!last.held.size) who.pop(); count--; }
  const sig = signAs(done[0].groupPublicKey, who, message);
  assert.equal(schnorr.verify(sig.signature, message, sig.publicKey), false);
});

async function reshare(c, made, next, { absent = [] } = {}) {
  const { done, up, run } = made;
  const present = up.map((n) => toHex(n.key)).filter((k) => !absent.includes(k));
  const dealing = reshareDealers({ holders: run.holders, threshold: run.threshold, present });
  assert.equal(dealing.ok, true, dealing.why);
  const key = done[0].groupPublicKey;
  const base = { ...next.shares };
  const runId = censusRunId({ networkId: NET, epoch: 2, censusHeight: 8640, holders: base.holders, threshold: base.threshold, reshareOf: key.subarray(1), dealers: dealing.dealers.map((h) => h.key) });
  const newRun = { runId, holders: base.holders, threshold: base.threshold, needed: base.threshold, total: base.total,
    reshare: { dealers: dealing.dealers, oldThreshold: run.threshold, xs: dealing.xs, oldCommitments: done[0].commitments, groupPublicKey: key } };
  const dealers = dealing.dealers.map((h) => {
    const i = up.findIndex((n) => toHex(n.key) === h.key);
    return new CensusDkg({ key: up[i].key, secret: up[i].secret, run: newRun, curve, random, part: reshareConstant({ xs: dealing.xs, shares: done[i].shares }) });
  });
  const bytes = []; for (const d of dealers) bytes.push((await d.deal()).bytes);
  return { newRun, bytes, key };
}

test('the reshare keeps the public key: the new census signs for it, an old holder who left deals, a new node receives', async () => {
  const c = census(bonds15);
  const made = await keygen(c);
  const fresh = census([300000n, 200000n]);
  const nodes = [...c.nodes.slice(2, 13), ...fresh.nodes];
  const next = { nodes, shares: censusKeyShares({ entries: nodes.map((n) => ({ pubkey: n.key, bondSats: n.bond })), lowestBondMinSats: 100000n, sharesMax: 1024 }) };
  const { newRun, bytes, key } = await reshare(c, made, next);
  const live = next.nodes.map((n) => new CensusDkg({ key: n.key, secret: n.secret, run: newRun, curve, random }));
  for (const d of live) for (const b of bytes) assert.equal((await d.accept(b)).ok, true);
  for (const d of live) assert.equal(d.check().ok, true);
  const statements = live.map((d) => d.statement());
  const done = live.map((d) => d.finish(statements));
  for (const f of done) assert.equal(f.ok, true, f.why);
  assert.equal(toHex(done[0].groupPublicKey), toHex(key), 'the same public key');
  assert.equal(done[0].negated, false);
  const message = random(32);
  const who = holdersUpTo(done, next.nodes, newRun.holders, newRun.threshold);
  const sig = signAs(key, who, message);
  assert.equal(schnorr.verify(sig.signature, message, key.subarray(1)), true);
  const record = censusRecordOf({ networkId: NET, epoch: 2, censusHeight: 8640, runId: newRun.runId, setId: done[0].setId, groupPublicKey: key, total: newRun.total, threshold: newRun.threshold });
  const signatures = next.nodes.map((n) => ({ key: n.key, signature: schnorr.sign(censusKeyRecordId(record), n.secret) }));
  assert.equal(censusKeyRecordStands({ record, signatures, networkId: NET, shares: next.shares, verify: (s, d, k) => schnorr.verify(s, d, k) }).ok, true);
});

test('with a dealer absent a reshare goes again without it; a dealer who moves its part is named', async () => {
  const c = census(bonds15);
  const made = await keygen(c);
  const absent = [toHex(c.nodes[0].key)];
  const { newRun, bytes, key } = await reshare(c, made, c, { absent });
  assert.ok(!newRun.reshare.dealers.some((h) => h.key === absent[0]), 'the top node, absent, is left out of the dealers');
  const live = c.nodes.map((n) => new CensusDkg({ key: n.key, secret: n.secret, run: newRun, curve, random }));
  for (const b of bytes.slice(1)) await live[1].accept(b);
  assert.equal(live[1].check().ok, true, 'part of a set is checked term by term, and the sum waits for all of it');
  assert.match(live[1].finish(live.slice(1, 2).map((d) => d.statement())).why, /holders of|dealers of that reshare/);
  for (const d of live) for (const b of bytes) await d.accept(b);
  for (const d of live) d.check();
  const done = live.map((d) => d.finish(live.map((x) => x.statement())));
  assert.equal(toHex(done[0].groupPublicKey || new Uint8Array(0)), toHex(done[0].ok ? key : new Uint8Array(0)));

  const fresh = c.nodes.map((n) => new CensusDkg({ key: n.key, secret: n.secret, run: newRun, curve, random }));
  const thief = newRun.reshare.dealers[0];
  const wrong = await new CensusDkg({ key: Uint8Array.from(Buffer.from(thief.key, 'hex')), secret: c.nodes.find((n) => toHex(n.key) === thief.key).secret, run: newRun, curve, random, part: scalar() }).deal();
  await fresh[0].accept(wrong.bytes);
  for (const b of bytes.slice(1)) await fresh[0].accept(b);
  const seen = fresh[0].check();
  assert.equal(seen.ok, false);
  assert.equal(fresh[0].bad.has(thief.key), true, 'the dealer is named');
});
