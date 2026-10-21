// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA'S GAMES SCREEN IN REACT (kanban #564): the tiles as the page drew them - games then markets, each kind's badge and verb, the
// logo's three tries, the description only once its signature was checked, the chips, the leaderboard, the tip only to a signed address,
// a warning for a game this page does not pin - and every tap: the tile picks the game, a chip / the leaderboard / the tip never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameTiles, GameTile, groupsOf, kindOf, countText } from '../dist/test/games.mjs';

const rps = { id: 'a1'.repeat(32), name: 'rps', title: 'Rock Paper Scissors', manifest: { resultType: 3 }, nodes: ['n1', 'n2'], live: { rounds: 3, players: 1 }, known: true, icon: 'https://seat/icons/rps.png' };
const nb = { id: 'b2'.repeat(32), name: 'nextblock', title: 'Next Block', manifest: { resultType: 1 }, nodes: ['n1'], live: { rounds: 0, players: 0 }, known: false, devKey: 'cd'.repeat(32) };
const ud = { id: 'c3'.repeat(32), name: 'btc-updown', title: 'BTC Up/Down', attested: true, nodes: ['n1', 'n2', 'n3'], live: { rounds: 12, players: 1530 }, known: true };
const html = (props) => renderToStaticMarkup(React.createElement(GameTiles, props));

test('games then markets, each kind its badge and verb, the counts as chips, a game not pinned warned', () => {
  const h = html({ tiles: [ud, rps, nb], routed: (u) => u.replace('https://seat', 'https://alt') });
  assert.deepEqual(groupsOf([ud, rps, nb]).map(([l, g]) => [l, g.map((x) => x.name)]), [['Games', ['rps', 'nextblock']], ['Prediction markets', ['btc-updown']]]);
  assert.ok(h.indexOf('Games · 2') < h.indexOf('Prediction markets · 1'));
  assert.match(h, /<button type="button" class="tile game play-game" data-game="a1a1/);
  assert.match(h, /<button type="button" class="tile game market" data-game="c3c3/);
  assert.deepEqual([kindOf(rps), kindOf(nb), kindOf(ud)], ['head-to-head', 'game', 'market']);
  assert.match(h, /<span class="play">Play →<\/span>[\s\S]*Head-to-head game/);
  assert.match(h, /<span class="play">Trade →<\/span>[\s\S]*Prediction market/);
  assert.match(h, /<img src="https:\/\/alt\/icons\/rps\.png" alt=""\/>/, 'its second route first');
  assert.match(h, /<div class="logo">N<\/div>/, 'no icon: its initial');
  assert.match(h, /title="1530 players"[^>]*>.*?1\.5k<span class="word"> players<\/span>/);
  assert.match(h, /class="chip idle opens" title="0 live rounds"/);
  assert.match(h, /<div class="desc none">No signed description\.<\/div>/);
  assert.match(h, /Not pinned by this page: developer cdcdcdcdcdcdcdcd, manifest b2b2b2b2b2b2b2b2/);
  assert.equal((h.match(/class="season-go"/g) || []).length, 3);
  assert.deepEqual([countText(999), countText(1250), countText(12500)], ['999', '1.2k', '12k']);
});

test('the description only once checked, its website, a tip only to the address it signed', async () => {
  const h = html({ tiles: [rps], infos: { [rps.id]: { description: 'Best of three, 8 s rounds.', website: 'https://rps.example/about', lightning: 'dev@rps.example' } }, onTip: () => {} });
  assert.match(h, /<div class="desc">Best of three, 8 s rounds\.<\/div><div class="signed">✓ signed by its developer · <a href="https:\/\/rps\.example\/about" target="_blank" rel="noopener">rps\.example<\/a> · <button type="button" class="tip-dev">⚡ Tip the developer<\/button>/);
  assert.doesNotMatch(html({ tiles: [rps], infos: { [rps.id]: { description: 'x', lightning: 'dev@rps.example' } } }), /tip-dev/, 'no zap on the page: no tip');
  // the check runs on mount; a tile whose check finds nothing keeps "No signed description."
  const t = new GameTile({ game: rps, verifyInfo: async () => ({ description: 'checked' }) });
  t.setState = (u) => Object.assign(t.state, typeof u === 'function' ? u(t.state) : u);
  await t.componentDidMount();
  assert.equal(t.state.info.description, 'checked');
  const none = new GameTile({ game: rps, verifyInfo: async () => null });
  none.setState = (u) => Object.assign(none.state, typeof u === 'function' ? u(none.state) : u);
  await none.componentDidMount();
  assert.match(renderToStaticMarkup(none.render()), /No signed description/);
});

test('the logo: its second route, then the address as listed, then its initial', () => {
  const t = new GameTile({ game: rps, routed: (u) => u.replace('https://seat', 'https://alt') });
  t.setState = (u) => Object.assign(t.state, typeof u === 'function' ? u(t.state) : u);
  assert.equal(t.state.src, 'https://alt/icons/rps.png');
  t.iconFailed(); assert.equal(t.state.src, 'https://seat/icons/rps.png');
  t.iconFailed(); assert.match(renderToStaticMarkup(t.render()), /<div class="logo">R<\/div>/);
});

test('the taps: the tile picks the game; a chip, the leaderboard and the tip open theirs and never pick it', () => {
  const did = [];
  const t = new GameTile({ game: rps, info: { description: 'd', lightning: 'dev@rps.example' }, onChoose: (g) => did.push(['choose', g.name]),
    onChip: (g, k) => did.push(['chip', k]), onSeason: (g) => did.push(['season', g.name]), onTip: (g, i) => did.push(['tip', i.lightning]) });
  const tree = t.render();
  const find = (node, pred, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { for (const x of node) find(x, pred, out); return out; }
    if (pred(node)) out.push(node); const kids = node.props && node.props.children; find(kids, pred, out);
    if (typeof node.type === 'function' && node.type.prototype && node.type.prototype.render) find(new node.type(node.props).render(), pred, out); return out; };
  const ev = () => { const e = { stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} }; return e; };
  tree.props.onClick();
  const chips = find(tree, (n) => n.props && /chip/.test(n.props.className || ''));
  assert.equal(chips.length, 3);
  for (const c of chips) { const e = ev(); c.props.onClick(e); assert.equal(e.stopped, true); }
  const season = find(tree, (n) => n.props && n.props.className === 'season-go')[0];
  const e1 = ev(); season.props.onKeyDown({ ...e1, key: 'Enter' });
  const tip = find(tree, (n) => n.props && n.props.className === 'tip-dev')[0];
  const e2 = ev(); tip.props.onClick(e2); assert.equal(e2.stopped, true);
  assert.deepEqual(did, [['choose', 'rps'], ['chip', 'nodes'], ['chip', 'players'], ['chip', 'rounds'], ['season', 'rps'], ['tip', 'dev@rps.example']]);
});
