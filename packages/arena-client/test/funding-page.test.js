// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROJECT PROPOSALS FROM BITCOIN-ARENA.IO (2026-10-17: "Add a Project Proposals section to the website where people
// can comment and review"): what the homepage signs is what the seats read - a proposal and a comment verify with the seats' own
// reader; an nsec and its npub go both ways; a proposal is shown only when five nodes hold it, with every comment any of them holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signedProposal, signedComment, keyOfNsec, npubOf, npubOfKey, fetchProposals, postFunding, newProposalKey } from '../src/funding-page.js';
import { readSignedFunding } from '../../arena-protocol/src/funding.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (k) => schnorr.getPublicKey(k), signSchnorr: (m, k) => schnorr.sign(m, k) };
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NET = '1060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15';

test('a proposal and a comment signed on the homepage verify with the seats\' own reader, under the visitor\'s key', () => {
  const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: 156900, amountSats: 21000, lnurl: 'relay@example.org', purpose: 'Run a second relay' });
  const r = readSignedFunding('proposal', fromHex(p.hex), verify);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([toHex(r.id), toHex(r.obj.author), r.obj.amountSats, r.obj.lnurl], [p.id, toHex(schnorr.getPublicKey(sk)), 21000n, 'relay@example.org']);
  const c = signedComment({ curve, secretKey: sk, proposalId: p.id, atHeight: 156901, text: 'Who pays the server?' });
  const rc = readSignedFunding('comment', fromHex(c.hex), verify);
  assert.deepEqual([rc.ok, toHex(rc.id), rc.obj.text], [true, c.id, 'Who pays the server?']);
  const reply = signedComment({ curve, secretKey: sk, proposalId: p.id, parentId: c.id, atHeight: 156902, text: 'The proposal does.' });
  assert.equal(toHex(readSignedFunding('comment', fromHex(reply.hex), verify).obj.parentId), c.id);
});

test('an nsec names its key, and the npub is that key\'s', () => {
  const sk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const nsec = bech32Encode('nsec', convertBits(sk, 8, 5, true));
  assert.deepEqual(keyOfNsec(nsec), sk);
  assert.equal(npubOf(sk, curve), npubOfKey(toHex(schnorr.getPublicKey(sk))));
  assert.match(npubOf(sk, curve), /^npub1/);
  assert.throws(() => keyOfNsec(npubOf(sk, curve)), /not an nsec/);
});

test('shown when five of seven nodes hold it; its stage as most say; every comment any of them holds; posted to every node', async () => {
  const sk = newProposalKey(curve);
  const p = signedProposal({ curve, secretKey: sk, networkId: NET, publishedHeight: 156900, amountSats: 21000, lnurl: 'relay@example.org', purpose: 'Run a second relay' });
  const view = (state, comments = []) => ({ id: p.id, hex: p.hex, purpose: 'Run a second relay', amountSats: '21000', lnurl: 'relay@example.org', author: 'aa', network: NET,
    publishedHeight: 156900, signal: { state }, vote: null, signals: [], comments });
  const cm = { id: 'c1', parent: '00'.repeat(32), author: 'bb', atHeight: 156901, text: 'yes please' };
  const answers = [view('signalling', [cm]), view('signalling'), view('signalling'), view('passed'), view('signalling'), { proposals: [] }, null];
  const posted = [];
  const fetcher = async (url, o) => { const i = Number(new URL(url).port) - 9000;
    if (o && o.method === 'POST') { posted.push(i); return { ok: i < 3, status: i < 3 ? 200 : 503, json: async () => (i < 3 ? { ok: true } : { ok: false, why: 'down' }) }; }
    const a = answers[i]; if (a === null) throw new Error('down');
    return { ok: true, json: async () => (a.proposals ? { tip: 156905, proposals: a.proposals } : { tip: 156905, proposals: [a] }) }; };
  const nodes = Array.from({ length: 7 }, (_, i) => `http://127.0.0.1:${9000 + i}`);
  const r = await fetchProposals({ nodes, fetcher });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.proposals.length, r.proposals[0].signal.state, r.proposals[0].holding, r.proposals[0].comments.map((c) => c.text), r.tip], [1, 'signalling', 5, ['yes please'], 156905]);
  const four = await fetchProposals({ nodes: nodes.slice(0, 4), fetcher });
  assert.equal(four.ok, false, 'four answering is not enough');
  const sent = await postFunding({ nodes, kind: 'comment', hex: 'ab', fetcher });
  assert.deepEqual([sent.ok, sent.took, posted.length], [true, 3, 7]);
});

