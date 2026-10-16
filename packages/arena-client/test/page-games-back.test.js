// BACK TO THE GAMES FROM UNITY'S GAME (kanban #383, the owner 2026-10-16: "there is no link/button to get back to the game selection
// like in the other games"). On the page's own code: the strip holds "← Games", shown once a game is chosen and never over a
// game's own client (that client has its own), and a click opens the address without the game, its round and play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');

test('the strip holds "← Games", shown for a chosen game, never over a game\'s own client', () => {
  const strip = HTML.slice(HTML.indexOf('  <div id="blwp-money">'), HTML.indexOf("<button id=\"blwp-settings-go\""));
  // it says Arena, as every way back does (kanban #396)
  assert.match(strip, /<button id="arena-games-back" type="button"[^>]*>.*&larr;.*Arena<\/span><\/button>/);
  assert.doesNotMatch(HTML, /\\u2190 Games|&larr; Games|← Games<\/button>/, 'no "← Games" left on the page');
  assert.match(HTML, /#arena-games-back \{ display: none; \}/);
  assert.match(HTML, /body\.arena-game-chosen:not\(\.arena-own-client\) #arena-games-back \{ display: inline-flex;/);
});

test('a click opens the choice of games: the address without game, round and play', () => {
  const from = HTML.indexOf("      const back = document.getElementById('arena-games-back');");
  assert.ok(from > 0, 'the button has a click handler');
  const src = HTML.slice(from, HTML.indexOf('\n      });\n', from) + 11);
  let click = null;
  const document = { getElementById: (id) => (id === 'arena-games-back' ? { addEventListener: (ev, fn) => { click = fn; } } : null) };
  const location = { search: '?game=nextblock&round=ab12&play=1&fed=b' };
  pageFunction(PAGE, ['document', 'location', 'URLSearchParams'], src)(document, location, URLSearchParams);
  click();
  assert.equal(location.search, 'fed=b');
});
