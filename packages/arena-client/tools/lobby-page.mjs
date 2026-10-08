// THE LOBBY AND FREE PLAY, IN A REAL BROWSER, WITH NO WALLET (M3.3-34).
// A TOOL, not a test: it wants a built page, a headless Chrome and the regtest
// bitcoind lobby-regtest.sh stands up. Nothing here reaches Lightning.
//
// The Daily's own 2-of-2 (`standUpRound`: bonded signer nodes, a census, each round
// published under its beacon block), stake 0, and the tool's opener keeping a
// free round joinable. Then, as two players would:
//   tab 1 opens the LOBBY link - nodes, bond, advert, NO round - and is shown
//     the rounds, checked against their contracts; it presses Join on a free one
//   tab 2 does the same and joins the SAME round
//   both play (PLAY, AUTO, depart, throttle), and neither is shown a wallet
//   tab 1's ghost field holds tab 2's truck
//   after that round's entry closes, the nodes - and a fresh lobby - still list
//     a joinable free round: the opener's next one
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';

import { standUpRound, servePage } from '../../arena-node/tools/round-2of2.mjs';
import { bitcoindRpc } from '../../arena-node/src/chain-rpc.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';

const env = process.env;
const P = env.PROBE;
const CHROME = env.CHROME || '/home/operator/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${env.RPCPORT}/`, cookiePath: `${env.RT}/regtest/.cookie` });
const cli = (...a) => execFileSync(env.BITCOIN_CLI, ['-regtest', `-datadir=${env.RT}`, `-rpcport=${env.RPCPORT}`, ...a],
  { encoding: 'utf8' }).trim();

