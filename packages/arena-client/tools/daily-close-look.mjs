// THE DAILY'S CLOSE, MEASURED ON THE LIVE PAGE (M3.3-34). A TOOL, not a test:
// it wants the deployed Daily page, a headless Chrome and the Daily's running
// signer nodes (tools/run-2of2.mjs with closeAtEnd).
//
// Two players open the bare root (btc-logistics-core.pages.dev, daily.json's
// lobby) and join the same free round:
//   P plays - PLAY, AUTO, depart, throttle held for about a run
//   W signer nodes and walks away - its tab closes before any first mark
// Nobody sends `close`: the signer nodes must close the round at its end by their own
// clocks. Then, read-only from both signer nodes' own stores and from the public
// /results through the tunnels: each run's outcome and score at each signer node,
// how many signer nodes signed it, its finality, and no ENTRY_VOID.
//
//   node tools/daily-close-look.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

import { Round } from '../../arena-node/src/round.js';
import { resultFinality } from '../../arena-node/src/finality.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult, SIGNED_RESULT_BYTES } from '../../arena-protocol/src/result.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const ROOT = env.DAILY || 'https://btc-logistics-core.pages.dev/';
const DIR = env.ARENA_2OF2_DIR || '/mnt/bitcoin/blwp-2of2';
const CHROME = env.CHROME || '/home/operator/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function browse(url) {
  const profile = mkdtempSync(join(tmpdir(), 'daily-close-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-sandbox', '--window-size=1280,800', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((r) => { let b = ''; chrome.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); if (!target) await wait(250); }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r, no) => {
    const i = ++n;
    const timer = setTimeout(() => { pending.delete(i); no(new Error(`the browser did not answer ${method} in 30 s`)); }, 30000);
    pending.set(i, (m) => { clearTimeout(timer); r(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    } catch (e) { return { threw: e.message }; }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 }); await wait(600); };
  const key = (type) => send('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, ...(type === 'keyDown' ? { text: 'w' } : {}) });
  const close = () => { try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
  return { evaluate, click, key, close };
}

const STATE = `JSON.stringify({ lobby: window.BLWP_LOBBY || null, from: window.BLWP_LOBBY_FROM || null,
  round: window.BLWP_ROUND && typeof BLWPCLIENT !== 'undefined' ? Array.from(BLWPCLIENT.roundId(window.BLWP_ROUND), (x) => x.toString(16).padStart(2, '0')).join('') : null,
  player: window.BLWP_ENTRY && window.BLWP_ENTRY.playerPubkey ? Array.from(window.BLWP_ENTRY.playerPubkey, (x) => x.toString(16).padStart(2, '0')).join('') : null,
  unity: !!window.unityInstance, chip: (document.getElementById('blwp-players') || {}).textContent || null,
  joinRefused: window.BLWP_JOIN_REFUSED || null, nodes: window.BLWP_NODES || null,
  ...((c) => c ? { peers: c.peers || null, peerJoins: c.peerJoins || null } : {})(
    window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.blwpNet && window.unityInstance.Module.blwpNet.client),
  error: (document.getElementById('err') || {}).textContent || null })`;
const stateOf = async (b) => { const v = await b.evaluate(STATE); try { return JSON.parse(v); } catch { return {}; } };
const until = async (b, ms, done) => { let s = {}; for (let t = Date.now(); Date.now() - t < ms; await wait(1000)) { s = await stateOf(b); if (done(s)) break; } return s; };
// THE LOBBY IS UNITY'S TITLE SCREEN (M3.3-34): its PLAY calls the page's
// BLWP_LOBBY_ACT.join - the round's own link with play=1 - and so does this.
const pressJoin = (b, id) => b.evaluate(`!!(window.BLWP_LOBBY_ACT && window.BLWP_LOBBY_ACT.join(${JSON.stringify(id)}))`);
const leftOf = (line) => { const m = String(line).match(/closes in (\d+):(\d\d)/); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };

// THE SIGNER NODES' OWN STORES, READ-ONLY: what each signer node signed and how final it is.
const signerNodes = ['a', 'b'].map((n) => new Round(new DatabaseSync(join(DIR, `${n}.db`), { readOnly: true })));
const entryOf = (signerNode, rid, playerHex) => signerNode.entriesOf(fromHex(rid)).find((e) => toHex(e.entry.playerPubkey) === playerHex);
const view = (signerNode, rid, eid) => ({
  results: [...new Set(signerNode.results(fromHex(rid), eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(signerNode.results(fromHex(rid), eid).map((r) => toHex(r.nodePubkey))).size,
  finality: resultFinality(signerNode, fromHex(rid), eid).state, entryVoid: !!signerNode.entryVoid(eid),
  closed: signerNode.get(fromHex(rid)).state === 1 });

const tabs = [];
let code = 0;
// A KILLED LOOK CLOSES ITS BROWSERS: measured, a killed run left its Chrome
// drawing Unity in software at 778% CPU, and the next runs' tabs could not
// enter a player in 60 s.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const t of tabs) t.close(); process.exit(143); });
try {
  const P = await browse(ROOT);
  tabs.push(P);
  const s0 = await until(P, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.join));
  const rows = (s0.lobby || []).filter((r) => r.join).sort((x, y) => leftOf(y.line) - leftOf(x.line));
  if (!rows.length) throw new Error('the Daily root listed no joinable round');
  const rid = rows[0].id;
  const c = decodeRoundContract(signerNodes[0].get(fromHex(rid)).contract ? new Uint8Array(signerNodes[0].get(fromHex(rid)).contract) : new Uint8Array());
  const endAt = roundEndMs(c);
  say({ step: 'picked', round: rid.slice(0, 16), from: s0.from, entryLeftS: leftOf(rows[0].line), roundEndsAt: new Date(Number(endAt)).toISOString() });

  await pressJoin(P, rid);
  const p = await until(P, 200000, (x) => (x.player && x.unity && x.round === rid) || x.error);
  const W = await browse(ROOT);
  tabs.push(W);
  await until(W, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === rid && r.join));
  await pressJoin(W, rid);
  const w = await until(W, 200000, (x) => (x.player && x.round === rid) || x.error);
  // W WALKS AWAY ONLY ONCE BOTH SIGNER NODES HOLD ITS ENTRY: measured, a tab closed as
  // soon as signer node A held it left signer node B without it - joined 1 of 2, no member
  // of a 2-of-2 round, and nothing that could become final.
  for (let t = Date.now(); Date.now() - t < 60000
    && !(entryOf(signerNodes[0], rid, w.player) && entryOf(signerNodes[1], rid, w.player)); await wait(500));
  const wJoinedAt = [entryOf(signerNodes[0], rid, w.player), entryOf(signerNodes[1], rid, w.player)].map(Boolean);
  W.close();
  if (!wJoinedAt.every(Boolean)) {
    const pAt = [entryOf(signerNodes[0], rid, p.player), entryOf(signerNodes[1], rid, p.player)].map(Boolean);
    say({ step: 'W not joined', w, p: { player: p.player, round: p.round, error: p.error, joinedAtAB: pAt } });
    throw new Error(`W was joined at ${wJoinedAt.filter(Boolean).length} of 2 signer nodes in 60 s: no 2-of-2 walk-away to measure`);
  }
  say({ step: 'joined', p: { player: p.player && p.player.slice(0, 16), unity: p.unity, error: p.error },
    w: { player: w.player && w.player.slice(0, 16), joinedAtAB: wJoinedAt, tabClosedBeforeAnyMark: true } });

  // P PLAYS: PLAY, AUTO, depart, throttle held for about a run.
  // PLAY IN THE LOBBY ALREADY STARTED THE ROUND (play=1): wait for Unity to say
  // its title screen is gone, instead of pressing PLAY a second time.
  for (let t = Date.now(); Date.now() - t < 30000; await wait(500)) {
    const shown = await P.evaluate('window.BLWP_UNITY_LOBBY ? JSON.stringify(window.BLWP_UNITY_LOBBY) : null');
    try { if (shown && JSON.parse(shown).showing === false) break; } catch { /* not yet */ }
  }
  await wait(3000);
  await P.click(303, 617); await wait(1200); await P.click(660, 617); await wait(1500);
  await P.key('keyDown');
  for (let t = Date.now(); Date.now() - t < 160000; await wait(10000)) {
    const s = await stateOf(P);
    if (s.error) break;
  }
  await P.key('keyUp');
  const pChip = (await stateOf(P)).chip;
  say({ step: 'played', chip: pChip });

  // SIGNER NODE B DOWN ACROSS THE ROUND'S END (DOWN_B_PID = the launcher's pid: SIGUSR1
  // takes signer node B down, SIGUSR2 brings it back): from 15 s before the end to 75 s
  // after it. Signer node A must close on its own clock, hold what it cannot sign, and
  // sign once B is back - no Void, no refund.
  const launcher = Number(env.DOWN_B_PID || 0);
  if (launcher) {
    const daily0 = await (await fetch(new URL('daily.json', ROOT))).json();
    const at = (ms) => wait(Math.max(0, Number(endAt) + ms - Date.now()));
    const closingA = async () => { try { return await (await fetch(`${daily0.node[0]}/closing?round=${rid}`)).json(); } catch (e) { return e.message; } };
    const publicA = async (player) => {
      const e = entryOf(signerNodes[0], rid, player);
      const r = await fetch(`${daily0.node[0]}/results?round=${rid}&entry=${toHex(e.entryId)}`);
      return Number(r.headers.get('x-results'));
    };
    const atA = () => ({ P: view(signerNodes[0], rid, entryOf(signerNodes[0], rid, p.player).entryId), W: view(signerNodes[0], rid, entryOf(signerNodes[0], rid, w.player).entryId) });
    await at(-15000);
    process.kill(launcher, 'SIGUSR1');
    say({ step: 'signer node B down', msBeforeTheEnd: Number(endAt) - Date.now() });
    let closedAtA = null;
    for (let t = Date.now(); Date.now() - t < 40000 && closedAtA === null; await wait(250)) {
      const row = signerNodes[0].get(fromHex(rid));
      if (row && row.state === 1) closedAtA = Number(row.closed_ms);
    }
    await at(20000);
    const look = await browse(ROOT);
    tabs.push(look);
    const sl = await until(look, 30000, (x) => Array.isArray(x.lobby) && x.lobby.length > 0);
    say({ step: 'B down, 20 s after the end', signerNodeAClosedMsAfterTheEnd: closedAtA === null ? null : closedAtA - Number(endAt),
      closingAtA: await closingA(), atA: atA(), publicResultsAtA: { P: await publicA(p.player), W: await publicA(w.player) },
      thisRoundInTheLobby: (sl.lobby || []).some((r) => r.id === rid),
      lobbyRows: (sl.lobby || []).map((r) => ({ id: r.id.slice(0, 16), agree: `${r.signerNodesAgree}/${r.needed}`, join: !!r.join })) });
    look.close();
    await at(75000);
    say({ step: 'B down, 75 s after the end', closingAtA: await closingA(), atA: atA(),
      publicResultsAtA: { P: await publicA(p.player), W: await publicA(w.player) } });
    // PAST SIGNER NODE A'S OBJECTION WINDOW (HOLD_S seconds after the end): a snapshot
    // midway and one 20 s before the hold ends.
    const holdMs = Number(env.HOLD_S || 0) * 1000;
    if (holdMs > 75000) {
      for (const t of [Math.round(holdMs / 2), holdMs - 20000]) {
        await at(t);
        say({ step: `B down, ${Math.round(t / 1000)} s after the end`, closingAtA: await closingA(), atA: atA(),
          publicResultsAtA: { P: await publicA(p.player), W: await publicA(w.player) } });
      }
    }
    // AND THEN EITHER SIGNER NODE B ALONE COMES BACK, OR - RESTART_CMD - THE LAUNCHER
    // RESTARTS WITH SIGNER NODE B STILL DOWN: signer node A restarted while holding, a minute
    // on its own store, and only then signer node B back.
    if (env.RESTART_CMD) {
      const said = execFileSync('bash', [env.RESTART_CMD, 'b-down'], { encoding: 'utf8', timeout: 400000 });
      const again = Number((said.match(/launcher pid (\d+)/) || [])[1] || 0);
      say({ step: 'launcher restarted, signer node B down: signer node A restarted while holding', pid: again, said: said.trim().split('\n').slice(-3) });
      if (!again) throw new Error('the launcher did not come back');
      await wait(60000);
      say({ step: 'signer node A restarted 60 s ago, B still down', closingAtA: await closingA(), atA: atA(),
        publicResultsAtA: { P: await publicA(p.player), W: await publicA(w.player) } });
      process.kill(again, 'SIGUSR2');
      say({ step: 'signer node B back' });
    } else {
      process.kill(launcher, 'SIGUSR2');
      say({ step: 'signer node B back' });
    }
  }

  // NOBODY CLOSES IT: wait for both signer nodes to close it, sign both runs and reach FINAL.
  const started = Date.now();
  let got = null;
  for (; Date.now() - started < 30 * 60000; await wait(10000)) {
    const eP = [0, 1].map((i) => entryOf(signerNodes[i], rid, p.player));
    const eW = [0, 1].map((i) => entryOf(signerNodes[i], rid, w.player));
    if (!eP.every(Boolean) || !eW.every(Boolean)) continue;
    got = { P: signerNodes.map((s, i) => view(s, rid, eP[i].entryId)), W: signerNodes.map((s, i) => view(s, rid, eW[i].entryId)) };
    if ([...got.P, ...got.W].every((x) => x.finality === 'FINAL')) break;
    if ((Date.now() - started) % 120000 < 10000) say({ step: 'waiting', got });
  }
  // AND WHAT ANYONE CAN READ: /results on each signer node's public address.
  const daily = await (await fetch(new URL('daily.json', ROOT))).json();
  const pub = {};
  for (const [who, player] of [['P', p.player], ['W', w.player]]) {
    const eid = entryOf(signerNodes[0], rid, player).entryId;
    pub[who] = [];
    for (const node of daily.node) {
      const body = new Uint8Array(await (await fetch(`${node}/results?round=${rid}&entry=${toHex(eid)}`)).arrayBuffer());
      const seen = [];
      for (let at = 0; at + SIGNED_RESULT_BYTES <= body.length; at += SIGNED_RESULT_BYTES) {
        const r = decodePlayerResult(splitSignedResult(body.subarray(at, at + SIGNED_RESULT_BYTES)).body);
        seen.push(`${r.outcome}/${r.score}`);
      }
      pub[who].push({ node: node.replace(/^https:\/\//, '').slice(0, 24), results: seen });
    }
  }
  say({ step: 'after the round ended', round: rid.slice(0, 16), roundEndsAt: new Date(Number(endAt)).toISOString(),
    waitedS: Math.round((Date.now() - started) / 1000), played: got && got.P, walkedAway: got && got.W, public: pub });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 3).join(' | ') });
  code = 1;
} finally {
  for (const t of tabs) t.close();
}
process.exit(code);
