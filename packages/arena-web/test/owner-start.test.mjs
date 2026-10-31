// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S WAY IN IN REACT (kanban #564): the welcome's three ways; new words shown once with three typed back (a wrong one stops);
// the secret handed to the page to hold, with where it stays said where it is typed (kanban #832); the restore by the words' checksum; Login with Nostr by an nsec and a new account (Continue only once
// the key is saved); the claim with the file's full path and the code; a one-card message with its buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerStart, OwnerMessage, stepOf, hashWith } from '../dist/test/owner-start.mjs';

const WORDS = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
function start(over = {}) {
  const calls = { kept: [], nostr: [], in: 0, claimed: [] };
  const client = { phraseFromSeed: () => ({ words: WORDS }), seedFromPhrase: (p) => (p.trim().split(/\s+/).length === 24 ? { ok: true, seed: 'S' } : { ok: false, why: 'it has the wrong number of words' }),
    signerFromNsec: (n) => { if (!/^nsec1/.test(n)) throw new Error('that is not an nsec'); return { secret: 'k', pubkey: 'p1' }; },
    newAccount: () => ({ nsec: 'nsec1new', signer: { secret: 'n', pubkey: 'p2' } }), toHex: (x) => 'hex:' + x };
  const props = { client, random32: () => 'R', holdSeed: (s) => { calls.kept.push(s); }, holdNostr: (o) => { calls.nostr.push(o); },
    claim: async (code) => { calls.claimed.push(code); if (code === 'BAD') throw new Error('that is not the claim code'); }, onIn: () => { calls.in++; }, ...over };
  const m = new OwnerStart(props);
  m.setState = (u, cb) => { Object.assign(m.state, typeof u === 'function' ? u(m.state) : u); if (cb) cb(); };
  return { m, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) };
}

test('a node that has an owner asks for its words or Nostr key and offers no new words (playtest 2026-10-25)', () => {
  const { m, html } = start({ claimed: true });
  const h = html();
  assert.match(h, /<h3>Sign in as this node.{1,6}s owner<\/h3><p>This node already has an owner\. Sign in with its 24 words or its Nostr key\.<\/p>/);
  assert.doesNotMatch(h, /Create new 24 words/, 'new words could never be this node\'s owner');
  assert.match(h, /id="owner-words">Sign in with your 24 words<\/button><button type="button">Sign in with Nostr<\/button>/);
  m.go('restore');
  assert.match(html(), /<h3>Sign in with your 24 words<\/h3>/);
  assert.match(html(), /<button type="submit" class="primary">Sign in<\/button>/);
});

test('the welcome: three ways in', () => {
  const h = start().html();
  assert.match(h, /^<div class="card"><h3>Your owner key<\/h3><p>The owner of this node is a key made from <b>24 words<\/b>\./);
  assert.match(h, /<button type="button" class="primary">Create new 24 words<\/button><button type="button">I have my 24 words<\/button><button type="button">Sign in with Nostr<\/button><\/div>$/);
});

test('new words: shown once, three typed back - a wrong one stops; held, then in', () => {
  const s = start();
  s.m.make();
  assert.equal(s.m.state.screen, 'make');
  assert.equal((s.html().match(/<span>w\d+<\/span>/g) || []).length, 24);
  assert.equal(s.m.state.ask.length, 3);
  for (const i of s.m.state.ask) s.m.state.typed[i] = WORDS[i];
  s.m.state.typed[s.m.state.ask[1]] = 'nope';
  s.m.wrote();
  assert.deepEqual([s.m.state.err, s.calls.kept.length], ['One of the three words is not right. Check what you wrote.', 0]);
  s.m.state.typed[s.m.state.ask[1]] = ' ' + WORDS[s.m.state.ask[1]].toUpperCase() + ' ';
  s.m.wrote();
  assert.deepEqual([s.calls.kept, s.calls.in], [['R'], 1]);
});

// WHERE THE SECRET STAYS (kanban #832): in the tab until the node confirms it, then in local storage, unencrypted - said on every screen that takes one
test('every screen that takes a secret says where it stays', () => {
  const where = /in this tab&#x27;s memory until your node confirms (them|it) as its owner\. Then this browser keeps (them|it) in its local storage, unencrypted, until you sign out\./;
  const s = start();
  s.m.go('restore'); assert.match(s.html(), where);
  s.m.go('nostr'); assert.match(s.html(), where);
  s.m.make(); assert.match(s.html(), where);
  s.m.go('nostr'); s.m.newAccount(); assert.match(s.html(), where);
  assert.match(start({ screen: 'claim', mine: 'k' }).html(), /Nothing is kept in this browser until the claim works/);
});

