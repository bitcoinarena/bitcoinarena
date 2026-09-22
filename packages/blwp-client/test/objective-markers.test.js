// WAR_TACTICS.md §0 row O4: "the client draws HIGH, LOW and OPEN at the core's points in the holder's colour,
// within 1 tick of the core's words (client test)".
//
// This asks the PAGE, not a stand-in for it: it reads the three markers out of the core the page is running - the
// same `chartView` words the HUD is handed - and then asks the page what it has drawn. A reader that only checked
// that the words exist would be measuring the core twice and the client not at all.
//
// The page is the Daily on the owner's test host (HARD 2026-09-18 19:05: live Chrome runs there, CDP 9341/9342 forwarded
// by monitoring/blwp_mac_playtest.sh). With no page reachable this test FAILS rather than skipping: O4 is a red row,
// and a silent skip would read as an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

// THE TEST HOST, NOT THE MACBOOK (HARD, the owner 2026-09-20 15:12: "Live Chrome
// playtests run on the test host only. Do not use the test host."). This defaulted
// to 9341, the test host's forwarded port from the 2026-09-18 HARD that ruling
// replaced, so the suite answered "no page on CDP 9341" on the machine the
// playtests actually run on. The the test host's two playtest Chromes are 9351 and
// 9352; BLWP_CDP_PORT still overrides. Measured against 9351 with the Daily
// open: 1 pass, 18.2 s.
const PORT = Number(process.env.BLWP_CDP_PORT || 9351);
const PAGE = process.env.BLWP_PAGE || 'https://btc-logistics-core.pages.dev/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The few CDP calls this needs, against a browser somebody else is running. */
async function page() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
  const target = list && list.find((x) => x.type === 'page' && x.url.startsWith('http'));
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled')
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
                                  wait(20000).then(() => null)]);
    return r ? r.result?.result?.value : 'TIMED OUT';
  };
  return { send, evaluate, logs, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

// The core's own three markers, read from the page's core through the same call the HUD's words come from:
// chart.js `chartView` writes, per objective, its kind, its point on the chart (t, price), its holder and whether it
// is on screen. CH_OBJ 28, five words each; HOLDER_NONE is 2.
const MARKERS = `(function () {
  var m = window.unityInstance && window.unityInstance.Module;
  var b = m && m.blwp;
  if (!b || !b.st || !b.core || typeof b.core.chartView !== 'function') return null;
  var out = new Int32Array(4096);
  b.core.chartView(b.st, 0, out);
  var got = [];
  for (var o = 0; o < 3; o++) {
    var at = 28 + o * 5;
    got.push({ kind: out[at], t: out[at + 1], price: out[at + 2], holder: out[at + 3], onScreen: out[at + 4] });
  }
  return JSON.stringify(got);
})()`;

// What the page says it has drawn. ChartHud prints one line a second naming every box it drew - the price, the gate,
// YOU, the ghosts' labels, HIGH / LOW - so a marker that is drawn appears there by name.
const DRAWN = `(function () {
  var said = (window.__blwpChartLines || []).slice(-1)[0] || '';
  return said;
})()`;

const WATCH = `(function () {
  if (window.__blwpChartLines) return 'already watching';
  window.__blwpChartLines = [];
  var was = console.log;
  console.log = function () {
    try {
      var s = Array.prototype.join.call(arguments, ' ');
      if (s.indexOf('[chart]') === 0) window.__blwpChartLines.push(s);
    } catch (e) { /* a log is not worth throwing over */ }
    return was.apply(this, arguments);
  };
  return 'watching';
})()`;

test('the page draws the core\'s three objective markers', { timeout: 110000 }, async () => {
  const p = await page();
  assert.ok(p, `no page on CDP ${PORT}: start it with monitoring/blwp_mac_playtest.sh start && ... tunnel`);
  try {
    await p.send('Page.navigate', { url: PAGE });
    await wait(9000);
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      up = await p.evaluate('!!(window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwp)') === true;
      if (!up) await wait(2000);
    }
    assert.ok(up, 'the page never brought its core up');
    await p.evaluate(WATCH);

    // INTO THE WORLD FIRST. The HUD draws no chart on the lobby, so a run that reads the line there measures the
    // splash screen: the first pass of this test did exactly that and reported "no chart line to read". SPECTATE is
    // pressed at the rectangle the splash publishes for it (window.BLWP_UNITY_LOBBY), and the chart is on in
    // spectate by the owner's 2026-09-17 16:38 ruling.
    for (let i = 0; i < 40; i++) {
      if (await p.evaluate('!!window.BLWP_UNITY_LOBBY') === true) break;
      await wait(2000);
    }
    const view = await p.evaluate('JSON.stringify(window.BLWP_UNITY_LOBBY || null)');
    assert.ok(view && view !== 'null', 'the splash published no rectangles, so SPECTATE cannot be pressed');
    const splash = JSON.parse(view);
    const geom = JSON.parse(await p.evaluate(`(function(){var c=document.querySelector('canvas');var r=c.getBoundingClientRect();
      return JSON.stringify({k:r.width/c.width,left:r.left,top:r.top});})()`));
    const at = { x: geom.left + (splash.spectate[0] + splash.spectate[2] / 2) * geom.k,
                 y: geom.top + (splash.spectate[1] + splash.spectate[3] / 2) * geom.k };
    for (const type of ['mousePressed', 'mouseReleased'])
      await p.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(6000);

    const raw = await p.evaluate(MARKERS);
    assert.ok(raw && raw !== 'TIMED OUT', 'the page core did not answer for its chart view');
    const markers = JSON.parse(raw);
    assert.equal(markers.length, 3, 'the core publishes three objectives');

    // Give the HUD a second of frames, then read what it says it drew.
    await wait(3000);
    const line = String(await p.evaluate(DRAWN));
    assert.ok(line.includes('[chart]'), 'the HUD printed no chart line to read');

    // WHAT COUNTS AS DRAWN, and what does not. The HUD names every box it draws in this line - priceBox, gateBox,
    // youBox, ghostLabelBoxes, lastTagBox - so a marker it drew would be named there too. Searching the line for the
    // WORDS "HIGH" and "LOW" is not that test: the line already carries `highLow=HIGH_$81,044 · LOW_$80,916`, the
    // chart's own high and low price marks, and the first pass of this test counted those two as objective markers
    // drawn. It asks for an objective box instead.
    const onScreen = markers.filter((m) => m.onScreen !== 0);
    const boxes = (line.match(/objBox|objectiveBox(?:es)?|objLabelBoxes/g) || []).length;
    assert.ok(onScreen.length > 0, `the core put no objective on screen this tick: ${raw}`);
    assert.ok(boxes > 0,
      `the core put ${onScreen.length} objective marker(s) on the chart and the HUD's own line names no box for any `
      + `of them. ChartHud builds them into its frame (f.Objectives, ChartHud.cs:275) and nothing consumes that list `
      + `outside a test helper, so they are built and never drawn. Core words: ${raw}. HUD line: `
      + `"${line.slice(0, 300)}"`);
  } finally {
    p.close();
  }
});
