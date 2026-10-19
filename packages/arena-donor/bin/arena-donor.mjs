#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEV'S DONATION CLIENT (2026-10-03): one instance per dev, one directory each.
//
//   arena-donor init <dir> --label "dev a" [--lnddir D --rpcserver H:P]   makes the key (key.json, 0600) and donor.json
//   arena-donor once <dir>      one pass: ask the seats, redeem in every federation, withdraw to the dev's LND
//   arena-donor loop <dir>      a pass every donor.json intervalSec
//   arena-donor status <dir>    the key, what the seats list for it, what each federation wallet holds
//   arena-donor game-key <dir>  makes the game developer's Ed25519 key (game-dev.pkcs8, 0600) and prints its public key
//   arena-donor sign <dir> <body.mjs>  signs the manifest body the module exports as BODY with <dir>/game-dev.pkcs8, checks it
//                               as a node does, and writes <dir>/<game>-manifest.hex; prints the game id
//
// The federation is the page's own wasm lock client (donor.json wasmPkg), run in Node; each federation's wallet state is
// kept in <dir>/wallet-<federation id 16>.json. The LND is the dev's own, through lncli. Invites: donor.json `invites`
// (federation id -> invite), and the `testnet.federation` invite of every `invitesFrom` daily.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gameDevKey, signManifest } from '../src/manifest-sign.js';
import { manifestStands, encodeManifest } from '../../arena-protocol/src/manifest.js';
import { verifyEd25519 } from '../../arena-node/src/ed25519.js';
import { newKey, walletSecretFor, gatherDonations, settleRead, withdrawToLnd, routeWebSockets, readRecord, walletClients, claimUnclaimed,
  payInvoice, lightningAddressInvoice, invoiceMsat } from '../src/donor.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, v) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1)); renameSync(`${p}.tmp`, p); };
if (!cmd || !dir) { console.error('arena-donor init|once|loop|status|game-key <dir>  |  arena-donor sign <dir> <body.mjs>'); process.exit(2); }

// THE GAME DEVELOPER'S KEY AND SIGNATURE: held by the developer's own client, never by a node
if (cmd === 'game-key') {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'game-dev.pkcs8');
  if (existsSync(keyPath)) { console.error(`${keyPath} exists: a key is never replaced (an update of a game is signed by the same key)`); process.exit(1); }
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'der' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  say({ step: 'game-key', file: keyPath, gameDevPubkey: Buffer.from(gameDevKey(readFileSync(keyPath)).pubkey).toString('hex') });
  process.exit(0);
}
if (cmd === 'sign') {
  const bodyPath = rest[0];
  if (!bodyPath) { console.error('arena-donor sign <dir> <body.mjs>: the module exporting the manifest BODY'); process.exit(2); }
  const dev = gameDevKey(readFileSync(join(dir, 'game-dev.pkcs8')));
  const { BODY } = await import(pathToFileURL(resolve(bodyPath)).href);
  if (!BODY) { console.error(`${bodyPath} exports no BODY`); process.exit(2); }
  const manifest = signManifest({ ...BODY, gameDevPubkey: BODY.gameDevPubkey || dev.pubkey }, dev);
  const stands = manifestStands(manifest, { verify: verifyEd25519 });
  if (!stands.ok) { console.error(`that manifest is not a game: ${stands.why}`); process.exit(1); }
  const out = join(dir, `${manifest.gameName}-manifest.hex`);
  writeFileSync(out, Buffer.from(encodeManifest(manifest)).toString('hex') + '\n');
  say({ step: 'signed', game: manifest.gameName, version: manifest.version, gameId: Buffer.from(stands.gameId).toString('hex'), file: out });
  process.exit(0);
}

