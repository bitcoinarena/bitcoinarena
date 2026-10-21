// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RISK OF DELETING AN ACCOUNT IS SAID AND SHOWN (2026-10-16: "this section should highlight the potential
// risk. maybe choosing red as text color in the button instead of white. also for the account section wording"). On the page's own
// markup and CSS: both delete buttons are danger buttons in red, and the section says in red what is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the card is React's (kanban #564, arena-web SettingsCards: AccountCard); the page keeps its section and the CSS
const CARDS = readFileSync(new URL('../../arena-web/src/arena/SettingsCards.jsx', import.meta.url), 'utf8');
const section = CARDS.slice(CARDS.indexOf('export class AccountCard'));

test('both delete buttons are red danger buttons', () => {
  assert.match(section, /<button id="arena-acct-delete" type="button" className="danger"/);
  assert.match(section, /<button id="arena-acct-go" type="button" className="primary danger" disabled=\{!saved\}/);
  assert.match(HTML, /<section class="settings-card" id="arena-set-account"><\/section>/);
  assert.match(HTML, /#arena-settings button\.danger \{ color: #ff6b6b;/);
  assert.match(HTML, /#arena-settings button\.danger\.primary \{ color: #fff; background: #c62828;/);
});

test('the section says in red, before any click, that the money is lost without the words or the key', () => {
  const risk = section.match(/<div className="risk" id="arena-acct-risk">([^<]+)<\/div>/);
  assert.ok(risk, 'a risk line');
  assert.match(risk[1], /24 words/); assert.match(risk[1], /Nostr key/); assert.match(risk[1], /lost/);
  // (2026-10-17): the warning moved BELOW the button, smaller and centered
  assert.ok(section.indexOf('id="arena-acct-risk"') > section.indexOf('id="arena-acct-delete"'), 'below the button');
  assert.match(HTML, /#arena-set-account #arena-acct-risk \{ margin: 10px auto 0; max-width: 34em; text-align: center; font-size: 12\.5px;/);
  assert.match(HTML, /#arena-set-account \.risk \{ color: #ff8a80;/);
});
