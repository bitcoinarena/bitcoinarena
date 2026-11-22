#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORANGE PILL RUN ROUND SERVICE, as a process (kanban #3248-#3250, #3256): systemd user unit arena-opr on the Beelink, behind the site Worker's
// /api/opr/* (src/website/worker.js). Listens on 127.0.0.1 only. Environment (secrets are files or hashes, never values in the unit):
//   OPR_PORT (18877), OPR_DB (the sqlite file), OPR_ADMIN_SHA256 (sha256 hex of the admin code), OPR_WORKER_KEY (the Worker's x-arena-worker key)
//   OPR_PUBLIC_BASES (comma list of public /api/opr URLs the NIP-98 sign-in may name; default the testnet stage)
//   OPR_ENTRY_SATS (0: free rounds, kanban #3273): the entry of a round made from now on
//   OPR_LNCLI, OPR_LND=<lnddir>|<rpc host:port>, OPR_LN_NETWORK (testnet4): the lnd that makes and reads the entry invoices (optional: free rounds need none)
//   OPR_BITCOIN_CLI, OPR_BITCOIN_DATADIR, OPR_BITCOIN_CHAIN (optional), OPR_WALLET (arena-opr), OPR_FEE_RATE (sat/vB, 1),
//   OPR_PENDING_FILE (miner C's list), OPR_CONFIRMATIONS (1); OPR_CHAIN=off opens rounds without a post (local runs only)
//   OPR_S2_DB (the bug bounty's Season 2 book: X links), FAUCET_BOT_X_HANDLES (its bot list, read by that store)
//   OPR_FIRST_DAY (2026-11-23), OPR_DAILY (on), OPR_SHOW_TEST (off: test rounds hidden from the public routes; on for the stage)
//   OPR_ALERTS (off), OPR_CHAT_URL, OPR_CHAT_CHANNEL, OPR_CHAT_TOKEN_FILE: the alert hook (Arena Chat, as the faucet posts); off: log only
//   OPR_TICK_MS (15000)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createOpr } from './opr-service.mjs';
import { lncliInvoices } from './opr-invoices.mjs';
import { bitcoinCliChain } from './opr-chain.mjs';

const env = process.env;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const port = Number(env.OPR_PORT || 18877);
if (port === 8080 || port === 18789) throw new Error('8080 is signal-cli and 18789 OpenClaw: pick another OPR_PORT');
if (!env.OPR_DB) throw new Error('OPR_DB names the sqlite file');

const simMod = await import('../src/sim/index.js');
const { checkLevel } = await import('../src/level-check.mjs');
const { fetchDay } = await import('../src/candles.mjs');
const sim = { GAME_VERSION: simMod.GAME_VERSION, buildLevel: simMod.buildLevel, runLog: simMod.runLog, newWorld: simMod.newWorld, stepWorld: simMod.stepWorld, botInput: simMod.botInput, MAX_STEPS: simMod.MAX_STEPS };   // the last four: the bot likelihood (#3274)
const fetchCandles = async (day) => (await fetchDay(day, { log: (m) => log(`candles ${day}: ${m}`) })).candles;   // Coinbase, then Kraken, Bitstamp

const s2 = env.OPR_S2_DB ? (await import('../../arena-node/src/bounty-season.js')).openBountySeason(env.OPR_S2_DB) : null;
const invoices = !env.OPR_LNCLI || !env.OPR_LND ? null : lncliInvoices({ lncli: env.OPR_LNCLI, lnd: env.OPR_LND, network: env.OPR_LN_NETWORK || 'testnet4' });
const chain = env.OPR_CHAIN === 'off' ? null : bitcoinCliChain({ cli: env.OPR_BITCOIN_CLI, datadir: env.OPR_BITCOIN_DATADIR || null, chain: env.OPR_BITCOIN_CHAIN || null,
  wallet: env.OPR_WALLET, pendingFile: env.OPR_PENDING_FILE || null, feeRate: Number(env.OPR_FEE_RATE || 1), log });

const alert = (text) => {
  log(`ALERT ${text}`);
  if (env.OPR_ALERTS !== 'on' || !env.OPR_CHAT_URL || !env.OPR_CHAT_CHANNEL || !env.OPR_CHAT_TOKEN_FILE) return;
  let token; try { token = readFileSync(env.OPR_CHAT_TOKEN_FILE, 'utf8').trim(); } catch { log('alert not posted: no chat token'); return; }
  fetch(`${env.OPR_CHAT_URL}/api/channels/${env.OPR_CHAT_CHANNEL}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) }).then((r) => { if (!r.ok) log(`alert not posted: chat ${r.status}`); }, (e) => log(`alert not posted: ${e.message}`));
};

const opr = createOpr({ dbPath: env.OPR_DB, sim, fetchCandles, checkLevel, invoices, chain, s2, alert, log, cfg: {
  entrySats: Number(env.OPR_ENTRY_SATS || 0), firstDay: env.OPR_FIRST_DAY || '2026-11-23', daily: env.OPR_DAILY !== 'off', showTest: env.OPR_SHOW_TEST === 'on',
  adminSha: env.OPR_ADMIN_SHA256 || '', workerKey: env.OPR_WORKER_KEY || '', confirmations: Number(env.OPR_CONFIRMATIONS || 1),
  publicBases: String(env.OPR_PUBLIC_BASES || 'https://testnet-stage.bitcoinarena.io/api/opr').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean),
} });

createServer((req, res) => { opr.handle(req, res); }).listen(port, '127.0.0.1', () => log(`orange pill run on 127.0.0.1:${port}, game ${sim.GAME_VERSION}, chain ${chain ? env.OPR_WALLET : 'off'}, X ${s2 ? 'season 2 book' : 'off'}`));
const tick = () => opr.tick().catch((e) => log(`tick failed: ${e.stack || e.message}`));
tick();
setInterval(tick, Number(env.OPR_TICK_MS || 15000));
