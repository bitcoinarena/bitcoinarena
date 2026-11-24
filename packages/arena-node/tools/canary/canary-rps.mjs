// kanban #2905: the live regression canary - ONE paid Rock Paper Scissors round on the real page against the live seats and the opponent
// bot, from a kept wallet (a persistent Chrome profile: the bot knows the key after its first round, #2901). Appends one JSON line per run to
// $CANARY_DIR/canary.jsonl and exits 0 (played, signed in time, lock fast) or 1 (a failure the alert counts).
// Based on wf1489/smoke-pw/rps2869.mjs (#2861/#2869). Usage: node canary-rps.mjs [page url]   (env: CANARY_DIR, CANARY_TAG, CHROME)
// Nothing is deleted: a spent wallet's profile is moved aside (profile.spent-<time>) and a new wallet is made.
import { chromium } from 'playwright-core';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { closeThenExit } from './canary-stop.mjs';

const U = (process.argv[2] || process.env.CANARY_URL || 'https://testnet.bitcoinarena.io').replace(/\/+$/, '');
const DIR = process.env.CANARY_DIR || `${homedir()}/arena-canary`;
const PROFILE = `${DIR}/profile`, WALLET = `${DIR}/profile-rounds.json`, LOG = `${DIR}/canary.jsonl`, REFILL = `${DIR}/refill-needed`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK_SLOW_MS = 6000, RESULT_WINDOW_MS = 60000, LOW_MSAT = Number(process.env.CANARY_LOW_MSAT || 400000);
const t0 = Date.now(), T = () => new Date().toISOString(), stamp = T().replace(/[:.]/g, '-');
const RUN = `${DIR}/runs/${stamp}`; mkdirSync(RUN, { recursive: true });
const rec = { at: T(), kind: 'rps', tag: process.env.CANARY_TAG || 'cron', url: U, ok: false, fail: [] };
const log = [];
const done = (code) => {
  if (done.ran) return; done.ran = true; // #3664: the hard stop's close can let the main path reach done() first - one line per run
  rec.totalMs = Date.now() - t0; rec.ok = rec.fail.length === 0 && !!rec.played;
  appendFileSync(LOG, JSON.stringify(rec) + '\n'); writeFileSync(`${RUN}/full.log`, log.join('\n')); writeFileSync(`${RUN}/rec.json`, JSON.stringify(rec, null, 1));
  console.log('#2905 ' + JSON.stringify(rec)); process.exit(code ?? (rec.ok || rec.countable === false ? 0 : 1));
};
// hard stop: the run never outlives 7 min (the wrapper kills the whole group at 8)
// #3664: the browser is closed first (capped at 15 s) - a killed Chrome loses the wallet's last storage writes and the next run spends a spent note
let ctx;
setTimeout(() => { rec.fail.push('canary-timeout'); log.push(`${T()} canary-timeout: closing the browser before exit (#3664)`); closeThenExit(ctx, () => { try { done(1); } catch { process.exit(1); } }, 15000); }, 420000).unref();

if (existsSync(REFILL)) { // the last round left the wallet below LOW_MSAT: a new wallet (the faucet's welcome) - the old profile kept aside
  try { renameSync(PROFILE, `${PROFILE}.spent-${stamp}`); renameSync(REFILL, `${REFILL}.done-${stamp}`); rec.refilled = true; } catch (e) { rec.refillError = String(e).slice(0, 120); }
}
// rounds this kept key has entered (the bot comes at once only for a key it already saw lock, #2901)
const wallet = (() => { try { return JSON.parse(readFileSync(WALLET, 'utf8')); } catch { return { entered: 0 }; } })();
if (rec.refilled || !existsSync(PROFILE)) wallet.entered = 0;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: CHROME, headless: true, viewport: { width: 1280, height: 900 } });
} catch (e) { rec.fail.push('chrome'); rec.error = String(e).slice(0, 200); done(2); }
await ctx.route(/stats\.bitcoinarena\.io/, (r) => r.abort());
const p = ctx.pages()[0] || await ctx.newPage();
const NOISE = /committee built|federation [0-9a-f]+: OPEN|still being issued|census of round|games of \d+ node|choose a game|WebSocket connection|storage:|federations from/;
p.on('console', (m) => { const t = m.text(); if (!NOISE.test(t) && /\[arena\]|\[rps\]/.test(t)) log.push(`${T()} ${t.slice(0, 300)}`); });
p.on('pageerror', (e) => log.push(`${T()} PAGEERROR ${String(e.message || e).slice(0, 200)}`));
const seen = (re, from = 0) => log.slice(from).find((l) => re.test(l)) || null;
// the header's balance button ("3,000 sat")
const headerSat = async () => { const t = await p.locator('header button, button').filter({ hasText: /^\s*[\d,.]+ sat\s*$/ }).first().textContent({ timeout: 3000 }).catch(() => null); return t ? Number(t.replace(/[^\d]/g, '')) : null; };
const waitFor = async (re, ms, from = 0) => { for (let w = 0; w < ms / 250; w++) { const l = seen(re, from); if (l) return l; await p.waitForTimeout(250); } return null; };

