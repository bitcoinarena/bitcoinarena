// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BENCHMARK IS IN SETTINGS (2026-10-16: "Remove the benchmark button and have that in the settings instead"):
// the Settings sheet carries a Benchmark card whose button closes Settings and asks Unity for the same Benchmark the lobby's button ran
// (SPECTATE + the page's frame-rate test); without Unity the test runs alone. 2026-10-16: "Benchmark is disabled by default" -
// a switch on the card, off unless this browser turned it on; while off, neither the button nor a tap on the FPS line runs it.
// The handlers are lifted from the page and run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the benchmark - its switch, its Settings card and handlers, the test itself - is Tick Tock's page part (kanban #521)
const UNITY = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');
const HANDLER = (() => {
  // the card's Run, handed to React's BenchCard (kanban #564)
  const head = "        onRun: () => {\n";
  const at = UNITY.indexOf(head); assert.ok(at > 0, 'unity-page.js has no Benchmark handler');
  return UNITY.slice(at + head.length, UNITY.indexOf('\n        } });\n', at));
})();
const click = (window) => {
  const panel = { style: { display: '' } };
  new Function('window', 'settingsPanel', HANDLER)(window, () => panel);
  return panel;
};

test('Settings has a Benchmark card with its button, inside the settings sheet', () => {
  const sheet = PAGE.slice(PAGE.indexOf('<div id="arena-settings"'), PAGE.indexOf('SETTINGS OPENS ON THE FIRST CLICK'));
  assert.match(sheet, /<section class="settings-card" id="arena-set-logs">/, 'the card goes in after the client logs');
  // the card is Tick Tock's React BenchCard (packages/nextblock/view, kanban #564), drawn into a host after the logs' card
  assert.match(UNITY, /NB_BENCH = nbHost\('arena-set-logs', 'after'\)/);
  const VIEW = readFileSync(new URL('../../nextblock/view/NextBlockParts.jsx', import.meta.url), 'utf8');
  const card = VIEW.slice(VIEW.indexOf('export class BenchCard'), VIEW.indexOf('const SECURING'));
  assert.match(card, /<section className="settings-card" id="arena-set-bench">\s*<h3>Benchmark<\/h3>/);
  assert.match(card, /<input type="checkbox" id="arena-bench-on" checked=\{!!on\} onChange=\{\(e\) => onToggle\(e\.target\.checked\)\} \/> On - off by default/);
  assert.match(card, /<button id="arena-bench-go" type="button" disabled=\{!on\} onClick=\{onRun\}>Run the benchmark<\/button>/, 'disabled while off');
  assert.match(UNITY, /on: window\.ARENA_BENCH_ON\(\),/, 'drawn with the switch as this browser keeps it');
});

test('the switch: off with nothing kept, on only with "1" kept; a blocked store is off', () => {
  const line = UNITY.slice(UNITY.indexOf('    window.ARENA_BENCH_ON = '), UNITY.indexOf('\n', UNITY.indexOf('    window.ARENA_BENCH_ON = ')));
  // the page reaches the browser's store through its one door, window.ARENA_BROWSER_STORE
  const on = (localStorage) => { const window = { ARENA_BROWSER_STORE: () => localStorage }; new Function('window', 'localStorage', line)(window, localStorage); return window.ARENA_BENCH_ON(); };
  assert.equal(on({ getItem: () => null }), false, 'off by default');
  assert.equal(on({ getItem: () => '0' }), false);
  assert.equal(on({ getItem: (k) => (k === 'arena.bench.on' ? '1' : null) }), true);
  assert.equal(on({ getItem: () => { throw new Error('blocked'); } }), false);
  assert.match(UNITY, /box\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); if \(window\.ARENA_BENCH_ON\(\)\) run\(\); \}\);/, 'the FPS tap asks the switch');
});

test('switched off, the button does nothing', () => {
  const panel = click({ ARENA_BENCH_ON: () => false, unityInstance: { SendMessage: () => assert.fail('off') }, arenaBench: () => assert.fail('off') });
  assert.equal(panel.style.display, '', 'Settings stays open');
});

test('the button closes Settings and asks Unity for Benchmark; without Unity the frame-rate test runs alone', () => {
  const sent = []; let ran = 0;
  const panel = click({ ARENA_BENCH_ON: () => true, unityInstance: { SendMessage: (...a) => sent.push(a) }, arenaBench: () => ran++ });
  assert.equal(panel.style.display, 'none');
  assert.deepEqual(sent, [['Bootstrap', 'Benchmark']]);
  assert.equal(ran, 0, 'Unity runs the test itself after spectating');
  const none = click({ ARENA_BENCH_ON: () => true, ARENA_UNITY: false, unityInstance: { SendMessage: () => assert.fail('a game without Unity') }, arenaBench: () => ran++ });
  assert.equal(none.style.display, 'none');
  assert.equal(ran, 1);
  click({ ARENA_BENCH_ON: () => true, unityInstance: { SendMessage: () => { throw new Error('not loaded'); } }, arenaBench: () => ran++ });
  assert.equal(ran, 2, 'a Unity that cannot take the message: the test alone');
});
