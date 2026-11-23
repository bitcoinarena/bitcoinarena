// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIVE TESTNET PAGE, SMOKED (kanban #2642, the owner 2026-11-15): the page as it is served at E2E_LIVE_URL (default the testnet site), in one
// headless Chrome on the test laptop, against the live testnet4 seats - every game from the chooser until it is loaded by its manifest hash (Next
// Block: until its rounds list is drawn), a new wallet and its welcome sats from the faucet, the Feedback form, and the console errors of all
// of it held to a known-noise allowlist. Only with `node e2e/run.mjs --live` (the regtest runs never reach the live site); run from our own
// address only, whose new wallets the explorer marks as ours (an admin address: kept out of the played counts).
import { join } from 'node:path';
import { check, wait } from '../lib/ctx.mjs';

const LIVE_URL = (ctx) => ctx.env.E2E_LIVE_URL || 'https://testnet.bitcoinarena.io/';
// THE KNOWN NOISE: Unity's own warning on this build, and - in a tab opened without Unity (a game that does not need it) - the page's
// background fetch of the Unity files this harness blocks
const NOISE = [/class 'SphereCollider' doesn't exist/];
const NO_UNITY_NOISE = [/Failed to download file Build\/.*\.unityweb/, /Unable to parse Build\/.*\.unityweb/, /unityFramework is not defined/, /^\s+at .*blob:/];
const GAMES = [
  // the tile shows the game's title, or its package name under a letter icon when the title is not read (seen live 2026-11-15)
  { name: 'rock-paper-scissors', tile: '(^|\\n)rock.paper.scissors', title: '^Rock Paper Scissors', unity: false },
  { name: 'btc-updown', tile: '^Bitcoin Up or Down', unity: false },
  { name: 'nextblock', tile: '^Tick Tock, Next Block', unity: true },
];
const errorsOf = (t, unity) => t.log.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 240))
  .concat(t.log.errors.map((e) => `EXC ${e.text.split('\n')[0].slice(0, 240)}`))
  .filter((x) => !NOISE.some((re) => re.test(x)) && (unity || !NO_UNITY_NOISE.some((re) => re.test(x.replace(/^EXC /, '')))));
const live = (ctx) => { ctx.shared.liveErrors = ctx.shared.liveErrors || []; return ctx.shared.liveErrors; };

export const flows = [
  ...GAMES.map((g, i) => ({
    id: `testnet.game-${g.name}`, area: 'testnet', live: true, order: i, money: 0, reach: 3, timeoutMs: 240000,
    title: `live testnet page: ${g.name} opens from the chooser and ${g.unity ? 'draws its rounds list' : 'is loaded by its manifest hash'}, no console error beyond the known noise`,
    async run(ctx) {
      const b = await ctx.chrome();
      const t = await b.tab('about:blank', { allowExternal: true, noUnity: !g.unity });
      await t.go(LIVE_URL(ctx), 8000);
      const ui = await t.js('(document.body.innerText.match(/UI \\d+/) || [""])[0]');
      // the chooser's tile, once the games list is drawn (a slow first answer from the seats: asked again for up to 30 s)
      let clicked = false; for (let i = 0; i < 15 && !clicked; i++) { clicked = await t.click('button,a,[role=button]', g.tile); if (!clicked) await wait(2000); }
      check(clicked, `the chooser offers ${g.name}`, { ui });
      const titled = g.title ? await t.js(`[...document.querySelectorAll('button,a,[role=button]')].some((e) => new RegExp(${JSON.stringify(g.title)}, 'i').test((e.innerText || '').trim()))`) : null;
      // a package game: the console line the page writes once its client file is loaded and its hash matches the game's manifest;
      // Next Block (the Unity client, pinned by the page itself): its rounds list drawn
      let manifest = null, rows = null;
      if (!g.unity) {
        const t0 = Date.now();
        while (Date.now() - t0 < 60000 && !manifest) { manifest = (t.log.console.find((c) => /loaded by its manifest hash/.test(c.text)) || {}).text || null; if (!manifest) await wait(1000); }
        check(manifest, `${g.name} is loaded by its manifest hash`, { ui, cannot: /cannot be loaded/.test(await t.text()) });
      } else rows = await t.until('Array.isArray(window.ARENA_LOBBY) && window.ARENA_LOBBY.length ? window.ARENA_LOBBY.length : null', 120000, 'the Next Block rounds list');
      await t.shot(join(ctx.dir, `${g.name}.png`));
      const errs = errorsOf(t, g.unity);
      live(ctx).push(...errs.map((e) => `${g.name}: ${e}`));
      check(!errs.length, `no console error beyond the known noise (${g.name})`, errs);
      return { ui, ...(manifest ? { manifest: manifest.slice(0, 160) } : {}), ...(rows !== null ? { rounds: rows } : {}), ...(titled === false ? { tileWithoutTitle: true } : {}) };
    },
  })),
  {
    id: 'testnet.wallet-welcome', area: 'testnet', live: true, order: 10, money: 1, reach: 3, timeoutMs: 300000,
    title: 'live testnet page: a new wallet is created and the faucet credits its welcome sats; the Feedback form opens; no console error beyond the known noise',
    async run(ctx) {
      const b = await ctx.chrome();
      const t = await b.tab('about:blank', { allowExternal: true, noUnity: true });
      await t.go(LIVE_URL(ctx), 8000);
      await t.click('button,a,[role=button]', '(^|\\n)rock.paper.scissors');
      await t.until('!!document.getElementById("arena-hdr-bal") || document.body.innerText.includes("Create a new wallet")', 60000, 'the wallet start');
      check(await t.click('button', 'Create a new wallet'), 'the wallet start offers "Create a new wallet"');
      const words = await t.until('(() => { const w = [...document.querySelectorAll(".seed-cell span:last-child")].map((e) => e.textContent.trim()); return w.length === 24 ? w.length : null; })()', 30000, '24 seed words');
      await t.click('button', '^Close$').catch(() => null);
      const sats = () => t.js('(() => { const m = String((document.getElementById("arena-hdr-bal") || {}).innerText || "").replace(/[,\\s ]/g, "").match(/(\\d+)sat/); return m ? Number(m[1]) : null; })()');
      const t0 = Date.now(); let bal = await sats();
      while (Date.now() - t0 < 180000 && !(bal > 0)) { await wait(3000); bal = await sats(); }
      await t.shot(join(ctx.dir, 'welcome.png'));
      check(bal > 0, 'the faucet credits the new wallet its welcome sats', { balance: bal, seconds: Math.round((Date.now() - t0) / 1000) });
      const fb = await t.click('#arena-foot-feedback');
      await wait(3000);
      const form = await t.js('!!document.querySelector("#arena-feedback-send, textarea") && /feedback/i.test(document.body.innerText)');
      await t.shot(join(ctx.dir, 'feedback.png'));
      check(fb && form, 'the Feedback form opens from the footer', { clicked: fb, form });
      const errs = errorsOf(t, false);
      live(ctx).push(...errs.map((e) => `wallet: ${e}`));
      check(!errs.length, 'no console error beyond the known noise (wallet, feedback)', errs);
      return { words, welcomeSats: bal, welcomeSeconds: Math.round((Date.now() - t0) / 1000), feedback: form };
    },
  },
];