if (cmd === 'init') {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.json');
  if (existsSync(keyPath)) { console.error(`${keyPath} exists: a key is never replaced`); process.exit(1); }
  const k = newKey();
  writeFileSync(keyPath, JSON.stringify({ label: flag('label', ''), ...k }, null, 1), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeJson(join(dir, 'donor.json'), {
    label: flag('label', ''),
    recipientPkHex: k.recipientPkHex,
    seats: (flag('seats', 'http://127.0.0.1:31221,http://127.0.0.1:31231,http://127.0.0.1:31241,http://127.0.0.1:31251,http://127.0.0.1:31261,http://127.0.0.1:31271,http://127.0.0.1:31281')).split(','),
    invites: {},
    invitesFrom: ['https://testnet.bitcoin-arena.io/daily.json'],
    wasmPkg: flag('wasm', '/mnt/bitcoin/blwp-2of2-s/page-hold'),
    lnd: { lncli: '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli', lnddir: flag('lnddir', '/mnt/bitcoin/lnd-testnet4-c'),
      rpcserver: flag('rpcserver', '127.0.0.1:11011'), network: 'testnet4' },
    minWithdrawMsat: flag('min', '10000'),
    intervalSec: Number(flag('interval', '300')),
  });
  say({ step: 'init', dir, label: flag('label', ''), recipientPk: k.recipientPkHex });
  process.exit(0);
}

const cfg = readJson(join(dir, 'donor.json'), null);
const key = readJson(join(dir, 'key.json'), null);
if (!cfg || !key) { console.error(`${dir} holds no donor.json and key.json: run init first`); process.exit(2); }
const statePath = join(dir, 'state.json');

const lncli = (...a) => new Promise((ok, no) => execFile(cfg.lnd && cfg.lnd.lncli, [`--lnddir=${cfg.lnd.lnddir}`, `--rpcserver=${cfg.lnd.rpcserver}`, `--network=${cfg.lnd.network}`, ...a],
  { timeout: 120000 }, (e, out, err) => (e ? no(new Error(String(err || e.message).trim())) : ok(JSON.parse(out)))));
const lnd = { invoice: async (msat, memo) => (await lncli('addinvoice', '--amt_msat', String(msat), '--memo', memo, '--expiry', '3600')).payment_request };

let LockClient = null;
async function lockClient() {
  if (LockClient) return LockClient;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `arena-donor-lock-client-${process.pid}.mjs`);
  copyFileSync(join(cfg.wasmPkg, 'blwp_lock_client.js'), esm);
  const m = await import(esm);
  await m.default({ module_or_path: readFileSync(join(cfg.wasmPkg, 'blwp_lock_client_bg.wasm')) });
  LockClient = m.LockClient;
  return LockClient;
}

/** A wallet store kept in a file: the lock client's state survives a restart, per federation. */
function fileStore(path) {
  const held = new Map(Object.entries(readJson(path, {})));
  const save = () => writeJson(path, Object.fromEntries(held));
  return { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); save(); }, remove: (k) => { held.delete(k); save(); } };
}

async function invites() {
  const LC = await lockClient();
  const out = { ...(cfg.invites || {}) };
  const routes = {};
  for (const url of cfg.invitesFrom || []) {
    try {
      const d = await (await fetch(url, { cache: 'no-store' })).json();
      // the guardians' second route, as the page takes it (not the loopback donation route)
      Object.assign(routes, (d && d.testnet && d.testnet.alt) || {});
      // the gateways the network names: a withdrawal tries these first
      for (const g of [].concat((d && d.testnet && d.testnet.gateway) || [])) if (typeof g === 'string' && !namedGateways.includes(g)) namedGateways.push(g);
      for (const inv of [d && d.testnet && d.testnet.federation, d && d.federation].filter((x) => typeof x === 'string')) {
        try { out[String(LC.federationIdOf(inv)).toLowerCase()] = inv; } catch { /* not an invite */ }
      }
    } catch (e) { say({ step: 'invites', from: url, why: e.message }); }
  }
  delete routes['127.0.0.1:18777'];
  if (!routed && routeWebSockets(routes)) { routed = true; say({ step: 'routes', guardians: Object.keys(routes).length }); }
  return out;
}
let routed = false;
const namedGateways = [];
// ONE CLIENT PER FEDERATION, KEPT ACROSS PASSES: joined on the first pass, used by every later one
// AN IMPORTED KEY RECOVERS, IT NEVER JOINS FRESH: a dev key set up on a node from the owner page may have held e-cash
// elsewhere; a fresh join would reuse its note indices. Fedimint's recovery reads them back from the federation into this wallet.
const clientFor = walletClients(async (invite, fed, secret, store) => {
  const LC = await lockClient();
  if (cfg.imported && !existsSync(join(dir, `wallet-${fed.slice(0, 16)}.json`))) { say({ step: 'recover', federation: fed.slice(0, 16), why: 'an imported key: its wallet is read back from the federation' }); return LC.recover(invite, fed, secret, store); }
  return LC.join(invite, fed, secret, store);
});