// A CLAIMED NODE (kanban #833): sign-in only - no new account, and no line promising that a key becomes the owner's
test('a claimed node: Nostr signs in only, no new account, no promise that a new key becomes the owner key', () => {
  const s = start({ claimed: true });
  s.m.go('nostr');
  const h = s.html();
  assert.match(h, /Sign in with the Nostr key that owns this node\./);
  assert.doesNotMatch(h, /Create an account/);
  assert.doesNotMatch(h, /becomes this node/);
  s.m.newAccount();
  assert.equal(s.m.state.screen, 'nostr', 'nothing else reaches the new-account screen');
  const open = start();
  open.m.go('nostr');
  assert.match(open.html(), /Create an account/, 'a node with no owner still offers it');
  assert.match(open.html(), /Your Nostr key becomes this node/);
});

test('restore by the words; Login with Nostr by an nsec; a new account goes on only once its key is saved', () => {
  const s = start();
  s.m.go('restore'); s.m.state.phrase = 'one two'; s.m.restore();
  assert.equal(s.m.state.err, 'Enter all 24 words (2 entered)');
  s.m.state.phrase = WORDS.join(' '); s.m.restore();
  assert.deepEqual([s.calls.kept, s.calls.in], [['S'], 1]);
  const n = start();
  n.m.go('nostr'); n.m.state.nsec = 'npub1'; n.m.nsec();
  assert.equal(n.m.state.err, 'That is not an nsec');
  n.m.state.nsec = 'nsec1abc'; n.m.nsec();
  assert.deepEqual([n.calls.nostr, n.calls.in], [[{ how: 'nsec', secret: 'hex:k' }], 1]);
  const a = start();
  a.m.go('nostr'); a.m.newAccount();
  assert.match(a.html(), /<div class="words"[^>]*>nsec1new<\/div>.*<button type="button" class="primary" disabled="">Continue<\/button>/);
  a.m.state.saved = true;
  assert.match(a.html(), /<button type="button" class="primary">Continue<\/button>/);
});

