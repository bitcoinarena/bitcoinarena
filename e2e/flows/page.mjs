// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE, AS A PLAYER USES IT (kanban #2642): the built page from this tree in a real headless Chrome against the devnet's seven seats,
// federation and gateways - wallet create and seed check, a Lightning deposit paid by a devnet lnd, a restore in a second browser, a
// Nostr login, a withdrawal to a devnet lnd invoice, the leaderboard, the settings and every sub-page.
// One player ("alice") keeps her browser profile across flows (ctx.shared.alice), as one person's browser does.
import { join } from 'node:path';
import { check, Skip, wait, req } from '../lib/ctx.mjs';

const sats = (t) => { const m = String(t || '').replace(/[,\s ]/g, '').match(/(\d+)sat/); return m ? Number(m[1]) : null; };
/** Open the lobby in a browser on `profileDir` and wait until the page has booted (its wallet bar and the lobby rows). */
async function open(ctx, profileDir, url = ctx.lobbyUrl, { unity = true, keepUnity = false } = {}) {   // the wallet opens only after the game client has booted (measured: with *.unityweb blocked an existing wallet is never opened)
  // A BROWSER ON A PROFILE JUST CLOSED waits out the seed keeper's heartbeat (index.html arenaSeedKeeper: a phrase whose tab beat in the
  // last 12 s is another tab's, so the new tab is offered "Create a new wallet" - measured, a harness fault, not the page's)
  if ((await import('node:fs')).existsSync(join(profileDir, 'profile'))) await wait(13000);
  const b = await ctx.chrome({ dir: profileDir });
  const t = await b.tab(url, { noUnity: !unity });
  await t.until('!!document.getElementById("arena-hdr-bal")', 60000, 'the wallet bar');
  if (unity) {
    // UNITY ONLY AS LONG AS THE PAGE NEEDS IT: once the client has booted, its frame loop is paused (emscripten's pauseMainLoop) - on
    // SwiftShader every frame is drawn by the CPU (~11 cores measured on the MacBook). The wallet, deposits and withdrawals go on.
    t.pauseUnity = () => t.js('(() => { const m = window.unityInstance && window.unityInstance.Module; if (m && typeof m.pauseMainLoop === "function") { m.pauseMainLoop(); return true; } return false; })()').catch(() => false);
    if (!keepUnity) { await t.until('!!window.unityInstance', 120000, 'Unity booted').catch(() => null); await wait(3000); t.unityPaused = await t.pauseUnity(); }
  }
  return { b, t };
}
const balance = (t) => t.js('(document.getElementById("arena-hdr-bal") || {}).innerText || ""').then(sats);
const pageErrors = (t) => t.log.errors.map((e) => e.text.split('\n')[0]).filter((x) => !/SphereCollider/.test(x));
/** Pay a BOLT11 invoice from whichever devnet lnd is not its payee (B pays through gateway A, A through B). */
function payInvoice(dn, invoice) {
  const dest = dn.lncli('c', 'decodepayreq', invoice).destination;
  const keyOf = (x) => dn.lncli(x, 'getinfo').identity_pubkey;
  const from = keyOf('b') === dest ? 'a' : 'b';
  const r = dn.lncli(from, 'payinvoice', '--force', '--timeout=60s', '--json', invoice);
  return { from, dest: dest.slice(0, 16), status: r.status || (typeof r === 'string' ? r.slice(-80) : null) };
}

