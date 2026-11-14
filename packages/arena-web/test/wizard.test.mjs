// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S STEPS IN REACT (kanban #564): rendered on the server for what they show, and their classes driven for what they do -
// the roles as tiles (game / verify and settlement on for a new node, custody and liquidity chosen on purpose), the words shown then taken
// off the screen before they are asked back, the emergency code, the owner login, and the rules typed back - against the installer's doors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RolesStep, AppsStep, SeedStep, OwnerStep, StartStep, START_WAYS, startWayOf, PromiseStep, onAtStart, OPT_IN_ROLES, appOnAtStart, StepBar, SetupRefused } from '../dist/test/wizard.mjs';

const roleInfo = {
  verify: { title: 'Game / verify', does: 'replays and signs rounds', chips: ['🔒 bond', '🌐 https address'], needs: 'Replays each round it is seated on.', slice: 1 },
  settlement: { title: 'Settlement', does: 'pays the winners out', chips: ['🔒 bond'], needs: 'Pays the round out.', slice: 1 },
  custody: { title: 'Custody', does: 'holds the players\' bitcoin', chips: ['⚡ LND', '🚪 port 9735'], needs: 'Holds the players\' bitcoin.', slice: 1 },
  liquidity: { title: 'Liquidity', does: 'lends inbound capacity', chips: ['💰 500,000 sat'], needs: 'Opens channels to new nodes.', slice: 1 },
};
/** The class run without a DOM: setState applied at once (and its callback run), so each step can be checked. */
function driven(Step, props) {
  const c = new Step(props);
  c.setState = (u, after) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); if (after) after(); };
  return c;
}

test('roles: four tiles, game / verify and settlement on for a new node, the opt-in roles marked, a saved choice shown as saved', () => {
  const html = renderToStaticMarkup(React.createElement(RolesStep, { st: { roleInfo, roles: [] }, post: async () => ({}), reload() {} }));
  assert.equal((html.match(/class="tile[ "]/g) || []).length, 4);
  assert.match(html, /class="tile on" id="role-verify"/); assert.match(html, /class="tile on" id="role-settlement"/);
  assert.match(html, /class="tile" id="role-custody"/); assert.match(html, /class="tile" id="role-liquidity"/);
  assert.equal((html.match(/needs coins \+ LND/g) || []).length, 2, 'custody and liquidity say what they need');
  assert.match(html, /<details class="more"><summary>more<\/summary>/, 'the prose behind "more"');
  assert.deepEqual(OPT_IN_ROLES, ['custody', 'liquidity']);
  assert.deepEqual(Object.keys(roleInfo).filter((k) => onAtStart(k, [])), ['verify', 'settlement']);
  assert.deepEqual(Object.keys(roleInfo).filter((k) => onAtStart(k, ['custody', 'verify'])), ['verify', 'custody']);
});

test('roles: a switch flipped, the custody picture told, Save posts the roles that are on and moves on; a refusal is shown', async () => {
  const posts = []; let reloaded = 0; const custody = [];
  const c = driven(RolesStep, { st: { roleInfo, roles: [] }, post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload: () => { reloaded++; }, onCustody: (on) => custody.push(on) });
  c.componentDidMount();
  c.toggle('custody', true);
  assert.deepEqual(custody, [false, true]);
  await c.save();
  // custody switched on is checked at once (kanban #641), then Save posts the roles
  assert.deepEqual(posts, [['/api/roles/check', { roles: ['verify', 'settlement', 'custody'] }], ['/api/roles', { roles: ['verify', 'settlement', 'custody'], hostGroup: '' }]]); assert.equal(reloaded, 1);
  const d = driven(RolesStep, { st: { roleInfo, roles: ['verify'] }, post: async () => ({ ok: false, why: 'custody needs your own Bitcoin Core' }), reload() {} });
  await d.save();
  assert.match(renderToStaticMarkup(d.render()), /class="msg bad"[^>]*>custody needs your own Bitcoin Core/);
});

