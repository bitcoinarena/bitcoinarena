// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SETTINGS' OWN CARDS IN REACT (kanban #564): the name (Update only for a new one), the client logs said once copied, the seed card's
// backup line and restore answer, and the account card that says what the wallet holds and waits for "I have my 24 words".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NameCard, LogsCard, SeedCard, AccountCard, ConfirmedFederationsCard, CommunityCard, DonationCard, ItemsShareCard, DebugCard } from '../dist/test/settings.mjs';

const live = (C, props) => { const c = new C(props); c.setState = (u) => Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); return c; };
const html = (c) => renderToStaticMarkup(React.createElement(React.Fragment, null, c.render()));

test('the name: the current one shown, Update only for another, the lobby\'s answer said', () => {
  const said = [];
  const n = live(NameCard, { current: 'brave-otter-0042', onUpdate: (t) => { said.push(t); return ''; } });
  assert.match(html(n), /<input id="arena-name-field" type="text" autoComplete="off" spellCheck="false" maxLength="32" value="brave-otter-0042"\/><button id="arena-name-update" type="button" class="primary" disabled="">Update<\/button>/i);
  n.state.typed = ' satoshi ';
  assert.match(html(n), /<button id="arena-name-update" type="button" class="primary">Update<\/button>/);
  n.update();
  assert.deepEqual(said, ['satoshi']);
  assert.match(html(n), /<div class="muted">Updated\.<\/div>/);
});

test('the logs and the seed card: what the page answers is said', async () => {
  const l = live(LogsCard, { onCopy: async () => 'copied 412 lines' });
  await l.copy();
  assert.match(html(l), /<div class="muted">copied 412 lines<\/div>/);
  const s = live(SeedCard, { backup: '', onShow() {}, onRestore: (t) => (t === 'ok' ? { ok: true } : { ok: false, why: 'not 24 words' }) });
  assert.match(html(s), /<div class="muted" id="arena-settings-backup">This wallet is backed up\.<\/div><button id="arena-phrase-show" type="button" class="primary">Show seed phrase<\/button>/);
  s.state.text = 'x'; s.restore(); assert.match(html(s), /<div class="muted">not 24 words<\/div>/);
  s.state.text = 'ok'; s.restore(); assert.match(html(s), /<div class="muted">restored - reloading<\/div>/);
});

test('the account: the risk below the button, what it holds said, Delete only once the words are kept', () => {
  let gone = 0;
  const a = live(AccountCard, { who: 'This wallet\'s key is its 24 words, kept in this browser.', holds: () => 'This wallet holds 2,100 sat. Withdraw it first.',
    onDelete: () => ({ ok: true }), onDeleted: () => gone++ });
  let h = html(a);
  assert.ok(h.indexOf('id="arena-acct-risk"') > h.indexOf('id="arena-acct-delete"'), 'the risk line below the button');
  assert.match(h, /<button id="arena-acct-delete" type="button" class="danger">Delete this account from this browser<\/button>/);
  a.ask();
  h = html(a);
  assert.match(h, /<div class="risk">This wallet holds 2,100 sat\. Withdraw it first\.<\/div>/);
  assert.match(h, /<button id="arena-acct-go" type="button" class="primary danger" disabled="">Delete and log in again<\/button>/);
  a.state.saved = true; a.remove();
  assert.equal(gone, 1);
  assert.match(html(a), /Deleted from this browser - opening the start screen/);
});

test('the confirmed federations with Forget, none said; the community link; the donation and items shares as the page hands them; the debug switch', () => {
  const forgot = [];
  const h = (C, props) => renderToStaticMarkup(React.createElement(C, props));
  assert.match(h(ConfirmedFederationsCard, { list: [{ federation: 'ab'.repeat(32) }], onForget: (f) => forgot.push(f) }), /<div class="name-row"><code>abababababababab…<\/code><button type="button" data-federation="(ab){32}">Forget<\/button><\/div>/);
  assert.match(h(ConfirmedFederationsCard, { list: [], onForget() {} }), /<div class="muted">none<\/div>/);
  const f = new ConfirmedFederationsCard({ list: [{ federation: 'cd'.repeat(32) }], onForget: (x) => forgot.push(x) });
  f.render().props.children[2].props.children[0].props.children[1].props.onClick();
  assert.deepEqual(forgot, ['cd'.repeat(32)]);
  assert.match(h(CommunityCard, { href: 'https://armada.example/x' }), /<a id="arena-armada-link" href="https:\/\/armada\.example\/x" target="_blank" rel="noopener"/);
  assert.match(h(DonationCard, { pct: 2, recipients: 'to 3 developers', onChange() {} }), /<option value="2" selected="">2%<\/option>.*<div class="muted">to 3 developers<\/div>/);
  const items = h(ItemsShareCard, { share: 20, lead: 'Your share', what: 'A 500 sat item costs 550 sat', onChange() {} });
  assert.deepEqual([...items.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1])), [40, 30, 20, 10, 0]);
  assert.match(items, /<option value="20" selected="">20%<\/option>/);
  assert.match(h(DebugCard, { on: true, onToggle() {} }), /<input type="checkbox" id="arena-debug-feds" checked=""\/>/);
});
