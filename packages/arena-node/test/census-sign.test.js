// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY SIGNS, seat to seat (spec 5A.3B, kanban #972): one nonce pair per node for its several shares, a nonce used once, and what a filer gets is a BIP-340 signature of the key or a reason. tools/slash-flow-regtest.mjs is this through real seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createCensusSigner, gatherCensusSignature } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { encodeCensusKeyRecord } from '../../arena-protocol/src/census-key.js';
import { aggregate340 } from '../../arena-protocol/src/frost-bip340.js';
import { encodeCommitmentList } from '../../arena-protocol/src/frost.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup } from '../src/curve.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const secret = (n) => taggedHash('ARENA/test/CensusSign', Uint8Array.of(n));
// a polynomial of degree 3 under an even key: threshold 4, x 1..6
function dealt() {
  let a0 = toScalar(secret(1));
  if (secp256k1.getPublicKey(secret(1), true)[0] === 3) a0 = N - a0;
  const co = [a0, toScalar(secret(2)), toScalar(secret(3)), toScalar(secret(4))];
  const share = (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n);
  return { publicKey: schnorr.getPublicKey(secret(1)), share };
}
const { publicKey, share } = dealt();
const digest = taggedHash('ARENA/test/CensusSign', Uint8Array.of(99));
// what each holder's own keygen kept of the key: 6 shares, threshold 4 (CensusKeyStore.held's `record`)
const record = encodeCensusKeyRecord({ networkId: new Uint8Array(32), epoch: 1, publicKey, censusHeight: 100, totalShares: 6, threshold: 4, transcriptHash: new Uint8Array(32) });
const holder = (n, xs, over = {}) => {
  const key = schnorr.getPublicKey(secret(10 + n));
  const signer = createCensusSigner({ key, work: censusKeyWork, held: () => ({ shares: new Map(xs.map((x) => [x, share(x)])), record }), check: async () => ({ ok: true, digest, publicKey }), ...over });
  return { url: `http://h${n}`, signer };
};
const wire = (holders) => async (url, init) => {
  const h = holders.find((x) => url.startsWith(x.url));
  const body = JSON.parse(init.body);
  const answer = url.endsWith('/commit') ? await h.signer.takeCommit(body) : await h.signer.takeShare(body);
  return { json: async () => answer };
};

test('the coefficients are the polynomial\'s: a node of two shares signs with one nonce pair', async () => {
  const hs = [holder(1, [1, 2]), holder(2, [3]), holder(3, [4])];
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs) });
  assert.ok(got.ok, got.why);
  assert.ok(schnorr.verify(got.signature, digest, publicKey), 'a BIP-340 signature of the key');
  assert.equal(got.signers.length, 3);
  assert.equal(got.shares, 4);
  const l = lagrangeOf([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.equal(toHex(schnorr.getPublicKey(Uint8Array.from(Buffer.from(([1, 2, 3, 4].reduce((a, x) => (a + l.get(x) * share(x)) % N, 0n)).toString(16).padStart(64, '0'), 'hex')))), toHex(publicKey));
});

test('more shares than the threshold sign too, and this node\'s own signer takes part with no fetch', async () => {
  const own = holder(1, [1, 2, 5]), hs = [holder(2, [3, 4, 6])];
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), own: own.signer, fetchFn: wire(hs) });
  assert.ok(got.ok, got.why);
  assert.equal(got.shares, 6);
});

test('a nonce is used once: a session ends at its share, whatever comes of it', async () => {
  const h = holder(1, [1]);
  const c = await h.signer.takeCommit({});
  const list = [{ id: 1, node: c.node, xs: c.xs, hiding: c.hiding, binding: c.binding }];
  assert.equal((await h.signer.takeShare({ session: c.session, signers: [{ ...list[0], hiding: c.binding }] })).why, 'that list does not carry this node\'s commitment');
  assert.equal(h.signer.sessions(), 0);
  assert.equal((await h.signer.takeShare({ session: c.session, signers: list })).why, 'no such session here', 'the same session again, with the right list');
});