async function pass() {
  const state = readJson(statePath, { done: [], withdrawals: [] });
  const done = new Set(state.done);
  const got = await gatherDonations({ recipientPkHex: cfg.recipientPkHex, seats: cfg.seats });
  say({ step: 'asked the seats', donations: got.total, federations: [...got.byFederation.keys()].map((f) => f.slice(0, 16)), unanswered: got.unanswered });
  const known = await invites();
  const LC = await lockClient();
  // EVERY FEDERATION THIS DEV HOLDS A WALLET IN, NOT ONLY THOSE WITH NEW DONATIONS (measured 2026-10-14: once the seats had
  // deleted the rows this client read, no pass reached the withdrawal again, and 38,563 msat sat in federation A)
  const feds = new Map(got.byFederation);
  for (const f of readdirSync(dir).filter((x) => /^wallet-[0-9a-f]{16}\.json$/.test(x)).map((x) => x.slice(7, 23))) {
    const full = Object.keys(known).find((k) => k.startsWith(f));
    if (full && !feds.has(full)) feds.set(full, []);
  }
  state.balances = state.balances || {};
  for (const [fed, donations] of feds) {
    const invite = known[fed.toLowerCase()];
    if (!invite) { say({ step: 'federation', federation: fed.slice(0, 16), donations: donations.length, why: 'no invite to this federation is known: its funds stay there until one is' }); continue; }
    let client = await clientFor(invite, fed, walletSecretFor(key.secretHex, fed), fileStore(join(dir, `wallet-${fed.slice(0, 16)}.json`)));
    if (donations.length) {
      // RECORDED FOR GOOD FIRST, THEN REDEEMED, THEN THE SEATS TOLD AND THEIR COPY DELETED: donations.jsonl in
      // this dir is the dev's permanent record - sender key, round id, amount, time, the USD and EUR rate and their provider.
      const r = await settleRead({ path: join(dir, 'donations.jsonl'), donations, client, key: { recipientPkHex: cfg.recipientPkHex, secretHex: key.secretHex }, seats: cfg.seats, done });
      for (const d of [...r.redeemed, ...r.spent]) done.add(d.outpoint);
      state.done = [...done];
      writeJson(statePath, state);
      say({ step: 'recorded, redeemed, receipted', federation: fed.slice(0, 16), recorded: r.recorded, unrecorded: r.unrecorded.map((u) => `${u.outpoint.slice(0, 12)}: ${u.why}`),
        redeemed: r.redeemed.length, redeemedMsat: r.redeemed.reduce((t, d) => t + BigInt(d.amountMsat), 0n), alreadySpent: r.spent.length,
        failed: r.failed.map((d) => `${d.outpoint.slice(0, 12)}: ${d.why}`), receipted: r.receipted, seats: r.answers.map((a) => `${a.seat}: ${a.status || a.why} ${a.said || ''}`.trim()) });
    }
    // UNCLAIMED E-CASH, RECOVERED ON ITS OWN: after the redeem, before the withdrawal - see claimUnclaimed
    {
      const f16 = fed.slice(0, 16), walletPath = join(dir, `wallet-${f16}.json`), recPath = join(dir, `wallet-${f16}.recovering.json`);
      const secret = walletSecretFor(key.secretHex, fed);
      const pendingMsatOf = async (c) => { try { return JSON.parse(await c.pendingOutputs()).reduce((t, x) => t + BigInt(x.amount_msat), 0n); } catch { return -1n; } };
      let rec = null, polls = 0;
      try {
        const r = await claimUnclaimed({ federation: fed, state, pendingOutputs: () => client.pendingOutputs(),
          balanceMsat: async () => { try { return await client.balanceMsat(); } catch { return 0; } },
          backup: async (at) => { const p = join(dir, `wallet-${f16}.pre-recover-${at.replace(/[:.]/g, '-')}.json`); copyFileSync(walletPath, p); return p; },
          recover: async () => { if (existsSync(recPath)) renameSync(recPath, `${recPath}.stale-${Date.now()}`); rec = await (await lockClient()).recover(invite, fed, secret, fileStore(recPath)); },
          // the recovery finishes in the background: poll the recovered store, and every fourth try reopen it from its file
          reopen: async () => {
            if (++polls % 4 === 0) { try { await rec.close(); } catch { /* closed */ } rec = await (await lockClient()).join(invite, fed, secret, fileStore(recPath)); }
            let b = 0n; try { b = BigInt(await rec.balanceMsat()); } catch { b = 0n; }
            return { balanceMsat: b, pendingMsat: await pendingMsatOf(rec) };
          },
          swap: async () => {
            const old = clientFor.forget(fed); if (old) { try { await (await old).close(); } catch { /* closed */ } }
            try { await rec.close(); } catch { /* closed */ }
            renameSync(recPath, walletPath);
            client = await clientFor(invite, fed, secret, fileStore(walletPath));
          },
          keepFailed: async (at) => { try { await rec.close(); } catch { /* closed */ } if (existsSync(recPath)) renameSync(recPath, join(dir, `wallet-${f16}.recovering-failed-${at.replace(/[:.]/g, '-')}.json`)); },
        });
        writeJson(statePath, state);
        if (r.step !== 'none') say({ step: `unclaimed: ${r.step}`, federation: f16, ...r });
      } catch (e) { say({ step: 'unclaimed: check failed', federation: f16, why: e.message }); }
    }
    // NO LND, NO AUTOMATIC WITHDRAWAL: a client set up from the owner page keeps its e-cash until the owner withdraws it
    if (!cfg.lnd || cfg.autoWithdraw === false) {
      let balanceMsat; try { balanceMsat = await client.balanceMsat(); } catch { balanceMsat = 0; }
      state.balances[fed] = { msat: String(balanceMsat), at: new Date().toISOString() };
      writeJson(statePath, state);
      continue;
    }
    const w = await withdrawToLnd({ client, lnd, minMsat: BigInt(cfg.minWithdrawMsat || 10000), memo: `blwp donations ${cfg.label}`, gateways: [...(cfg.gateways || []), ...namedGateways] });
    if (w.withdrawn !== false || w.state) {
      state.withdrawals.push({ at: new Date().toISOString(), federation: fed, msat: String(w.withdrawableMsat), state: w.state, gateway: w.gateway, preimage: w.preimage || null });
      writeJson(statePath, state);
    }
    let balanceMsat; try { balanceMsat = await client.balanceMsat(); } catch { balanceMsat = 0; }
    // WHAT THE NODE'S DASHBOARD SHOWS: this dev's balance per federation, kept beside the record
    state.balances[fed] = { msat: String(balanceMsat), at: new Date().toISOString() };
    writeJson(statePath, state);
    say({ step: 'withdraw', federation: fed.slice(0, 16), ...w, balanceMsat });
  }
  state.lastPass = { at: new Date().toISOString(), donations: got.total, unanswered: got.unanswered.length, seats: (cfg.seats || []).length };
  writeJson(statePath, state);
}

