// A PAID PICK THROUGH THE PAGE ITSELF (kanban #206, the owner 2026-10-07 23:23, decision A): on the test host, two players in two
// browser profiles, each on the page's own chain - the lobby's market row (a round of the published series), PLAY, the pick
// sheet, the deposit invoice the page shows (paid from alice's lnd: the player's own wallet), the one lock transaction with the
// fee and the donation, the pick handed to the seats - then the attestors' outcome (2 of 3, posted to the seven seats), the
// seats' own settlement after 600 s, and the winner's Withdraw through the page. Screenshots and the page's own state, as
// JSON lines. The browser is driven only where a player would act: PLAY, a pick, paying an invoice, Withdraw.
//   LOBBY=<url> SEATS=<p,p,...> LNCLI=<lncli> ALICE_DIR=<dir> ALICE_RPC=<host:port> OUT=<dir> node paid-pick.mjs
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MARKET } from '../../blwp-node/test/plugins/market/index.js';
import { attestorSign } from '../../blwp-node/test/plugins/sign.js';
import { encodeAttestation } from '../../protocol/src/attested.js';
const env = process.env;
const CHROME = process.env.CHROME || '/Users/arena/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lncli = (...a) => new Promise((ok) => execFile(env.LNCLI, [`--lnddir=${env.ALICE_DIR}`, `--rpcserver=${env.ALICE_RPC}`, '--network=regtest', ...a], { timeout: 120000 },
  (e, so, se) => ok(e ? { error: String(se || e.message).trim() } : JSON.parse(so))));
const seats = env.SEATS.split(',').map((p) => `http://127.0.0.1:${p}`);

