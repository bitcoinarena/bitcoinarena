// THE DRAWN GHOST AGAINST THE OTHER PAGE'S OWN CORE, IN THE BROWSER (the owner 2026-09-18 14:20).
//
// Every earlier attempt at this used a node client as a stand-in for the page's core, and every large number it
// produced turned out to be the stand-in rather than the game. So this reads the PAGE's own core: `Module.blwp.st.i32`
// is the whole state the jslib steps, and O_TICK / O_TRUCK+T_X / T_Z / T_HEADING are its truck. Each tab records its
// own truck per frame and every ghost picture it holds, and afterwards tab A's ghost of B at tick T is held against
// B's OWN core at that same tick.
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
const DRIVE_MS = Number(arg('drive', 120000));   // of the FIRST round; the second is the one being measured
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
// THE PAGE'S OWN CORE, per frame, and every ghost it holds. Injected once the bridge is up; `Module.blwp.st.i32` is
// the state the jslib steps, and the offsets are the ones the C# layout is generated from.
const RECORDER = `(function () {
  if (window.__blwpRec) return 'already';
  var rec = window.__blwpRec = { mine: [], ghosts: [], seed: null, said: 'pending', watched: null };
  // WHAT THE NODE ANSWERED THE WATCH WITH. client.watch sends a watch line and resolves with the node's own word; a
  // field with nothing in it is either a watch that was refused or one that was never answered, and those are
  // different faults. Also kept: what the client thinks it is watching.
  try {
    var mod0 = window.unityInstance && window.unityInstance.Module;
    var net0 = mod0 && mod0.blwpNet;
    if (net0 && net0.ghosts && net0.ghosts.watching && net0.ghosts.watching.then) {
      net0.ghosts.watching.then(function (v) { rec.said = 'answered: ' + String(v); },
                                function (e) { rec.said = 'refused: ' + String(e && e.message || e); });
    }
    if (net0 && net0.client) rec.watched = net0.client.watchingWhat
      ? 'round ' + String(net0.client.watchingWhat.round).slice(0, 16) : 'the client is watching nothing';
  } catch (e) { rec.said = 'threw ' + String(e && e.message || e); }
  var O_TICK = 0, O_TRUCK = 5, T_X = 0, T_Z = 1, T_HEADING = 2;
  function frame() {
    requestAnimationFrame(frame);
    try {
      var mod = window.unityInstance && window.unityInstance.Module;
      var st = mod && mod.blwp && mod.blwp.st;
      if (st) {
        var i = st.i32;
        rec.mine.push([i[O_TICK], i[O_TRUCK + T_X], i[O_TRUCK + T_Z], i[O_TRUCK + T_HEADING]]);
        if (rec.mine.length > 20000) rec.mine.splice(0, 5000);
      }
      var net = mod && mod.blwpNet;
      var f = net && net.ghosts;
      var held = f && f.present;
      if (held) held.forEach(function (g, who) {
        // THE PICTURE'S OWN ENTRY, not the key of the map: the field keys a drawn truck by its PLAYER, and comparing
        // that with an entry id matched nothing at all while 48 samples sat in hand.
        var eid = g.entryId ? Array.prototype.map.call(g.entryId, function (x) { return x.toString(16).padStart(2, '0'); }).join('') : String(who);
        rec.ghosts.push([eid, g.tick, g.x, g.z, g.heading, Date.now()]);
        if (rec.ghosts.length > 20000) rec.ghosts.splice(0, 5000);
      });
      // AND WHAT THE FIELD ITSELF SAYS IT HAS SEEN, so no-ghost can be told from nothing-delivered: the counters
      // watchGhosts keeps - what arrived, what is queued, what was this page's own, what it drew.
      if (f) rec.field = { drawn: f.drawn | 0, size: f.size | 0, others: f.others | 0, self: f.self | 0,
        silenced: f.silenced | 0, retired: f.retired | 0, superseded: f.superseded | 0, shed: f.shed | 0,
        collapsed: f.collapsed | 0, watching: String(f.watching && f.watching.constructor && f.watching.constructor.name) };
    } catch (e) { rec.why = String(e && e.message || e); }
  }
  requestAnimationFrame(frame);
  return 'recording';
})()`;