/**
 * THE OWNER'S WITHDRAWAL: the node leaves { id, invoice | lnAddress, msat?, federation? } in withdraw-request.json; it is
 * taken once (renamed), paid from one federation's wallet - the one named, else the one holding most - and answered in
 * state.requests (the newest 20), which the owner page reads.
 */
async function serveRequest() {
  const reqPath = join(dir, 'withdraw-request.json');
  if (!existsSync(reqPath)) return;
  const q = readJson(reqPath, null);
  renameSync(reqPath, join(dir, `withdraw-request.${Date.now()}.taken.json`));
  const state = readJson(statePath, { done: [], withdrawals: [] });
  state.requests = state.requests || [];
  const answer = (o) => {
    const row = { id: String((q && q.id) || ''), at: new Date().toISOString(), ...o };
    state.requests = [...state.requests.filter((r) => r.id !== row.id), row].slice(-20);
    writeJson(statePath, state);
    say({ step: 'owner withdrawal', ...row });
  };
  answer({ state: 'Paying' });
  try {
    const known = await invites();
    const feds = readdirSync(dir).filter((x) => /^wallet-[0-9a-f]{16}\.json$/.test(x)).map((x) => x.slice(7, 23))
      .map((f) => Object.keys(known).find((k) => k.startsWith(f))).filter(Boolean);
    let best = null;
    for (const fed of feds) {
      if (q.federation && !fed.startsWith(String(q.federation).toLowerCase())) continue;
      const client = await clientFor(known[fed], fed, walletSecretFor(key.secretHex, fed), fileStore(join(dir, `wallet-${fed.slice(0, 16)}.json`)));
      let can; try { can = BigInt(await client.withdrawableMsat()); } catch { can = 0n; }
      if (!best || can > best.can) best = { fed, client, can };
    }
    if (!best) return answer({ state: 'Refused', why: q.federation ? `this client holds no wallet in federation ${q.federation}` : 'this client holds no wallet yet' });
    let invoice = q.invoice;
    if (!invoice) {
      const msat = q.msat ? BigInt(q.msat) : best.can - (best.can % 1000n);
      if (msat <= 0n) return answer({ state: 'Refused', federation: best.fed, why: 'nothing to withdraw' });
      invoice = await lightningAddressInvoice(q.lnAddress, msat);
    }
    const w = await payInvoice({ client: best.client, invoice, gateways: [...(cfg.gateways || []), ...namedGateways] });
    if (w.paid || (w.state && w.state !== 'Refused')) {
      state.withdrawals.push({ at: new Date().toISOString(), federation: best.fed, msat: String(w.msat), state: w.state, gateway: w.gateway, preimage: w.preimage || null,
        to: q.lnAddress || `invoice ${String(invoice).slice(0, 24)}…`, byOwner: true });
    }
    let balanceMsat; try { balanceMsat = await best.client.balanceMsat(); } catch { balanceMsat = 0; }
    state.balances = state.balances || {};
    state.balances[best.fed] = { msat: String(balanceMsat), at: new Date().toISOString() };
    answer({ state: w.state, paid: !!w.paid, federation: best.fed, msat: w.msat !== undefined ? String(w.msat) : String(invoiceMsat(invoice)),
      preimage: w.preimage || null, to: q.lnAddress || null, tried: w.tried || [], why: w.why || null });
  } catch (e) { answer({ state: 'Failed', why: e.message }); }
}

