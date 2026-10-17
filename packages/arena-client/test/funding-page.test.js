// PROJECT PROPOSALS FROM BITCOIN-ARENA.IO (kanban #397, the owner 2026-10-17: "Add a Project Proposals section to the website where people
// can comment and review"): what the homepage signs is what the seats read - a proposal and a comment verify with the seats' own
// reader; an nsec and its npub go both ways; a proposal is shown only when five nodes hold it, with every comment any of them holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
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
