// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CONSOLE BUTTON AND ITS PANEL, PLACED FROM THE HUD'S OWN SLOT: index.html's ARENA_PLACE_CONSOLE run on fake slots - the
// measured screens and an upright phone. The button stays under the HUD corner (2026-10-04). THE OPEN PANEL (kanban
//, 2026-10-06 17:11: it covered the truck) is bottom right at its fixed 260 px: its right edge at the HUD's
// corner margin, its bottom one HUD margin above the throttle pad (the screen's bottom margin where no pads are drawn) and
// above the cargo bay, right of the screen's middle (the truck's lane), at most 280 px wide. Where 260 px do not fit
// between the button and that bottom, it keeps its height and steps aside (held). The function is the page's own text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = html.indexOf('      window.ARENA_PLACE_CONSOLE = () => {');
const b = html.indexOf("      window.addEventListener('resize', () => window.ARENA_PLACE_CONSOLE());", a);
assert.ok(a > 0 && b > a, 'the page places its Console button in ARENA_PLACE_CONSOLE');
const body = html.slice(a, b);
const PANEL_H = 260;
const css = html.slice(html.indexOf('body.arena-console-open #arena-wallet { position: fixed;'), html.indexOf('#arena-console-thumb {'));

/** The page's function over a fake window: the canvas fills the window, the button is 64 x 22 as measured. */
function place(slot, { open = true, bw = 64, bh = 22, w = slot && slot.w, h = slot && slot.h, coarse = true, btnTop = 52, lobby = null } = {}) {
  const go = { offsetWidth: bw, offsetHeight: bh, style: {}, title: '', getBoundingClientRect: () => ({ top: btnTop, bottom: btnTop + bh, height: bh }) };
  const panel = { style: {} };
  const window = { innerWidth: w, innerHeight: h, ARENA_HUD_CORNER: slot, ARENA_UNITY_LOBBY: lobby, matchMedia: () => ({ matches: coarse }) };
  const classes = new Set();
  const document = { body: { classList: { toggle: (k, on) => (on ? classes.add(k) : classes.delete(k)), remove: (k) => classes.delete(k), contains: (k) => classes.has(k) } },
    getElementById: (id) => (id === 'canvas' ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) } : id === 'arena-wallet' ? panel : null) };
  pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['window', 'document', 'go', 'consoleOpen', 'paintConsoleThumb'], body, 'window.ARENA_PLACE_CONSOLE();')(window, document, go, () => open, () => {});
  const px = (v) => Number(String(v).replace('px', ''));
  const btn = slot ? { top: px(go.style.top), right: px(go.style.right) } : { top: btnTop, right: null };
  btn.bottom = btn.top + bh;
  if (slot) { btn.rightX = w - btn.right; btn.left = btn.rightX - bw; }
  const held = classes.has('arena-console-held');
  let p = null;
  if (open) {
    p = { held, lobbyClass: classes.has('arena-console-lobby'), title: go.title, right: px(panel.style.right), bottomGap: px(panel.style.bottom), width: px(panel.style.width), maxW: px(panel.style.maxWidth) };
    if (panel.style.bottom === 'auto') { p.top = px(panel.style.top); p.bottom = p.top + PANEL_H; } else { p.bottom = h - p.bottomGap; p.top = p.bottom - PANEL_H; }
    p.rightX = w - p.right; p.left = p.rightX - p.width;
  }
  return { btn, p, placed: window.ARENA_CONSOLE_PLACED };
}
const PAD = (s) => ({ left: s.padX, right: s.padX + s.padW, top: s.padY });