test('seed: the words shown, then off the screen before three are asked back; then on to the emergency code\'s own step; a wrong word starts again', async () => {
  const words = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
  const posts = []; let reloaded = 0;
  const answer = { '/api/seed/new': { ok: true, words, positions: [3, 11, 20] }, '/api/seed/confirm': { ok: true, emergencyCode: 'ARENA-7Q2X-K9PL' } };
  const c = driven(SeedStep, { post: async (p, b) => { posts.push([p, b]); return answer[p]; }, reload: () => { reloaded++; } });
  await c.show();
  let html = renderToStaticMarkup(c.render());
  assert.equal((html.match(/<span><b>\d+<\/b>w\d+<\/span>/g) || []).length, 24);
  c.written();
  html = renderToStaticMarkup(c.render());
  assert.doesNotMatch(html, /<b>1<\/b>w1/, 'the words are gone from the screen');
  assert.deepEqual((html.match(/id="cw-(\d+)"/g) || []), ['id="cw-3"', 'id="cw-11"', 'id="cw-20"']);
  c.setState({ answers: { 3: 'w3', 11: 'w11', 20: 'w20' } });
  await c.confirm();
  assert.deepEqual(posts[1], ['/api/seed/confirm', { answers: { 3: 'w3', 11: 'w11', 20: 'w20' } }]);
  assert.equal(reloaded, 1, 'confirmed: the wizard goes on - the emergency code has its own step (kanban #647)');
  assert.doesNotMatch(renderToStaticMarkup(c.render()), /ARENA-7Q2X-K9PL/);
  const w = driven(SeedStep, { post: async () => ({ ok: false, why: 'word 11 is not right', wrong: true }), reload() {} });
  w.setState({ phase: 'confirm', positions: [3, 11, 20] });
  await w.confirm();
  assert.equal(w.state.phase, 'start');
  assert.match(renderToStaticMarkup(w.render()), /id="seed-show"[\s\S]*word 11 is not right/);
});

test('owner: the 24 words by default, Nostr with an npub (from the extension), each posted to /api/owner', async () => {
  const posts = []; let reloaded = 0;
  const c = driven(OwnerStep, { post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload: () => { reloaded++; }, nostr: { getPublicKey: async () => 'npub1abc' } });
  assert.match(renderToStaticMarkup(c.render()), /<label class="choice on"><input type="radio" name="om" checked="" value="seed"\/>/);
  await c.fromExtension();
  assert.deepEqual([c.state.mode, c.state.npub], ['nostr', 'npub1abc']);
  assert.match(renderToStaticMarkup(c.render()), /id="npub"[^>]*value="npub1abc"/);
  await c.save();
  assert.deepEqual(posts, [['/api/owner', { mode: 'nostr', npub: 'npub1abc' }]]); assert.equal(reloaded, 1);
  const n = driven(OwnerStep, { post: async () => ({}), reload() {}, nostr: null });
  await n.fromExtension();
  assert.match(n.state.msg.text, /no Nostr extension/);
});

