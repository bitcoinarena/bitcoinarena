// WHERE A WINNER'S WINNINGS ARE SENT, THE PAGE'S HALF (ruled 2026-09-23), with stubs: a prompt that answers what it is
// told, a session key, a storage like the tab's, and signer nodes that answer 201 or are down. The same three cases the
// harness measures on real signer nodes (tools/winnings-page-probe.mjs):
//   A  an address named: asked once, signed over its UTF-8 bytes only, posted once to every node, kept with who took it.
//   B  nothing named (empty, cancelled, not an address): asked once, nothing kept, nothing posted - and after a reload
//      still asked zero more times.
//   C  a node down at the post: only the others take it; the reload asks nothing and posts the same bytes to that node
//      only, once.
// And no prompt at all for a wreck, a forfeit or a score below min_score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { askForWinnings, resendWinnings, winningsQualify, winningsAddressOf, WINNINGS_PROMPT,
  winningsAskedKey, winningsAddrKey } from '../src/winnings.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const NODES = ['https://a.example', 'https://b.example'];
const ADDRESS = 'winner@pay.example';

function tab() {
  const held = new Map();
  return { held, getItem: (k) => (held.has(k) ? held.get(k) : null), setItem: (k, v) => held.set(k, String(v)),
    get length() { return held.size; }, key: (i) => [...held.keys()][i] ?? null };
}
function nodes({ down = [] } = {}) {
  const posts = [];
  const fetcher = async (url, init) => {
    const u = new URL(url);
    const node = `${u.protocol}//${u.host}`;
    posts.push({ node, path: u.pathname, entry: u.searchParams.get('entry'), body: new Uint8Array(init.body) });
    if (down.includes(node)) throw new Error('connect ECONNREFUSED');
    return { status: 201 };
  };
  return { posts, fetcher, down };
}
function session() {
  const secret = ed25519.utils.randomSecretKey();
  const signed = [];
  const signAddress = async (address) => { const bytes = new TextEncoder().encode(address); signed.push(bytes); return ed25519.sign(bytes, secret); };
  return { pub: ed25519.getPublicKey(secret), signed, signAddress };
}
const runOf = (s, over = {}) => ({ roundHex: 'aa'.repeat(32), entryHex: 'bb'.repeat(32), word: 1, score: 179, minScore: 1,
  nodes: NODES, signAddress: s.signAddress, ...over });
function asking(answer) {
  const asked = [];
  return { asked, prompt: (text) => { asked.push(text); return answer; } };
}

test('A: a named address is asked once, signed over its bytes alone, posted once to every signer node, and kept with who took it', async () => {
  const storage = tab(); const s = session(); const n = nodes(); const p = asking(`  ${ADDRESS} `);
  const r = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: n.fetcher });
  console.log('  FACTS (A):', JSON.stringify({ r, asked: p.asked.length, posts: n.posts.map((x) => x.node) }));
  assert.deepEqual(p.asked, [WINNINGS_PROMPT], 'not asked exactly once, with the ruled text');
  assert.equal(r.named, true);
  assert.equal(r.address, ADDRESS, 'the address was not trimmed to what is signed');
  assert.deepEqual(s.signed.map((b) => new TextDecoder().decode(b)), [ADDRESS], 'something other than the address bytes was signed');
  assert.deepEqual(n.posts.map((x) => x.node).sort(), [...NODES].sort(), 'not one post to each signer node');
  for (const x of n.posts) {
    assert.equal(x.path, '/payout-address');
    assert.equal(x.entry, 'bb'.repeat(32));
    const addr = x.body.subarray(0, x.body.length - 64);
    assert.equal(new TextDecoder().decode(addr), ADDRESS);
    assert.equal(ed25519.verify(x.body.subarray(x.body.length - 64), addr, s.pub), true, 'the posted signature is not the session key\'s over the address');
  }
  const kept = JSON.parse(storage.getItem(winningsAddrKey('aa'.repeat(32), 'bb'.repeat(32))));
  assert.deepEqual(kept.acked.sort(), [...NODES].sort());
  // THE HOOK FIRES AGAIN (it does, twice per run) AND THE PAGE RELOADS: no prompt, no post.
  const again = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: n.fetcher });
  const reload = await resendWinnings({ storage, fetcher: n.fetcher });
  assert.equal(again.asked, false);
  assert.equal(p.asked.length, 1, 'asked a second time');
  assert.equal(n.posts.length, 2, 'posted again to a node that had taken it');
  assert.deepEqual(reload.map((x) => x.posted.length), [0]);
});

