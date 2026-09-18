// TWO REAL BROWSERS ON THE DAILY, EACH LOOKING FOR THE OTHER'S TRUCK (the owner 2026-09-17 19:15, the two-tab gate).
//
// Every other measurement on this letter was made with node clients: they carry the same @blwp/client, the same
// watch, the same stamps, and they proved the wire and the label's arithmetic. What they cannot do is BE a browser -
// no jslib, no C#, no camera. This drives two headless Chromes at the deployed page instead, presses the page's own
// PLAY in each, and asks each tab what it holds of the other one.
//
// IT IS NOT THE OWNER'S SHOT AND CANNOT BE. Headless swiftshader draws about eleven frames a second where a player has
// sixty (measured by `screen.mjs` on this same host), and the age over a truck is partly how long the page waited for
// a frame. So an age here is the number THIS MACHINE shows, not the number a player sees, and a large one is not a
// failure of the ghost path. What this can say, and what a node client never could, is whether the two tabs are shown
// to each other at all, whether the labels exist with the name and the arrows, and whether a new round puts the other
// truck straight onto its first picture.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const PAGE = arg('page', 'https://btc-logistics-core.pages.dev/');
const MINUTES = Number(arg('minutes', 14));
const OUT = arg('out', '/tmp/claude-1000/-tmp-btc-phase0/3702e750-4ad9-4253-93e3-670b04a90b08/scratchpad/two-tabs');
const CHROME = arg('chrome', '/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${clock()}  ${line}`);
mkdirSync(OUT, { recursive: true });

/** One headless Chrome, and the few CDP calls this needs. */
async function browser(name, port) {
  const dir = mkdtempSync(join(tmpdir(), `blwp-${name}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox',
    `--user-data-dir=${dir}`, '--window-size=1280,800', '--hide-scrollbars',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', PAGE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const trouble = [];
  proc.stderr.on('data', (b) => {
    const s = String(b);
    // THE FAILURE THE OWNER ASKED FOR BY NAME: a second WebGL context that will not start says so here.
    if (/context lost|Out of memory|GPU process|SwiftShader|WebGL|crash/i.test(s)) trouble.push(s.trim().slice(0, 200));
  });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await wait(1000);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
  }
  if (!target) throw new Error(`${name}: chrome never opened the page`);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  const said = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const line = m.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
      logs.push(line);
      if (/context lost|WebGL|out of memory|abort/i.test(line)) trouble.push(`console: ${line.slice(0, 200)}`);
      if (/no session yet|session opening/.test(line)) said.push(`${name}: ${line.slice(0, 160)}`);
    }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  // EVERY ASK HAS AN END. The renderer draws about eleven frames a second here, and one `Runtime.evaluate` that never
  // came back ended the first run of this tool on an unsettled await rather than on a measurement.
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
  return { name, proc, ws, send, evaluate, shot, key, logs, said, trouble, close: () => { try { ws.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} } };
}

/** What one tab holds of the round and of the other trucks - asked of the page's own objects. */
const STATE = `(function () {
  var out = { boot: '', join: '', round: '', entry: '', ghosts: 0, labels: '', fps: 0, why: '' };
  try {
    // THE PAGE'S OWN WAY OF REACHING THE NET (index.html \`theClient\`): the Module is inside the Unity instance,
    // not a global. Asking for a global \`Module\` said "no net" for twelve minutes while the round was running and
    // the console was printing [spawnmark] and [strike] lines from that very page.
    var b = document.getElementById('boot');
    out.boot = !window.unityInstance ? 'unity not up' : (b ? getComputedStyle(b).display : 'gone');
    out.join = window.BLWP_JOIN ? (window.BLWP_JOIN.state + (window.BLWP_JOIN.why ? ' ' + window.BLWP_JOIN.why : '')) : '';
    var hex = function (u8) { return Array.prototype.map.call(u8, function (x) { return x.toString(16).padStart(2, '0'); }).join(''); };
    var inst = window.unityInstance;
    var mod = (inst && inst.Module) || (typeof Module !== 'undefined' ? Module : window.Module);
    var n = mod && mod.blwpNet;
    out.say = (function () {
      var el = document.getElementById('blwp-players');
      return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    })();
    // WHAT THE RENDERER IS DRAWING OVER THE TRUCKS, left there by the jslib for exactly this.
    out.drawn = (mod && mod.blwpGhostLabelText) || '';
    if (!n) { out.why = window.unityInstance ? 'unity up, no net yet' : 'unity not up'; return out; }
    if (n.where) { out.round = hex(n.where.roundId).slice(0, 16); out.entry = hex(n.where.entryId); }
    if (n.ghosts && n.ghosts.present) out.ghosts = n.ghosts.present.size;
    if (typeof BLWPCLIENT !== 'undefined' && BLWPCLIENT.ghostLabels && n.ghosts) {
      out.labels = BLWPCLIENT.ghostLabelText(BLWPCLIENT.ghostLabels(n.ghosts, { clock: mod.blwpTickClock || null }));
    }
    out.fps = window.__blwpFrames || 0;
  } catch (e) { out.why = String(e && e.message || e); }
  return out;
})()`;

const tabs = [];
try {
  say(`page ${PAGE}`);
  const a = await browser('tabA', 9341);
  tabs.push(a);
  const b = await browser('tabB', 9342);
  tabs.push(b);
  say('two chromes are up');

  // THE PLAYER IS 35 MB AND BUILDS A BATTLEFIELD. The boot screen goes when it is ready, which on this host is minutes.
  // THE LOBBY IS DOM AND COMES FIRST; Unity only loads once a round is joined. So what is waited for here is the
  // lobby having rows, not a boot screen.
  for (const t of tabs) {
    let rows = 0;
    for (let i = 0; i < 90; i++) {
      rows = Number(await t.evaluate('(window.BLWP_LOBBY || []).length')) || 0;
      if (rows > 0) break;
      await wait(2000);
    }
    say(`${t.name}: lobby rows ${rows}`);
    await t.shot(`${t.name}-01-lobby.png`);
  }

  // PLAY, BY THE PAGE'S OWN HAND. `BLWP_LOBBY_ACT.join` is what the lobby's PLAY link calls: the address becomes the
  // round's link and the round is joined in this page, with no reload.
  // PLAY IN ONE MOVE, re-read each try: the lobby list is REPLACED as rounds roll over, and a `join(id)` for a row
  // that has just been replaced answers false - which is what happened the first time this ran, seven seconds after
  // the id was read.
  // THE ROUND'S OWN LINK, OPENED BEFORE UNITY LOADS. Pressing the lobby's PLAY in a page whose Unity has already
  // booted at the bare root leaves the game in practice - photographed on this host: the truck departs, drives, and
  // the page's own line reads "play - not started, 1 player - waiting" for eleven minutes, because the C# never opens
  // a round session and so never builds `Module.blwpNet`. The link `?round=...&play=1` is what the lobby's PLAY puts
  // in the address anyway, and what a second tab is given; opening it first is the flow that has a session.
  const link = async (t) => {
    for (let i = 0; i < 20; i++) {
      const href = await t.evaluate(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];`
        + `return r ? (location.origin + location.pathname + r.join + '&play=1') : '';})()`);
      if (href && String(href).includes('round=')) return String(href);
      await wait(3000);
    }
    return '';
  };
  const play = async (t, href) => {
    await t.send('Page.navigate', { url: href });
    await wait(4000);
    const round = /round=([0-9a-f]+)/.exec(href);
    return round ? round[1] : '';
  };
  const click = async (t, x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await t.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(800);
  };
  const href = await link(a);
  if (!href) throw new Error('tabA never saw a joinable free round in its lobby');
  say(`both tabs open the round's own link: ${href.replace(/^https?:\/\/[^/]+/, '').slice(0, 70)}...`);
  const roundA = await play(a, href);
  const roundB = await play(b, href);
  say(`tabA round ${roundA.slice(0, 16)}; tabB round ${roundB.slice(0, 16)}`);
  say(roundA && roundA === roundB ? 'both tabs took the same round' : 'THE TABS TOOK DIFFERENT ROUNDS');

  // AND THEN PLAY INSIDE THE GAME. The lobby's PLAY joins the round; Unity still shows its own splash, and the bridge
  // - `Module.blwpNet` - is only built when the round starts. Measured before this was here: `BLWP_ROUND` and
  // `BLWP_ENTRY` set, `unityInstance.Module` present, and no net for three and a half minutes. The splash button, the
  // AUTO that fills the bed and the depart are the same three clicks `screen.mjs` makes, at 1280x800.
  // WAIT FOR THE PAGE THAT WAS NAVIGATED TO, not the one that was there before: asking `!!window.unityInstance` two
  // seconds after `Page.navigate` answered true off the old context, and the splash clicks then fired into a page
  // that was still loading. The new document is the one whose address carries the round.
  for (const t of tabs) {
    for (let i = 0; i < 120; i++) {
      const ready = await t.evaluate('(location.search.indexOf("round=") >= 0) && !!window.unityInstance');
      if (ready === true) break;
      await wait(2000);
    }
    await t.shot(`${t.name}-01a-splash-before-any-click.png`);
    say(`${t.name}: unity ${await t.evaluate("!!window.unityInstance")}, join ${await t.evaluate("(window.BLWP_JOIN||{}).state || '-'")}`);
  }
  // SPLASH, THEN THE BAY, THEN THE BRIDGE - in that order. Photographed on this host at 1280x800 after the splash
  // click: the tab is in the loading bay - "CHOOSE YOUR MEMPOOL CARGO", AUTO (80%) bottom left, and the page's own
  // line reading "play - not started, 1 player - waiting". The run only starts when the truck is loaded and departs,
  // so waiting for `Module.blwpNet` before those two clicks waits for something that cannot happen yet.
  for (const t of tabs) { await click(t, 486, 554); await wait(2500); await t.shot(`${t.name}-01b-splash.png`); }
  for (const t of tabs) {
    await click(t, 303, 617);              // AUTO - fill the bed
    await wait(2000);
    await click(t, 660, 617);              // and depart
    await wait(2000);
    await t.shot(`${t.name}-01c-departed.png`);
  }
  for (const t of tabs) {
    let net = false;
    for (let i = 0; i < 40 && !net; i++) {
      net = await t.evaluate('!!(window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwpNet)');
      if (!net) await wait(3000);
    }
    say(`${t.name}: the bridge is ${net ? 'up' : 'STILL NOT UP - the round never started in this tab'}`);
  }

  // AND NOW WATCH BOTH. The interesting columns are: are they in one round, does each hold a ghost of the other, and
  // what do the two lines say.
  const until = Date.now() + MINUTES * 60000;
  const seenOfEachOther = { a: 0, b: 0 };
  const ages = { a: [], b: [] };
  let shots = 0;
  let drove = false;
  while (Date.now() < until) {
    const sa = await a.evaluate(STATE);
    const sb = await b.evaluate(STATE);
    const line = (n, s, other) => `${n} round ${s.round || '-'} join ${s.join || '-'} ghosts ${s.ghosts}`
      + (s.labels ? ` | ${s.labels.split('\n').map((l) => l.split('\t').slice(1).join(' ')).join(' ; ')}` : '')
      + (s.why ? ` (${s.why})` : '')
      + (s.say ? ` :: ${s.say}` : '')
      + (s.drawn ? ` || DRAWN ${s.drawn.replace(/\n/g, ' ; ')}` : '');
    say(line('tabA', sa));
    say(line('tabB', sb));
    const holds = (s, otherEntry) => (s.labels || '').split('\n').find((l) => l.startsWith(String(otherEntry || 'x')));
    const aHoldsB = sb.entry ? holds(sa, sb.entry) : null;
    const bHoldsA = sa.entry ? holds(sb, sa.entry) : null;
    if (aHoldsB) { seenOfEachOther.a++; const m = /(\d+)ms/.exec(aHoldsB); if (m) ages.a.push(Number(m[1])); }
    if (bHoldsA) { seenOfEachOther.b++; const m = /(\d+)ms/.exec(bHoldsA); if (m) ages.b.push(Number(m[1])); }
    if (aHoldsB && bHoldsA && shots < 3) { shots++; await a.shot(`tabA-02-sees-${shots}.png`); await b.shot(`tabB-02-sees-${shots}.png`); }

    // DRIVE ONE AWAY, so the other tab has a truck that is off its screen: that is what the rim marker is for.
    if (!drove && aHoldsB && bHoldsA) {
      drove = true;
      say('tabA drives away for 25 s, so tabB has a truck off its screen');
      await a.key('keyDown', 'KeyW', 87, 'w');
      await wait(25000);
      await a.key('keyUp', 'KeyW', 87, 'w');
      await b.shot('tabB-03-other-truck-away.png');
      await a.shot('tabA-03-driven-away.png');
    }
    await wait(5000);
  }

  const p50 = (xs) => (xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
  console.log('\n# what the two tabs held of each other');
  console.log(`tabA held a ghost of tabB in ${seenOfEachOther.a} looks; age p50 ${p50(ages.a) ?? '-'} ms`);
  console.log(`tabB held a ghost of tabA in ${seenOfEachOther.b} looks; age p50 ${p50(ages.b) ?? '-'} ms`);
  for (const t of tabs) {
    console.log(`${t.name} on the session: ` + (t.said.length ? [...new Set(t.said)].join('\n  ') : 'said nothing'));
    if (t.trouble.length) console.log(`${t.name} trouble:\n  ` + [...new Set(t.trouble)].slice(0, 6).join('\n  '));
    else console.log(`${t.name}: no WebGL context loss, no out-of-memory`);
    console.log(`${t.name} last console lines:\n  ` + t.logs.slice(-6).join('\n  '));
  }
  console.log(`shots in ${OUT}`);
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  for (const t of tabs) console.log(`${t.name} last console:\n  ` + t.logs.slice(-10).join('\n  '));
} finally {
  for (const t of tabs) t.close();
  await wait(500);
  process.exit(0);
}
