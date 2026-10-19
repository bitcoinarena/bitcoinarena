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

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const HANDLER = (() => {
  const head = "    document.getElementById('blwp-bench-go').addEventListener('click', () => {\n";
  const at = PAGE.indexOf(head); assert.ok(at > 0, 'the page has no Benchmark handler');
  return PAGE.slice(at + head.length, PAGE.indexOf('\n    });\n', at));
})();
const click = (window) => {
  const panel = { style: { display: '' } };
  new Function('window', 'settingsPanel', HANDLER)(window, () => panel);
  return panel;
};

test('Settings has a Benchmark card with its button, inside the settings sheet', () => {
  const sheet = PAGE.slice(PAGE.indexOf('<div id="blwp-settings"'), PAGE.indexOf('SETTINGS OPENS ON THE FIRST CLICK'));
  assert.match(sheet, /<section class="settings-card" id="blwp-set-bench">\s*<h3>Benchmark<\/h3>/);
  assert.match(sheet, /<input type="checkbox" id="blwp-bench-on"> On - off by default/);
  assert.match(sheet, /<button id="blwp-bench-go" type="button" disabled>Run the benchmark<\/button>/, 'disabled as the page loads');
});

test('the switch: off with nothing kept, on only with "1" kept; a blocked store is off', () => {
  const line = PAGE.slice(PAGE.indexOf('    window.ARENA_BENCH_ON = '), PAGE.indexOf('\n', PAGE.indexOf('    window.ARENA_BENCH_ON = ')));
  // the page reaches the browser's store through its one door, window.BLWP_BROWSER_STORE
  const on = (localStorage) => { const window = { BLWP_BROWSER_STORE: () => localStorage }; new Function('window', 'localStorage', line)(window, localStorage); return window.ARENA_BENCH_ON(); };
  assert.equal(on({ getItem: () => null }), false, 'off by default');
  assert.equal(on({ getItem: () => '0' }), false);
  assert.equal(on({ getItem: (k) => (k === 'arena.bench.on' ? '1' : null) }), true);
  assert.equal(on({ getItem: () => { throw new Error('blocked'); } }), false);
  assert.match(PAGE, /box\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); if \(window\.ARENA_BENCH_ON\(\)\) run\(\); \}\);/, 'the FPS tap asks the switch');
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