// KANBAN #648: the first step as the player page's wallet screen - a new seed, my Nostr identity (the nsec, or an extension / phone
// signer as owner only), a new Nostr identity, restore - each saying who the owner becomes; "Use another Nostr key as owner" keeps the npub
test('#648 start: the player page\'s four choices, each posted to /api/start with the owner it names', async () => {
  assert.deepEqual(START_WAYS.map(([k]) => k), ['new', 'nostr', 'newnostr', 'restore']);
  const html = renderToStaticMarkup(React.createElement(StartStep, { st: {}, post: async () => ({}), reload() {} }));
  for (const t of ['Create a new seed', 'Use my Nostr identity', 'Create a new Nostr identity', 'Restore my node']) assert.ok(html.includes(t), t);
  assert.match(html, /id="start-owner"[\s\S]*Owner login:[\s\S]*your 24 words[\s\S]*no separate owner step[\s\S]*Use another Nostr key as owner/);
  const posts = []; let reloaded = 0;
  const make = (st = {}) => driven(StartStep, { st, post: async (p, b) => { posts.push([p, b]); return p === '/api/start/nsec' ? { ok: true, nsec: 'nsec1made' } : { ok: true }; }, reload: () => { reloaded++; }, nostr: { getPublicKey: async () => 'ab'.repeat(32) } });
  // a new seed
  let c = make(); assert.equal(c.ready(), true); await c.go();
  assert.deepEqual(posts.pop(), ['/api/start', { control: 'words', action: 'new', ownerNpub: undefined }]);
  // ... with another Nostr key as owner: Continue waits for the key
  c = make(); c.setState({ other: true }); assert.equal(c.ready(), false);
  await c.fromExtension(); assert.equal(c.ready(), true);
  assert.match(renderToStaticMarkup(c.render()), /the Nostr key <code>abababababab…ababab<\/code>, and only it/);
  await c.go(); assert.deepEqual(posts.pop(), ['/api/start', { control: 'words', action: 'new', ownerNpub: 'ab'.repeat(32) }]);
  // my Nostr identity: the nsec runs the node
  c = make(); c.setState({ way: 'nostr' }); assert.equal(c.ready(), false);
  assert.match(renderToStaticMarkup(c.render()), /id="start-nsec"[\s\S]*owner only/);
  c.setState({ nsec: 'nsec1abc' }); await c.go();
  assert.deepEqual(posts.pop(), ['/api/start', { control: 'nostr', action: 'new', nsec: 'nsec1abc', ownerNpub: undefined }]);
  // ... or an extension / phone signer: owner only, the node gets 24 words of its own
  c = make(); c.setState({ way: 'nostr', how: 'signer' }); assert.equal(c.ready(), false);
  let h = renderToStaticMarkup(c.render());
  assert.match(h, /cannot run your node/); assert.doesNotMatch(h, /Use another Nostr key as owner/, 'it is the other key already');
  c.setState({ npub: 'npub1someone' });
  assert.match(renderToStaticMarkup(c.render()), /the Nostr key <code>npub1someone<\/code>\. Your node gets its own 24 words/);
  await c.go(); assert.deepEqual(posts.pop(), ['/api/start', { control: 'words', action: 'new', ownerNpub: 'npub1someone' }]);
  // a new Nostr identity: shown, "I saved my key" before Continue
  c = make(); c.setState({ way: 'newnostr' }); await c.makeKey();
  assert.match(renderToStaticMarkup(c.render()), /id="start-made"[\s\S]*nsec1made[\s\S]*I saved my key/);
  assert.equal(c.ready(), false); c.setState({ saved: true }); assert.equal(c.ready(), true);
  await c.go(); assert.deepEqual(posts.pop(), ['/api/start', { control: 'nostr', action: 'new', nsec: 'nsec1made', ownerNpub: undefined }]);
  // restore: 24 words or an nsec in the one field
  c = make(); c.setState({ way: 'restore', text: 'w '.repeat(23) }); assert.equal(c.ready(), false);
  c.setState({ text: 'w '.repeat(24) }); await c.go();
  assert.deepEqual(posts.pop(), ['/api/start', { control: 'words', action: 'restore', words: 'w '.repeat(24), ownerNpub: undefined }]);
  c = make(); c.setState({ way: 'restore', text: ' nsec1old ' }); assert.match(renderToStaticMarkup(c.render()), /Owner login:<\/b> your Nostr key/);
  await c.go(); assert.deepEqual(posts.pop(), ['/api/start', { control: 'nostr', action: 'restore', nsec: ' nsec1old ', ownerNpub: undefined }]);
  assert.equal(reloaded, 7);
  // a refusal is shown and nothing moves on
  const r = driven(StartStep, { st: {}, post: async () => ({ ok: false, why: 'that is not an nsec (it starts with nsec1)' }), reload() { reloaded++; } });
  await r.go(); assert.equal(reloaded, 7);
  assert.match(renderToStaticMarkup(r.render()), /class="msg bad"[^>]*>that is not an nsec/);
  // run again: the saved choice, and the owner the node has said as kept
  assert.deepEqual([startWayOf({ control: 'nostr', origin: 'new' }), startWayOf({ control: 'words', origin: 'restore' }), startWayOf({})], ['nostr', 'restore', 'new']);
  h = renderToStaticMarkup(React.createElement(StartStep, { st: { control: 'words', origin: 'restore', done: { owner: 1 }, ownerNpub: 'npub1abcdefghijklmnopqrstuvwxyz' }, post: async () => ({}), reload() {} }));
  assert.match(h, /stays <code>npub1abcdefg…uvwxyz<\/code>, as this node has it now/);
});

