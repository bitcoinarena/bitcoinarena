// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2641: the Armada community membership read for the bounty social bonus. A fake Armada community is built the way the Armada client builds
// it (owner list 33302 NIP-44 to itself with base64url fields, guestbook stream key from the root, wraps 1059 -> seals 20013 -> rumors 3306/3309/3312)
// with throwaway keys, and the reader must find joined members, drop leavers and kicked keys, ignore kicks by non-owners and forged seals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  armadaPubkeyOf, armadaMembers, armadaVerifier, armadaFromEnv, bech32Encode, secretKeyHexOf, pubkeyOf, conversationKey, nip44Encrypt, nip44Decrypt,
  signEvent, eventId, guestbookStream, communityIdOf,
} from '../src/bounty-armada.js';

const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => hex(schnorr.utils.randomSecretKey());
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
const T0 = 1762000000;

function rumor(pk, kind, content, tags, at, ms = 0) {
  const r = { kind, content, tags: [...tags, ['ms', String(ms)]], created_at: at, pubkey: pk }; r.id = eventId(r); return r;
}
function wrap(stream, memberSk, r, { forgeSig = false } = {}) {
  const seal = signEvent({ kind: 20013, content: nip44Encrypt(JSON.stringify(r), stream.convKey), tags: [], created_at: r.created_at }, memberSk);
  if (forgeSig) seal.sig = seal.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  return signEvent({ kind: 1059, content: nip44Encrypt(JSON.stringify(seal), stream.convKey), tags: [['p', pubkeyOf(rnd())]], created_at: r.created_at + 7 }, stream.sk);
}

function fakeArmada() {
  const ownerSk = rnd(), owner = pubkeyOf(ownerSk), salt = rnd(), root = rnd(), id = communityIdOf(owner, salt);
  const keys = Object.fromEntries(['alice', 'bob', 'carol', 'dave', 'eve', 'mallory'].map((n) => { const sk = rnd(); return [n, { sk, pk: pubkeyOf(sk) }]; }));
  const frag = { frags: 1, entries: [{ community_id: b64u(id), current: { owner: b64u(owner), owner_salt: b64u(salt), community_root: b64u(root), root_epoch: 0, control_pk: b64u(rnd()), control_root: b64u(rnd()), relays: ['wss://relay.example'], name: 'Bitcoin Arena' }, added_at: T0 }] };
  const list = signEvent({ kind: 33302, content: nip44Encrypt(JSON.stringify(frag), conversationKey(ownerSk, owner)), tags: [['d', '0']], created_at: T0 }, ownerSk);
  const gb = guestbookStream(root, id, 0n);
  const other = guestbookStream(rnd(), id, 0n); // a stream of some other community
  const { alice, bob, carol, dave, eve, mallory } = keys;
  const wraps = [
    wrap(gb, ownerSk, rumor(owner, 3306, 'join', [], T0)),
    wrap(gb, alice.sk, rumor(alice.pk, 3306, 'join', [['invite', owner, 'bounty']], T0 + 10)),
    wrap(gb, bob.sk, rumor(bob.pk, 3306, 'join', [], T0 + 20)),
    wrap(gb, bob.sk, rumor(bob.pk, 3306, 'leave', [], T0 + 30)),
    wrap(gb, carol.sk, rumor(carol.pk, 3306, 'join', [], T0 + 40)),
    wrap(gb, ownerSk, rumor(owner, 3309, '', [['p', carol.pk]], T0 + 50)),
    wrap(gb, dave.sk, rumor(dave.pk, 3306, 'join', [], T0 + 60)),
    wrap(gb, mallory.sk, rumor(mallory.pk, 3309, '', [['p', dave.pk]], T0 + 70)), // not the owner: no kick
    wrap(other, eve.sk, rumor(eve.pk, 3306, 'join', [], T0 + 80)), // other community's stream
    wrap(gb, eve.sk, rumor(eve.pk, 3306, 'join', [], T0 + 90), { forgeSig: true }), // forged seal
    { ...wrap(gb, mallory.sk, rumor(mallory.pk, 3306, 'join', [], T0 + 95)), pubkey: other.pk }, // relabelled wrap author
  ];
  const calls = [];
  const query = async (relays, filters) => {
    calls.push({ relays, filters });
    const out = [];
    for (const f of filters) for (const e of [list, ...wraps]) if (f.kinds.includes(e.kind) && (!f.authors || f.authors.includes(e.pubkey))) out.push(e);
    return out;
  };
  return { ownerSk, owner, id, keys, query, calls };
}

test('nip44 round trip and npub / nsec decoding (NIP-19 vectors)', async () => {
  assert.equal(await armadaPubkeyOf('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'), '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e');
  assert.equal(secretKeyHexOf('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5\n'), '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa');
  const pk = pubkeyOf(rnd());
  assert.equal(await armadaPubkeyOf(bech32Encode('npub', Buffer.from(pk, 'hex'))), pk);
  assert.equal(await armadaPubkeyOf(pk.toUpperCase()), pk);
  assert.equal(await armadaPubkeyOf('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptx'), null); // bad checksum
  assert.equal(await armadaPubkeyOf(bech32Encode('nsec', Buffer.from(pk, 'hex'))), null); // a secret key is not a member id
  assert.equal(await armadaPubkeyOf('not a key'), null);
  const ck = conversationKey(rnd(), pk);
  assert.equal(nip44Decrypt(nip44Encrypt('hello armada', ck), ck), 'hello armada');
});

