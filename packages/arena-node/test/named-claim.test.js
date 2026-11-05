// THE NAMED CLAIM'S MUSIG2 (protocol 27, kanban #1044 B1): the seats' session math, held byte for byte to the fork's own output - the stake-lock
// tool's musig-keyagg / musig-nonce / musig-aggnonce / musig-partial / musig-aggregate (fedimint-lnv2-common arena_lock::musig, the musig2 crate),
// run on the claim keys of secrets 1..7, signers 0,2,3,5,6, message ab..ab, each seat's nonce seed 0x10+i || cd..cd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { NamedSession, namedKey, namedContext, sendRefundKey, signingSecret, checkSigners, aggregateNamed, partialStands, evenYKey, namedSignerSet } from '../src/named-claim.js';
import { nonceGen, sign, nonceAgg } from '../src/musig2.js';

const FORK = {
 "claimKeys": [
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
  "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4",
  "fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556",
  "5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"
 ],
 "signers": [
  0,
  2,
  3,
  5,
  6
 ],
 "message": "abababababababababababababababababababababababababababababababab",
 "aggKey": "1f0bf07ebf2a9b38b88a2a35ccca61ee1c383e6b25df6f606880300e1dac1ce3",
 "aggnonce": "0285745c143fac8ce19a85fbf3be4c8d18dd70215b06c77631f674239606d08a42023da5e3ecab6f43a2f6fe3e918f859fb0c13e788e6a57cff57b22c5d1a4eafb81",
 "signature": "06b0b6ddf9ac63ce336583acb14a025bf425a5b6ad0ced17aaa7def8248f47624c4075a28aeed837724c37368854dcc6f9918abd164cb7a3df3f744acca75410",
 "seats": [
  {
   "index": 0,
   "secret": "0000000000000000000000000000000000000000000000000000000000000001",
   "seed": "10cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
   "secnonce": "644ba5854ba1103ad4175b9b6170017aada81cecbad140b3d5a1af1824f62265fbb1433e6f9ea111b5fca025343d7ac1925af19f4942f40c7712cfea98cdb8990279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
   "pubnonce": "0296af7cd9f8f356b56e7d6e44ce1d2c40adf959325ceec6cbe98c2e267486b82a0350ac6e316fe5b900eb98de5445202082fe05b52baa1b1278fc983a0c1a9f41c6",
   "partial": "00a40f82a650c99ea2215e64af7a4eb54abf495a5ce52084788f94d962114be8"
  },
  {
   "index": 2,
   "secret": "0000000000000000000000000000000000000000000000000000000000000003",
   "seed": "12cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
   "secnonce": "9e6357c5531418f46f28eb2e307ddc0659b096f311b930f08aedfc67fe5017581c47584dc26dd23130daeb7a016ea5152e783282faf94658b3a3b7bd9731de3402f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
   "pubnonce": "0365eb02bc12b274291292b244edb5d3bd149ced48278406f72387d3a5df5e6933033094b0fe21d3547adbe85ac477cfc20931aadd1eea4eaa4193a48d03d36a9e54",
   "partial": "f30edf7db8aeea81f2fad2348a1a9ddde924c629e43e7652e9673e4832d5111d"
  },
  {
   "index": 3,
   "secret": "0000000000000000000000000000000000000000000000000000000000000004",
   "seed": "13cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
   "secnonce": "5e4654895bb6f15cc776f14f28e5516bec380885c23aaeb00cef603ca74d3b017f66dbe6f847e2552d2a4515e25c6d8e4a4d33a800a86fe6e7979cf65dad220302e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
   "pubnonce": "02529e5b0e9450ffebec6df1760e14762b5ea05a8601951c2326f0843914254e6f03327413060e42a8d7050b521c6809aa54c705c1c56c673396108f650d300caa1f",
   "partial": "fcf16e44af2997ffe9e9852da01020ee7805204977c6345eb6618eb10a3e90eb"
  },
  {
   "index": 5,
   "secret": "0000000000000000000000000000000000000000000000000000000000000006",
   "seed": "15cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
   "secnonce": "1a619aac734bf8d87eea462c6e8510f6702971fa25298b7d11d48cc710dbcace48800dcaf74948d27a8fd176cfbe7d831f4f94aa470bc6df6a81df05459107fb02fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556",
   "pubnonce": "03d4d59b57fe61aaf97aa639d2b6ec8665cee9c6a8c16e8d2b51874c122a49b96002f1e67927a12a1f1550e55380057a357816437fa98b6a8d5ca3e8baea625db457",
   "partial": "c269470468a893721d925769873e728c32d92afd301b1441932b607d2e239e89"
  },
  {
   "index": 6,
   "secret": "0000000000000000000000000000000000000000000000000000000000000007",
   "seed": "16cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
   "secnonce": "89089cc68c5a07e3b3da56afcd1073a4a74ee41aff7dfe3b2fb1014603fbeebdc7401a7cadae88185e739a6ed2ba692530157783b9ada22bf277810715f8b5f8025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc",
   "pubnonce": "026e0fab7b39268471cf1ed5e928b1d535e54040a3673086b38e0bb4f6628dfa1b03b7fd94e34b79c0e6ae90a1f646ca9b82b27cc68e8d482f18ab01cb5990adab82",
   "partial": "9932d159141cf8a4d5b42a0627715cb54adbc6a63b21b8df7332cda170018b5a"
  }
 ]
};
const h = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');
const KEYS = FORK.claimKeys.map(h);
const secret = (i) => h(i.toString(16).padStart(64, '0'));
const MSG = h(FORK.message);

