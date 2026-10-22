#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * ONE MARKET-MAKER BOT, A SCRIPT, NO BROWSER (kanban #581, the owner 2026-10-22: "es darf kein Chrome sein sondern nur ein Script pro
 * Instanz was den Bot macht. Soll die API verwenden"). One process is one bot: its own wallet (the page's wasm lock client, its
 * notes kept in BOT_DIR/wallet.json across restarts), its own price source, and the seats' own doors - the same API a player's page
 * uses. Every LOOP_S it reads the open Bitcoin Up or Down windows, takes the fair chance of Up from the price to beat and the last
 * BTC/USD price (book-bot.js fairUp), and quotes a ladder of buys on both sides below it (quoteLadder); each rung it has not placed
 * yet in that window becomes an order: the stake and fee locks on the federation, the shares dealt to the signer nodes, and an entry
 * with its pick, its limit price and the BOT MARK (contracts.js BOT_MARKER: the leaderboard and its payouts leave bots out) handed
 * to the round's seats. DRY=1 reads and prices only - nothing is paid.
 *
 *   NODES=<seat urls> INVITE_FILE=<federation invite> WASM_PKG=<dir with blwp_lock_client.js> BOOK_BOT=<book-bot.js of the Up/Down
 *   app> BOT_DIR=<this bot's folder> [BOT_NAME=m1] [PRICE=coinbase|kraken] [LEVELS=2] [STEP_CENTS=2] [EDGE_CENTS=1] [SHARES=100]
 *   [MAX_ORDERS=4 per window] [LOOP_S=60] [AHEAD_S=120] [GATEWAY=<url>] [LNCLI= PAYER_DIR= PAYER_RPC= for deposits] [DRY=1]
 *   node tools/market-bot.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey, playerFor, feeBpsForRound } from '../../arena-client/src/join.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockEntry } from './entry-locks.mjs';

const env = process.env;
for (const k of ['NODES', 'BOOK_BOT', 'BOT_DIR', ...(env.DRY ? [] : ['INVITE_FILE', 'WASM_PKG'])]) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const NAME = env.BOT_NAME || 'bot', DIR = env.BOT_DIR, DRY = !!env.DRY;
const nodes = env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const LEVELS = Number(env.LEVELS || 2), STEP = Number(env.STEP_CENTS || 2), EDGE = Number(env.EDGE_CENTS || 1), SHARES = Number(env.SHARES || 100);
const MAX_ORDERS = Number(env.MAX_ORDERS || 4), LOOP_MS = Number(env.LOOP_S || 60) * 1000, AHEAD_MS = Number(env.AHEAD_S || 120) * 1000;
const WINDOW_MS = 900000, GAME = env.GAME || 'btc-updown-15m';
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const say = (o) => console.log(J({ at: new Date().toISOString(), bot: NAME, ...o }));
const rand = (n) => new Uint8Array(randomBytes(n));
const getJson = async (u, ms = 8000) => { const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r.json(); };
// THE APP'S OWN PRICING (its page/book-bot.js, as the app published it): its `arena-sdk/...` imports read from this tree's arena-sdk
// through its export map - the app lives outside this tree, where `arena-sdk` names no package
async function importApp(file) {
  const sdk = new URL('../../arena-sdk/', import.meta.url);
  const map = JSON.parse(readFileSync(new URL('package.json', sdk), 'utf8')).exports;
  const src = readFileSync(file, 'utf8').replace(/from\s+'arena-sdk\/([^']+)'/g, (m, sub) => {
    if (!map[`./${sub}`]) throw new Error(`arena-sdk exports no ${sub}`);
    return `from '${new URL(map[`./${sub}`], sdk).href}'`;
  });
  const copy = join(tmpdir(), `arena-book-bot-${process.pid}.mjs`);
  writeFileSync(copy, src);
  return import(copy);
}
const { fairUp, quoteLadder } = await importApp(env.BOOK_BOT);