const MINE = `(function () {
  var r = window.__blwpRec || { mine: [], ghosts: [] };
  var net = window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwpNet;
  var hex = function (u8) { return Array.prototype.map.call(u8, function (x) { return x.toString(16).padStart(2, '0'); }).join(''); };
  return {
    entry: net && net.where ? hex(net.where.entryId) : '',
    round: net && net.where ? hex(net.where.roundId) : '',
    mine: r.mine, ghosts: r.ghosts, why: r.why || '', field: r.field || null,
    said: r.said, watched: r.watched,
    socket: net && net.client ? String(net.client.state || '') + ' seen ' + (net.seen | 0) : 'no client'
  };
})()`;

try {
  say(`page ${PAGE}`);
  const a = await browser('tabA', 9341);
  tabs.push(a);
  const b = await browser('tabB', 9342);
  tabs.push(b);
  say('two chromes are up');

  for (const t of tabs) {
    let rows = 0;
    for (let i = 0; i < 90; i++) {
      rows = Number(await t.evaluate('(window.BLWP_LOBBY || []).length')) || 0;
      if (rows > 0) break;
      await wait(2000);
    }
    say(`${t.name}: lobby rows ${rows}`);
  }

  const click = async (t, x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await t.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(800);
  };
  const link = async (t) => {
    // A LOBBY ROLLS OVER between rounds, and these tabs are slow to boot: waited for rather than failed on.
    for (let i = 0; i < 60; i++) {
      const href = await t.evaluate(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];`
        + `return r ? (location.origin + location.pathname + r.join + '&play=1') : '';})()`);
      if (href && String(href).includes('round=')) return String(href);
      await wait(3000);
    }
    return '';
  };
  const href = await link(a);
  if (!href) throw new Error('no joinable free round in the lobby');
  for (const t of tabs) { await t.send('Page.navigate', { url: href }); await wait(4000); }
  say(`both tabs opened the same round link`);

  for (const t of tabs) {
    for (let i = 0; i < 120; i++) {
      if (await t.evaluate('(location.search.indexOf("round=") >= 0) && !!window.unityInstance') === true) break;
      await wait(2000);
    }
  }
  for (const t of tabs) { await click(t, 486, 554); await wait(2500); }          // the splash
  for (const t of tabs) { await click(t, 303, 617); await wait(2000); await click(t, 660, 617); await wait(2000); }  // load and depart
  for (const t of tabs) {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await t.evaluate('!!(window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwpNet)');
      if (!up) await wait(3000);
    }
    say(`${t.name}: the bridge is ${up ? 'up' : 'STILL NOT UP'}`);
    if (up) say(`${t.name}: ${await t.evaluate(RECORDER)}`);
  }

  // BOTH TRUCKS DRIVE, so a pose at one tick is not a pose at the next.
  for (const t of tabs) await t.key('keyDown', 'KeyW', 87, 'w');
  const until = Date.now() + DRIVE_MS;
  while (Date.now() < until) {
    await wait(15000);
    const at = Math.round((DRIVE_MS - (until - Date.now())) / 1000);
    const [na, nb] = [await a.evaluate('(window.__blwpRec||{mine:[]}).mine.length'), await b.evaluate('(window.__blwpRec||{mine:[]}).mine.length')];
    say(`${at} s: tabA has ${na} of its own poses, tabB ${nb}`);
  }
  for (const t of tabs) await t.key('keyUp', 'KeyW', 87, 'w');
  for (const t of tabs) await t.shot(`${t.name}-driving.png`);

  for (const t of tabs) {
    say(`${t.name} now: ${await t.evaluate(`(function(){var n=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwpNet;`
      + `if(!n) return 'no net'; return 'net yes, client ' + (n.client?'yes':'NO') + ', ghosts ' + (n.ghosts?'yes':'NO')`
      + ` + ', state ' + String(n.state||'') + ', error ' + String(n.error||'');})()`)}`);
  }
  // ROUND TWO, PRESSED IN THE PAGE (the owner 2026-09-18 12:02: "after 2nd round Truck 1 cannot see Truck 2, age
  // 6736ms"). The page returns to its lobby when a run is over and its own PLAY joins the next round without a
  // reload, which is exactly what a player does; a node client cannot press it.
  const ROUND = `(function(){var n=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwpNet;`
    + `var hex=function(u){return Array.prototype.map.call(u,function(x){return x.toString(16).padStart(2,'0');}).join('');};`
    + `return n&&n.where?hex(n.where.roundId):'';})()`;
  // WHETHER THE CHAIN PROVIDERS ANSWER AT ALL, timed from inside the page, just before PLAY is pressed again. The
  // page reads /headers from each node it was given, and `agreedChain` gives up on one after 10000 ms; the error at
  // this boundary was that none of the two answered.
  const PROVIDERS = `(function(){
    var from = (window.BLWP_CHAIN_FROM || []).slice();
    if (!from.length) {
      var q = new URLSearchParams(location.search.replace(/^\\?/, ''));
      from = (q.get('node') || '').split(',').filter(Boolean);
    }
    return Promise.all(from.map(function (u) {
      var at = Date.now();
      return fetch(u.replace(/\\/+$/, '') + '/headers', { method: 'GET' })
        .then(function (r) { return r.arrayBuffer().then(function (b) {
          return u.replace('https://', '').slice(0, 12) + ' http ' + r.status + ' ' + b.byteLength + ' bytes in ' + (Date.now() - at) + ' ms'; }); })
        .catch(function (e) { return u.replace('https://', '').slice(0, 12) + ' FAILED after ' + (Date.now() - at) + ' ms: ' + (e && e.message); });
    })).then(function (all) { return all.join(' | '); });
  })()`;
  for (const t of tabs) say(`${t.name} chain providers at the moment the round ends: ${await t.evaluate(PROVIDERS)}`);

  // DID THE FIRST SESSION LEAVE A PROOF TO REUSE? If this is false, the next round cannot open from it however well
  // the reuse works, and that is a different fault from a chain read that is merely slow.
  for (const t of tabs) say(`${t.name} kept a proved chain after round one: `
    + `${await t.evaluate('(function(){var p=window.BLWP_PROVED_CHAIN;return p?("yes, "+((p.headers||[]).length)+" headers"):"NO";})()')}`);
  const firstRound = { tabA: await a.evaluate(ROUND), tabB: await b.evaluate(ROUND) };
  say(`round one: tabA in ${String(firstRound.tabA).slice(0, 8)}, tabB in ${String(firstRound.tabB).slice(0, 8)}`);

  // WAIT FOR THE FIRST RUN TO END, which is what puts the lobby back in front of the player.
  let over = false;
  for (let i = 0; i < 60 && !over; i++) {
    over = (await a.evaluate('!!window.BLWP_RUN_ENDED')) === true && (await b.evaluate('!!window.BLWP_RUN_ENDED')) === true;
    if (!over) await wait(5000);
  }
  say(over ? 'both runs are over; the lobby is back' : 'the first run did not end inside the window');
  for (const t of tabs) await t.shot(`${t.name}-round1-over.png`);

  // AND THE TRUCK OF THE FINISHED ROUND MUST GO, while the pictures of the new one must not name the old.
  for (const t of tabs) say(`${t.name} between rounds: ${await t.evaluate(`(function(){var n=window.unityInstance&&`
    + `window.unityInstance.Module&&window.unityInstance.Module.blwpNet;var f=n&&n.ghosts;`
    + `return f?('trucks '+(f.others|0)+', roundEnded '+(f.roundEnded|0)+', retired '+(f.retired|0)):'no field';})()`)}`);

  const playAgain = async (t) => {
    for (let i = 0; i < 40; i++) {
      const got = await t.evaluate(`(function(){var r=(window.BLWP_LOBBY||[]).filter(function(x){return x.free&&x.join;})[0];`
        + `if(!r) return 'no free row'; var ok=window.BLWP_LOBBY_ACT&&window.BLWP_LOBBY_ACT.join(r.id);`
        + `return (ok?'joined ':'refused ')+r.id;})()`);
      if (String(got).startsWith('joined')) return String(got).slice(7);
      await wait(5000);
    }
    return '';
  };
  // PLAY AGAIN ON THE PAGE THAT IS ALREADY RUNNING - and nothing else. Walking the splash and the bay again cost
  // about three minutes here, and a round's entry window is about a minute and a half, so the tab joined a round
  // that had closed before it could publish: "ended - not publishing - error the round is closed". An already-loaded
  // page needs none of that walk; it joins in place and publishes from its session's first tick.
  const played = {};
  for (const t of tabs) {
    const took = await playAgain(t);
    played[t.name] = took;
    say(`${t.name} PLAY again: ${took.slice(0, 8) || 'never took a round'}`
      + `; client at that moment: ${await t.evaluate('(function(){var n=window.unityInstance&&window.unityInstance.Module'
      + '&&window.unityInstance.Module.blwpNet;return n&&n.client?"yes":"NO";})()')}`);
  }

  // AND WHETHER THE CHAIN WAS REUSED OR READ: the page logs which of the two opened this session.
  for (const t of tabs) {
    const said = t.logs.filter((l) => /the chain was/.test(l)).slice(-2);
    say(`${t.name} chain on opening: ${said.length ? said.join(' | ') : 'said nothing'}`);
  }
  for (const t of tabs) say(`${t.name} right after PLAY again: ${await t.evaluate(`(function(){`
    + `var n=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwpNet;`
    + `var j=window.BLWP_JOIN||{};`
    + `return 'join '+(j.state||'-')+(j.why?' ('+j.why+')':'')+', net '+(n?'yes':'no')+', client '+(n&&n.client?'yes':'NO')`
    + `+', ghosts '+(n&&n.ghosts?'yes':'NO')+', state '+String(n&&n.state||'')+', error '+String(n&&n.error||'');})()`)}`);
  const began2 = Date.now();
  const secondRound = {};
  for (const t of tabs) {
    for (let i = 0; i < 60; i++) {
      const now = await t.evaluate(ROUND);
      if (now && now !== firstRound[t.name]) { secondRound[t.name] = now; break; }
      await wait(3000);
    }
    say(`${t.name} is now in round ${String(secondRound[t.name] || '').slice(0, 8) || 'NONE - it never left the first'}`);
  }

  // THE ANSWER: does each tab get a picture of the other in the second round, and how long after it began.
  const SEEN2 = (mineRound) => `(function(){var n=window.unityInstance&&window.unityInstance.Module&&window.unityInstance.Module.blwpNet;`
    + `var f=n&&n.ghosts;var hex=function(u){return Array.prototype.map.call(u,function(x){return x.toString(16).padStart(2,'0');}).join('');};`
    + `if(!f||!f.present) return {trucks:0,who:'',old:0};var who='',old=0;`
    + `f.present.forEach(function(g){who=hex(g.entryId);if(g.roundId&&hex(g.roundId)!==${JSON.stringify(mineRound)})old++;});`
    + `return {trucks:f.others|0,who:who,old:old,drawn:f.drawn|0,roundEnded:f.roundEnded|0};})()`;
  const first2 = { tabA: null, tabB: null };
  for (let i = 0; i < 60; i++) {
    for (const t of tabs) {
      if (first2[t.name]) continue;
      const s = await t.evaluate(SEEN2(secondRound[t.name] || ''));
      if (s && s.trucks > 0) first2[t.name] = { at: Date.now() - began2, who: s.who, old: s.old, drawn: s.drawn };
    }
    if (first2.tabA && first2.tabB) break;
    await wait(3000);
  }
  for (const t of tabs) {
    const f = first2[t.name];
    say(`${t.name} in round two: ${f ? `the other truck appeared ${f.at} ms after PLAY, entry ${String(f.who).slice(0, 8)}`
      + `, pictures naming the old round ${f.old}, drawn ${f.drawn}` : 'NEVER saw the other truck'}`);
    // WHAT THE PAGE HOLDS WHEN IT IS NEVER: client, what it has published, and whether the round it joined is closed.
    if (!f) say(`${t.name} holds: ${await t.evaluate('(function(){var m=window.unityInstance&&window.unityInstance.Module;'
      + 'var n=m&&m.blwpNet;var c=n&&n.client;var hex=function(u){return Array.prototype.map.call(u,function(x){'
      + 'return x.toString(16).padStart(2,"0");}).join("");};'
      + 'return "client "+(c?"yes":"NO")+", published "+(c?(c.nextTick|0):"-")+" ticks, state "+String(n&&n.state||"")'
      + '+", error "+String(n&&n.error||"")+", on "+(c?String(c.base||"").replace("https://","").slice(0,12):"-")'
      + '+", round "+(n&&n.where?hex(n.where.roundId).slice(0,8):"-");})()')}`);
    await t.shot(`${t.name}-round2.png`);
  }

  const A = await a.evaluate(MINE);
  const B = await b.evaluate(MINE);
  for (const [who, got] of [['tabA', A], ['tabB', B]]) {
    say(`${who}: entry ${String(got.entry).slice(0, 8)}, round ${String(got.round).slice(0, 8)}, `
      + `${got.mine.length} own poses, ${got.ghosts.length} ghost samples${got.why ? `, recorder said ${got.why}` : ''}`);
    say(`${who}: its field says ${got.field ? JSON.stringify(got.field) : 'no field'}; client ${got.socket}`);
    say(`${who}: the node answered its watch with "${got.said}"; ${got.watched || '-'}`);
  }

  // A's GHOST OF B AGAINST B's OWN CORE, at the same tick - and the other way round.
  const METRES = (w) => w / 65536;
  const compare = (seer, seen, name) => {
    const theirs = new Map();
    for (const [tick, x, z, h] of seen.mine) theirs.set(tick, { x, z, h });
    const apart = [], turned = [];
    let matched = 0, unseen = 0;
    for (const [who, tick, x, z, heading] of seer.ghosts) {
      if (String(who) !== String(seen.entry)) continue;
      const held = theirs.get(tick) || theirs.get(tick + 1) || theirs.get(tick - 1);
      if (!held) { unseen++; continue; }
      matched++;
      apart.push(Math.hypot(METRES(x - held.x), METRES(z - held.z)));
      const d = ((((heading - held.h) % 65536) + 98304) % 65536) - 32768;
      turned.push(Math.abs(d) / 65536 * 360);
    }
    const pct = (xs, p) => (xs.length ? xs.slice().sort((q, w) => q - w)[Math.floor(p * xs.length)] : null);
    const m = (x) => (x === null ? '-' : `${x.toFixed(3)} m`);
    const deg = (x) => (x === null ? '-' : `${x.toFixed(2)} deg`);
    say(`${name}: ${matched} pictures held against that page's own core (${unseen} at a tick it had not recorded); `
      + `position p50 ${m(pct(apart, 0.5))}, p90 ${m(pct(apart, 0.9))}, max ${m(apart.length ? Math.max(...apart) : null)}; `
      + `heading p50 ${deg(pct(turned, 0.5))}, p90 ${deg(pct(turned, 0.9))}`);
  };
  compare(A, B, "tabA's ghost of tabB");
  compare(B, A, "tabB's ghost of tabA");

  // AND WHAT THE PAGE SAID ABOUT GHOSTS IN ITS OWN CONSOLE: the jslib logs "ghosts unavailable" when the field cannot
  // be made, and a field that was never made is a different fault from one that was made and fed nothing.
  for (const t of tabs) {
    const said = t.logs.filter((l) => /ghost|watch|unavailable|session/i.test(l)).slice(-8);
    say(`${t.name} said about ghosts: ${said.length ? said.join(' | ').slice(0, 600) : 'nothing'}`);
  }
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  for (const t of tabs) console.log(`${t.name} last console:\n  ` + t.logs.slice(-8).join('\n  '));
} finally {
  for (const t of tabs) t.close();
  await wait(500);
  process.exit(0);
}