// PIP (2026-10-17): "Each item set to vote are prefixed with PIP"; "Users can sign in with their ingame key and their custom name or
// their generated name"; "Have custom names in the protocol"
test('PIP: numbered by publication; a player signs in with the in-game identity key and is shown its own name, else its generated one', async () => {
  const { signedName, forumIdentity, forumNameOf } = await import('../src/funding-page.js');
  const { identitySecretFor } = await import('../../arena-protocol/src/player-key.js');
  const { displayNameFromKey } = await import('../../arena-protocol/src/display-name.js');
  const seed = '11'.repeat(32);
  const me = forumIdentity(seed, curve);
  assert.equal(me.pubkey, toHex(schnorr.getPublicKey(identitySecretFor(fromHex(seed)))), 'the identity key the lobby and the board use');
  assert.equal(me.generated, displayNameFromKey(fromHex(me.pubkey)));
  const n = signedName({ curve, secretKey: me.secret, networkId: NET, name: 'Satoshi Fan', atMs: 1792240000000 });
  const r = readSignedFunding('name', fromHex(n.hex), verify);
  assert.deepEqual([r.ok, toHex(r.obj.player), r.obj.name], [true, me.pubkey, 'Satoshi Fan']);
  // three proposals at 7 nodes: PIP-1 is the earliest published; a forged name (another key's signature) is not shown
  const other = newProposalKey(curve), mk = (h, x) => signedProposal({ curve, secretKey: other, networkId: NET, publishedHeight: h, amountSats: 1000, lnurl: 'a@b.org', purpose: x });
  const ps = [mk(156900, 'B'), mk(156800, 'A'), mk(156950, 'C')].map((x) => ({ ...readSignedFunding('proposal', fromHex(x.hex), verify).obj, id: x.id, hex: x.hex }));
  const forged = (() => { const f = signedName({ curve, secretKey: other, networkId: NET, name: 'Not Me', atMs: 1792240000001 }); return f.hex; })();
  const view = (p) => ({ id: p.id, hex: p.hex, purpose: p.purpose, amountSats: '1000', lnurl: p.lnurl, author: toHex(p.author), network: NET, publishedHeight: p.publishedHeight, signal: { state: 'open' }, vote: null, comments: [] });
  const fetcher = async () => new Response(JSON.stringify({ tip: 157000, proposals: ps.map(view), names: [
    { player: me.pubkey, name: 'Satoshi Fan', atMs: '1792240000000', hex: n.hex },
    { player: me.pubkey, name: 'Not Me', atMs: '1792240000001', hex: forged } ] }), { status: 200 });
  const got = await fetchProposals({ nodes: Array.from({ length: 7 }, (_, i) => `https://n${i}.example`), fetcher, verify });
  assert.deepEqual(got.proposals.map((p) => [p.purpose, p.pip]), [['C', 3], ['B', 2], ['A', 1]]);
  assert.equal(forumNameOf(me.pubkey, got.names), 'Satoshi Fan', 'the forged newer record is not believed');
  assert.equal(forumNameOf(toHex(schnorr.getPublicKey(other)), got.names), displayNameFromKey(schnorr.getPublicKey(other)), 'no record: the generated name');
});