// ---- WHAT THIS BOT PLACED, KEPT ACROSS RESTARTS: per window, the rungs ("outcome:priceCents") already ordered ----
const placedFile = join(DIR, 'placed.json');
const placed = existsSync(placedFile) ? JSON.parse(readFileSync(placedFile, 'utf8')) : {};
const keepPlaced = () => { const t = `${placedFile}.tmp`; writeFileSync(t, JSON.stringify(placed)); renameSync(t, placedFile); };

// ---- PRICES: the bot's own source; the price to beat is the 1-minute close before the window opened (Coinbase's candles) ----
const SOURCES = {
  coinbase: async () => Number((await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount),
  kraken: async () => Number(Object.values((await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).result)[0].c[0]),
};
const lastPrice = SOURCES[env.PRICE || 'coinbase'];
if (!lastPrice) throw new Error(`no price source ${env.PRICE}`);
async function beatOf(startMs) {
  const iso = (t) => new Date(t).toISOString();
  const c = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(startMs - 180000)}&end=${iso(startMs)}`);
  const before = Array.isArray(c) ? c.filter((x) => x[0] * 1000 < startMs).sort((a, b) => b[0] - a[0])[0] : null;
  if (!before) throw new Error(`no 1-minute candle before ${iso(startMs)}`);
  return before[4];
}

// ---- THE OPEN WINDOWS: the rounds of the market the seats list, entry open, closing far enough ahead to pay into ----
// THE WALLET'S FEDERATION: only its rounds are traded (each window has a round per federation; a lock pays into one)
let walletFed = null;   // set by wallet()
async function openWindows() {
  const now = Date.now();
  if (!DRY) await wallet();
  for (const n of nodes) {
    try {
      const rows = ((await getJson(`${n}/rounds?ahead=${WINDOW_MS * 2}`, 15000)).rounds || [])
        .filter((r) => r.game && r.game.name === GAME && r.entryOpen && r.windowStartMs && Number(r.entryCloseMs) - now > AHEAD_MS)
        .filter((r) => !walletFed || !r.federation || String(r.federation.id || r.federation).toLowerCase().startsWith(walletFed.slice(0, 16)));
      return rows.sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs));
    } catch (e) { say({ step: 'rounds', seat: n, why: e.message }); }
  }
  return [];
}

// ---- THE WALLET: one lock client, its notes in BOT_DIR/wallet.json (written whole on every change, never half) ----
let lc = null;
async function wallet() {
  if (lc) return lc;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `arena-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const file = join(DIR, 'wallet.json');
  const held = new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  const write = () => { const t = `${file}.tmp`; writeFileSync(t, JSON.stringify([...held]), { mode: 0o600 }); renameSync(t, file); };
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); write(); }, remove: (k) => { held.delete(k); write(); } };
  const seedFile = join(DIR, 'seed.hex');
  if (!existsSync(seedFile)) writeFileSync(seedFile, toHex(rand(32)), { mode: 0o600 });
  const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
  walletFed = String(LockClient.federationIdOf(invite)).toLowerCase();
  lc = await LockClient.join(invite, walletFed, readFileSync(seedFile, 'utf8').trim(), store);
  return lc;
}

// ---- A DEPOSIT WHEN THE WALLET RUNS LOW: from the payer lnd through the named gateway (as tn4-rps-paid.mjs) ----
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
async function topUp(needMsat) {
  const w = await wallet();
  const have = BigInt(await w.balanceMsat());
  if (have >= needMsat) return have;
  if (!env.LNCLI) throw new Error(`the wallet holds ${have} msat, ${needMsat} needed, and no payer is named (LNCLI)`);
  const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
  const amount = needMsat * 3n - have;
  const rcv = JSON.parse(await w.receive(String(amount), env.GATEWAY || ''));
  const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
  const final = await w.awaitReceive(rcv.operation);
  const after = BigInt(await w.balanceMsat());
  say({ step: 'deposit', msat: amount, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, balanceMsat: after });
  return after;
}

