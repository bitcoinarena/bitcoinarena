// DOES THE ASSAULT HORN ACTUALLY SOUND? (the owner 2026-09-20 16:22: "a banner ... and a sound when it starts".)
//
// The banner and the desktop log are visible on screen and were measured there. The sound cannot be seen, and
// Unity's own audio bookkeeping is NOT reachable from the page: the framework declares `var WEBAudio = {...}`
// inside its own closure, so it is on neither `Module` nor `window`. Asking the page for it answers "no Unity
// WEBAudio module", which says nothing about whether a horn played.
//
// So this measures the horn where it actually lands: the Web Audio API. Before Unity loads, every
// `AudioBufferSourceNode.start` is wrapped to record the moment and the buffer's DURATION. The horn is built in
// code by `DriveHud.AssaultHorn` and is 0.55 s long at 44100, which no other sound in this build shares - so a
// started buffer of that length, within a second of `BLWP_UNITY_ASSAULT.chimes` going up, is the horn and
// nothing else. Nothing is patched in the game: the hook only counts.
//
// MUST RUN ON A GPU BROWSER. On SwiftShader the page runs the core at 23 ticks/s and the round closes under it
// before much happens; ANGLE/Vulkan on the the test host's AMD Renoir gives 61.4 ticks/s.
//
//   node probe-assault-horn.mjs <cdp-port> <url> <tag>
const PORT = Number(process.argv[2] || 9347);
const URL_ = process.argv[3] || 'http://127.0.0.1:8191/';
const TAG = process.argv[4] || 'horn';
const OUT = '/tmp/btc-phase0/owner-screens/';
const PLAY = [504, 690], AUTO = [306, 751], ROLLOUT = [660, 751];
const HORN_SECONDS = 0.55, TOLERANCE = 0.02;

let id = 0; const pend = new Map();
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result ?? d.error); pend.delete(d.id); } };
await new Promise((r) => { ws.onopen = r; });
await call('Runtime.enable'); await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await call('Network.enable'); await call('Network.clearBrowserCache');

// THE HOOK, installed before any page script runs.
await call('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function () {
    window.__BLWP_SOUNDS = { started: [], contexts: 0 };
    var NativeStart = (window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype.start);
    if (NativeStart) {
      window.AudioBufferSourceNode.prototype.start = function () {
        try {
          window.__BLWP_SOUNDS.started.push({
            at: Date.now(),
            seconds: this.buffer ? this.buffer.duration : -1,
            rate: this.buffer ? this.buffer.sampleRate : -1,
          });
        } catch (e) { /* counting must never break the game */ }
        return NativeStart.apply(this, arguments);
      };
    }
    ['AudioContext', 'webkitAudioContext'].forEach(function (n) {
      var C = window[n];
      if (!C) return;
      window[n] = function () {
        window.__BLWP_SOUNDS.contexts++;
        var c = new C(...arguments);
        window.__BLWP_SOUNDS.lastState = c.state;
        return c;
      };
      window[n].prototype = C.prototype;
    });
  })();
` });

const ev = (e) => call('Runtime.evaluate', { returnByValue: true, expression: e }).then((r) => r?.result?.value);
const click = async ([x, y]) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
  await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0 }); };
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png' });
  if (s && s.data) { (await import('node:fs')).writeFileSync(OUT + name, Buffer.from(s.data, 'base64')); return name; } return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = `(function(){ var s = window.__BLWP_SOUNDS || { started: [], contexts: 0 };
  var a = window.BLWP_UNITY_ASSAULT || null;
  return JSON.stringify({ sounds: s.started.length, contexts: s.contexts,
                          horns: s.started.filter(function (x) { return Math.abs(x.seconds - ${HORN_SECONDS}) < ${TOLERANCE}; }).length,
                          lengths: s.started.slice(-6).map(function (x) { return +x.seconds.toFixed(3); }),
                          chimes: a ? a.chimes : null, banner: a ? a.banner : null,
                          lines: a ? a.lines.length : 0, last: a && a.lines.length ? a.lines[a.lines.length - 1] : null }); })()`;

await call('Page.navigate', { url: URL_ });
let ready = false;
for (let i = 0; i < 45; i++) {
  await sleep(4000);
  const showing = await ev('!!(window.BLWP_UNITY_LOBBY&&window.BLWP_UNITY_LOBBY.showing)');
  const rows = await ev('(function(){try{var v=window.BLWP_LOBBY_VIEW&&window.BLWP_LOBBY_VIEW();return v?(v.rows||[]).length:0;}catch(e){return 0;}})()');
  if (showing === true && rows > 0) { console.log(`  lobby with ${rows} round(s) at t+${i * 4}s`); ready = true; break; }
}
if (!ready) { console.log('  NO LOBBY - stopping'); process.exit(1); }
await click(PLAY); await sleep(14000);
await click(AUTO); await sleep(1500); await click(ROLLOUT); await sleep(3000);
console.log(`  rolled out: ${await ev(READ)}`);

let chimes = 0, reported = 0;
for (let i = 0; i < 300; i++) {
  await sleep(1000);
  let o; try { o = JSON.parse(await ev(READ)); } catch { continue; }
  if (o.chimes !== null && o.chimes > chimes) {
    // THE WINDOW, not a before/after count. The horn is started in the same frame the chime is counted, which
    // is very likely BEFORE this poll reads it - comparing a count taken here with one taken later therefore
    // reports "no horn" for a horn that has already sounded. That was the first version's own bug. Ask instead
    // which buffers were started in the second either side of the banner, and what length each was.
    console.log(`    t+${i}s  CHIME ${chimes} -> ${o.chimes}   banner "${o.banner}"   ${o.last}`);
    const mark = Date.now();
    await sleep(1200);
    const around = await ev(`(function(){ var s = window.__BLWP_SOUNDS.started;
      return JSON.stringify(s.filter(function (x) { return Math.abs(x.at - ${mark}) <= 1500; })
                             .map(function (x) { return +x.seconds.toFixed(3); })); })()`);
    const lens = JSON.parse(around || '[]');
    const horn = lens.filter((L) => Math.abs(L - HORN_SECONDS) < TOLERANCE);
    console.log(`       ${lens.length} buffers started within 1.5 s of the banner: ${JSON.stringify(lens)}`);
    if (horn.length) console.log(`       *** THE HORN SOUNDED: ${horn.length} buffer(s) of ${HORN_SECONDS}s with the banner`);
    else console.log(`       *** NO HORN in that window - no ${HORN_SECONDS}s buffer among them`);
    chimes = o.chimes;
    if (++reported === 1) console.log(`  shot: ${await shot(TAG + '-banner.png')}`);
    if (reported >= 2) break;
  }
  if (i % 30 === 0) console.log(`    t+${i}s  chimes ${o.chimes}  sounds ${o.sounds}  contexts ${o.contexts}`);
}
const census = await ev(`(function(){ var s = window.__BLWP_SOUNDS.started, by = {};
  s.forEach(function (x) { var k = x.seconds.toFixed(3); by[k] = (by[k] || 0) + 1; });
  return JSON.stringify(Object.keys(by).sort(function(a,b){return by[b]-by[a];}).slice(0, 12)
                              .map(function (k) { return k + 's x' + by[k]; })); })()`);
console.log(`  every buffer length started, commonest first: ${census}`);
const end = JSON.parse(await ev(READ));
console.log(`\n  RESULT chimes ${end.chimes}, buffers started ${end.sounds}, of horn length ${end.horns},`
  + ` audio contexts ${end.contexts}, log lines ${end.lines}`);
process.exit(end.horns > 0 ? 0 : 2);
