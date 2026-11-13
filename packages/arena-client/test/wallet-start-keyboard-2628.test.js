// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2628, feedback #051 (UI 660): with the wallet screen up, the first Tab went to the footer's Donate and the wallet bar behind it;
// Create a new wallet came on the 18th Tab. The screen is modal for the keyboard: the page's other top-level parts are inert while it
// shows (and not after), and the focus starts on its first action. The page's own script is run here on a small stand-in DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');

test('#2628 the wallet screen makes the page behind it inert, focuses its first action, and frees the page when done', () => {
  const at = page.indexOf("box.style.display = 'flex';", page.indexOf("const box = $('arena-wallet-start')"));
  assert.ok(at > 0, 'the wallet screen is shown in the page');
  const end = page.indexOf('const done = () =>', at);
  const doneLine = page.slice(end, page.indexOf('\n', end));
  const block = page.slice(at, end) + doneLine;
  // a stand-in body: footer, wallet bar, the wallet screen with its buttons, a script
  const mk = (tag, kids = []) => ({ tagName: tag, inert: false, kids, focused: false, focus() { focused = this; } });
  let focused = null;
  const btn = mk('BUTTON'); const box = { ...mk('DIV'), style: {}, querySelector: () => btn };
  const footer = mk('FOOTER'), bar = mk('DIV'), script = mk('SCRIPT');
  const document = { body: { children: [bar, box, footer, script] } };
  const window = { ARENA_WALLET_SCREEN: {} };
  const timers = []; const setTimeout = (f) => timers.push(f);
  const $ = () => ({ textContent: '', querySelector: () => null });
  const run = new Function('box', 'document', 'window', 'setTimeout', '$', `${block}\nreturn done;`);
  const done = run(box, document, window, (f) => setTimeout(f), $);
  btn.focus = () => { focused = btn; };
  timers.forEach((f) => f());
  assert.equal(bar.inert, true, 'the wallet bar behind the screen is inert');
  assert.equal(footer.inert, true, 'the footer behind the screen is inert');
  assert.equal(box.inert, false, 'the screen itself is not');
  assert.equal(script.inert, false);
  assert.equal(focused, btn, 'the focus starts on the screen\'s first action');
  done();
  assert.equal(bar.inert, false, 'done: the page takes the keyboard again');
  assert.equal(footer.inert, false);
});