test('the claim: the file\'s full path, the code; a wrong code is said; the owner key under it', async () => {
  const s = start({ screen: 'claim', mine: 'ab'.repeat(32), claimFile: '/home/x/arena/node.db.owner-claim' });
  assert.match(s.html(), /<div class="path"><code>\/home\/x\/arena\/node\.db\.owner-claim<\/code><button type="button">Copy<\/button><\/div>.*<b>abab/);
  s.m.state.code = 'BAD'; await s.m.claim();
  assert.deepEqual([s.m.state.err, s.m.state.busy, s.calls.in], ['That is not the claim code', false, 0]);
  s.m.state.code = 'GOOD-CODE'; await s.m.claim();
  assert.deepEqual([s.calls.claimed, s.calls.in], [['BAD', 'GOOD-CODE'], 1]);
  assert.match(start({ screen: 'claim', mine: 'k' }).html(), /<code>&lt;database&gt;\.owner-claim<\/code>, beside the node&#x27;s database/);
});

test('a one-card message with its error and buttons', () => {
  let again = 0;
  const h = renderToStaticMarkup(React.createElement(OwnerMessage, { title: 'Could not sign in', err: 'no answer', buttons: [{ label: 'Try again', onClick: () => again++ }] }));
  assert.equal(h, '<div class="card"><h3>Could not sign in</h3><p class="err">no answer</p><button type="button">Try again</button></div>');
  new OwnerMessage({ title: 't', buttons: [{ label: 'Try again', onClick: () => again++ }] }).render().props.children[3][0].props.onClick();
  assert.equal(again, 1);
});

// ONE VERB (kanban #839): Sign in on a node with an owner and for Nostr everywhere; Restore only where there is no owner yet
test('the wording: Sign in; Restore only with no owner; no Login, no Log in', () => {
  const open = start();
  open.m.go('restore');
  assert.match(open.html(), /<h3>Restore from your 24 words<\/h3>/);
  assert.match(open.html(), /<button type="submit" class="primary">Restore<\/button>/);
  for (const claimed of [true, false]) {
    const s = start({ claimed });
    const pages = [s.html()];
    s.m.go('nostr'); pages.push(s.html());
    s.m.go('restore'); pages.push(s.html());
    for (const h of pages) assert.doesNotMatch(h, /Login with|Log in with/);
    assert.match(pages[1], /<h3>Sign in with Nostr<\/h3>/);
    assert.match(pages[1], />Sign in with the nsec<\/button>/);
    if (claimed) assert.doesNotMatch(pages.join(''), /Restore/);
  }
});

// ENTER SUBMITS (kanban #840): each way in is a form, its button a submit; in the words Enter is a new line until all 24 are there
test('every field is in a form that submits its own action', () => {
  const s = start();
  const form = (m, i = 0) => { const found = []; const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && n.props) { if (n.type === 'form') found.push(n); walk(n.props.children); } }; walk(m.render()); return found[i]; };
  const press = (f) => { let stopped = 0; f.props.onSubmit({ preventDefault: () => stopped++ }); assert.equal(stopped, 1, 'the page does not navigate'); };
  s.m.go('restore'); s.m.state.phrase = ''; press(form(s.m));
  assert.equal(s.m.state.err, 'Enter all 24 words (0 entered)');
  s.m.go('nostr'); s.m.state.bunker = 'x';
  s.m.state.nsec = 'npub1'; press(form(s.m, 1));
  assert.equal(s.m.state.errAt, 'nsec');
  const c = start({ screen: 'claim', mine: 'k' });
  c.m.state.code = 'GOOD'; press(form(c.m));
  assert.deepEqual(c.calls.claimed, ['GOOD']);
  const key = (over) => { const e = { key: 'Enter', preventDefault() { this.stopped = true; }, ...over }; s.m.phraseKey(e); return !!e.stopped; };
  s.m.go('restore');
  s.m.state.phrase = 'one two';
  assert.deepEqual([key({}), key({ shiftKey: true })], [false, false], 'a new line while words are missing');
  assert.equal(key({ ctrlKey: true }), true);
  assert.equal(s.m.state.err, 'Enter all 24 words (2 entered)');
  s.m.state.phrase = WORDS.join(' ');
  assert.equal(key({}), true, 'all 24: Enter submits');
  assert.deepEqual(s.calls.kept, ['S']);
});