test('#648 owner: opened again from the bar, it says who the owner is and why; a Nostr node\'s own choice is its nsec', () => {
  let h = renderToStaticMarkup(React.createElement(OwnerStep, { st: { control: 'words', owner: { mode: 'seed', pubkey: 'aa'.repeat(32) }, ownerNpub: 'npub1ownerownerownerownerowner' }, post: async () => ({}), reload() {} }));
  assert.match(h, /id="owner-now"><b>Your owner: your 24 words<\/b> <code>npub1ownerow…rowner<\/code>[\s\S]*Set from your choice at the first step/);
  assert.match(h, /<label class="choice on"><input type="radio" name="om" checked="" value="seed"\/><div><b>My 24 words/);
  h = renderToStaticMarkup(React.createElement(OwnerStep, { st: { control: 'nostr', nostrPubkey: 'bb'.repeat(32), owner: { mode: 'nostr', pubkey: 'cc'.repeat(32) }, ownerNpub: 'npub1otherotherotherotherother' }, post: async () => ({}), reload() {} }));
  assert.match(h, /Your owner: another Nostr key you named/);
  assert.match(h, /<b>My Nostr key \(nsec\)<\/b>/);
  assert.match(h, /<label class="choice on"><input type="radio" name="om" checked="" value="nostr"\/>[\s\S]*id="npub"[^>]*value="npub1otherotherotherotherother"/);
});

test('#648 seed: with another key as owner, the words are the wallet, not the login', () => {
  const h = renderToStaticMarkup(React.createElement(SeedStep, { st: { ownerPick: { mode: 'nostr', pubkey: 'ab'.repeat(32) } }, post: async () => ({}), reload() {} }));
  assert.match(h, /your owner login is the Nostr key you named at the first step/);
  assert.match(renderToStaticMarkup(React.createElement(SeedStep, { st: {}, post: async () => ({}), reload() {} })), /your node&#x27;s wallet and your owner login/);
});

test('promise: Continue only once I UNDERSTAND is typed; posted as typed', async () => {
  const posts = [];
  const c = driven(PromiseStep, { post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload() {} });
  assert.match(renderToStaticMarkup(c.render()), /<button type="button" disabled="">Continue<\/button>/);
  c.setState({ text: 'i understand ' });
  assert.match(renderToStaticMarkup(c.render()), /<button type="button">Continue<\/button>/);
  await c.save();
  assert.deepEqual(posts, [['/api/promise', { text: 'i understand ' }]]);
  assert.match(renderToStaticMarkup(c.render()), /Your bond is slashed: you lose it/);
});

// THE APPS (kanban #569, 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the installer where
// all apps are automatically selected")
const appInfo = [
  { id: 'nextblock', title: 'Tick Tock, Next Block', short: 'Next Block', versions: 4 },
  { id: 'btc-updown', title: 'Bitcoin Up or Down', short: 'Up or Down', versions: 15 },
  { id: 'rock-paper-scissors', title: 'Rock Paper Scissors', short: 'Rock Paper Scissors', versions: 3 },
];
test('apps: a tile per app, every one switched on, its versions counted; a saved choice shown as saved', () => {
  const html = renderToStaticMarkup(React.createElement(AppsStep, { st: { appInfo, apps: [] }, post: async () => ({}), reload() {} }));
  assert.equal((html.match(/class="tile[ "]/g) || []).length, 3);
  for (const a of appInfo) {
    assert.match(html, new RegExp(`class="tile on" id="app-${a.id}"`));
    assert.match(html, new RegExp(`<input type="checkbox" id="ap-${a.id}"[^>]*checked=""`), `${a.id} switched on`);
  }
  assert.match(html, /<h4>Tick Tock, Next Block<\/h4>[\s\S]*?4 versions/);
  assert.match(html, /15 versions/); assert.match(html, /3 versions/);
  assert.match(html, /3 of 3 apps on/);
  assert.deepEqual(appInfo.map((a) => appOnAtStart(a.id, ['btc-updown'])), [false, true, false]);
  const saved = renderToStaticMarkup(React.createElement(AppsStep, { st: { appInfo, apps: ['btc-updown'] }, post: async () => ({}), reload() {} }));
  assert.match(saved, /class="tile" id="app-nextblock"/); assert.match(saved, /class="tile on" id="app-btc-updown"/);
});

