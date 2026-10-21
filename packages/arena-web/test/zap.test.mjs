// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ZAP BOX IN REACT (kanban #564): drawn from what the page's zaps block holds - title, who it goes to, the amounts with the pressed
// one, the message only for a tip, the button (disabled while it cannot send), the line under it in its tone - and every tap handed back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZapCard } from '../dist/test/zap.mjs';

const VIEW = { title: 'Zap satoshi', to: 'to satoshi · e-cash into their Bitcoin Arena wallet, from yours', showMsg: false, msg: '', goLabel: 'Zap', goDisabled: false, st: '', stKind: '',
  amounts: [{ msat: '21000', label: '21 sat', pressed: true }, { msat: '100000', label: '100 sat', pressed: false }, { msat: '1000000', label: '1,000 sat', pressed: false }] };

test('the box as the page holds it: title, to, the pressed amount, no message for a player, the button, the line', () => {
  const h = renderToStaticMarkup(React.createElement(ZapCard, { view: VIEW }));
  assert.match(h, /<div class="zt"><h3>Zap satoshi<\/h3><button type="button" class="x" aria-label="Close">×<\/button><\/div><div class="to">to satoshi · e-cash/);
  assert.match(h, /<button type="button" aria-pressed="true">21 sat<\/button><button type="button" aria-pressed="false">100 sat<\/button>/);
  assert.doesNotMatch(h, /class="msg"/, 'a player\'s zap takes no message');
  assert.match(h, /<button type="button" class="go">Zap<\/button><div class="st" role="status"><\/div>/);
  const tip = renderToStaticMarkup(React.createElement(ZapCard, { view: { ...VIEW, showMsg: true, msg: 'thanks', goLabel: 'Tip', goDisabled: true, st: 'Not sent: no federation of your wallet holds 21 sat', stKind: 'bad' } }));
  assert.match(tip, /<input class="msg" type="text" maxLength="140"[^>]*value="thanks"\/>/i);
  assert.match(tip, /<button type="button" class="go" disabled="">Tip<\/button><div class="st bad" role="status">Not sent: no federation/);
});

test('every tap is handed back to the page', () => {
  const got = [];
  const c = new ZapCard({ view: { ...VIEW, showMsg: true }, onChoose: (i) => got.push(['choose', i]), onMsg: (v) => got.push(['msg', v]), onGo: () => got.push(['go']), onClose: () => got.push(['close']) });
  const tree = c.render();
  const find = (node, test) => { if (!node || typeof node !== 'object') return null; if (test(node)) return node; for (const k of [].concat(node.props && node.props.children || [])) { const f = find(k, test); if (f) return f; } return null; };
  find(tree, (n) => n.props && n.props.className === 'x').props.onClick();
  find(tree, (n) => n.props && n.props['aria-pressed'] === 'false').props.onClick();
  find(tree, (n) => n.props && n.props.className === 'msg').props.onChange({ target: { value: 'gm' } });
  find(tree, (n) => n.props && n.props.className === 'go').props.onClick();
  assert.deepEqual(got, [['close'], ['choose', 1], ['msg', 'gm'], ['go']]);
});
