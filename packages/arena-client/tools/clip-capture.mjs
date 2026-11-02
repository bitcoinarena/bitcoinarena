#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE CLIPS OF THE X PLAN (kanban #926 item 13, plan #924): a clip recorded from the live page, the same way each time, so a large Bitcoin move can be clipped the same day.
 *
 *   truck    Tick Tock, Next Block, spectating with the HUD off (?hud=0): the truck carrying real transactions
 *   block    the same view, kept running until a block arrives
 *   strike   the same view, kept running until a liquidation falls: RECORD_S long enough, it depends on the market
 *   rps      a Rock Paper Scissors round, with a wallet that holds test sats (STORAGE: a file of localStorage saved from such a browser)
 *   login    the Nostr login on a fresh browser
 *
 *   PLAYWRIGHT=<path to playwright-core> CHROME=<chrome binary> [URL=https://testnet.bitcoinarena.io/] [RECORD_S=30] [OUT=<dir>] [STORAGE=<json>] node tools/clip-capture.mjs <clip>
 *
 * THE WORLD NEEDS A REAL GPU: software GL draws it at about 3 frames a second (tools/gpu-chrome.sh), so truck, block and strike are recorded on a machine with one. The login is
 * plain page and records anywhere. The recording is a .webm at 1280x720; cut the 30 seconds that matter by hand.
 */
import { mkdirSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
export const CLIPS = Object.freeze({
  truck: { query: 'game=nextblock&hud=0', seconds: 30, world: true },
  block: { query: 'game=nextblock&hud=0', seconds: 120, world: true },
  strike: { query: 'game=nextblock&hud=0', seconds: 300, world: true },
  rps: { query: 'game=rock-paper-scissors', seconds: 45, wallet: true },
  login: { query: '', seconds: 30 },
});
/** The page's address for a clip: its query after the site's own. */
export const clipUrl = (base, clip) => (CLIPS[clip].query ? `${base}${base.includes('?') ? '&' : '?'}${CLIPS[clip].query}` : base);

if (import.meta.url === `file://${process.argv[1]}`) {
  const clip = process.argv[2];
  if (!CLIPS[clip]) { console.error(`one of ${Object.keys(CLIPS).join(', ')}`); process.exit(2); }
  const { chromium } = await import(env.PLAYWRIGHT || 'playwright-core');
  const c = CLIPS[clip], url = clipUrl(env.URL || 'https://testnet.bitcoinarena.io/', clip), out = env.OUT || '.', seconds = Number(env.RECORD_S || c.seconds);
  if (c.wallet && !env.STORAGE) { console.error('this clip needs a wallet with test sats: STORAGE=<json of localStorage>'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: !env.HEADED, executablePath: env.CHROME, args: c.world ? [process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=gl', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [] });
  const size = { width: 1280, height: 720 };
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
  if (env.STORAGE) { const kept = JSON.parse(readFileSync(env.STORAGE, 'utf8')); await context.addInitScript((k) => { for (const [a, b] of Object.entries(k)) localStorage.setItem(a, b); }, kept); }
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const tap = async (re, ms = 20000) => { const b = page.getByRole('button', { name: re }).first(); await b.waitFor({ state: 'visible', timeout: ms }); await page.waitForTimeout(800); await b.click(); };
  let did = 'recorded';
  try {
    if (clip === 'login') { await tap(/nostr/i, 30000); await page.waitForTimeout(2500); }
    else if (c.world) {
      // A FRESH BROWSER MAKES A WALLET FIRST, AND A NEW WALLET SHOWS ITS WORDS (kanban #1033). SPECTATE is drawn on the game's canvas, not a page button: its place on the title screen at 1280x720
      await tap(/create a new wallet/i, 40000); await tap(/^close$/i, 20000);
      await page.waitForTimeout(Number(env.TITLE_S || 40) * 1000);
      await page.mouse.click(838, 620);
      await page.waitForTimeout(5000);
    }
    else if (clip === 'rps') { await tap(/join|play/i, 60000); await tap(/rock/i, 60000); }
  } catch (e) { did = `the script stopped: ${String(e.message).split('\n')[0]}`; }
  await page.waitForTimeout(seconds * 1000);
  const video = page.video();
  await context.close();
  const file = join(out, `${clip}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`);
  renameSync(await video.path(), file);
  await browser.close();
  console.log(JSON.stringify({ clip, url, seconds, file, did }));
}