test('apps: Continue posts the apps that are on and moves on; none on cannot continue; a refusal is shown', async () => {
  const posts = []; let reloaded = 0;
  const c = driven(AppsStep, { st: { appInfo, apps: [] }, post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload: () => { reloaded++; } });
  c.toggle('btc-updown', false);
  await c.save();
  assert.deepEqual(posts, [['/api/apps', { apps: ['nextblock', 'rock-paper-scissors'] }]]); assert.equal(reloaded, 1);
  for (const a of appInfo) c.toggle(a.id, false);
  assert.match(renderToStaticMarkup(c.render()), /<button type="button" disabled="">Continue<\/button>/);
  const d = driven(AppsStep, { st: { appInfo, apps: [] }, post: async () => ({ ok: false, why: 'no app chess in this release' }), reload() {} });
  await d.save();
  assert.match(renderToStaticMarkup(d.render()), /class="msg bad"[^>]*>no app chess in this release/);
});

test('the steps along the top: done ticked, the current one marked; the page\'s one line when the installer cannot set up', () => {
  const steps = [['chain', 'Bitcoin'], ['roles', 'Roles'], ['apps', 'Apps']];
  assert.equal(renderToStaticMarkup(React.createElement(StepBar, { steps, done: { chain: true }, now: 'roles' })),
    '<li class="done">Bitcoin</li><li class="now">Roles</li><li class="">Apps</li>');
  // KANBAN #635 (the owner's playtest 2026-10-25: "ich kann auch nicht zurück gehen und den Zustand prüfen"): a done step opens again
  const picked = [];
  const bar = new StepBar({ steps, done: { chain: true }, now: 'chain', current: 'roles', onPick: (k) => picked.push(k) }).render();
  assert.equal(renderToStaticMarkup(React.createElement(React.Fragment, null, bar)),
    '<li class="done now" role="button" tabindex="0" title="Look at this step again">Bitcoin</li><li class="current" role="button" tabindex="0" title="Back to the current step">Roles</li><li class="">Apps</li>');
  bar[0].props.onClick(); bar[1].props.onClick(); assert.equal(bar[2].props.onClick, undefined, 'a step not reached yet is not opened');
  assert.deepEqual(picked, ['chain', 'roles']);
  assert.equal(renderToStaticMarkup(React.createElement(SetupRefused, { why: 'no disk <here>' })), '<h1>Bitcoin Arena setup</h1><p>no disk &lt;here&gt;</p>');
});

