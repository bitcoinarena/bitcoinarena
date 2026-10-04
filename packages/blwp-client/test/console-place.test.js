// THE CONSOLE BUTTON AND ITS PANEL, PLACED FROM THE HUD'S OWN SLOT (the owner 2026-10-04): index.html's BLWP_PLACE_CONSOLE run
// on fake slots - the two measured screens and an upright phone. The button and the open panel stay inside the screen and
// off the throttle pad; the panel is capped to the room under the button. The function is the page's own text, run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
const a = html.indexOf('      window.BLWP_PLACE_CONSOLE = () => {');
const b = html.indexOf("      window.addEventListener('resize', () => window.BLWP_PLACE_CONSOLE());", a);
assert.ok(a > 0 && b > a, 'the page places its Console button in BLWP_PLACE_CONSOLE');
const body = html.slice(a, b);

/** The page's function over a fake window: the canvas fills the window, the button is 64 x 22 as measured. */
function place(slot, { open = true, bw = 64, bh = 22 } = {}) {
  const style = () => ({});
  const go = { offsetWidth: bw, offsetHeight: bh, style: style() };
  const panel = { style: style() };
  const window = { innerWidth: slot.w, innerHeight: slot.h, BLWP_HUD_CORNER: slot };
  const classes = new Set();
  const document = { body: { classList: { toggle: (k, on) => (on ? classes.add(k) : classes.delete(k)), remove: (k) => classes.delete(k), contains: (k) => classes.has(k) } }, getElementById: (id) => (id === 'canvas' ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: slot.w, height: slot.h }) } : id === 'blwp-wallet' ? panel : null) };
  new Function('window', 'document', 'go', 'consoleOpen', body + '\nwindow.BLWP_PLACE_CONSOLE();')(window, document, go, () => open);
  const px = (v) => Number(String(v).replace('px', ''));
  const btn = { top: px(go.style.top), right: px(go.style.right) };
  btn.bottom = btn.top + bh; btn.rightX = slot.w - btn.right; btn.left = btn.rightX - bw;
  const held = classes.has('blwp-console-held');
  const p = open ? { held, top: px(panel.style.top), right: px(panel.style.right), maxH: px(panel.style.maxHeight), maxW: px(panel.style.maxWidth) } : null;
  if (p) { p.bottom = p.top + p.maxH; p.rightX = slot.w - p.right; p.left = p.rightX - p.maxW; }
  return { btn, p };
}
const pad = (s) => ({ left: s.padX, right: s.padX + s.padW, top: s.padY });
const overlaps = (r, q) => r.left < q.right && r.rightX > q.left && r.bottom > q.top;

// the slots Unity sent, read off the live page 0.0.2519 (1280x720, 844x390) and an upright phone's shape
const SLOTS = {
  desktop: { w: 1280, h: 720, top: 313, right: 1254.8, padX: 1110.8, padY: 394.2, padW: 144, m: 25.2 },
  phone: { w: 844, h: 390, top: 221.7, right: 830, padX: 752, padY: 213, padW: 78, m: 14 },
  upright: { w: 390, h: 844, top: 120, right: 376, padX: 290, padY: 700, padW: 86, m: 14 },
};

for (const [name, s] of Object.entries(SLOTS)) {
  test(`${name} ${s.w}x${s.h}: the button and the open panel stay inside the screen and off the throttle pad`, () => {
    const { btn, p } = place(s);
    assert.ok(btn.top >= Math.round(s.top) - 1, `the button under the HUD corner (top ${btn.top}, slot ${s.top})`);
    assert.ok(btn.left >= 0 && btn.rightX <= s.w && btn.bottom <= s.h, `the button inside the screen ${JSON.stringify(btn)}`);
    assert.ok(!overlaps({ left: btn.left, rightX: btn.rightX, bottom: btn.bottom }, pad(s)) || btn.bottom <= s.padY, `the button off the pad ${JSON.stringify(btn)}`);
    assert.ok(p.top >= btn.bottom, 'the panel under the button');
    assert.ok(p.bottom <= s.h, `the panel's bottom ${p.bottom} inside the ${s.h} px screen`);
    assert.ok(p.left >= 0 && p.rightX <= s.w, `the panel inside the screen ${JSON.stringify(p)}`);
    assert.ok(p.rightX <= s.padX || p.top >= s.padY + 9999 || p.bottom <= s.padY, `the panel off the throttle pad's column ${JSON.stringify(p)}`);
    assert.ok(p.maxW <= 280, 'at most 280 px wide');
  });
}

test('closed, the panel is left alone; the button is still placed', () => {
  const { btn, p } = place(SLOTS.phone, { open: false });
  assert.equal(p, null);
  assert.ok(btn.top > 0);
});

// THE CARGO BAY UP (measured live on 0.0.2521, a FREE round's chooser): the HUD's slot top is then under the cargo chooser
// and its floor the bay's top - 1280x720: chooser to 367, bay from 508.3; 844x390: chooser to ~200, bay from 257.6.
test('1280x720 with the cargo bay up: button and panel in the band between the chooser and the bay', () => {
  const s = { ...SLOTS.desktop, top: 373.3, floor: 508.3 };
  const { btn, p } = place(s);
  assert.equal(p.held, false);
  assert.ok(btn.top >= 367, `the button under the chooser (top ${btn.top})`);
  assert.ok(p.top >= btn.bottom, 'the panel under the button');
  assert.ok(p.bottom <= s.floor, `its bottom ${p.bottom} above the bay's top ${s.floor}`);
  assert.ok(p.maxH >= 80, `room for the lock lines (${p.maxH} px)`);
});

test('844x390 with the cargo bay up: the band is too short, so the panel steps aside (held) - it covers nothing', () => {
  const s = { ...SLOTS.phone, top: 203.5, floor: 257.6 };
  const { btn, p } = place(s);
  assert.equal(p.held, true, 'held while the bay is up');
  assert.ok(btn.bottom <= s.floor, `the button stays, above the bay (bottom ${btn.bottom})`);
});

test('the bay closes (ROLL OUT): the next slot lets the panel back', () => {
  const s = { ...SLOTS.phone, top: 203.5, floor: 257.6 };
  const doc = place(s);
  assert.equal(doc.p.held, true);
  const after = place(SLOTS.phone);
  assert.equal(after.p.held, false);
  assert.ok(after.p.bottom <= SLOTS.phone.h);
});

test('no floor sent (an older build): the screen bottom, as before', () => {
  const { p } = place(SLOTS.phone);
  assert.equal(p.held, false);
  assert.ok(p.bottom <= SLOTS.phone.h);
});
