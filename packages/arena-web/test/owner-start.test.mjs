// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S WAY IN IN REACT (kanban #564): the welcome's three ways; new words shown once with three typed back (a wrong one stops, a
// browser that keeps nothing says so); the restore by the words' checksum; Login with Nostr by an nsec and a new account (Continue only once
// the key is saved); the claim with the file's full path and the code; a one-card message with its buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerStart, OwnerMessage } from '../dist/test/owner-start.mjs';

const WORDS = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
function start(over = {}) {
  const calls = { kept: [], nostr: [], in: 0, claimed: [] };
  const client = { phraseFromSeed: () => ({ words: WORDS }), seedFromPhrase: (p) => (p.trim().split(/\s+/).length === 24 ? { ok: true, seed: 'S' } : { ok: false, why: 'it has the wrong number of words' }),
    signerFromNsec: (n) => { if (!/^nsec1/.test(n)) throw new Error('that is not an nsec'); return { secret: 'k', pubkey: 'p1' }; },
    newAccount: () => ({ nsec: 'nsec1new', signer: { secret: 'n', pubkey: 'p2' } }), toHex: (x) => 'hex:' + x };
  const props = { client, random32: () => 'R', keepSeed: (s) => (calls.kept.push(s), over.keeps !== false), keepNostr: (o) => (calls.nostr.push(o), true),
    claim: async (code) => { calls.claimed.push(code); if (code === 'BAD') throw new Error('that is not the claim code'); }, onIn: () => { calls.in++; }, ...over };
  const m = new OwnerStart(props);
  m.setState = (u, cb) => { Object.assign(m.state, typeof u === 'function' ? u(m.state) : u); if (cb) cb(); };
  return { m, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())) };
}

test('the welcome: three ways in', () => {
  const h = start().html();
  assert.match(h, /^<div class="card"><h3>Your owner key<\/h3><p>The owner of this node is a key made from <b>24 words<\/b>\./);
  assert.match(h, /<button type="button" class="primary">Create new 24 words<\/button><button type="button">I have my 24 words<\/button><button type="button">Login with Nostr<\/button><\/div>$/);
});

test('new words: shown once, three typed back - a wrong one stops; kept, then in; a browser that keeps nothing says so', () => {
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
  const private_ = start({ keeps: false });
  private_.m.make(); for (const i of private_.m.state.ask) private_.m.state.typed[i] = WORDS[i];
  private_.m.wrote();
  assert.equal(private_.m.state.err, 'This browser does not let the page keep them (private mode?).');
});

test('restore by the words; Login with Nostr by an nsec; a new account goes on only once its key is saved', () => {
  const s = start();
  s.m.go('restore'); s.m.state.phrase = 'one two'; s.m.restore();
  assert.equal(s.m.state.err, 'These are not your 24 words: it has the wrong number of words');
  s.m.state.phrase = WORDS.join(' '); s.m.restore();
  assert.deepEqual([s.calls.kept, s.calls.in], [['S'], 1]);
  const n = start();
  n.m.go('nostr'); n.m.state.nsec = 'npub1'; n.m.nsec();
  assert.equal(n.m.state.err, 'that is not an nsec');
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
  assert.deepEqual([s.m.state.err, s.m.state.busy, s.calls.in], ['that is not the claim code', false, 0]);
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