async function browser(name) {
  const profile = mkdtempSync(join(tmpdir(), `paid206-${name}-`));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((r) => { let b = ''; proc.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  let t = null;
  for (let i = 0; i < 40 && !t; i++) { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); if (!t) await wait(250); }
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let n = 0; const pending = new Map(); const logs = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') { const s = m.params.args.map((x) => x.value ?? x.description ?? '').join(' '); if (/\[blwp\]/.test(s) && !/slower than the core/.test(s)) logs.push(s.slice(0, 260)); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 260)); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : { threw: JSON.stringify(r.result && r.result.exceptionDetails).slice(0, 300) }; };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(env.OUT, `${name}-${file}.png`), Buffer.from(r.result.data, 'base64')); return `${name}-${file}.png`; };
  return { name, send, evaluate, shot, logs, close: () => { ws.close(); proc.kill('SIGTERM'); } };
}
const STATE = `(() => { const f = (g) => { try { return g(); } catch (e) { return 'ERR ' + e.message; } };
  return { rows: f(() => (window.BLWP_LOBBY || []).map((r) => ({ id: r.id, line: r.line, join: !!r.join, free: !!r.free, market: !!(r.raw && (r.raw.market || r.raw.marketLike)), series: !!(r.raw && r.raw.contract && r.raw.contract.seriesId) }))),
    join: f(() => window.BLWP_JOIN ? { state: window.BLWP_JOIN.state, stage: window.BLWP_JOIN.stage, why: window.BLWP_JOIN.why } : null),
    sheetShown: f(() => document.getElementById('blwp-pick').classList.contains('show')), sheet: f(() => window.BLWP_PICK_SHEET || null),
    deposit: f(() => window.BLWP_DEPOSIT || null), picked: f(() => window.BLWP_PICKED || null), entry: f(() => (window.BLWP_ENTRY ? 'SET' : null)),
    unity: f(() => !!window.unityInstance), withdrawable: f(() => window.BLWP_WITHDRAW_AVAILABLE ? window.BLWP_WITHDRAW_AVAILABLE() : null),
    lines: f(() => (window.BLWP_LOBBY_VIEW ? window.BLWP_LOBBY_VIEW().collect : []).map((l) => l.text)), step: f(() => window.BLWP_WITHDRAW_STEP || null) }; })()`;
const stateOf = (b) => b.evaluate(STATE);
const until = async (b, ms, done) => { let s = {}; for (const stop = Date.now() + ms; Date.now() < stop; await wait(1000)) { s = await stateOf(b) || {}; if (done(s)) break; } return s; };
const balance = async () => { const c = await lncli('channelbalance'); return c.local_balance ? Number(c.local_balance.msat) : null; };

// BOTH PLAYERS ON THE LOBBY, THEN THE SAME ROUND TOGETHER: a fresh paid market row (>= 80 s of entry left - a deposit and a lock
// took ~23 s and run 1's pick, PLAYed 47 s before the close, came after it), PLAY and a pick in both, both invoices paid at once
const rowsOf = (s) => (Array.isArray(s.rows) ? s.rows : []).filter((r) => r.market && r.join && !r.free);
async function lobby(b) {
  await b.send('Page.navigate', { url: env.LOBBY });
  const s = await until(b, 240000, (x) => rowsOf(x).length > 0 && x.unity);
  say({ player: b.name, step: 'lobby', rows: s.rows, shot: await b.shot('1-lobby') });
}
const leftS = (line) => { const m = /pick closes in (\d+):(\d+)/.exec(line || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };
async function pickIn(b, id, pick) {
  const answered = await b.evaluate(`window.BLWP_LOBBY_ACT.join(${JSON.stringify(id)})`);
  const s2 = await until(b, 20000, (x) => x.sheetShown === true);
  say({ player: b.name, step: 'PLAY', round: id.slice(0, 12), answered, sheet: s2.sheet, shot: await b.shot('2-sheet') });
  await b.evaluate(`document.querySelector('#blwp-pick button[data-outcome="${pick}"]').click()`);
  const s3 = await until(b, 120000, (x) => (x.deposit && x.deposit.invoice) || (x.join && ['picked', 'refused'].includes(x.join.state)));
  if (s3.deposit && s3.deposit.invoice) {
    say({ player: b.name, step: 'deposit invoice', amountMsat: s3.deposit.amountMsat, invoice: s3.deposit.invoice.slice(0, 40) });
    const paid = await lncli('payinvoice', '--force', '--json', s3.deposit.invoice);
    say({ player: b.name, step: 'deposit paid', status: paid.status || paid.error, feeMsat: paid.fee_msat });
  }
  await until(b, 300000, (x) => x.join && ['picked', 'refused'].includes(x.join.state));
  await wait(3000);
  const s5 = await stateOf(b);
  say({ player: b.name, step: 'picked', join: s5.join, picked: s5.picked, sessionEntry: s5.entry, lines: s5.lines, logs: b.logs.slice(-16), shot: await b.shot('3-picked') });
  return { row: id, picked: s5.picked };
}

// ONE PLAYER (run 4): two WebGL tabs beside seven seats and their guardians made each join slower than a 90 s round's pick window
// (run 3: PLAY to the invoice ~15 s and ~100 s, both refused "the entry closed before the deposit arrived"). A lone pick on the
// winning outcome still runs the whole chain - invoice, one lock with fee and donation, hand-off, Withdraw (its stake back).
// A refusal for a missed close is tried again on the next fresh row: the deposit stays in the player wallet, no second invoice.
const A = await browser('A');
const before = await balance();
say({ step: 'alice before', msat: before });
await lobby(A);
let a = null;
for (let attempt = 1; attempt <= 4 && !(a && a.picked); attempt++) {
  let target = null;
  for (const stop = Date.now() + 240000; Date.now() < stop && !target; await wait(1000)) {
    const r = rowsOf(await stateOf(A))[0];
    if (r && leftS(r.line) >= 80) target = r.id;
  }
  if (!target) throw new Error('no paid market row with 80 s of entry left came up');
  say({ step: 'the round A picks', attempt, round: target });
  a = await pickIn(A, target, 0);
}
if (!a || !a.picked) throw new Error('four tries and no pick taken');
const bb = { picked: null };
const rid = a.row;
// WHAT THE SEATS HOLD: each pick's entry, its stake seen
for (const [who, p] of [['A', a], ['B', bb]]) {
  if (!p.picked) continue;
  const got = await Promise.all(seats.map(async (s) => { try { const r = await fetch(`${s}/entry?id=${p.picked.entryIdHex}`); return r.status; } catch { return 0; } }));
  say({ step: 'seats hold the entry', player: who, entry: p.picked.entryIdHex.slice(0, 16), perSeat: got });
}
// THE ROUND'S START (its entries close then), the attestation after it - 2 of 3, outcome 0, to the seven seats
const contract = await (await fetch(`${seats[0]}/outcome?round=${rid}`)).json();
const closeMs = Number(contract.entryCloseMs);
say({ step: 'entry close', at: new Date(closeMs).toISOString() });
while (Date.now() < closeMs + 5000) await wait(2000);
const [A0, , A2] = MARKET.attestors;
const body = { roundId: Buffer.from(rid, 'hex'), outcome: 0, observedAtMs: BigInt(Date.now()) };
const att = encodeAttestation({ ...body, signatures: [A0, A2].map((k) => attestorSign(k, body)) });
const posted = await Promise.all(seats.map(async (s) => (await fetch(`${s}/outcome?round=${rid}`, { method: 'POST', body: att })).status));
say({ step: 'attested', outcome: 0, perSeat: posted });
// THE SEATS' OWN SETTLEMENT, once final (600 s), up to 20 min
let ls = null;
for (const stop = Date.now() + 1200000; Date.now() < stop; await wait(10000)) { ls = await (await fetch(`${seats[0]}/lock-settlement?round=${rid}`)).json(); if (ls.state === 'ACCEPTED') break; }
const o = await (await fetch(`${seats[0]}/outcome?round=${rid}`)).json();
say({ step: 'settlement', state: ls && ls.state, why: ls && ls.why, txid: ls && ls.txid, moved: ls && ls.moved && { claims: ls.moved.claims.map((c) => [c.kind, String(c.msat ?? c.amountMsat)]), payouts: ls.moved.payouts.map((p) => [p.kind, String(p.pk).slice(0, 10), String(p.msat)]) },
  table: o.table && o.table.rows.map((r) => [r.entryId.slice(0, 8), r.pick, r.netMsat, r.payoutMsat]) });
// THE WINNER'S WITHDRAW, THROUGH THE PAGE: BLWP_WITHDRAW handed the player's own wallet (an invoice for the exact amount)
await wait(15000);
const sW0 = await stateOf(A);
say({ player: 'A', step: 'before withdraw', withdrawable: sW0.withdrawable, lines: sW0.lines, shot: await A.shot('5-outcome') });
const w = await A.evaluate(`window.BLWP_WITHDRAW(async (msat) => { const r = await fetch('/harness-invoice?msat=' + msat); const j = await r.json(); return j.payment_request ? { ok: true, invoice: j.payment_request } : { ok: false, why: j.error }; }).then((x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? String(v) : v))))`);
await wait(5000);
const after = await balance();
const sW = await stateOf(A);
say({ player: 'A', step: 'withdraw', result: w, step2: sW.step, aliceBefore: before, aliceAfter: after, lines: sW.lines, logs: A.logs.slice(-20), shot: await A.shot('6-withdrawn') });
A.close();
process.exit(0);