test('a holder that refuses is named; short of the threshold nothing is asked of the others', async () => {
  let asked = 0;
  const refuses = holder(2, [3, 4], { check: async () => ({ ok: false, why: 'it does not replay' }) });
  const hs = [holder(1, [1, 2]), refuses];
  const wired = wire(hs);
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: async (u, i) => { if (u.endsWith('/share') && JSON.parse(i.body).signers.length) asked += 1; return wired(u, i); } });   // a share with no signers hands a session back (#1187)
  assert.deepEqual([got.ok, got.why, asked], [false, '2 of the 4 shares of that key answered', 0]);
  assert.deepEqual(got.refused, [{ who: 'http://h2', why: 'it does not replay' }]);
});

test('a holder with no shares of the key commits nothing; a bad share never leaves as a signature', async () => {
  assert.match((await holder(1, [1], { held: () => null }).signer.takeCommit({})).why, /holds no shares/);
  const hs = [holder(1, [1, 2]), holder(2, [3, 4])];
  const wired = wire(hs);
  const lies = async (u, i) => { const r = await wired(u, i); if (!u.endsWith('/share') || !u.includes('h2')) return r; const a = await r.json(); return { json: async () => ({ ...a, z: (BigInt(`0x${a.z}`) + 1n).toString(16).padStart(64, '0') }) }; };
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: lies });
  assert.equal(got.ok, false);
  assert.match(got.why, /do not add up/);
});

// THE SIGNING SET IS BOUND (kanban #1155). Before: a holder took the xs of every signer from the wire as they came, checked none of them, and left them out of the binding factors.
const commitAll = async (hs) => Promise.all(hs.map(async (h) => ({ h, c: await h.signer.takeCommit({}) })));
const listOf = (got) => [...got].sort((a, b) => (a.c.node < b.c.node ? -1 : 1)).map(({ c }, i) => ({ id: i + 1, node: c.node, xs: c.xs, hiding: c.hiding, binding: c.binding }));

test('#1155 a holder signs only for real shares of the key, its own exactly, up to the threshold: anything else is refused and nothing is signed', async () => {
  let worked = 0;
  const counted = { work: async (job) => { worked += 1; return censusKeyWork(job); } };
  const tamper = {
    'an x past the key\'s shares': (l) => { l[1].xs = [3, 7]; },
    'an x of zero': (l) => { l[1].xs = [0]; },
    'an x that is not an integer': (l) => { l[1].xs = [2.5]; },
    'an x as a string': (l) => { l[1].xs = ['3']; },
    'one x twice': (l) => { l[1].xs = [3, 3]; },
    'another node\'s x claimed again': (l) => { l[2].xs = [1]; },
    'this node\'s own xs changed': (l) => { l.find((x) => x.xs.includes(1)).xs = [1]; },
    'fewer shares than the threshold': (l) => { l.splice(l.findIndex((x) => x.xs.length === 1), 1); },
    'a signer id out of the list': (l) => { l[0].id = 9; },
  };
  for (const [what, edit] of Object.entries(tamper)) {
    const hs = [holder(1, [1, 2], counted), holder(2, [3], counted), holder(3, [4], counted)];
    const got = await commitAll(hs);
    const list = listOf(got);
    edit(list);
    const victim = got.find(({ c }) => c.xs.includes(1));
    const answer = await victim.h.signer.takeShare({ session: victim.c.session, signers: list });
    assert.equal(answer.ok, false, `${what}: refused`);
    assert.equal(victim.h.signer.stateOf(victim.c.session), 'none', `${what}: the session is used up all the same`);
  }
  assert.equal(worked, 0, 'no share was computed for any of those lists');
});