async function browse(url) {
  const profile = mkdtempSync(join(tmpdir(), 'lobby-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-sandbox', '--window-size=1280,800', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debugPort = await new Promise((r) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page');
    if (!target) await wait(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  const logs = [];
  const requests = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Network.requestWillBeSent') requests.push({ method: m.params.request.method, url: m.params.request.url });
  });
  const send = (method, params = {}) => new Promise((r, no) => {
    const i = ++n;
    const timer = setTimeout(() => { pending.delete(i); no(new Error(`the browser did not answer ${method} in 30 s`)); }, 30000);
    pending.set(i, (m) => { clearTimeout(timer); r(m); });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(timer); pending.delete(i); no(e); }
  });
  // AN EXPRESSION THAT THROWS IS SAID SO. Measured: a state read that threw came
  // back as nothing at all, and the harness waited out two 240 s joins on it.
  const evaluate = async (expression) => {
    let r;
    try { r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
    catch (e) { return { threw: e.message }; }
    const d = r.result && r.result.exceptionDetails;
    if (d) return { threw: (d.exception && d.exception.description) || d.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result) writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(600);
  };
  const key = (type) => send('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87, ...(type === 'keyDown' ? { text: 'w' } : {}) });
  const close = () => { try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
  return { evaluate, shot, click, key, logs, requests, close };
}

// WHAT A TAB HAS AND SHOWS, read in whatever document is current - each field
// on its own, so one that throws names itself instead of blanking the rest.
const STATE = `(() => {
  const f = (fn) => { try { return fn(); } catch (e) { return 'threw: ' + e.message; } };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({
    href: location.search.slice(0, 40),
    lobby: f(() => window.BLWP_LOBBY || null),
    lobbyShown: f(() => { const l = document.getElementById('blwp-lobby'); return !!l && getComputedStyle(l).display !== 'none'; }),
    round: f(() => (window.BLWP_ROUND ? hex(BLWPCLIENT.roundId(window.BLWP_ROUND)) : null)),
    // The page's BLWP_ENTRY is entryFor's fields - no round id or session key -
    // so the tab is named by its player key and the signer node is found at the nodes.
    player: f(() => { const e = window.BLWP_ENTRY; return e && e.playerPubkey ? hex(e.playerPubkey) : null; }),
    unity: f(() => !!window.unityInstance),
    deposit: f(() => window.BLWP_DEPOSIT || null),
    pageError: f(() => (document.getElementById('err') || {}).textContent || null),
    walletShown: f(() => { const w = document.getElementById('blwp-wallet'); return !!w && getComputedStyle(w).display !== 'none'; }),
    chip: f(() => (document.getElementById('blwp-players') || {}).textContent || null),
    net: f(() => { const i = window.unityInstance; const m = (i && i.Module) || window.Module; const n = m && m.blwpNet;
      return n ? { state: n.state || null, error: n.error || null, status: n.client && n.client.status ? n.client.status(n.seen) : null } : null; }),
    ghosts: f(() => { const i = window.unityInstance; const m = (i && i.Module) || window.Module;
      const g = m && m.blwpNet && m.blwpNet.ghosts; return g ? { others: g.others, seen: g.seen, self: g.self, drawn: g.drawn } : null; }),
  });
})()`;
const stateOf = async (b) => {
  const v = await b.evaluate(STATE);
  if (v && typeof v === 'object' && v.threw) return { threw: v.threw };
  try { return JSON.parse(v || '{}'); } catch { return {}; }
};
const until = async (b, ms, done) => { let s = {}; for (let t = Date.now(); Date.now() - t < ms; await wait(500)) { s = await stateOf(b); if (done(s)) break; } return s; };
const listed = async (base) => { try { return (await (await fetch(`${base}/rounds`)).json()).rounds; } catch (e) { return `? ${e.message}`; } };
const freeOpen = (rows) => (Array.isArray(rows) ? rows.filter((r) => r.free && r.phase === 'open') : []);
const joinedIn = (x) => typeof x.player === 'string' && /^[0-9a-f]{64}$/.test(x.player) && x.unity === true;

const page = await servePage(env.BUILD, { host: '127.0.0.1', port: 0 });
const pageUrl = `http://127.0.0.1:${page.port}`;
const t0 = Date.now();
const round = await standUpRound({ host: '127.0.0.1', portA: 18581, portB: 18582, rpc, cli, page: pageUrl });
say({ step: 'stood up', firstRound: round.id, beacon: round.beacon && round.beacon.ok ? round.beacon.height : round.beacon,
  stakeMsat: round.contract.stakeMsat, lobbyUrl: round.lobbyUrl.replace(pageUrl, ''), ms: Date.now() - t0 });
const opened = [];
const keeper = round.keepOpen({ everyMs: 3000, leadMs: 60000,
  onOpen: (id) => { opened.push({ id, atMs: Date.now() - t0 }); say({ step: 'opener', opened: id, atMs: Date.now() - t0 }); },
  onError: (e) => say({ step: 'opener', error: e.message }) });

const tabs = [];
let TWO_NAME = null;                 // tab 2's generated name, read off its page
const ONE_NAME = 'Night Hauler 7';   // tab 1's own name, saved in its lobby
let idTwoNamed = null;
let code = 0;
try {
  const signerNodes = [round.a, round.b];
  say({ step: 'nodes list', a: freeOpen(await listed(round.nodes[0])).map((r) => r.id.slice(0, 16)),
    b: freeOpen(await listed(round.nodes[1])).map((r) => r.id.slice(0, 16)) });

  // TAB 1: THE LOBBY, NO ROUND NAMED.
  const one = await browse(round.lobbyUrl);
  tabs.push(one);
  const s1 = await until(one, 60000, (x) => (Array.isArray(x.lobby) && x.lobby.some((r) => r.free && r.join)) || x.pageError || x.threw);
  await one.shot(`${P}/lobby.png`);
  const target = (Array.isArray(s1.lobby) ? s1.lobby : []).find((r) => r.free && r.join);
  say({ step: 'tab 1 lobby', shown: s1.lobbyShown, unityLoaded: s1.unity, walletShown: s1.walletShown, pageError: s1.pageError, threw: s1.threw || null,
    rows: (Array.isArray(s1.lobby) ? s1.lobby : []).map((r) => ({ id: r.id.slice(0, 16), phase: r.phase, free: r.free, wallet: r.wallet, line: r.line, join: !!r.join })) });
  if (!target) throw new Error('the lobby showed no free round to join');

  // WHO TAB 1 IS: the generated key and name, then the player's own name, a
  // name the page must refuse, and a reload that must keep both key and name.
  const identity = async (b) => { const v = await b.evaluate('JSON.stringify(window.BLWP_IDENTITY || null)'); try { return JSON.parse(v); } catch { return v; } };
  const idBefore = await identity(one);
  const typed = await one.evaluate(`(() => { const i = document.getElementById('blwp-name'); if (!i) return false;
    i.value = 'Night Hauler 7'; document.getElementById('blwp-name-save').click(); return true; })()`);
  await wait(300);
  const idNamed = await identity(one);
  const shownName = await one.evaluate(`(document.querySelector('#blwp-lobby b') || {}).textContent || null`);
  const refusedName = await one.evaluate(`(() => { const i = document.getElementById('blwp-name'); i.value = '<b>x</b>';
    document.getElementById('blwp-name-save').click();
    return { why: (document.getElementById('blwp-name-why') || {}).textContent || null, nameAfter: (window.BLWP_IDENTITY || {}).name || null }; })()`);
  await one.evaluate('location.reload(); true');
  await wait(1500);
  await until(one, 60000, (x) => x.lobbyShown === true && Array.isArray(x.lobby) && x.lobby.length > 0);
  const idReloaded = await identity(one);
  await one.shot(`${P}/lobby-named.png`);
  say({ step: 'identity', before: idBefore, typed, named: idNamed, shownName, refusedName, reloaded: idReloaded,
    keyKept: !!(idBefore && idReloaded && idBefore.pubkey === idReloaded.pubkey),
    nameKept: !!(idReloaded && idReloaded.name === 'Night Hauler 7' && idReloaded.custom === true) });

  // JOIN, BY THE ROW'S OWN BUTTON; TAB 2 JOINS THE SAME ROUND FROM ITS OWN LOBBY.
  const pressJoin = (b, id) => b.evaluate(`(() => { for (const row of document.querySelectorAll('#blwp-lobby .row')) {
    if (row.textContent.includes(${JSON.stringify(id)})) { const a = row.querySelector('a.join'); if (a) { a.click(); return true; } } } return false; })()`);
  const pressed1 = await pressJoin(one, target.id);
  const two = await browse(round.lobbyUrl);
  tabs.push(two);
  await until(two, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === target.id && r.join));
  // TAB 2 IS ANOTHER PLAYER: its own generated key and name.
  const idTwo = await identity(two);
  say({ step: 'tab 2 identity', identity: idTwo, anotherKey: !!(idTwo && idBefore && idTwo.pubkey !== idBefore.pubkey) });
  // TAB 2 CHOOSES NO NAME: it is shown by its generated one, made from its
  // identity key with display-name.js - the string every other place must show.
  idTwoNamed = idTwo;
  TWO_NAME = idTwo && idTwo.generated;
  say({ step: 'tab 2 keeps its generated name', name: TWO_NAME, custom: idTwo && idTwo.custom,
    isDisplayNameOfIdentityKey: !!(idTwo && TWO_NAME === displayNameFromKey(fromHex(idTwo.pubkey)) && idTwo.name === TWO_NAME) });
  const pressed2 = await pressJoin(two, target.id);
  const joined = await Promise.all([one, two].map((b) => until(b, 200000, (x) => joinedIn(x) || x.pageError)));
  await one.shot(`${P}/joined-tab1.png`);
  say({ step: 'joined', pressed: [pressed1, pressed2], href: joined.map((x) => x.href),
    round: joined.map((x) => (typeof x.round === 'string' ? x.round.slice(0, 16) : x.round)),
    sameRound: joined.every((x) => x.round === target.id), entries: joined.map((x) => (typeof x.entry === 'string' ? x.entry.slice(0, 16) : x.entry)),
    unity: joined.map((x) => x.unity), walletShown: joined.map((x) => x.walletShown), deposit: joined.map((x) => x.deposit),
    pageError: joined.map((x) => x.pageError), net: joined.map((x) => x.net), threw: joined.map((x) => x.threw || null),
    lobbyShownAfterJoin: joined.map((x) => x.lobbyShown), msSinceStart: Date.now() - t0 });
  if (!joined.every(joinedIn)) throw new Error('a tab did not come to a joined, loaded game');

  // BOTH PLAY, as a player starts a run: PLAY, AUTO, depart, then throttle.
  for (const b of [one, two]) { await b.click(486, 554); await wait(3000); }
  for (const b of [one, two]) { await b.click(303, 617); await wait(1200); await b.click(660, 617); await wait(1500); }
  for (const b of [one, two]) await b.key('keyDown');
  let s = {};
  const drove = Date.now();
  let ghostAtMs = null;
  for (let t = Date.now(); Date.now() - t < 45000; await wait(1000)) {
    s = await stateOf(one);
    if (s.ghosts && s.ghosts.others > 0 && s.ghosts.drawn > 0) { ghostAtMs = Date.now() - drove; break; }
  }
  // AND KEEP DRIVING, so the signer nodes have marks to receipt: measured, stopping
  // at the first ghost left 4-11 batches and 0-1 receipts per player.
  await wait(25000);
  for (const b of [one, two]) await b.key('keyUp');
  const ridNow = fromHex(target.id);
  for (let t = Date.now(); Date.now() - t < 20000; await wait(1000)) {
    const every = signerNodes.every((d) => { const es = d.round.entriesOf(ridNow); return es.length === 2 && es.every((e) => d.round.receipts(ridNow, e.entryId).count > 0); });
    if (every) break;
  }
  s = await stateOf(one);
  say({ step: 'drove', ghostAfterMs: ghostAtMs, droveMs: Date.now() - drove });
  await one.shot(`${P}/playing-tab1.png`);
  await two.shot(`${P}/playing-tab2.png`);
  const s2 = await stateOf(two);
  const rid = fromHex(target.id);
  const perSignerNode = await Promise.all(signerNodes.map(async (d) => {
    const entries = d.round.entriesOf(rid);
    return {
      joined: entries.length,
      players: d.round.playersOf(rid),
      hold: await Promise.all(entries.map(async (e) => (await d.custody.seenPaid(e.entryId)).state)),
      receipts: entries.map((e) => d.round.receipts(rid, e.entryId).count),
      batches: entries.map((e) => d.round.db.prepare('SELECT COUNT(*) n FROM batches WHERE round_id = ? AND entry_id = ?').get(rid, e.entryId).n),
      // THE HONEST FIRST MARK (ENTRY_VOID's deadline): each player's join tick
      // and the tick of the first mark this signer node stored, as the page sent them.
      joinTick: entries.map((e) => e.entry.joinTick),
      firstMarkTick: entries.map((e) => d.round.db.prepare('SELECT MIN(tick) t FROM checkpoints WHERE round_id = ? AND entry_id = ?').get(rid, e.entryId).t),
      markTicks: entries.map((e) => d.round.db.prepare('SELECT tick FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(rid, e.entryId).map((r) => r.tick).slice(0, 8)),
    };
  }));
  const lightning = [...one.requests, ...two.requests].filter((q) => /\/(invoice|federation-invoice|stake-lock|lock)\b/.test(q.url) || /nostr|walletconnect/i.test(q.url));
  say({ step: 'played', ghostsTab1: s.ghosts, ghostsTab2: s2.ghosts, chipTab1: s.chip, chipTab2: s2.chip,
    walletShown: [s.walletShown, s2.walletShown],
    lightningOrWalletRequests: [...new Set(lightning.map((q) => { try { return `${q.method} ${new URL(q.url).pathname}`; } catch { return q.url; } }))],
    lightningOrWalletRequestCount: lightning.length, signerNodes: perSignerNode,
    exceptions: [one, two].map((b) => b.logs.filter((l) => l.startsWith('EXCEPTION')).length) });

  // WHAT THE OTHER PLAYER IS SHOWN OF TAB 2'S NAME: tab 1's joined view, then a
  // lobby's row for the round - fresh, after the list's own repaint, and after
  // a reload. A key stub of tab 2 in place of the name counts as not shown.
  const twoKeys = [idTwoNamed && idTwoNamed.pubkey, idTwoNamed && idTwoNamed.fingerprint, s2.player]
    .filter(Boolean).map((k) => String(k).replace(/-/g, '').slice(0, 8));
  const seen = (t) => ({ text: t == null ? t : String(t).slice(0, 500), hasName: String(t || '').includes(TWO_NAME),
    keyStub: twoKeys.filter((k) => String(t || '').replace(/-/g, '').includes(k)) });
  const rowText = (b, id = target.id) => b.evaluate(`(() => { for (const row of document.querySelectorAll('#blwp-lobby .row'))
    if (row.textContent.includes(${JSON.stringify(id)})) return row.textContent; return null; })()`);
  const look = await browse(round.lobbyUrl);
  tabs.push(look);
  await until(look, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === target.id));
  const rowFirst = await rowText(look);
  await wait(6000);
  const rowRepaint = await rowText(look);
  await look.evaluate('location.reload(); true');
  await wait(1500);
  await until(look, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === target.id));
  const rowReload = await rowText(look);
  await look.shot(`${P}/lobby-names.png`);
  const chipLater = (await stateOf(one)).chip;
  await one.shot(`${P}/names-tab1.png`);
  const chipTwoLater = (await stateOf(two)).chip;
  const exchangedOne = await Promise.all([one, two].map(async (b) => {
    const v = await b.evaluate('JSON.stringify(window.BLWP_NAMES_SAID || null)');
    try { return JSON.parse(v); } catch { return v; }
  }));
  say({ step: 'names shown to others', tab2Generated: TWO_NAME, tab1Joined: seen(s.chip), tab1JoinedLater: seen(chipLater),
    lobbyRow: seen(rowFirst), afterRepaint: seen(rowRepaint), afterReload: seen(rowReload),
    // AND A CUSTOM NAME STILL WINS: tab 1's own, as tab 2 and the lobby show it.
    customOverrides: { name: ONE_NAME, tab2Joined: String(s2.chip || '').includes(ONE_NAME),
      tab2JoinedLater: String(chipTwoLater || '').includes(ONE_NAME), lobbyRow: String(rowFirst || '').includes(ONE_NAME),
      afterRepaint: String(rowRepaint || '').includes(ONE_NAME), afterReload: String(rowReload || '').includes(ONE_NAME),
      generatedOfTab1Shown: [s2.chip, rowFirst, rowReload].some((t) => idBefore && String(t || '').includes(idBefore.generated)) },
    exchanged: exchangedOne });

  // 2 OF 2: WITH BOTH SIGNER NODES UP A ROW IS JOINABLE; WITH ONE SIGNER NODE DOWN IT IS NOT.
  // Signer node B goes away, a fresh lobby is opened, and the round the two tabs
  // played in (entry still open) must say 1 of 2 and offer no Join. B comes back.
  const agreedBefore = (Array.isArray(s1.lobby) ? s1.lobby : []).map((r) => `${r.signerNodesAgree}/${r.needed} ${r.joinable ? 'join' : 'no join'}`);
  await round.b.close();
  const four = await browse(round.lobbyUrl);
  tabs.push(four);
  const s4 = await until(four, 60000, (x) => (Array.isArray(x.lobby) && x.lobby.length > 0) || x.pageError);
  await four.shot(`${P}/lobby-one-signer node.png`);
  await round.restartB();
  say({ step: '2 of 2', bothUp: agreedBefore,
    bDown: (Array.isArray(s4.lobby) ? s4.lobby : []).map((r) => ({ id: r.id.slice(0, 16), agree: `${r.signerNodesAgree}/${r.needed}`, join: !!r.join, line: r.line })) });

  // AFTER THIS ROUND'S ENTRY CLOSES: the lobby is not empty.
  const closesAt = Number(round.rounds().find((r) => r.id === target.id).entryCloseMs);
  const left = closesAt - Date.now();
  if (left > 0) await wait(left + 5000);
  const afterA = await listed(round.nodes[0]);
  const afterB = await listed(round.nodes[1]);
  const three = await browse(round.lobbyUrl);
  tabs.push(three);
  const s3 = await until(three, 60000, (x) => (Array.isArray(x.lobby) && x.lobby.length > 0) || x.pageError);
  await three.shot(`${P}/lobby-after.png`);
  say({ step: 'after the first round aged out', firstRoundListed: [afterA, afterB].map((l) => Array.isArray(l) && l.some((r) => r.id === target.id)),
    freeOpenListed: [freeOpen(afterA).length, freeOpen(afterB).length],
    newerRound: freeOpen(afterA).map((r) => r.id.slice(0, 16)),
    lobbyRows: (Array.isArray(s3.lobby) ? s3.lobby : []).map((r) => ({ id: r.id.slice(0, 16), phase: r.phase, free: r.free, join: !!r.join })),
    opened: opened.map((o) => ({ id: o.id.slice(0, 16), atMs: o.atMs })), msSinceStart: Date.now() - t0 });

  // A SECOND ROUND, THE SAME TWO TABS: the same identity keys, new round keys.
  // Tab 2 must still be shown by the same generated name, tab 1 by its own.
  const next = (Array.isArray(s3.lobby) ? s3.lobby : []).find((r) => r.free && r.join);
  if (!next) throw new Error('no joinable second round to measure names in');
  const firstRoundPlayers = [s.player, s2.player];
  for (const b of [one, two]) await b.evaluate(`location.href = ${JSON.stringify(round.lobbyUrl)}; true`);
  await wait(1500);
  for (const b of [one, two]) await until(b, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === next.id && r.join));
  const idTwoAgain = await identity(two);
  for (const b of [one, two]) await pressJoin(b, next.id);
  const again = await Promise.all([one, two].map((b) => until(b, 200000, (x) => (joinedIn(x) && x.round === next.id) || x.pageError)));
  // AND BOTH START A RUN, as in the first round: PLAY, AUTO, depart, throttle.
  for (const b of [one, two]) { await b.click(486, 554); await wait(3000); }
  for (const b of [one, two]) { await b.click(303, 617); await wait(1200); await b.click(660, 617); await wait(1500); }
  for (const b of [one, two]) await b.key('keyDown');
  let chips = [];
  const namesSince = Date.now();
  let namesAfterMs = null;
  for (let t = Date.now(); Date.now() - t < 60000; await wait(1000)) {
    chips = await Promise.all([one, two].map(async (b) => (await stateOf(b)).chip));
    if (String(chips[0] || '').includes(TWO_NAME) && String(chips[1] || '').includes(ONE_NAME)) { namesAfterMs = Date.now() - namesSince; break; }
  }
  for (const b of [one, two]) await b.key('keyUp');
  const exchanged = await Promise.all([one, two].map(async (b) => {
    const v = await b.evaluate('JSON.stringify(window.BLWP_NAMES_SAID || null)');
    try { return JSON.parse(v); } catch { return v; }
  }));
  if (typeof again[1].player === 'string') twoKeys.push(again[1].player.slice(0, 8));
  await three.evaluate('location.reload(); true');
  await wait(1500);
  await until(three, 60000, (x) => Array.isArray(x.lobby) && x.lobby.some((r) => r.id === next.id));
  const row2 = await rowText(three, next.id);
  await three.shot(`${P}/lobby-round2-names.png`);
  await one.shot(`${P}/round2-tab1.png`);
  say({ step: 'second round, same tabs', round: next.id.slice(0, 16),
    joined: again.map((x) => joinedIn(x) && x.round === next.id),
    newRoundKeys: again.map((x, i) => typeof x.player === 'string' && x.player !== firstRoundPlayers[i]),
    sameIdentityKey: !!(idTwoAgain && idTwoNamed && idTwoAgain.pubkey === idTwoNamed.pubkey),
    generatedAgain: idTwoAgain && idTwoAgain.generated, sameGenerated: !!(idTwoAgain && idTwoAgain.generated === TWO_NAME),
    namesAfterMs, tab1Joined: seen(chips[0]), lobbyRow: seen(row2),
    customOverrides: { tab2Joined: String(chips[1] || '').includes(ONE_NAME), lobbyRow: String(row2 || '').includes(ONE_NAME) },
    exchanged });

  // THE CUSTOM NAME IS ON NO SIGNER NODE'S ENTRY, BATCH, MARK OR RESULT: every table of
  // both signer nodes but lobby_names, every value, searched for the name's bytes.
  const needle = Buffer.from(ONE_NAME, 'utf8');
  const scan = [round.a, round.b].map((d) => {
    const tables = d.round.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    const counted = {};
    const hits = new Set();
    let scanned = 0;
    for (const t of tables) {
      const all = d.round.db.prepare(`SELECT * FROM "${t}"`).all();
      counted[t] = all.length;
      const inNames = t === 'lobby_names';
      if (!inNames) scanned += all.length;
      for (const r of all) for (const v of Object.values(r)) {
        const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : (v instanceof Uint8Array ? Buffer.from(v) : null);
        if (b && b.indexOf(needle) >= 0) hits.add(t);
      }
    }
    return { tables: tables.length, rowsScannedOutsideNames: scanned, tablesHoldingTheName: [...hits],
      entries: counted.entries, batches: counted.batches, checkpoints: counted.checkpoints, results: counted.results,
      lobbyNames: counted.lobby_names };
  });
  say({ step: 'custom name on no entry, batch, mark or result', name: ONE_NAME, signerNodes: scan });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  keeper.stop();
  for (const b of tabs) {
    for (const l of b.logs) if (/\[blwp\]|EXCEPTION|refused/i.test(l)) console.log('   ', l.slice(0, 300));
    b.close();
  }
  await round.close();
  page.server.close();
}
process.exit(code);
