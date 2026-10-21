// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S STEPS IN REACT (kanban #564): rendered on the server for what they show, and their classes driven for what they do -
// the roles as tiles (game / verify and settlement on for a new node, custody and liquidity chosen on purpose), the words shown then taken
// off the screen before they are asked back, the emergency code, the owner login, and the rules typed back - against the installer's doors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RolesStep, SeedStep, OwnerStep, PromiseStep, onAtStart, OPT_IN_ROLES } from '../dist/test/wizard.mjs';

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
  assert.deepEqual(posts, [['/api/roles', { roles: ['verify', 'settlement', 'custody'] }]]); assert.equal(reloaded, 1);
  const d = driven(RolesStep, { st: { roleInfo, roles: ['verify'] }, post: async () => ({ ok: false, why: 'custody needs your own Bitcoin Core' }), reload() {} });
  await d.save();
  assert.match(renderToStaticMarkup(d.render()), /class="msg bad"[^>]*>custody needs your own Bitcoin Core/);
});

test('seed: the words shown, then off the screen before three are asked back; the emergency code after; a wrong word starts again', async () => {
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
  assert.match(renderToStaticMarkup(c.render()), /<p class="code">ARENA-7Q2X-K9PL<\/p>/);
  assert.equal(reloaded, 0, 'the wizard waits until the code is written down');
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