export const flows = [
  {
    id: 'page.boot', area: 'page', title: 'the page boots on the devnet lobby link: the pinned Next Block client is accepted, the lobby lists the open rounds, no uncaught error', money: 0, reach: 3, timeoutMs: 180000, order: 0,
    async run(ctx) {
      const { t } = await open(ctx, join(ctx.dir, 'p'), ctx.lobbyUrl, { unity: true, keepUnity: true });
      const rows = await t.until('Array.isArray(window.ARENA_LOBBY) && window.ARENA_LOBBY.length ? window.ARENA_LOBBY.map((r) => ({ id: r.id.slice(0, 12), free: r.free, phase: r.phase, join: !!r.join })) : null', 90000, 'the lobby rows');
      const unity = await t.until('!!window.unityInstance', 120000, 'the Unity client loaded');
      await t.shot(join(ctx.dir, 'boot.png'));
      const pinned = t.log.console.filter((c) => /not the pinned client/.test(c.text));
      check(!pinned.length, 'every client file hashes to the pin', pinned.map((c) => c.text));
      check(rows.some((r) => r.free && r.join), 'the lobby offers a free round to join', rows);
      const errs = pageErrors(t);
      check(!errs.length, 'no uncaught exception while booting', errs);
      return { rows, unity, rewrites: ctx.page.rewrites, requests: t.log.requests.length, blockedExternal: t.log.failed.filter((f) => f.blocked).length };
    },
  },
  {
    id: 'wallet.create-and-verify', area: 'wallet', title: 'create a wallet: 24 words shown, the seed check (3 words from memory) passes, the backup warning goes', money: 2, reach: 3, timeoutMs: 180000, order: 1,
    async run(ctx) {
      const profile = join(ctx.out, 'profiles', 'alice');
      const { t } = await open(ctx, profile);
      check(await t.click('button', 'Create a new wallet'), 'the wallet start offers "Create a new wallet"');
      const words = await t.until('(() => { const w = [...document.querySelectorAll(".seed-cell span:last-child")].map((e) => e.textContent.trim()); return w.length === 24 ? w : null; })()', 30000, '24 seed words');
      check(await t.click('button', '^Verify seed phrase$'), 'the seed card offers the check');
      const asked = [];
      for (let i = 0; i < 3; i++) {
        const n = Number(await t.until('(document.querySelector(".verify-n") || {}).textContent', 10000, 'the word asked for'));
        asked.push(n);
        const ok = await t.js(`(() => { const b = document.querySelector('button[data-word="${words[n - 1]}"]'); if (!b) return false; b.click(); return true; })()`);
        check(ok, `word ${n} is among the choices`, n);
        await wait(500);
        if (await t.js('document.body.innerText.includes("Seed phrase verified")')) break;
      }
      await t.until('document.body.innerText.includes("Seed phrase verified")', 10000, 'Seed phrase verified');
      await t.click('button', '^Done$');
      await wait(1500);
      const warn = await t.js('(() => { const e = document.getElementById("arena-backup-warn") || document.getElementById("arena-backup-notice"); return !!e && e.offsetParent !== null && /no backup/i.test(e.innerText); })()');
      await t.shot(join(ctx.dir, 'verified.png'));
      check(!warn, 'the "no backup" warning is gone after the check', warn);
      ctx.shared.alice = { profile, words };
      return { asked, words: words.length, warningGone: !warn };
    },
  },
  {
    id: 'deposit.lightning', area: 'deposit', title: 'deposit 10 000 sat over Lightning: the page makes an invoice through a federation gateway, a devnet lnd pays it, the balance shows it', money: 2, reach: 3, after: ['wallet.create-and-verify'], timeoutMs: 300000, order: 2,
    async run(ctx) {
      const a = ctx.shared.alice;
      if (!a) throw new Skip('no wallet was created in this run');
      const { t } = await open(ctx, a.profile);
      const before = await t.until('(() => { const s = (document.getElementById("arena-hdr-bal") || {}).innerText || ""; return /\\d/.test(s) ? s : null; })()', 60000, 'a balance');
      await t.click('#arena-hdr-deposit');
      await t.until('[...document.querySelectorAll("button")].some((b) => /^10,000 sat$/.test(b.innerText.trim()))', 60000, 'the amounts');
      await t.click('button', '^10,000 sat$');
      const invoice = await t.until('(document.body.innerHTML.match(/lnbcrt[0-9a-z]{100,}/) || [])[0]', 90000, 'a 10 000 sat invoice');
      const decoded = ctx.dn.lncli('c', 'decodepayreq', invoice);
      check(Number(decoded.num_satoshis) === 10000, 'the invoice asks 10 000 sat', decoded.num_satoshis);
      const paid = payInvoice(ctx.dn, invoice);
      const t0 = Date.now();
      const after = await t.until('(() => { const s = (document.getElementById("arena-hdr-bal") || {}).innerText || ""; const n = Number(s.replace(/[^0-9]/g, "")); return n >= 10000 ? s : null; })()', 120000, 'the balance showing the deposit');
      await t.shot(join(ctx.dir, 'deposited.png'));
      a.funded = sats(after);
      return { before, after, paid, secondsToShow: Math.round((Date.now() - t0) / 1000), gateway: (await t.text()).match(/via (localhost:\d+)/)?.[1] || null };
    },
  },
  {
    id: 'wallet.reload-keeps-balance', area: 'wallet', title: 'a reload of the same browser opens the same wallet with the same balance', money: 2, reach: 3, after: ['deposit.lightning'], timeoutMs: 180000, order: 3,
    async run(ctx) {
      const a = ctx.shared.alice;
      if (!a || !a.funded) throw new Skip('no funded wallet in this run');
      const { t } = await open(ctx, a.profile);
      const shown = await t.until(`(() => { const n = Number(((document.getElementById("arena-hdr-bal") || {}).innerText || "").replace(/[^0-9]/g, "")); return n >= ${a.funded} ? n : null; })()`, 90000, 'the kept balance');
      return { funded: a.funded, shown };
    },
  },
  {
    id: 'wallet.restore-from-words', area: 'wallet', title: 'restore the funded wallet from its 24 words in a second, empty browser: same wallet, the balance comes back', money: 2, reach: 2, after: ['deposit.lightning'], timeoutMs: 420000, order: 4,
    async run(ctx) {
      const a = ctx.shared.alice;
      if (!a || !a.funded) throw new Skip('no funded wallet in this run');
      const second = join(ctx.dir, 'second-browser');
      const { t } = await open(ctx, second);
      check(await t.click('button', 'Restore a wallet'), 'the wallet start offers "Restore a wallet"');
      await t.until('!!document.querySelector("textarea")', 10000);
      await t.js(`(() => { const e = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, ${JSON.stringify(a.words.join(' '))}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      check(await t.click('button', '^Restore$'), 'the Restore button');
      const t0 = Date.now();
      let shown = null;
      try { shown = await t.until(`(() => { const n = Number(((document.getElementById("arena-hdr-bal") || {}).innerText || "").replace(/[^0-9]/g, "")); return n > 0 ? n : null; })()`, 300000, 'the restored balance'); }
      catch (e) { await t.shot(join(ctx.dir, 'restore.png')); e.message = `${e.message}; the page says: ${(await t.text()).slice(0, 300).replace(/\n/g, ' / ')}`; throw e; }
      await t.shot(join(ctx.dir, 'restored.png'));
      check(shown >= a.funded * 0.98, 'the restored balance is the funded one', { funded: a.funded, shown });
      // THE MONEY IS NOW THIS BROWSER'S: the restore recovers the wallet's e-cash into it, and the first browser's notes are spent
      // (measured: the first browser then showed 0 sat and its withdrawal never paid) - later money flows use this browser
      a.profile = second;
      return { funded: a.funded, restored: shown, seconds: Math.round((Date.now() - t0) / 1000) };
    },
  },
  {
    id: 'withdraw.lightning', area: 'withdraw', title: 'withdraw 2 000 sat to an invoice of a devnet lnd that runs no gateway: the invoice is paid, the balance drops', money: 2, reach: 3, after: ['wallet.restore-from-words', 'wallet.reload-keeps-balance'], timeoutMs: 300000, order: 5,
    async run(ctx) {
      const a = ctx.shared.alice;
      if (!a || !a.funded) throw new Skip('no funded wallet in this run');
      // THE WALLET IS READ THROUGH A LISTED PAID ROUND ("No paid round is listed on the games' nodes right now, so the wallet cannot be read"):
      // one is opened when none is open for entries
      const st = ctx.dn.state();
      if (!(st.rounds || []).some((r) => r.kind === 'paid' && r.entryCloseMs > Date.now() + 120000)) {
        const { post } = await import('../lib/ctx.mjs');
        let r = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=1800000`, {}, { ms: 280000 });
        if (r.status !== 201) { await wait(15000); r = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=1800000`, {}, { ms: 280000 }); }
        check(r.status === 201, 'a paid round is open for the wallet to be read through', r);
      }
      const { t } = await open(ctx, a.profile);
      const before = Number(await t.until(`(() => { const n = Number(((document.getElementById("arena-hdr-bal") || {}).innerText || "").replace(/[^0-9]/g, "")); return n > 0 ? n : null; })()`, 90000, 'the balance'));
      const inv = ctx.dn.lncli('c', 'addinvoice', '--amt=2000', '--memo=e2e-2642');
      await t.click('#arena-hdr-withdraw');
      await t.until('!!document.getElementById("arena-wd-invoice") && !document.getElementById("arena-wd-invoice").disabled', 60000, 'the withdraw form');
      await t.js(`(() => { const e = document.getElementById('arena-wd-invoice'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(inv.payment_request)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await wait(800);
      await t.click('#arena-wd-go');
      const t0 = Date.now();
      let settled = null;
      for (let i = 0; i < 90 && !settled; i++) {
        const l = ctx.dn.lncli('c', 'lookupinvoice', inv.r_hash);
        if (l.state === 'SETTLED') settled = l;
        else await wait(2000);
      }
      await t.shot(join(ctx.dir, 'withdrawn.png'));
      check(settled, 'the payee\'s invoice is settled', (await t.text()).slice(-400));
      const after = Number(await t.until(`(() => { const n = Number(((document.getElementById("arena-hdr-bal") || {}).innerText || "").replace(/[^0-9]/g, "")); return n < ${before} ? n : null; })()`, 60000, 'the lower balance'));
      return { before, after, paidSat: Number(settled.amt_paid_sat), seconds: Math.round((Date.now() - t0) / 1000) };
    },
  },
  {
    id: 'nostr.login-nsec', area: 'wallet', title: 'log in with a Nostr nsec in a fresh browser: the page opens a wallet for that key, and a reload keeps it', money: 1, reach: 2, timeoutMs: 240000, order: 6,
    async run(ctx) {
      let nt;
      try { nt = req('nostr-tools'); } catch (e) { throw new Skip(`nostr-tools is not installed beside the suite (${e.message})`); }
      const sk = nt.generateSecretKey();
      const nsec = nt.nip19.nsecEncode(sk), npub = nt.nip19.npubEncode(nt.getPublicKey(sk));
      const profile = join(ctx.dir, 'nostr-browser');
      const { t } = await open(ctx, profile);
      check(await t.click('button', 'Login with Nostr'), 'the wallet start offers "Login with Nostr"');
      await t.until('!!document.querySelector("input[placeholder^=nsec]")', 10000, 'the nsec field');
      await t.js(`(() => { const e = document.querySelector('input[placeholder^=nsec]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(nsec)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      check(await t.click('button', 'Log in with my nsec'), 'the nsec login button');
      const shown = await t.until('(() => { const s = (document.getElementById("arena-hdr-bal") || {}).innerText || ""; return /\\d/.test(s) && !document.querySelector("input[placeholder^=nsec]") ? s : null; })()', 120000, 'a wallet opened for the key');
      const stored = await t.js('JSON.stringify(Object.keys(localStorage).filter((k) => /nostr|seed|identity/i.test(k)))');
      await t.go(ctx.lobbyUrl, 3000);
      const again = await t.until('(() => { const s = (document.getElementById("arena-hdr-bal") || {}).innerText || ""; return /\\d/.test(s) ? s : null; })()', 90000, 'the wallet after a reload');
      const askedAgain = await t.js('!!document.querySelector("input[placeholder^=nsec]") || document.body.innerText.includes("Create a new wallet")');
      check(!askedAgain, 'a reload keeps the Nostr login', askedAgain);
      return { npub: npub.slice(0, 20), shown, afterReload: again, storage: stored };
    },
  },
  {
    id: 'leaderboard.page', area: 'leaderboard', title: 'the Leaderboard button opens the season board read from the seats', money: 1, reach: 3, timeoutMs: 150000, order: 7,
    async run(ctx) {
      const { t } = await open(ctx, join(ctx.dir, 'p'));
      check(await t.click('#arena-season-go'), 'the Leaderboard button');
      const text = await t.until('(() => { const e = document.getElementById("arena-season"); return e && getComputedStyle(e).display !== "none" && /LEADERBOARD/i.test(e.innerText) && /nodes/.test(e.innerText) ? e.innerText : null; })()', 60000, 'the season board');
      await t.shot(join(ctx.dir, 'season.png'));
      const asked = t.log.requests.filter((r) => /\/season/.test(r.url)).map((r) => `${r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60)} ${r.status ?? '-'}`);
      check(asked.length > 0, 'the board is read from the seats', asked);
      const errs = pageErrors(t);
      check(!errs.length, 'no uncaught exception', errs);
      return { text: text.slice(0, 160).replace(/\n/g, ' / '), asked: asked.slice(0, 4) };
    },
  },
  {
    id: 'settings.name', area: 'settings', title: 'settings: a player name is saved and kept over a reload; a name with markup is refused', money: 0, reach: 2, after: ['wallet.create-and-verify'], timeoutMs: 150000, order: 8,
    async run(ctx) {
      const a = ctx.shared.alice;
      const { t } = await open(ctx, a ? a.profile : join(ctx.dir, 'p'));
      check(await t.click('#arena-settings-go'), 'the settings button');
      await t.until('(() => { const e = document.getElementById("arena-settings"); return e && getComputedStyle(e).display !== "none"; })()', 20000, 'the settings panel');
      await t.until('!!document.getElementById("arena-name-field")', 20000, 'the name card (SettingsCards NameCard)');
      const setName = async (v) => {
        await t.js(`(() => { const e = document.getElementById('arena-name-field'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await wait(300);
        await t.click('#arena-name-update');
        await wait(800);
        return t.js('(document.getElementById("arena-set-name") || {}).innerText || ""');
      };
      const saidBad = await setName('<b>x</b>');
      const nameAfterBad = await t.js('(window.ARENA_IDENTITY || {}).name || null');
      const said = await setName('E2E Hauler');
      await t.go(ctx.lobbyUrl, 3000);
      await t.until('!!document.getElementById("arena-hdr-bal")', 60000);
      const kept = await t.until('(window.ARENA_IDENTITY || {}).name || null', 60000, 'the identity after a reload');
      check(kept === 'E2E Hauler', 'the name is kept over a reload', kept);
      check(nameAfterBad !== '<b>x</b>', 'a name with markup is refused', { saidBad: saidBad.slice(0, 200), nameAfterBad });
      return { said: said.replace(/\n/g, ' / ').slice(0, 120), refused: saidBad.replace(/\n/g, ' / ').slice(0, 160), kept };
    },
  },
  {
    id: 'round.free.page-join', area: 'rounds', title: 'press PLAY on a free round in the page (Unity lobby): the entry is taken by the round\'s seats', money: 0, reach: 3, timeoutMs: 300000, order: 9,
    async run(ctx) {
      const { t } = await open(ctx, join(ctx.dir, 'p'), ctx.lobbyUrl, { unity: true, keepUnity: true });
      // a player with a wallet (the wallet start covers the lobby until there is one)
      if (await t.click('button', 'Create a new wallet')) { await wait(3000); await t.click('button', '^Close$'); }
      await t.until('Array.isArray(window.ARENA_LOBBY) && window.ARENA_LOBBY.some((r) => r.free && r.join)', 90000, 'a free round');
      await t.until('!!window.unityInstance', 120000, 'Unity');
      await wait(4000);
      // the PLAY button of the Unity lobby, at 1280 x 860 (screenshot e2e/flows: page.boot)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await t.call('Input.dispatchMouseEvent', { type, x: 457, y: 647, button: 'left', clickCount: 1, buttons: 1 });
      const said = await t.until('(() => { const s = window.ARENA_JOIN_STATUS; const c = (window.ARENA_CONSOLE_TAIL ? "" : ""); return s && s.state ? JSON.stringify(s) : null; })()', 120000, 'a join status').catch(() => null);
      const bond = t.log.console.find((c) => /no proven endpoint/.test(c.text));
      await t.shot(join(ctx.dir, 'joined.png'));
      if (bond) throw new Skip(`the page cannot prove a seat on a private chain: "${bond.text.slice(0, 220)}" - the client anchors to compiled-in blocks only (directory.js chainAnchorFor; the suite points it at the devnet genesis) and every devnet seat serves the ONE shared bond proof of runner/proof (GET /bond: 409 "the bond proof this node was given is node X's" at six of seven seats, and node 1's is not in the served headers). Joins are covered headless by round.free.headless-play and round.paid.headless-entry`);
      check(said, 'the page said how the join went', said);
      const s = JSON.parse(said);
      check(!/refused|failed|not joined/i.test(s.line || ''), 'the join is not refused', s);
      return { status: s };
    },
  },
];

// EVERY SUB-PAGE OF THE SITE loads without an uncaught exception and renders something
for (const [path, want] of [['wallet/', /wallet/i], ['proposals/', /proposal|forum|vote/i], ['referral/', /referr|link|site/i], ['dashboard/', /node|dashboard|seat/i],
  ['guardians/', /guardian|federation/i], ['health/', /health|seat|node/i], ['platform/', /arena|game|platform/i], ['offline/', /offline|arena/i]]) {
  flows.push({
    id: `page.sub.${path.replace(/\/$/, '').replace(/\//g, '-')}`, area: 'page', title: `/${path} loads and renders without an uncaught exception`, money: 0, reach: 1, timeoutMs: 120000, order: 20,
    async run(ctx) {
      const q = ctx.lobbyUrl.slice(ctx.lobbyUrl.indexOf('?'));
      const b = await ctx.chrome({ dir: join(ctx.dir, 'p') });
      const t = await b.tab(`${ctx.pageUrl}/${path}${q}`, { noUnity: true });
      await wait(6000);
      const text = await t.text();
      await t.shot(join(ctx.dir, 'page.png'));
      const status = t.log.requests.find((r) => r.url.startsWith(`${ctx.pageUrl}/${path}`))?.status;
      check(status === 200, `/${path} is served`, status);
      const errs = pageErrors(t);
      check(!errs.length, 'no uncaught exception', errs);
      check(text.trim().length > 10 && want.test(text), 'the page renders its content', text.slice(0, 200));
      return { chars: text.length, start: text.trim().slice(0, 100).replace(/\n/g, ' / '), failedRequests: t.log.failed.filter((f) => !f.blocked).length };
    },
  });
}