// THE WHOLE TEXT, NO SCROLLBAR (kanban #732, the owner: "make the overlays for the detailed description that opens by clicking the "more"-link,
// fit the whole text without scrollbars"): measured in Chrome at 1100 and 390 px, custody's and liquidity's text was 247 px in a 238 px box
// with a scrollbar; the box now grows with its text, in the stylesheet the wizard's bundle carries
test('roles: a role\'s "more" box has no height limit and no scrollbar, in the source and in the shipped wizard.js', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/installer/wizard.css', import.meta.url), 'utf8');
  const rule = /\.aw \.more-pop\{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(rule, /max-height|overflow/, rule);
  assert.match(readFileSync(new URL('../../arena-installer/www/wizard.js', import.meta.url), 'utf8'), /\.aw \.more-pop\{position:absolute;left:8px;right:8px;bottom:48px;z-index:5;[^}]*padding:10px 12px;box-shadow:/);
  const html = renderToStaticMarkup(React.createElement(RolesStep, { st: { roleInfo, roles: [] }, post: async () => ({ ok: true }) }));
  assert.match(html, /<details class="more"><summary>more<\/summary><div class="more-pop"><p>[^<]*<\/p><p>Holds the players&#x27; bitcoin\.<\/p><\/div><\/details>/);
});

// WHAT IS NEW IN 2.0, BEFORE THE BOND (kanban #1096): every node's points, a guardian's too when custody is chosen, and a guardian answers
// point 10 (its bond is the players' insurance) before Continue
test('promise: the 2.0 points for the roles chosen; custody needs the yes to point 10', async () => {
  const posts = [];
  const plain = driven(PromiseStep, { st: { roles: ['verify', 'settlement'] }, post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload() {} });
  let html = renderToStaticMarkup(plain.render());
  assert.match(html, /New in 2\.0 for your node/);
  assert.match(html, /1\. Your bond is withdrawn with your 24 words, not by the node/);
  assert.match(html, /9\. Abandonment/);
  assert.doesNotMatch(html, /players&#x27; insurance|Gateways keep the load cap/, 'no guardian or gateway point for a node without custody');
  assert.match(html, /planned for 2\.0/); assert.match(html, /comes with 2\.0/);
  const guard = driven(PromiseStep, { st: { roles: ['verify', 'custody'] }, post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload() {} });
  html = renderToStaticMarkup(guard.render());
  assert.match(html, /10\. A guardian&#x27;s bond is the players&#x27; insurance/);
  assert.match(html, /16\. The held proof/);
  guard.setState({ text: 'I UNDERSTAND' });
  assert.match(renderToStaticMarkup(guard.render()), /<button type="button" disabled="">Continue<\/button>/, 'typed, but point 10 not answered');
  await guard.save();
  assert.equal(posts.length, 0, 'nothing posted without the yes');
  guard.setState({ yes: true });
  assert.match(renderToStaticMarkup(guard.render()), /<button type="button">Continue<\/button>/);
  await guard.save();
  assert.deepEqual(posts, [['/api/promise', { text: 'I UNDERSTAND' }]]);
});

test('roles: with custody on, the node is asked where it runs (kanban #1093 part 4); the name goes with the roles, never without custody', async () => {
  const off = renderToStaticMarkup(React.createElement(RolesStep, { st: { roleInfo, roles: [] }, post: async () => ({}), reload() {} }));
  assert.doesNotMatch(off, /id="host-group"/);
  const on = renderToStaticMarkup(React.createElement(RolesStep, { st: { roleInfo, roles: ['custody'], hostGroup: 'Hetzner' }, post: async () => ({}), reload() {} }));
  assert.match(on, /<label class="field" id="host-group"><span>Where does this node run\? <small>\(optional\)<\/small><\/span><input type="text" maxLength="80"[^>]*value="Hetzner"/);
  assert.match(on, /Only a hash of the name goes into your node&#x27;s advertisement/);
  const posts = [];
  const c = driven(RolesStep, { st: { roleInfo, roles: ['custody'] }, post: async (p, b) => { posts.push([p, b]); return { ok: true }; }, reload() {} });
  c.setState({ hostGroup: 'my-vps-1' }); await c.save();
  assert.deepEqual(posts.at(-1), ['/api/roles', { roles: ['custody'], hostGroup: 'my-vps-1' }]);
});