// ---- ONE ORDER: the page's join for a market order, with the bot mark ----
async function placeOrder(c, rid, rung, orderIndex, signers) {
  const r = { ...c, orderStakeMsat: rung.stakeMsat };
  // THE SEATED SIGNER NODES (the seating certificate's settlement committee), not the contract's list: a seated round's shares are
  // dealt to them - measured 2026-10-22 22:50Z, shares dealt to c.nodes: "this node is not one of the signer nodes that handout was dealt to"
  const att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: signers, nodes, curve: pageCurve });
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  const w = await wallet();
  const rule = JSON.parse(await w.feeRule());
  const oc = { ...c, stakeMsat: rung.stakeMsat };
  // A MARKET ORDER PAYS THE MARKET'S OWN FEE (join.js feeBpsForRound: Up/Down's 1 %) out of its stake, and no reserve or developer
  // outputs (reserves.js: "a market's reserves are a later slice") - measured 2026-10-22 22:42Z: an entry built with a game's split
  // was refused, "charged 2020 where 1% of 40406 is 404"
  const feeBps = feeBpsForRound(r);
  const feeMsat = entryFeeMsat(rung.stakeMsat, feeBps);
  const split = { feeMsat, donationMsat: 0n, netMsat: netStakeMsat({ stakeMsat: rung.stakeMsat, feeMsat, donationMsat: 0n }), shares: [], reserveKey: null };
  const gate = feeLockPays({ contract: oc, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) }, feeBps });
  await topUp(rung.stakeMsat + 200000n);
  const seed = Uint8Array.from(Buffer.from(readFileSync(join(DIR, 'seed.hex'), 'utf8').trim(), 'hex'));
  // the order's own key (join.js playerFor with its order number): the payout and refund key the bot finds again from its seed
  const player = playerFor({ ...r, id: rid }, { seed, curve: feldmanGroup, order: orderIndex }).pubkey;
  const p = (() => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } })();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD);
  // the lock lasts the round's own stake expiry (a market's window and settlement, 1800+ blocks), not lockEntry's 150 for a short game -
  // measured 22:53Z: "that stake lock's lock height 155634 (its expiration 157469 less the round's 1835 blocks)"
  const locks = await lockEntry({ lc: w, c: oc, split, stakePoint: point, player, claimPk: att.claimPk, gate, rand, expiry: Number(c.stakeExpiryBlocks) });
  if (env.DEBUG) say({ step: 'locks', gate: gate.pays, gateWhy: gate.why, fee: !!locks.fee, feeLock: locks.entryFields.feeLockOutpoint && toHex(locks.entryFields.feeLockOutpoint.txid).slice(0, 12), feeMsat: split.feeMsat, netMsat: split.netMsat });
  const needed = receiptsNeeded(signers.length), e = rand(32);
  const dealt = await dealHandout({ preimage: p, signerNodes: signers, roundId: rid, playerPubkey: player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  const session = ed25519.utils.randomSecretKey();
  // the entry as tn4-rps-paid.mjs builds a paid one, with the order's pick, limit price (until the market closes) and the bot mark
  const entry = { roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(p), stakeMsat: rung.stakeMsat,
    feeMsat: split.feeMsat, donationMsat: split.donationMsat, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], ...locks.entryFields, claimKeyAttestationRef: att.ref,
    pick: Number(rung.outcome), limitPrice: Number(rung.price), orderExpiryMs: 0n, bot: true };
  const eid = entryId(entry);
  const said = [];
  for (const n of nodes) {
    try {
      const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      const hWhy = h.status >= 300 ? (await h.text()).trim().slice(0, 200) : null;
      const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      const enWhy = en.status >= 300 ? (await en.text()).trim().slice(0, 200) : null;
      if (locks.fee) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.fee.fields)) });
      const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.stake.fields)) });
      const lWhy = l.status >= 300 ? (await l.text()).trim().slice(0, 200) : null;
      said.push({ seat: n.replace(/^https?:\/\//, ''), entry: en.status, lock: l.status, ...(enWhy ? { why: enWhy } : {}), ...(hWhy ? { handout: h.status, handoutWhy: hWhy } : {}), ...(lWhy ? { lockWhy: lWhy } : {}) });
    } catch (x) { said.push({ seat: n, why: x.message.slice(0, 80) }); }
  }
  // TAKEN only when enough seats took the entry and its lock (as tn4-rps-paid.mjs counts): else the rung is tried again next pass
  const took = said.filter((x) => x.lock >= 200 && x.lock < 300).length;
  if (env.DEBUG) for (const x of said) say({ step: 'seat answer', ...x });
  if (took < needed) throw new Error(`the seats did not take the order: ${took} of ${needed} needed took its lock; ${said.find((x) => x.handoutWhy)?.handoutWhy ? `handout: ${said.find((x) => x.handoutWhy).handoutWhy}; ` : ''}${said.find((x) => x.why)?.why || 'no reason given'}`);
  return { entry: toHex(eid), took, said: said.map((x) => `${x.seat}:${x.entry}/${x.lock}`).join(' ') };
}

