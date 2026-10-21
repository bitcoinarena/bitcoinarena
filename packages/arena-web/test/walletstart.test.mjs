// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET SCREEN IN REACT (kanban #564): Create, Restore and Login with Nostr; Create that fails says why on the busy line; Restore
// says the page's answer; a Nostr way in runs the page's login with the signer it makes, saying each step with a ring; a new account's
// key is shown and Continue waits for "I saved my key"; a failed step says why under the pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalletStart } from '../dist/test/walletstart.mjs';

const live = (props) => { const w = new WalletStart(props); w.setState = (u) => Object.assign(w.state, typeof u === 'function' ? u(w.state) : u); return w; };
const html = (w) => renderToStaticMarkup(w.render());
const noNostr = { load: async () => ({}) };

test('the three ways in, and Create: straight on, or why it cannot on the busy line', () => {
  const h = renderToStaticMarkup(React.createElement(WalletStart, { create: () => ({ ok: true }), restore: () => ({ ok: true }), nostr: noNostr }));
  assert.match(h, /<h2 id="ws-title">Your wallet<\/h2>/);
  assert.match(h, /<button type="button" class="primary">Create a new wallet<small>Ready at once - back up its 24 words any time in Settings<\/small><\/button>/);
  assert.match(h, />Restore a wallet<small>Your 24 words, or your seed<\/small>/);
  assert.match(h, /class="nostr">Login with Nostr</);
  assert.match(h, /<div id="ws-busy" class="ws-note" style="display:none"><\/div>/);
  assert.match(h, /Join the community on Armada/);
  let made = 0;
  const w = live({ create: () => { made++; return { ok: false, why: 'This browser cannot keep a wallet: no storage' }; }, restore() {}, nostr: noNostr });
  w.create();
  assert.equal(made, 1);
  assert.match(html(w), /<div id="ws-busy" class="ws-note">This browser cannot keep a wallet: no storage<\/div>/);
});

test('Restore: the page\'s answer under the words', () => {
  const asked = [];
  const w = live({ create() {}, restore: (t) => { asked.push(t); return t === 'good' ? { ok: true } : { ok: false, why: 'those are not 24 words of the list' }; }, nostr: noNostr });
  w.pane('restore'); w.state.text = 'bad';
  w.restore();
  assert.match(html(w), /<div class="ws-why">those are not 24 words of the list<\/div>/);
  w.state.text = 'good'; w.restore();
  assert.match(html(w), /<div class="ws-why">restored - opening your wallet<\/div>/);
  assert.deepEqual(asked, ['bad', 'good']);
});

test('a Nostr way in: the page\'s login with the signer, each step said with a ring and its seconds; a refusal said under the pane', async () => {
  const steps = [];
  const signer = { pubkey: 'ab' };
  const nostr = { load: async () => ({}), extension: async () => signer,
    login: async (s, how, made, say) => { steps.push([s === signer, how, made]); say('Reading your wallet from Nostr…'); } };
  const w = live({ create() {}, restore() {}, nostr });
  w.pane('nostr');
  await w.attempt('extension', () => nostr.extension());
  clearInterval(w.tick);
  assert.deepEqual(steps, [[true, 'extension', null]]);
  assert.match(html(w), /<div id="ws-busy" class="ws-note on"><span class="ws-spin" aria-hidden="true"><\/span><span class="ws-step">Reading your wallet from Nostr…<\/span><span class="ws-secs"><\/span><\/div>/);
  const no = live({ create() {}, restore() {}, nostr: { load: async () => ({}), nsec: async () => { throw new Error('that is not an nsec'); }, login() {} } });
  no.pane('nostr');
  await no.attempt('nsec', () => no.props.nostr.nsec('x'));
  assert.match(html(no), /<div class="ws-why">that is not an nsec<\/div>/);
  assert.equal(no.state.working, false, 'the buttons are back');
});

test('a new account: the key shown, Continue only once it is saved, the name published, then the page\'s login as new', async () => {
  const done = [];
  const fresh = { nsec: 'nsec1test', signer: { pubkey: 'cd' } };
  const nostr = { load: async () => ({}), newAccount: () => fresh, publish: async (s, n) => done.push(['publish', n]), login: async (s, how, made) => done.push(['login', how, made]) };
  const w = live({ create() {}, restore() {}, nostr });
  await w.newAccount();
  let h = html(w);
  assert.match(h, /<div class="ws-key">nsec1test<\/div>/);
  assert.match(h, /<button type="button" class="primary" disabled="">Continue<\/button>/);
  w.state.saved = true; w.state.name = ' satoshi ';
  assert.match(html(w), /<button type="button" class="primary">Continue<\/button>/);
  await w.createAccount();
  clearInterval(w.tick);
  assert.deepEqual(done, [['publish', 'satoshi'], ['login', 'new', { name: 'satoshi' }]]);
});