// the slots Unity sent, read off the live page 0.0.2519 (1280x720, 844x390) and an upright phone's shape; `pads` as DriveHud.PadsShown
const SLOTS = {
  desktop: { w: 1280, h: 720, top: 313, right: 1254.8, padX: 1110.8, padY: 394.2, padW: 144, m: 25.2, pads: 0 },
  desktopTouch: { w: 1280, h: 720, top: 313, right: 1254.8, padX: 1110.8, padY: 394.2, padW: 144, m: 25.2, pads: 1 },
  phone: { w: 844, h: 390, top: 221.7, right: 830, padX: 752, padY: 213, padW: 78, m: 14, pads: 1 },
  upright: { w: 430, h: 932, top: 120, right: 415, padX: 333, padY: 735, padW: 86, m: 15, pads: 1 },
};

test('the height is fixed at 260 CSS px in the page\'s own CSS - a height, not a max, border and padding inside it, scrolling', () => {
  assert.match(css, /height: 260px;/);
  assert.match(css, /max-height: none;/);
  assert.match(css, /box-sizing: border-box;/);
  assert.match(css, /overflow-y: scroll;/);
  assert.match(css, /touch-action: pan-y;/);
  assert.doesNotMatch(body, /maxHeight = Math/, 'the panel\'s height is not set from the room left any more');
});

test('upright phone 430x932 in a round: bottom right, one HUD margin above the throttle pad, right edge at the HUD margin, off the truck\'s lane', () => {
  const s = SLOTS.upright;
  const { btn, p } = place(s);
  assert.equal(p.held, false);
  assert.equal(p.right, Math.round(s.w - s.right), 'the right gap is the HUD corner margin');
  assert.ok(p.bottom <= s.padY - s.m + 0.5, `its bottom ${p.bottom} one margin above the throttle pad's top ${s.padY}`);
  assert.ok(p.bottom >= s.padY - s.m - 1, 'and right there, not floating higher');
  assert.ok(p.top >= btn.bottom, `260 px of it under the button (top ${p.top}, button bottom ${btn.bottom})`);
  assert.ok(p.left >= s.w / 2 + s.m - 1, `left of it the screen's middle stays clear (left ${p.left})`);
  assert.ok(p.width <= 280 && p.maxW === 280);
});

test('desktop 1280x720 without pads: bottom right at the screen\'s margin, 280 px wide', () => {
  const s = SLOTS.desktop;
  const { btn, p } = place(s);
  assert.equal(p.held, false);
  assert.ok(Math.abs(p.bottom - (s.h - s.m)) <= 1, `its bottom ${p.bottom} one margin above the screen's bottom`);
  assert.ok(p.top >= btn.bottom);
  assert.equal(p.width, 280);
  assert.equal(p.right, Math.round(s.w - s.right));
});

test('where 260 px do not fit above the throttle pad (844x390 phone, 1280x720 with pads) the panel keeps its height and steps aside, saying why', () => {
  for (const s of [SLOTS.phone, SLOTS.desktopTouch]) {
    const { p } = place(s);
    assert.equal(p.held, true, `${s.w}x${s.h}: not held`);
    assert.match(p.title, /needs 260 px above the throttle pad/);
  }
});

test('the cargo bay up: the panel stands above the bay, or steps aside until ROLL OUT where 260 px do not fit', () => {
  const tall = { ...SLOTS.upright, top: 300, floor: 700 };
  const up = place(tall).p;
  assert.equal(up.held, false);
  assert.ok(up.bottom <= tall.floor - tall.m + 0.5, `its bottom ${up.bottom} above the bay's top ${tall.floor}`);
  const short = { ...SLOTS.desktop, top: 373.3, floor: 508.3 };
  const held = place(short).p;
  assert.equal(held.held, true);
  assert.match(held.title, /after ROLL OUT/);
  const after = place({ ...SLOTS.desktop }).p;
  assert.equal(after.held, false, 'the bay closes and the next slot lets the panel back');
});

