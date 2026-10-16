// THE RISK OF DELETING AN ACCOUNT IS SAID AND SHOWN (kanban #380, the owner 2026-10-16: "this section should highlight the potential
// risk. maybe choosing red as text color in the button instead of white. also for the account section wording"). On the page's own
// markup and CSS: both delete buttons are danger buttons in red, and the section says in red what is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const section = HTML.slice(HTML.indexOf('<section class="settings-card" id="arena-set-account">'), HTML.indexOf('</section>', HTML.indexOf('id="arena-set-account"')));

test('both delete buttons are red danger buttons', () => {
  assert.match(section, /<button id="arena-acct-delete" type="button" class="danger">/);
  assert.match(section, /<button id="arena-acct-go" type="button" class="primary danger" disabled>/);
  assert.match(HTML, /#blwp-settings button\.danger \{ color: #ff6b6b;/);
  assert.match(HTML, /#blwp-settings button\.danger\.primary \{ color: #fff; background: #c62828;/);
});

test('the section says in red, before any click, that the money is lost without the words or the key', () => {
  const risk = section.match(/<div class="risk" id="arena-acct-risk">([^<]+)<\/div>/);
  assert.ok(risk, 'a risk line');
  assert.match(risk[1], /24 words/); assert.match(risk[1], /Nostr key/); assert.match(risk[1], /lost/);
  assert.ok(section.indexOf('arena-acct-risk') < section.indexOf('arena-acct-delete'), 'above the button');
  assert.match(HTML, /#arena-set-account \.risk \{ color: #ff8a80;/);
});
