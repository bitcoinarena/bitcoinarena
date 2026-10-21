// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S PAGE PARTS IN REACT (kanban #564): the next round's box with its words, add-ons only when sold, donate and exit game; the link's
// warning hidden with nothing to say; the graphics choice with what runs now; the benchmark card off by default, Run only while on;
// "securing your run" in its tone; and lines of words where the page keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRoundBox, LinkWarn, GraphicsChoice, BenchCard, Securing, Lines } from '../dist/test/nextblock.mjs';

const r = (c, p) => renderToStaticMarkup(React.createElement(c, p));

test('the next round\'s box: hidden, then the countdown beside exit game; add-ons only when this game sells something', () => {
  assert.match(r(NextRoundBox, { show: false }), /^<div id="arena-next" role="status" style="display:none"><span id="arena-next-say"><\/span><button id="arena-next-addons" type="button" style="display:none">Buy add-ons<\/button><button id="arena-next-donate" type="button">♥ Donate<\/button><button id="arena-next-exit" type="button">exit game<\/button><\/div>$/);
  const h = r(NextRoundBox, { show: true, line: 'joining next round in 12 s', exit: 'exit game', addons: true });
  assert.match(h, /style="display:flex"><span id="arena-next-say">joining next round in 12 s<\/span><button id="arena-next-addons" type="button">Buy add-ons<\/button>/);
  const box = new NextRoundBox({ show: true, line: 'x', exit: 'exit game', onExit: () => 'exited', onDonate: () => 'donate', onAddons: () => 'addons' }).render();
  const [, addons, donate, exit] = box.props.children;
  assert.deepEqual([addons.props.onClick(), donate.props.onClick(), exit.props.onClick()], ['addons', 'donate', 'exited']);
});

test('the link\'s warning: hidden with nothing to say, shown with what is not reaching the signer nodes', () => {
  assert.match(r(LinkWarn, { say: '' }), /^<div id="arena-link-warn" role="alert" style="display:none;position:fixed;top:8px;left:50%;transform:translateX\(-50%\);z-index:9999;/);
  assert.match(r(LinkWarn, { say: 'Your run is not reaching the signer nodes: the last 5 s are not sent yet.' }), /style="position:fixed;[^"]*">Your run is not reaching the signer nodes: the last 5 s are not sent yet\.<\/div>$/);
});

test('graphics: the choice as kept and what this device runs now; a change is handed back', () => {
  const h = r(GraphicsChoice, { mode: 'low', now: 'Now: Low · iPhone: all off' });
  assert.match(h, /<select id="arena-gfx-select" aria-label="Graphics"><option value="auto">Auto \(by device\)<\/option><option value="high">High<\/option><option value="low" selected="">Low<\/option><\/select><div class="muted" id="arena-gfx-now">Now: Low · iPhone: all off<\/div>/);
  let got = null; const sel = new GraphicsChoice({ mode: 'auto', now: '', onChange: (m) => { got = m; } }).render().props.children[0];
  sel.props.onChange({ target: { value: 'high' } }); assert.equal(got, 'high');
});

test('the benchmark card: off by default and Run disabled; on, Run enabled; the switch and Run handed back', () => {
  assert.match(r(BenchCard, { on: false }), /<input type="checkbox" id="arena-bench-on"\/> On - off by default<\/label>.*<button id="arena-bench-go" type="button" disabled="">Run the benchmark<\/button><\/section>$/);
  assert.match(r(BenchCard, { on: true }), /<input type="checkbox" id="arena-bench-on" checked=""\/>.*<button id="arena-bench-go" type="button">Run the benchmark<\/button>/);
  const calls = []; const card = new BenchCard({ on: true, onToggle: (on) => calls.push(on), onRun: () => calls.push('run') }).render();
  const [, label, , go] = card.props.children;
  label.props.children[0].props.onChange({ target: { checked: false } }); go.props.onClick();
  assert.deepEqual(calls, [false, 'run']);
});

test('securing your run in its tone, hidden with nothing to say; lines as given', () => {
  assert.match(r(Securing, { say: 'Securing your run with the signer nodes … keep this tab open', tone: 'wait' }), /color:#ffd27a">Securing your run with the signer nodes … keep this tab open<\/div>$/);
  assert.match(r(Securing, { say: 'Your run is safe: 2 signer nodes hold all of it', tone: 'safe' }), /color:#7ee08a">Your run is safe/);
  assert.match(r(Securing, { say: '', tone: 'safe' }), /display:none/);
  assert.match(r(Securing, { say: 'Your run is safe: 2 signer nodes hold all of it', tone: 'safe', hidden: true }), /display:none">Your run is safe/);
  assert.equal(r(Lines, { text: 'as built: avg 60\ntap to rerun' }), 'as built: avg 60\ntap to rerun');
  assert.equal(r(Lines, { text: '' }), '');
});