test('the named set\'s key is the fork\'s KeyAgg (02 || x lifted, index order, no tweak)', () => {
  assert.equal(hex(namedKey(KEYS, 5, FORK.signers)), FORK.aggKey);
  assert.equal(hex(sendRefundKey(KEYS, 5, FORK.signers)), '02' + FORK.aggKey);
});

test('the fork\'s nonces, partials and signature come out of musig2.js byte for byte', () => {
  const ctx = namedContext(KEYS, 5, FORK.signers);
  for (const s of FORK.seats) {
    // NonceGen with the same seed, key, aggregate and message: the same secret and public nonce
    const g = nonceGen({ sk: signingSecret(h(s.secret)), pk: evenYKey(KEYS[s.index]), aggpk: h(FORK.aggKey), msg: MSG, rand: h(s.seed) });
    assert.equal(hex(g.pubnonce), s.pubnonce, `seat ${s.index} pubnonce`);
    assert.equal(hex(g.secnonce), s.secnonce, `seat ${s.index} secnonce`);
  }
  const aggnonce = nonceAgg(FORK.seats.map((s) => h(s.pubnonce)));
  assert.equal(hex(aggnonce), FORK.aggnonce);
  for (const s of FORK.seats) assert.equal(hex(sign(h(s.secnonce), signingSecret(h(s.secret)), ctx, aggnonce, MSG)), s.partial, `seat ${s.index} partial`);
  const got = aggregateNamed({ claimKeys: KEYS, threshold: 5, signers: FORK.signers, message: MSG, pubnonces: FORK.seats.map((s) => h(s.pubnonce)), partials: FORK.seats.map((s) => h(s.partial)) });
  assert.equal(got.ok, true);
  assert.equal(hex(got.signature), FORK.signature);
  assert.ok(schnorr.verify(got.signature, MSG, h(FORK.aggKey)));
});

test('a seat whose node key has an odd y signs with its negated secret', () => {
  const odd = [1, 2, 3, 4, 5, 6, 7].filter((i) => hex(signingSecret(secret(i))) !== hex(secret(i)));
  assert.ok(odd.length > 0 && odd.length < 7, `${odd.length} odd`);
});

/** One whole session among `set`, in-process: every seat's NamedSession, partials checked, the aggregate. */
function session(set, messages, rand = null) {
  const seats = set.map((i) => new NamedSession({ claimKeys: KEYS, threshold: 5, signers: set, me: i, secret: secret(i + 1), messages, rand }));
  const pubnonces = seats.map((s) => s.pubnonces);
  return messages.map((m, k) => {
    const partials = seats.map((s) => s.partial(k, pubnonces));
    return aggregateNamed({ claimKeys: KEYS, threshold: 5, signers: set, message: m, pubnonces: pubnonces.map((p) => p[k]), partials });
  });
}

test('a batch: the settlement and a send\'s auth and refund, each its own nonces; only the named set\'s key verifies', () => {
  const set = namedSignerSet({ committed: [6, 5, 3, 2, 0], threshold: 5 });
  assert.deepEqual(set, [0, 2, 3, 5, 6]);
  const msgs = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
  const sigs = session(set, msgs);
  const key = namedKey(KEYS, 5, set);
  sigs.forEach((s, k) => { assert.equal(s.ok, true); assert.ok(schnorr.verify(s.signature, msgs[k], key)); });
  for (const other of [[0, 1, 2, 3, 4], [1, 2, 3, 5, 6], [0, 2, 3, 4, 6]]) assert.equal(schnorr.verify(sigs[0].signature, msgs[0], namedKey(KEYS, 5, other)), false);
});

test('a secret nonce signs once; a bad partial is named; t-1, t+1, unsorted refused', () => {
  const set = [0, 1, 2, 3, 4], m = new Uint8Array(32).fill(9);
  const seats = set.map((i) => new NamedSession({ claimKeys: KEYS, threshold: 5, signers: set, me: i, secret: secret(i + 1), messages: [m] }));
  const pubnonces = seats.map((s) => s.pubnonces);
  const partials = seats.map((s) => s.partial(0, pubnonces));
  assert.throws(() => seats[0].partial(0, pubnonces), /used already/);
  const bad = partials.slice(); bad[2] = partials[3];
  const got = aggregateNamed({ claimKeys: KEYS, threshold: 5, signers: set, message: m, pubnonces: pubnonces.map((p) => p[0]), partials: bad });
  assert.equal(got.ok, false);
  assert.deepEqual(got.bad, [2]);
  assert.equal(partialStands({ claimKeys: KEYS, threshold: 5, signers: set, message: m, pubnonces: pubnonces.map((p) => p[0]), position: 3, partial: partials[3] }), true);
  // the next set after seat 2 dropped out
  assert.deepEqual(namedSignerSet({ committed: [0, 1, 2, 3, 4, 5], threshold: 5, dropped: [2] }), [0, 1, 3, 4, 5]);
  assert.equal(checkSigners(KEYS, 5, [0, 1, 2, 3]).ok, false);
  assert.equal(checkSigners(KEYS, 5, [0, 1, 2, 3, 4, 5]).ok, false);
  assert.equal(checkSigners(KEYS, 5, [1, 0, 2, 3, 4]).ok, false);
  assert.equal(checkSigners(KEYS, 5, [0, 1, 1, 3, 4]).ok, false);
  assert.throws(() => new NamedSession({ claimKeys: KEYS, threshold: 5, signers: set, me: 6, secret: secret(7), messages: [m] }), /not one of the named signers/);
  assert.throws(() => new NamedSession({ claimKeys: KEYS, threshold: 5, signers: set, me: 0, secret: secret(2), messages: [m] }), /not this seat/);
});