try {
  // 1. the wallet: kept in the profile; the first run (or a refill) makes one and waits for the faucet's welcome
  await p.goto(`${U}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  rec.ui = await p.locator('.ui-stamp').first().textContent({ timeout: 20000 }).catch(() => null);
  const create = p.getByRole('button', { name: /Create a new wallet/i }).first();
  let fresh = false;
  for (let i = 0; i < 40 && !fresh; i++) {
    if (await create.isVisible().catch(() => false)) fresh = true;
    else if (seen(/player wallet open|reopening the player wallet/)) break;
    else await p.waitForTimeout(500);
  }
  rec.walletNew = fresh;
  if (fresh) {
    await create.click(); await p.waitForTimeout(8000);
    await p.locator('button:visible', { hasText: /^Close$/ }).first().click({ timeout: 15000 }).catch(() => {});
    let sat = 0; for (let i = 0; i < 90 && !(sat > 0); i++) { await p.waitForTimeout(2000); sat = await headerSat(); }
    rec.funded = sat;
    if (!(sat > 0)) { rec.fail.push('faucet'); throw new Error('no faucet welcome in 180 s'); }
  }
  rec.balanceSatStart = await headerSat();
  // 2. the game
  await p.goto(`${U}/?game=rock-paper-scissors`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let fr = null;
  for (let i = 0; i < 60 && !fr; i++) { await p.waitForTimeout(1000); for (const f of p.frames()) { if (f === p.mainFrame()) continue; const t = await f.evaluate(() => document.title).catch(() => ''); if (/Rock Paper Scissors/.test(t)) { fr = f; break; } } }
  if (!fr) { rec.fail.push('no-game'); throw new Error('RPS frame not found in 60 s'); }
  // the key the page plays with ("this tab's phrase"): a new one (the page made a new wallet and merged the old one in) starts the count again
  const ph = await waitFor(/this tab's phrase [0-9a-f]+/, 15000); rec.phrase = ph ? ph.match(/this tab's phrase ([0-9a-f]+)/)[1] : null;
  if (rec.phrase && wallet.phrase && rec.phrase !== wallet.phrase) { rec.keyChanged = wallet.phrase; wallet.entered = 0; }
  if (rec.phrase) wallet.phrase = rec.phrase;
  rec.keyRounds = wallet.entered;
  await fr.evaluate(() => { window.RPS_VERDICT_SHOWN = null; }).catch(() => {});
  // 3. the press, until a round takes the entry (a press in a closing window rolls to the next round)
  if (process.env.CANARY_PRESS_AT) { const w = Number(process.env.CANARY_PRESS_AT) - Date.now(); if (w > 0) await p.waitForTimeout(w); } // test only: two wallets press together
  const MOVES = ['Rock', 'Paper', 'Scissors'], move = MOVES[Math.floor(Math.random() * 3)];
  let from = log.length, taken = null, pressMs = null;
  for (let k = 0; k < 8 && !taken; k++) {
    from = log.length;
    const left = await fr.evaluate(() => (document.body.innerText.match(/(\d+):(\d\d)/) || [])[0] || null).catch(() => null);
    try { await fr.getByText(move, { exact: true }).first().click({ timeout: 30000 }); pressMs = Date.now(); log.push(`${T()} PRESS ${move} (client countdown ${left})`); }
    catch (e) { log.push(`${T()} tap: ${String(e).slice(0, 1200)}`); await p.screenshot({ path: `${RUN}/tap-${k + 1}.png`, timeout: 5000 }).catch(() => {}); } // #3664: the whole call log (why the button took no click) and what the page showed
    const l = await waitFor(/taken \d+ ms after the press|refused at the tap|not-started|missed/i, 30000, from);
    if (l && /taken \d+ ms after the press/.test(l)) taken = l;
    else await p.waitForTimeout(4000);
    rec.presses = k + 1;
  }
  rec.pressAt = pressMs ? new Date(pressMs).toISOString() : null;
  if (!taken) { rec.fail.push('no-entry'); throw new Error('no round took the entry'); }
  wallet.entered += 1; writeFileSync(WALLET, JSON.stringify(wallet));
  rec.entryMs = Number(taken.match(/taken (\d+) ms after the press/)[1]);
  rec.round = (taken.match(/round ([0-9a-f]{16})/) || [])[1] || null;
  const r8 = rec.round ? rec.round.slice(0, 8) : '~';
  const hidden = await p.evaluate((rid) => { const A = window.ARENA_GAME; const h = A && A.hiddenAll ? A.hiddenAll().find((x) => x.roundIdHex.startsWith(rid)) : null; return h ? Number(h.entryCloseMs) : null; }, rec.round).catch(() => null);
  rec.closeAt = hidden ? new Date(hidden).toISOString() : null;
  // 4. the lock
  const lk = await waitFor(/TIMED lock accepted \d+ ms/, 30000, from);
  rec.lockMs = lk ? Number(lk.match(/lock accepted (\d+) ms/)[1]) : null;
  const held = lk && lk.match(/wallet holds (\d+) msat/); rec.balanceMsat = held ? Number(held[1]) : null;
  if (rec.lockMs === null) rec.fail.push('no-lock'); else if (rec.lockMs > LOCK_SLOW_MS) rec.fail.push('lock-slow');
  // 5. the result: the page's own verdict (window.RPS_VERDICT_SHOWN), "Signed by the seats", the 'alone' phase (nobody else entered)
  const close = hidden || (pressMs + 8000);
  let firstVerdict = null, signed = null, alone = false, them = null, payAt = null;
  const payRe = new RegExp(`${r8}.*payout [A-Z_]+ (VOID|DELIVERED|FAILED|FORFEIT)`);
  while (Date.now() < close + RESULT_WINDOW_MS + 15000) {
    const s = await fr.evaluate((r8) => {
      const st = (window.RPS_STATES || []).filter((x) => x.lastId === r8); const z = st[st.length - 1] || null;
      return { v: window.RPS_VERDICT_SHOWN || null, signed: (document.getElementById('rps-signed') || {}).textContent || '', last: z && z.last, them: z && z.them, alone: st.some((x) => x.last === 'alone') };
    }, r8).catch(() => null);
    if (s) {
      if (s.them !== null && s.them !== undefined) them = Math.max(them ?? 0, s.them);
      if (s.alone) alone = true;
      if (s.v && s.v.at >= close && !firstVerdict) firstVerdict = { word: s.v.word, at: s.v.at }; // not an older round's banner
      if (/Signed by the seats/.test(s.signed) && s.last === 'result' && s.v && s.v.at >= close) { signed = { word: s.v.word, at: Date.now() }; break; }
    }
    const pv = seen(payRe);
    if (pv && !payAt) payAt = Date.parse(pv.slice(0, 24));
    if (pv && Date.now() - payAt > 3000) break; // the seats' signed outcome came (a VOID round shows no verdict on the page)
    await p.waitForTimeout(500);
  }
  rec.opponent = them; rec.alone = alone;
  rec.verdictAfterCloseMs = firstVerdict ? firstVerdict.at - close : null; rec.verdict = firstVerdict ? firstVerdict.word : null;
  rec.signedAfterCloseMs = signed ? signed.at - close : null; rec.result = signed ? signed.word : null;
  const pay = seen(payRe); rec.payout = pay ? (pay.match(/payout [A-Z_]+ [A-Z]+/) || [])[0] : null; rec.payoutAfterCloseMs = payAt ? payAt - close : null;
  const seats = seen(new RegExp(`${r8}[0-9a-f]*: locks with \\d+ of \\d+`), from); rec.lockSeats = seats ? (seats.match(/locks with (\d+ of \d+)/) || [])[1] : null;
  rec.states = await fr.evaluate((r8) => (window.RPS_STATES || []).filter((x) => x.id === r8 || x.lastId === r8).slice(-8).map((x) => `${x.phase}/${x.last}/${x.them}`).join(' '), r8).catch(() => null);
  // the result: the seats' signed outcome as the page reads it from the signer nodes (payout DELIVERED / FAILED / VOID), or the page's
  // "Signed by the seats" verdict, whichever came first
  const times = [rec.signedAfterCloseMs, rec.payoutAfterCloseMs].filter((x) => Number.isFinite(x));
  rec.resultAfterCloseMs = times.length ? Math.min(...times) : null;
  const isVoid = (signed && signed.word === 'NOT PLAYED') || (pay && /VOID/.test(pay)) || (!signed && !pay && alone);
  rec.played = !isVoid && !!((signed && /^(WON|LOST|DRAW)$/.test(signed.word)) || (pay && /DELIVERED|FAILED|FORFEIT/.test(pay)));
  if (!rec.result && rec.played) rec.result = rec.verdict || (/DELIVERED/.test(pay) ? 'DELIVERED' : 'LOST');
  if (isVoid) {
    if (rec.walletNew || !rec.keyRounds) rec.countable = false; // a fresh key's first round: the bot comes only for a key it knows (#2901)
    rec.fail.push('void');
  } else if (!rec.played) rec.fail.push('no-result-60s');
  else if (rec.resultAfterCloseMs > RESULT_WINDOW_MS) rec.fail.push('result-slow');
  if (rec.balanceMsat !== null && rec.balanceMsat < LOW_MSAT) writeFileSync(REFILL, T());
  if (!rec.ok && rec.fail.length) await p.screenshot({ path: `${RUN}/fail.png` }).catch(() => {});
} catch (e) {
  rec.error = String(e.message || e).slice(0, 200);
  if (!rec.fail.length) rec.fail.push('canary-error');
  await p.screenshot({ path: `${RUN}/fail.png` }).catch(() => {});
}
await ctx.close().catch(() => {});
done();