test('NIP-05 name@domain resolves through nostr.json; failures give null', async () => {
  const pk = pubkeyOf(rnd()); const seen = [];
  const fetchFn = async (url) => { seen.push(url); return { ok: true, json: async () => ({ names: { bob: pk } }) }; };
  assert.equal(await armadaPubkeyOf('Bob@Example.com', { fetchFn }), pk);
  assert.equal(seen[0], 'https://example.com/.well-known/nostr.json?name=bob');
  assert.equal(await armadaPubkeyOf('carol@example.com', { fetchFn }), null);
  assert.equal(await armadaPubkeyOf('bob@example.com', { fetchFn: async () => { throw new Error('down'); } }), null);
});

test('the owner reads the guestbook: joined members in, leavers, kicked and outsiders out', async () => {
  const f = fakeArmada();
  const r = await armadaMembers({ secretKeyHex: f.ownerSk, relays: ['wss://a'], community: { d: '' }, query: f.query, detail: true });
  const { alice, bob, carol, dave, eve, mallory } = f.keys;
  assert.deepEqual([...r.members].sort(), [f.owner, alice.pk, dave.pk].sort());
  assert.equal(r.states.get(bob.pk).state, 'leave');
  assert.equal(r.states.get(carol.pk).state, 'kick');
  assert.equal(r.members.has(eve.pk), false);
  assert.equal(r.members.has(mallory.pk), false);
  assert.equal(r.undecryptable, 1); // the forged seal; the relabelled wrap is not this stream's and is never opened
  assert.equal(r.community.name, 'Bitcoin Arena');
  assert.equal(r.community.id, f.id);
  // only reads: the list by the owner, then wraps by the guestbook stream key, on the configured relays plus the community's own
  assert.deepEqual(f.calls[0].filters[0], { kinds: [33302], authors: [f.owner] });
  assert.deepEqual(f.calls[1].relays, ['wss://a', 'wss://relay.example']);
  assert.equal(f.calls[1].filters[0].kinds[0], 1059);
});

test('the community is picked by owner, id or name; a wrong id or a stranger key fails', async () => {
  const f = fakeArmada();
  assert.equal((await armadaMembers({ secretKeyHex: f.ownerSk, community: { author: f.owner, name: 'Bitcoin Arena' }, query: f.query })).size, 3);
  assert.equal((await armadaMembers({ secretKeyHex: f.ownerSk, community: { author: pubkeyOf(rnd()) }, query: f.query })).size, 3); // invite-link signer: ignored
  await assert.rejects(armadaMembers({ secretKeyHex: f.ownerSk, community: { id: 'ab'.repeat(32) }, query: f.query }), /not in the owner's list/);
  await assert.rejects(armadaMembers({ secretKeyHex: rnd(), community: {}, query: f.query }), /not in the owner's list/);
});

test('verifier: member / non-member / removed member, cached, errors answer null without secrets', async () => {
  const f = fakeArmada(); let reads = 0;
  const members = async (o) => { reads++; return armadaMembers({ ...o, query: f.query }); };
  const v = armadaVerifier({ secretKeyHex: f.ownerSk, community: {}, members });
  assert.deepEqual(await v({ userId: f.keys.alice.pk }), { member: true, why: 'in the community guestbook' });
  assert.equal((await v({ userId: f.keys.eve.pk })).member, false);
  assert.equal((await v({ userId: f.keys.carol.pk })).member, false); // kicked
  assert.equal((await v({ userId: f.keys.bob.pk })).member, false); // left
  assert.equal((await v({ userId: 'npub-not-hex' })).member, null);
  assert.equal(reads, 1);
  const bad = armadaVerifier({ secretKeyHex: f.ownerSk, members: async () => { throw new Error(`relay down for ${f.ownerSk}`); } });
  const a = await bad({ userId: f.keys.alice.pk });
  assert.equal(a.member, null);
  assert.ok(!a.why.includes(f.ownerSk));
});

test('armadaFromEnv: nsec file in bech32 or hex, relays list; missing file gives null', async () => {
  const f = fakeArmada();
  const nsec = bech32Encode('nsec', Buffer.from(f.ownerSk, 'hex'));
  assert.equal(armadaFromEnv({}), null);
  assert.equal(armadaFromEnv({ FAUCET_BOUNTY_ARMADA_NSEC_FILE: '/x' }, { readFn: () => 'garbage' }), null);
  assert.equal(armadaFromEnv({ FAUCET_BOUNTY_ARMADA_NSEC_FILE: '/x' }, { readFn: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(typeof armadaFromEnv({ FAUCET_BOUNTY_ARMADA_NSEC_FILE: '/x', FAUCET_BOUNTY_ARMADA_RELAYS: 'wss://a, wss://b' }, { readFn: () => `${nsec}\n` }), 'function');
  assert.equal(typeof armadaFromEnv({ FAUCET_BOUNTY_ARMADA_NSEC_FILE: '/x' }, { readFn: () => f.ownerSk }), 'function');
});