test('the lobby, before the HUD is placed: TouchPad.RectFor\'s rule in CSS pixels - bottom 45.25vmin + 3.5vmin up, right 3.5vmin', () => {
  const { p } = place(null, { w: 430, h: 932 });
  const vmin = 4.3;
  assert.equal(p.held, false);
  assert.equal(p.right, Math.round(3.5 * vmin));
  assert.equal(p.bottomGap, Math.round(45.25 * vmin + 3.5 * vmin));
  const noTouch = place(null, { w: 1280, h: 720, coarse: false }).p;
  assert.equal(noTouch.bottomGap, Math.round(3.5 * 7.2), 'no pads drawn: the screen\'s bottom margin');
  assert.match(css, /@media \(pointer: coarse\) \{ body\.arena-console-open #arena-wallet \{ bottom: calc\(45\.25vmin \+ 3\.5vmin\); \} \}/);
});

test('closed, the panel is left alone; the button is still placed', () => {
  const { btn, p } = place(SLOTS.phone, { open: false });
  assert.equal(p, null);
  assert.ok(btn.top > 0);
});

// THE LOBBY (2026-10-06: "Stepped aside while the lobby is up. Not drawn over the lobby content"): Unity's
// own lobby rectangles as read off the live page 0.0.2821 at 430x932 - the balance boxes and the two round rows
const LOBBY = { showing: true, balance: [56, 468, 318, 34], rows: [{ rect: [56, 538, 318, 30] }, { rect: [56, 572, 318, 30] }] };
const clearOf = (p, [x, y, ww, hh]) => p.rightX <= x || p.left >= x + ww || p.bottom <= y || p.top >= y + hh;

test('the lobby up: the open console parks top right under the button, 260 x 260, clear of the balance boxes and the round rows, above the lobby', () => {
  const s = SLOTS.upright;
  const { btn, p, placed } = place(s, { lobby: LOBBY });
  assert.equal(p.held, false);
  assert.equal(p.lobbyClass, true, 'drawn above the lobby chrome (arena-console-lobby)');
  assert.equal(p.width, 260);
  assert.ok(p.top >= btn.bottom, `under the Console button (top ${p.top}, button bottom ${btn.bottom})`);
  assert.equal(p.right, Math.round(s.w - s.right), 'at the right margin');
  for (const r of [LOBBY.balance, ...LOBBY.rows.map((x) => x.rect)]) assert.ok(clearOf(p, r), `the panel ${JSON.stringify(p)} lies on ${r}`);
  assert.equal(placed.lobby.edge, 'top right');
  assert.match(html, /body\.arena-console-lobby #arena-wallet \{ z-index: 35; \}/);
});

test('the lobby with a widget at the top right: the panel slides left along the top edge until clear, and says so', () => {
  const s = SLOTS.upright;
  const lobby = { ...LOBBY, rows: [...LOBBY.rows, { rect: [300, 200, 100, 30] }] };
  const { p, placed } = place(s, { lobby });
  assert.equal(p.held, false);
  assert.equal(p.width, 260);
  assert.ok(clearOf(p, [300, 200, 100, 30]));
  assert.match(placed.lobby.edge, /^top edge, slid left to \d+ px$/);
});

test('the lobby with no clear spot on the top edge: the panel steps aside (held) rather than lie on the lobby', () => {
  const s = SLOTS.upright;
  const lobby = { ...LOBBY, rows: [...LOBBY.rows, { rect: [0, 150, 430, 40] }] };
  const { p, placed } = place(s, { lobby });
  assert.equal(p.held, true);
  assert.equal(placed.lobby.edge, 'none');
  assert.match(p.title, /steps aside in the lobby/);
});

test('the lobby closed again: the truck view comes back as measured - bottom right one margin above the throttle pad', () => {
  const s = SLOTS.upright;
  const { p, placed } = place(s, { lobby: { ...LOBBY, showing: false } });
  assert.equal(p.lobbyClass, false);
  assert.equal(placed.lobby, null);
  assert.ok(Math.abs(p.bottom - (s.padY - s.m)) <= 1);
  assert.ok(p.left >= s.w / 2 + s.m - 1);
});