test('#1155 the xs are in the binding factors: the same shares over a list whose xs were moved after R do not verify', async () => {
  const hs = [holder(1, [1, 2]), holder(2, [3]), holder(3, [4])];
  const wired = wire(hs);
  let wireList = null;
  const zs = [];
  const fetchFn = async (u, i) => { const r = await wired(u, i); if (!u.endsWith('/share')) return r; const a = await r.json(); wireList = JSON.parse(i.body).signers; zs.push(BigInt(`0x${a.z}`)); return { json: async () => a }; };
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn });
  assert.ok(got.ok, got.why);
  const groupPublicKey = Uint8Array.from([0x02, ...publicKey]);
  const commitments = (list) => list.map((s) => ({ id: s.id, hiding: fromHex(s.hiding), binding: fromHex(s.binding), xs: s.xs }));
  const signs = (list) => schnorr.verify(aggregate340({ commitments: commitments(list), message: digest, groupPublicKey, shares: zs, curve: feldmanGroup }).signature, digest, publicKey);
  assert.equal(signs(wireList), true, 'the list as signed');
  // the same union of x, 1..4, split another way between the nodes: the Lagrange set is unchanged and only the binding hash can tell
  const moved = wireList.map((s) => ({ ...s, xs: s.xs.length === 2 ? [s.xs[0]] : s.xs.includes(3) ? [2, 3] : s.xs }));
  assert.deepEqual(moved.flatMap((s) => s.xs).sort(), [1, 2, 3, 4]);
  assert.equal(signs(moved), false, 'a list whose xs moved is another signature');
  assert.notEqual(toHex(encodeCommitmentList(commitments(moved))), toHex(encodeCommitmentList(commitments(wireList))), 'the encoding names each node\'s xs');
  // a list without xs, as RFC 9591 and every one-share signer have it, encodes as before
  const plain = commitments(wireList).map(({ id, hiding, binding }) => ({ id, hiding, binding }));
  assert.equal(encodeCommitmentList(plain).length, plain.length * 98);
});

test('#1155 one session state, one way: none -> committed -> used, and a holder with no record of the key commits nothing', async () => {
  const h = holder(1, [1, 2]);
  const c = await h.signer.takeCommit({});
  assert.equal(c.bind, 1);
  assert.equal(h.signer.stateOf(c.session), 'committed');
  assert.equal(h.signer.stateOf('ab'.repeat(16)), 'none');
  await h.signer.takeShare({ session: c.session, signers: [] });
  assert.equal(h.signer.stateOf(c.session), 'none', 'used is gone from memory');
  assert.equal((await h.signer.takeShare({ session: c.session, signers: [] })).why, 'no such session here');
  const noRecord = createCensusSigner({ key: schnorr.getPublicKey(secret(30)), work: censusKeyWork, held: () => ({ shares: new Map([[1, share(1)]]) }), check: async () => ({ ok: true, digest, publicKey }) });
  assert.match((await noRecord.takeCommit({})).why, /no record of that key/);
  const otherKey = createCensusSigner({ key: schnorr.getPublicKey(secret(31)), work: censusKeyWork, held: () => ({ shares: new Map([[1, share(1)]]), record }), check: async () => ({ ok: true, digest, publicKey: schnorr.getPublicKey(secret(5)) }) });
  assert.match((await otherKey.takeCommit({})).why, /no record of that key/, 'a record of another key');
});

test('#1155 a filer leaves out a holder that does not bind its xs, and an x two holders both claim counts once', async () => {
  const old = holder(3, [5, 6]);
  const unbound = { ...old, signer: { ...old.signer, takeCommit: async (r) => { const c = await old.signer.takeCommit(r); delete c.bind; return c; } } };
  const hs = [holder(1, [1, 2]), unbound, holder(2, [3, 4])];
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs) });
  assert.ok(got.ok, got.why);
  assert.equal(got.shares, 4);
  assert.match(got.refused[0].why, /does not bind/);
  const twice = [holder(1, [1, 2]), holder(4, [2, 3])];
  const short = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: twice.map((h) => h.url), fetchFn: wire(twice) });
  assert.equal(short.ok, false, 'x 2 brought by two nodes counts once: 1, 2 of the first and nothing of the second');
});