// EACH ERROR AT ITS FIELD (kanban #841): an alert beside the control, gone on edit and on another way in, capitalised, one ellipsis
test('an error sits at its field, is an alert, and clears on edit or on another way in', async () => {
  const s = start();
  s.m.props.client.bunkerSigner = async () => { throw new Error('that is not a bunker:// link or a name with a bunker'); };
  s.m.props.client.extensionSigner = async () => { throw new Error('no Nostr extension in this browser (Alby, nos2x...): install one'); };
  s.m.go('nostr');
  await s.m.bunkerLink();
  assert.equal(s.m.state.err, 'That is not a bunker:// link or a name with a bunker');
  const alerts = () => [...s.html().matchAll(/<div class="err field-err" role="alert">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(alerts(), ['', 'That is not a bunker:// link or a name with a bunker', ''], 'signer, bunker, nsec: only its own slot');
  assert.ok(s.html().indexOf('Connect the bunker') > s.html().indexOf('That is not a bunker'), 'above its own button');
  s.m.edit('nsec', 'n');
  assert.deepEqual(alerts(), ['', '', ''], 'editing another field clears it');
  await s.m.bunkerLink();
  globalThis.window = {};
  await s.m.extension();
  delete globalThis.window;
  assert.deepEqual(alerts(), ['No Nostr extension in this browser (Alby, nos2x…): install one', '', ''], 'another way in moves it, one ellipsis');
  s.m.go('restore'); s.m.restore();
  assert.equal(s.m.state.err, 'Enter all 24 words (0 entered)');
  s.m.edit('phrase', 'w');
  assert.equal(s.m.state.err, '');
  s.m.state.phrase = WORDS.join(' ');
  s.m.props.client.seedFromPhrase = () => ({ ok: false, why: 'word 3 is not in the wordlist' });
  s.m.restore();
  assert.equal(s.m.state.err, 'Check your words: word 3 is not in the wordlist');
});

// LABELS (kanban #842): each input named by a linked label, the QR by text
test('every field has a linked label, and the QR a name', () => {
  const s = start();
  const linked = (h) => { const inputs = [...h.matchAll(/<(?:input|textarea)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]); assert.ok(inputs.length); for (const id of inputs) assert.match(h, new RegExp(`<label for="${id}">`), id); assert.doesNotMatch(h.replace(/<input[^>]*type="checkbox"[^>]*>/g, ''), /<(?:input|textarea)(?![^>]*\bid=)/); };
  s.m.go('restore'); linked(s.html());
  s.m.go('nostr'); linked(s.html());
  s.m.make(); linked(s.html());
  linked(start({ screen: 'claim', mine: 'k' }).html());
  s.m.go('nostr', { qr: '<svg></svg>', uri: 'nostrconnect://x' });
  assert.match(s.html(), /<div role="img" aria-label="Nostr Connect QR code"[^>]*><svg>/);
});

// THE SUB-SCREENS IN THE ADDRESS (kanban #843): step= beside the node's part, an entry per screen; the page's Back and the browser's agree
test('stepOf and hashWith keep the node\'s part of the #', () => {
  const key = 'ab'.repeat(32);
  assert.equal(stepOf(''), 'welcome');
  assert.equal(stepOf('#overview'), 'welcome');
  assert.equal(stepOf(`#node=${key}&step=restore`), 'restore');
  assert.equal(hashWith(`#node=${key}`, 'nostr'), `#node=${key}&step=nostr`);
  assert.equal(hashWith(`#node=${key}&step=nostr`, 'welcome'), `#node=${key}`);
  assert.equal(hashWith('#step=restore', 'welcome'), '');
  const url = 'https://n.example/a', h = hashWith('#' + new URLSearchParams({ node: key, url }), 'restore');
  assert.equal(new URLSearchParams(h.slice(1)).get('url'), url);
});

test('Back and Forward step through the sub-screens; a typed secret never reaches the address', () => {
  const tab = { entries: [{ hash: '', state: null }], at: 0 };
  const now = () => tab.entries[tab.at];
  globalThis.location = { pathname: '/owner/', search: '', get hash() { return now().hash; } };
  globalThis.history = { get state() { return now().state; }, pushState(st, _t, url) { tab.entries = tab.entries.slice(0, tab.at + 1); tab.entries.push({ state: st, hash: url.split('#')[1] ? '#' + url.split('#')[1] : '' }); tab.at++; }, back() { tab.at--; m.follow(); } };
  let m;
  try {
    const s = start(); m = s.m;
    s.m.go('nostr');
    assert.equal(location.hash, '#step=nostr');
    s.m.state.nsec = 'nsec1secret';
    s.m.newAccount();
    assert.equal(location.hash, '#step=account');
    s.m.leave('nostr');
    assert.deepEqual([s.m.state.screen, location.hash, s.m.state.nsec], ['nostr', '#step=nostr', ''], 'one step back, not a new entry');
    assert.equal(tab.entries.length, 3);
    s.m.leave('welcome');
    assert.deepEqual([s.m.state.screen, location.hash, s.m.depth], ['welcome', '', 0]);
    tab.at = 2; s.m.follow();
    assert.equal(s.m.state.screen, 'account', 'Forward finds the key shown');
    assert.doesNotMatch(JSON.stringify(tab.entries), /secret|nsec1/);
    const claimed = start({ claimed: true });
    tab.entries = [{ hash: '#step=account', state: null }]; tab.at = 0;
    claimed.m.follow();
    assert.equal(claimed.m.state.screen, 'welcome', 'a claimed node never shows the new-account screen');
    tab.entries = [{ hash: '#step=restore', state: { ownerDepth: 1 } }];
    const reload = start({ screen: 'welcome' });
    assert.deepEqual([reload.m.state.screen, reload.m.depth], ['restore', 1], 'a reload stays on its screen');
    tab.entries = [{ hash: '#step=make', state: null }];
    assert.equal(start({ screen: 'welcome' }).m.state.screen, 'welcome', 'new words are not in the address, so that step shows the welcome');
    tab.entries = [{ hash: '#step=restore', state: null }];
    const claim = start({ screen: 'claim', mine: 'k' });
    assert.equal(claim.m.state.screen, 'claim');
    claim.m.follow();
    assert.equal(claim.m.state.screen, 'claim', 'the page answers Back on the claim');
  } finally { delete globalThis.location; delete globalThis.history; }
});