// ---- THE LOOP ----
async function pass() {
  const windows = await openWindows();
  if (!windows.length) { say({ step: 'no open window' }); return; }
  const last = await lastPrice();
  for (const row of windows) {
    const start = Number(row.windowStartMs), end = start + WINDOW_MS;
    let beat; try { beat = await beatOf(start); } catch (e) { say({ step: 'beat', round: row.id.slice(0, 16), why: e.message }); continue; }
    const fair = fairUp({ beat, last, msLeft: end - Date.now() });
    const ladder = quoteLadder({ fair, levels: LEVELS, stepCents: STEP, edgeCents: EDGE, shares: SHARES });
    const done = new Set(placed[row.id] || []);
    const todo = ladder.filter((q) => !done.has(`${q.outcome}:${q.priceCents}`)).slice(0, Math.max(0, MAX_ORDERS - done.size));
    say({ step: 'quote', round: row.id.slice(0, 16), window: new Date(start).toISOString().slice(11, 16), beat, last, fair: Number(fair.toFixed(4)),
      ladder: ladder.map((q) => `${Number(q.outcome) === 0 ? 'Up' : 'Down'}@${q.priceCents}c×${q.shares}=${q.stakeMsat}msat`), placed: [...done], todo: todo.length });
    if (DRY || !todo.length) continue;
    const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${row.id}`)).arrayBuffer()));
    const rid = roundId(c);
    if (toHex(rid) !== row.id) throw new Error('the seat answered another round');
    const seated = await clientSettlementSignerNodes(row.id, c, nodes, { curve: pageCurve });   // seated before anything is paid (§5A.7)
    for (const q of todo) {
      const index = done.size;
      try {
        const o = await placeOrder(c, rid, q, index, seated.signerNodes);
        done.add(`${q.outcome}:${q.priceCents}`); placed[row.id] = [...done]; keepPlaced();
        say({ step: 'order', round: row.id.slice(0, 16), side: Number(q.outcome) === 0 ? 'Up' : 'Down', priceCents: q.priceCents, stakeMsat: q.stakeMsat, ...o });
      } catch (e) { say({ step: 'order failed', round: row.id.slice(0, 16), priceCents: q.priceCents, why: String(e.message).slice(0, 300) }); break; }
    }
  }
}

for (;;) {
  try { await pass(); } catch (e) { say({ step: 'pass failed', why: String(e.stack || e.message).slice(0, 400) }); }
  if (env.ONCE) break;
  await new Promise((r) => setTimeout(r, LOOP_MS));
}
process.exit(0);
