#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * TWO LIVE DONATIONS ON TESTNET4, AS THE PAGE GIVES THEM (kanban #672: "when clicking donate on the main Testnet site the donation goes too
 * 100% to protocol devs. If it's within an app 50% to protocol devs, 50% to game devs. That donation is tagged so we know its origin"):
 * the page's wasm lock client joins the federation and takes a deposit from a testnet4 lnd, the donation sets are read from a paid round
 * as the Donate box reads them, then one gift on the site (the protocol set, origin "site") and one inside Rock Paper Scissors (both sets,
 * origin "app:rock-paper-scissors"), each recorded at the seats; then the seats are asked what they indexed under one recipient key.
 *
 *   PORTS=<seat ports> INVITE_FILE=<federation invite> WASM_PKG=<dir with blwp_lock_client.js> LNCLI=<lncli> PAYER_DIR=<lnd dir>
 *   PAYER_RPC=<host:port> GATEWAY=<gateway url> [SAT=<each gift, default 100>] node tools/tn4-gift-run.mjs
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
import { decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { fetchDonationSet } from '../../arena-client/src/donation-pay.js';
import { giftDonation } from '../../arena-client/src/donation-gift-page.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
for (const k of ['PORTS', 'INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC', 'GATEWAY']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, '--network=testnet4', ...a]);
const nodes = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const SAT = Number(env.SAT || 100);
const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();

let code = 0;
try {
  // THE WALLET: the page's lock client in the round's federation, a deposit from lnd through the page's gateway
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  routeGuardianSockets();
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const held = new Map();
  const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
  const fid = LockClient.federationIdOf(invite);
  // THE SETS, from the newest-census paid Rock Paper Scissors round the seats list in this federation (as the Donate box reads them)
  const list = (await (await fetch(`${nodes[0]}/rounds?next=8`)).json()).rounds;
  const rows = list.filter((x) => !x.free && x.game && x.game.name === 'rock-paper-scissors' && x.committee && x.committee.drawn);
  if (!rows.length) throw new Error('no drawn paid Rock Paper Scissors round is listed to read the donation sets from');
  let ds = null, used = null;
  for (const row of rows.slice(0, 30)) {
    const c = decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${row.id}`)).arrayBuffer()));
    if (toHex(c.federationId) !== String(fid).toLowerCase()) continue;   // a round in the invite's federation: the gifts are paid there
    ds = await fetchDonationSet({ round: { ...c, id: roundId(c) }, nodes, verifyEd25519: (s, m, k) => ed25519.verify(s, m, k), keepBySet: true }).catch((e) => ({ ok: false, why: e.message }));
    if (ds.ok && ds.target) { used = { row, c }; break; }
  }
  if (!used) throw new Error(`the donation sets could not be read: ${ds && ds.why}`);
  const network = ds.target.network, game = ds.target.game;
  log({ step: 'sets', round: used.row.id.slice(0, 16), federation: toHex(used.c.federationId).slice(0, 16), protocol: network.length, app: game.length });

  const lc = await LockClient.join(invite, fid, toHex(new Uint8Array(randomBytes(32))), memStore);
  const depositMsat = BigInt(SAT * 2 + 200) * 1000n;
  const rcv = JSON.parse(await lc.receive(String(depositMsat), env.GATEWAY));
  const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
  const final = await lc.awaitReceive(rcv.operation);
  log({ step: 'deposit', msat: depositMsat, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, balanceMsat: await lc.balanceMsat() });

  // THE DONOR'S KEY: a page's items key is one; here a fresh one
  const secret = schnorr.utils.randomSecretKey();
  const donor = { pubkey: schnorr.getPublicKey(secret), sign: (m) => schnorr.sign(m, secret) };
  // ON THE SITE: the protocol developers' set, origin "site"
  const site = await giftDonation({ recipients: network, origin: 'site', sat: SAT, wallet: lc, federationId: fid, donor, seats: nodes, fetch: (u, o) => fetch(u, o) });
  log({ step: 'gift on the site', ...site });
  // INSIDE ROCK PAPER SCISSORS: half to each set, origin "app:rock-paper-scissors"
  const games = (await (await fetch(`${nodes[0]}/network-games`)).json()).games || [];
  const rps = games.find((g) => g.name === 'rock-paper-scissors');
  const app = await giftDonation({ game: { gameDevPubkey: fromHex(rps.devKey), gameName: rps.name }, recipients: game, networkSet: network, origin: 'app:rock-paper-scissors',
    sat: SAT, wallet: lc, federationId: fid, donor, seats: nodes, fetch: (u, o) => fetch(u, o) });
  log({ step: 'gift in the app', ...app });

  // WHAT THE SEATS INDEXED: the first protocol recipient's donations, by item
  await new Promise((r) => setTimeout(r, 8000));
  const key = toHex(network[0].recipientPk);
  for (const n of nodes) {
    let rows2 = [];
    try { rows2 = ((await (await fetch(`${n}/donations?key=${key}`)).json()).donations || []); } catch { rows2 = []; }
    const mine = rows2.filter((r) => [site.txid, app.txid].includes(String(r.outpoint || '').split(':')[0]));
    log({ step: 'indexed', seat: n, rows: mine.map((r) => ({ item: r.item, msat: String(r.amountMsat) })) });
  }
  if (!site.ok || !app.ok) code = 1;
} catch (e) { log({ step: 'stopped', why: String(e && e.stack || e) }); code = 1; }
process.exit(code);