test('B: nothing named - empty, cancelled or not an address - is asked once, keeps nothing, posts nothing, and a reload asks nothing more', async () => {
  for (const answer of ['', null, '   ', 'not an address', 'winner@']) {
    const storage = tab(); const s = session(); const n = nodes(); const p = asking(answer);
    const r = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: n.fetcher });
    await resendWinnings({ storage, fetcher: n.fetcher });
    const reloaded = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: n.fetcher });
    assert.equal(r.asked, true);
    assert.equal(r.named, false, `${JSON.stringify(answer)} was taken as an address`);
    assert.equal(reloaded.asked, false, 'asked again after a reload');
    assert.equal(p.asked.length, 1);
    assert.equal(s.signed.length, 0, 'something was signed');
    assert.equal(n.posts.length, 0, 'something was posted');
    assert.deepEqual([...storage.held.keys()], [winningsAskedKey('aa'.repeat(32), 'bb'.repeat(32))], 'something beyond "asked" was kept');
  }
});

test('C: a signer node down at the post - the others take it; the reload asks nothing and posts the same bytes to that node only, once', async () => {
  const storage = tab(); const s = session(); const p = asking(ADDRESS);
  const first = nodes({ down: ['https://b.example'] });
  const r = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: first.fetcher });
  assert.deepEqual(r.acked, ['https://a.example']);
  assert.equal(r.complete, false);
  const firstBody = first.posts.find((x) => x.node === 'https://a.example').body;
  // RELOAD, B BACK UP.
  const later = nodes();
  const again = await askForWinnings({ run: runOf(s), prompt: p.prompt, storage, fetcher: later.fetcher });
  const sent = await resendWinnings({ storage, fetcher: later.fetcher });
  const once = await resendWinnings({ storage, fetcher: later.fetcher });
  console.log('  FACTS (C):', JSON.stringify({ firstAcked: r.acked, reloadPosts: later.posts.map((x) => x.node), sent, once }));
  assert.equal(again.asked, false);
  assert.equal(p.asked.length, 1, 'the reload asked again');
  assert.deepEqual(later.posts.map((x) => x.node), ['https://b.example'], 'the reload posted to a node that had taken it, or not to the one that had not');
  assert.equal(toHex(later.posts[0].body), toHex(firstBody), 'the reload posted other bytes than the first post');
  assert.equal(sent[0].complete, true);
  assert.deepEqual(once[0].posted, [], 'posted again once every node held it');
  assert.equal(s.signed.length, 1, 'signed again on the reload');
});

test('no prompt and no post for a wreck, a forfeit, or a score below min_score - and the address check is the door\'s', async () => {
  for (const over of [{ word: 2 }, { word: 3 }, { word: 0 }, { score: 4, minScore: 5 }]) {
    const storage = tab(); const s = session(); const n = nodes(); const p = asking(ADDRESS);
    const r = await askForWinnings({ run: runOf(s, over), prompt: p.prompt, storage, fetcher: n.fetcher });
    assert.equal(r.asked, false, `asked for ${JSON.stringify(over)}`);
    assert.equal(p.asked.length + n.posts.length + storage.held.size, 0);
  }
  assert.equal(winningsQualify({ word: 1, score: 5, minScore: 5 }), true, 'a score AT min_score qualifies');
  assert.equal(winningsAddressOf(' winner@pay.example '), 'winner@pay.example');
  assert.equal(winningsAddressOf('http://x'), null);
});