if (cmd === 'status') {
  const got = await gatherDonations({ recipientPkHex: cfg.recipientPkHex, seats: cfg.seats });
  const state = readJson(statePath, { done: [], withdrawals: [] });
  say({ label: cfg.label, recipientPk: cfg.recipientPkHex, donations: got.total, unanswered: got.unanswered, recorded: readRecord(join(dir, 'donations.jsonl')).length,
    federations: Object.fromEntries([...got.byFederation].map(([f, ds]) => [f.slice(0, 16), { donations: ds.length, msat: String(ds.reduce((t, d) => t + BigInt(d.amountMsat), 0n)),
      redeemed: ds.filter((d) => state.done.includes(d.outpoint)).length }])), withdrawals: state.withdrawals.slice(-5) });
  process.exit(0);
}
// AN E-CASH STRING INTO THIS DEV'S OWN WALLET: the receive whose claim a test can strand (the throwaway federation T's
// armed guardians, tools/fedimint-test-reject-armed.patch); the passes then note, back up and recover what stays unclaimed, as for a
// donation's redeem (claimUnclaimed). Without an e-cash string it only opens the wallet: the passes look at every federation this
// dev holds a wallet file for.
if (cmd === 'receive-ecash') {
  const [fedPrefix, ecash] = rest.filter((x) => !x.startsWith('--'));
  const known = await invites();
  const fed = Object.keys(known).find((k) => k.startsWith(String(fedPrefix || '').toLowerCase()));
  if (!fed) { console.error('arena-donor receive-ecash <dir> <federation id or its prefix> [<e-cash>]: no invite to that federation is known'); process.exit(2); }
  const client = await clientFor(known[fed], fed, walletSecretFor(key.secretHex, fed), fileStore(join(dir, `wallet-${fed.slice(0, 16)}.json`)));
  const read = async () => { let b = null, p = null; try { b = String(await client.balanceMsat()); } catch (e) { b = e.message; } try { p = JSON.parse(await client.pendingOutputs()); } catch (e) { p = e.message; } return { balanceMsat: b, pending: p }; };
  const before = await read();
  let said = null;
  if (ecash) { try { said = await client.receiveEcash(ecash); } catch (e) { said = { error: String(e && e.message || e) }; } }
  say({ step: ecash ? 'receive-ecash' : 'wallet opened', federation: fed.slice(0, 16), before, said, after: await read() });
  process.exit(0);
}
// PAYOUTS TO KEYS FROM THIS WALLET (an in-game item's purchase): arena-donor pay-keys <dir> <federation> <payouts.json>
// [--wasm <pkg>] - the lock client's paySubmit (one transaction of pre-expired payout contracts, [{ pk, msat, image }]) and its
// acceptance read back output by output (lockAccepted); prints the txid, every output and the balance before and after
if (cmd === 'pay-keys') {
  const [fedPrefix, file] = rest.filter((x) => !x.startsWith('--'));
  if (flag('wasm', '')) cfg.wasmPkg = flag('wasm', '');
  const known = await invites();
  const fed = Object.keys(known).find((k) => k.startsWith(String(fedPrefix || '').toLowerCase()));
  if (!fed || !file) { console.error('arena-donor pay-keys <dir> <federation id or its prefix> <payouts.json> [--wasm <pkg>]'); process.exit(2); }
  const client = await clientFor(known[fed], fed, walletSecretFor(key.secretHex, fed), fileStore(join(dir, `wallet-${fed.slice(0, 16)}.json`)));
  if (typeof client.paySubmit !== 'function') { console.error(`the lock client at ${cfg.wasmPkg} has no paySubmit`); process.exit(2); }
  const before = String(await client.balanceMsat());
  const t0 = Date.now();
  const submitted = JSON.parse(await client.paySubmit(readFileSync(file, 'utf8')));
  const t1 = Date.now();
  const accepted = JSON.parse(await client.lockAccepted(JSON.stringify(submitted)));
  const t2 = Date.now();
  say({ step: 'paid to keys', federation: fed.slice(0, 16), txid: submitted.txid, submitMs: t1 - t0, acceptMs: t2 - t1, before,
    after: String(await client.balanceMsat()), outputs: (accepted.donations || []).map((d) => ({ outIdx: d.out_idx, pk: d.recipient_pk, msat: d.amount_msat, idsMatch: d.ids_match, stored: d.stored_contract_id })) });
  process.exit(0);
}
if (cmd === 'once') { await pass(); process.exit(0); }
if (cmd === 'loop') {
  for (;;) {
    try { await pass(); } catch (e) { say({ step: 'pass failed', why: e.message }); }
    // the owner's withdrawal is taken within 5 s, between passes too
    const until = Date.now() + (cfg.intervalSec || 300) * 1000;
    while (Date.now() < until) {
      try { await serveRequest(); } catch (e) { say({ step: 'owner withdrawal failed', why: e.message }); }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
console.error(`no command ${cmd}`); process.exit(2);
