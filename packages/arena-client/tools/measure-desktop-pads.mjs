#!/usr/bin/env node
// Do the on-screen driving pads drive the truck on a DESKTOP page?
//
// the owner 2026-09-18 20:22 (HARD): "on desktop the mobile pads are drawn but do nothing. They must stay drawn AND they
// must drive the truck. Mouse / pointer on a pad = throttle, steer, handbrake. Measure on desktop WebGL."
//
// This measures the whole chain the player uses, in the page itself: a real mouse press at the pad's own rectangle,
// and the answer read off the PAGE'S OWN CORE (`unityInstance.Module.blwp.st.i32`) - not a node client, not a
// screenshot. The keyboard is pressed the same way in a second window as the control: if W moves the truck and the
// pad does not, the fault is between the mouse and DriveInput, not in the run.
//
// Live Chrome runs on the test host (HARD 19:05): monitoring/blwp_mac_playtest.sh start && ... tunnel, then --attach.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const PORT = Number(arg('port', 9351));
const OUT = arg('out', '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/desktop-pads');
const CHROME = arg('chrome', '/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const HOLD_MS = Number(arg('hold', 4000));
const DPR = Number(arg('dpr', 1));
const ATTACH = process.argv.includes('--attach');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${clock()}  ${line}`);
const METRES = (w) => w / 65536;
mkdirSync(OUT, { recursive: true });

async function browser(port) {
  if (ATTACH) {
    let target = null;
    for (let i = 0; i < 30 && !target; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
      target = list.find((x) => x.type === 'page' && x.url.startsWith('http'));
      if (!target) await wait(1000);
    }
    if (!target) throw new Error(`nothing to attach to on ${port}`);
    return await wire({ pid: 0, kill() {} }, target);
  }
  const dir = mkdtempSync(join(tmpdir(), 'blwp-pads-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox',
    `--user-data-dir=${dir}`, '--window-size=1280,800', '--hide-scrollbars',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', PAGE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await wait(1000);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
  }
  if (!target) throw new Error('chrome never opened the page');
  return await wire(proc, target);
}

async function wire(proc, target) {
  const logs = [];
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled')
      logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      wait(20000).then(() => null),
    ]);
    if (!r) return 'TIMED OUT';
    if (r.result?.exceptionDetails) return `THREW ${r.result.exceptionDetails.text}`;
    return r.result?.result?.value;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (r?.result?.data) writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64'));
  };
  const key = (type, code, keyCode, text) => send('Input.dispatchKeyEvent', {
    type, code, key: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    ...(type === 'keyDown' ? { text } : {}),
  });
  return { ws, send, evaluate, shot, key, logs, close: () => { try { ws.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} } };
}

// Where the truck is AND where it is going, in the page's own core. O_TICK 0, O_TRUCK 5,
// T_X 0, T_Z 1, T_HEADING 2 (a whole turn is 65536), T_VX 3, T_VZ 4.
//
// SPEED, NOT DISTANCE. The first run of this compared metres travelled, and a truck that is already rolling covers
// twenty metres with nothing held at all - so coasting read as "the pad drives". What a throttle does is change the
// speed, and the core carries the velocity itself.
const POSE = `(function () {
  var m = window.unityInstance && window.unityInstance.Module;
  var st = m && m.blwp && m.blwp.st;
  if (!st) return null;
  // O_SCORE 18 + S_STATE 5: 0 while the run is live, 1 DELIVERED, 2 WRECKED, 3 MISSED. A finished run ignores every
  // input there is, and the run before this one read that silence as a dead pad.
  return { tick: st.i32[0], x: st.i32[5], z: st.i32[6], heading: st.i32[7], vx: st.i32[8], vz: st.i32[9],
           run: st.i32[23] };
})()`;

// Whether this page actually holds a seat in a round, in its own words - a refusal here is a different fault from
// pads that do not answer, and the last run confused the two.
const SEAT = `(function () {
  var m = window.unityInstance && window.unityInstance.Module;
  var net = m && m.blwpNet;
  if (!net) return 'no bridge';
  var hex = function (a) { return a ? Array.from(a).slice(0, 4).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('') : ''; };
  return 'state ' + (net.client ? String(net.client.state || '') : 'no client')
    + ', round ' + (net.where ? hex(net.where.roundId) : '-')
    + ', entry ' + (net.where ? hex(net.where.entryId) : '-')
    + ', error ' + (net.error || window.BLWP_JOIN_REFUSED || 'none');
})()`;

// The pad rectangles, computed the way TouchPad.RectFor computes them, then put into CSS pixels so a mouse event
// lands where the pad is drawn. Unity's GUI space is the CANVAS's backing-store pixels, origin top-left.
const GEOMETRY = `(function () {
  var c = document.querySelector('canvas');
  if (!c) return null;
  var r = c.getBoundingClientRect();
  var w = c.width, h = c.height;
  var s = Math.max(76, Math.min(w, h) * 0.20);
  var m = Math.max(14, Math.min(w, h) * 0.035);
  var bottom = h - m - s;
  var pads = {
    left:  { x: m,               y: bottom,             w: s, h: s },
    right: { x: m + s + m * 0.5, y: bottom,             w: s, h: s },
    up:    { x: w - m - s,       y: bottom - s - m*0.5, w: s, h: s },
    down:  { x: w - m - s,       y: bottom,             w: s, h: s }
  };
  // THE BAY'S OWN TWO BUTTONS, laid out the way LoadoutPanel.Bar lays them out. Their font sizes and the panel's
  // width are CLAMPED, so the panel is not in the same place on a 2560-wide screen as on a 1280-wide one - which is
  // why clicking remembered pixels departed at one pixel ratio and never departed at the other.
  var bpad = Math.max(10, h * 0.022);
  var headFont = Math.round(Math.min(Math.max(Math.min(w, h) * 0.034, 15), 26));
  var lh = headFont * 1.6;
  var barW = Math.min(w * 0.94, 1040);
  var panelH = lh * 5.1;
  var px = (w - barW) / 2, py = h - panelH - bpad;
  var inner = bpad * 1.2;
  var gaugeW = (barW - inner * 3) * 0.34;
  var by = py + panelH - lh * 1.25;
  pads.auto    = { x: px + inner, y: by, w: gaugeW, h: lh };
  pads.rollOut = { x: px + inner * 2 + gaugeW, y: by, w: gaugeW, h: lh };

  var out = { canvas: { w: w, h: h, cssW: r.width, cssH: r.height, left: r.left, top: r.top }, dpr: window.devicePixelRatio, pads: {} };
  Object.keys(pads).forEach(function (k) {
    var p = pads[k];
    out.pads[k] = {
      x: r.left + (p.x + p.w / 2) * (r.width / w),
      y: r.top  + (p.y + p.h / 2) * (r.height / h)
    };
  });
  return out;
})()`;

let page = null;
try {
  say(`page ${PAGE}`);
  page = await browser(PORT);

  // A RETINA SCREEN, WHEN ASKED FOR. the owner's test host draws at devicePixelRatio 2, and the template sizes the
  // drawing buffer `innerWidth * dpr` - so Unity's Screen is twice the page's CSS pixels there and only there. If
  // the pads answer a mouse at 1 and ignore it at 2, that difference is the bug.
  if (DPR !== 1) {
    await page.send('Emulation.setDeviceMetricsOverride',
                    { width: 1280, height: 800, deviceScaleFactor: DPR, mobile: false });
    say(`the page is pretending to be a devicePixelRatio ${DPR} screen`);
  } else {
    // AN ATTACHED TAB KEEPS THE LAST OVERRIDE. One run measured "dpr 1" on a tab still pretending to be retina.
    await page.send('Emulation.clearDeviceMetricsOverride');
  }

  // A FRESH PAGE FIRST. An attached tab has been sitting since the last probe, and a tab whose session already died
  // refuses the next one with "no proven endpoint" - which is not what this letter is measuring.
  await page.send('Page.navigate', { url: PAGE });
  await wait(8000);

  // ONE seat, joined the way a player joins: the lobby's own free-round link.
  let rows = 0;
  for (let i = 0; i < 90 && !rows; i++) {
    rows = Number(await page.evaluate('(window.BLWP_LOBBY || []).length')) || 0;
    if (!rows) await wait(2000);
  }
  say(`lobby rows ${rows}`);
  let href = '';
  for (let i = 0; i < 60 && !href; i++) {
    const got = await page.evaluate(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];`
      + `return r ? (location.origin + location.pathname + r.join + '&play=1') : '';})()`);
    if (got && String(got).includes('round=')) href = String(got); else await wait(3000);
  }
  if (!href) throw new Error('no joinable free round in the lobby');
  await page.send('Page.navigate', { url: href });
  await wait(6000);
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate('(location.search.indexOf("round=") >= 0) && !!window.unityInstance') === true) break;
    await wait(2000);
  }
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(800);
  };

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = await page.evaluate('!!(window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwpNet)');
    if (!up) await wait(3000);
  }
  say(`the bridge is ${up ? 'up' : 'STILL NOT UP'}`);
  say(`the seat: ${await page.evaluate(SEAT)}`);

  // The run has to be moving under its own clock before any of this means anything.
  let pose = null;
  for (let i = 0; i < 40; i++) {
    pose = await page.evaluate(POSE);
    if (pose && pose.tick > 0) break;
    await wait(3000);
  }
  if (!pose || !pose.tick) throw new Error('the page core never started ticking');
  say(`the core is ticking: tick ${pose.tick}, truck at (${METRES(pose.x).toFixed(1)}, ${METRES(pose.z).toFixed(1)}) m`);

  // WHAT HOLDING SOMETHING DID: the speed it reached, the distance it covered and the heading it turned through,
  // all read from the page's own core. The core is the player's outcome, not a re-simulation of it.
  const TURNS = (w) => ((((w % 65536) + 98304) % 65536) - 32768) * 360 / 65536;   // signed degrees
  const drove = async (ms, hold, release) => {
    const before = await page.evaluate(POSE);
    if (hold) await hold();
    const t0 = Date.now();
    let far = 0, top = 0, last = before;
    while (Date.now() - t0 < ms) {
      await wait(400);
      const now = await page.evaluate(POSE);
      if (now && last) far += Math.hypot(METRES(now.x - last.x), METRES(now.z - last.z));
      if (now) { top = Math.max(top, Math.hypot(METRES(now.vx), METRES(now.vz))); last = now; }
    }
    if (release) await release();
    return {
      far, top, run: last ? last.run : -1,
      turned: last && before ? TURNS(last.heading - before.heading) : 0,
      ticks: last && before ? last.tick - before.tick : 0,
    };
  };
  const holdW = (ms) => drove(ms, () => page.key('keyDown', 'KeyW', 87, 'w'), () => page.key('keyUp', 'KeyW', 87, 'w'));

  // EVERY WINDOW STARTS FROM A STANDSTILL, or the one before it is still rolling through this one. The brake is the
  // keyboard's, which the control window proves works.
  const stop = async () => {
    await page.key('keyDown', 'Space', 32, ' ');
    for (let i = 0; i < 25; i++) {
      await wait(400);
      const p = await page.evaluate(POSE);
      if (p && Math.hypot(METRES(p.vx), METRES(p.vz)) < 0.4) break;
    }
    await page.key('keyUp', 'Space', 32, ' ');
    await wait(600);
  };

  const geom = await page.evaluate(GEOMETRY);
  if (!geom) throw new Error('no canvas');
  say(`canvas ${geom.canvas.w}x${geom.canvas.h} backing, ${Math.round(geom.canvas.cssW)}x${Math.round(geom.canvas.cssH)} css, dpr ${geom.dpr}`);
  say(`the UP pad's centre is at css (${geom.pads.up.x.toFixed(0)}, ${geom.pads.up.y.toFixed(0)}), ROLL OUT at `
      + `(${geom.pads.rollOut.x.toFixed(0)}, ${geom.pads.rollOut.y.toFixed(0)})`);
  await page.shot('01-pads-drawn.png');

  // THE BAY, PRESSED AT ITS OWN RECTANGLES until it opens. The keyboard is the proof the run is live.
  let live = (await holdW(2500)).far > 0.5;
  for (let i = 0; i < 6 && !live; i++) {
    await click(geom.canvas.cssW / 2, geom.canvas.cssH * 0.69);   // the splash, if it is still up
    await wait(2000);
    await click(geom.pads.auto.x, geom.pads.auto.y); await wait(1500);
    await click(geom.pads.rollOut.x, geom.pads.rollOut.y); await wait(3000);
    live = (await holdW(2500)).far > 0.5;
    say(`after try ${i + 1} the truck ${live ? 'answers the keyboard' : 'is still parked'}`);
  }
  if (!live) {
    say(`the run never started: ${await page.evaluate(SEAT)}`);
    await page.shot('00-never-departed.png');
    throw new Error('the truck never left the bay, so the pads cannot be measured');
  }

  const window_ = async (what, hold, release) => {
    await stop();
    const r = await drove(HOLD_MS, hold, release);
    say(`${what}: ${r.top.toFixed(2)} m/s top, ${r.far.toFixed(2)} m, turned ${r.turned.toFixed(1)} deg, ${r.ticks} ticks`
        + (r.run ? `, THE RUN IS OVER (${r.run})` : ''));
    return r;
  };
  const press = (p) => async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
  };
  const lift = (p) => async () =>
    page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });

  let clicking = false;
  const idle = await window_('nothing held                 ', null, null);
  const pad = await window_('the UP pad held with the mouse', press(geom.pads.up), lift(geom.pads.up));
  await page.shot('02-pad-held.png');
  // A MOUSE CLICKS, IT DOES NOT HOLD. A pad built for a thumb gets a tenth of a second from a mouse, and "the pads
  // do nothing" is what a tenth of a second of throttle looks like. Measured, so the difference is a number.
  const clicks = await window_('the UP pad CLICKED, not held ',
    async () => {
      clicking = true;
      (async () => {
        while (clicking) {
          await press(geom.pads.up)();
          await wait(120);
          await lift(geom.pads.up)();
          await wait(200);
        }
      })();
    },
    async () => { clicking = false; await wait(400); });

  const keys = await window_('W held on the keyboard       ', () => page.key('keyDown', 'KeyW', 87, 'w'),
                                                              () => page.key('keyUp', 'KeyW', 87, 'w'));
  // STEERING CANNOT COAST: a truck rolling straight holds its heading, so a turn is the pad's own doing. Held with
  // the keyboard's throttle, because a still truck cannot steer at all.
  const wheel = async (what, hold, release) => {
    await stop();
    await page.key('keyDown', 'KeyW', 87, 'w');
    const r = await drove(HOLD_MS, hold, release);
    await page.key('keyUp', 'KeyW', 87, 'w');
    say(`${what}: turned ${r.turned.toFixed(1)} deg, ${r.far.toFixed(2)} m` + (r.run ? `, THE RUN IS OVER (${r.run})` : ''));
    return r;
  };
  const straight = await wheel('driving straight, no pad     ', null, null);
  const padRight = await wheel('the RIGHT pad with the mouse ', press(geom.pads.right), lift(geom.pads.right));
  await page.shot('03-right-pad-held.png');

  say('');
  say(`top speed: idle ${idle.top.toFixed(2)} | UP pad held ${pad.top.toFixed(2)} | UP pad clicked `
      + `${clicks.top.toFixed(2)} | keyboard W ${keys.top.toFixed(2)} m/s`);
  say(`turned: straight ${straight.turned.toFixed(1)} | RIGHT pad ${padRight.turned.toFixed(1)} deg`);
  const keyDrives = keys.top > idle.top + 1;
  const padDrives = pad.top > idle.top + 1;
  const padSteers = padRight.turned - straight.turned > 10;
  if (!keyDrives) {
    say('the KEYBOARD did not drive it either - this measurement proves nothing about the pads');
  } else {
    say(padDrives ? 'the UP pad DRIVES the truck' : 'the UP pad does NOT drive the truck, while the keyboard does');
    say(padSteers ? 'the RIGHT pad STEERS the truck' : 'the RIGHT pad does NOT steer the truck');
  }
  const seen = page.logs.filter((l) => /touch|pad|input/i.test(l)).slice(-5);
  if (seen.length) say(`the page said: ${seen.join(' | ')}`);
  say(`shots in ${OUT}`);
} catch (e) {
  say(`FAILED ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
} finally {
  if (page) page.close();
}
