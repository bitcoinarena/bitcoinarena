#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FAUCET'S E-CASH WALLET (kanban #1381, Daniel 2026-11-09: "Das Ziel ist unter 3s fuer die 500"): a lock-client wallet in the players'
// federation that holds e-cash made ahead of time, so a new player's welcome is one reissue of ready notes - not an invoice, a Lightning
// payment through a gateway and a claim (three federation steps, measured 12-15 s from a new wallet's first click).
//
//   node tools/faucet-ecash.mjs balance
//   node tools/faucet-ecash.mjs fund <sat>            an invoice through GATEWAY, paid by the faucet's payer, awaited until claimed
//   node tools/faucet-ecash.mjs mint <count> <msat>   <count> e-cash strings of exactly <msat>, one file each in POOL/<federation>/
//   node tools/faucet-ecash.mjs keep <count> <msat> <fundSat>   runs on: keeps <count> notes of <msat> ready, funds <fundSat> when short
//
// ONE FILE PER NOTE (the faucet takes one by renaming it into taken/, so a note is never handed out twice and a mint never races a take).
// ECASH_DIR the wallet's directory (seed.hex, wallet.json); INVITE_FILE the federation's invite; WASM_PKG the lock client build
// (blwp_lock_client.js + _bg.wasm); GATEWAY a gateway URL the federation lists; FAUCET_LNCLI and PAYER (<lnddir>|<rpc>) the payer;
// POOL the pool directory (default ECASH_DIR/pool); the faucet reads it as FAUCET_ECASH_POOL.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const env = process.env;
const DIR = env.ECASH_DIR;
for (const k of ['ECASH_DIR', 'INVITE_FILE', 'WASM_PKG']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
mkdirSync(DIR, { recursive: true });
const POOL = env.POOL || join(DIR, 'pool');
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

// ONE WRITER PER WALLET (kanban #2337, state audit 2026-11-12): the wallet is read whole before the join (seconds live) and written whole at the
// end, so a second run that read it before another run's mint wrote its old copy over the minted state - the notes already in the pool were
// unspent again and the next mint handed them out a second time. Every run that may spend or receive (mint, fund, keep) holds the wallet's lock
// from before the read to its exit; a second one waits while a live pid holds it. `balance` takes no lock and never writes the wallet back.
// The lock is a chain of files wallet.lock.<n> made with O_EXCL (nothing is ever removed): the newest one is held while it names a live pid
// (an empty one for 5 s, while its maker writes it); 'free', or a dead pid, lets the next run make <n+1>.
const live = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function lockWallet() {
  let told = false;
  for (;;) {
    const gens = readdirSync(DIR).map((f) => /^wallet\.lock\.(\d+)$/.exec(f)).filter(Boolean).map((x) => Number(x[1]));
    const g = gens.length ? Math.max(...gens) : 0;
    if (g > 0) {
      const f = join(DIR, `wallet.lock.${g}`);
      let held = '', age = 0;
      try { held = readFileSync(f, 'utf8').trim(); age = Date.now() - statSync(f).mtimeMs; } catch {}
      const busy = held === '' ? age < 5000 : (held !== 'free' && /^\d+$/.test(held) && Number(held) !== process.pid && live(Number(held)));
      if (busy) {
        if (!told) { told = true; say({ step: 'waiting for the wallet', heldBy: held || 'starting' }); }
        await new Promise((ok) => setTimeout(ok, 200));
        continue;
      }
    }
    const mine = join(DIR, `wallet.lock.${g + 1}`);
    let fd;
    try { fd = openSync(mine, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    writeSync(fd, String(process.pid)); closeSync(fd);
    process.on('exit', () => { try { writeFileSync(mine, 'free'); } catch {} });
    return;
  }
}

export async function openWallet({ readOnly = false } = {}) {
  if (!readOnly) await lockWallet();
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `arena-lock-client-ecash-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const m = await import(esm);
  await m.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const file = join(DIR, 'wallet.json');
  const held = new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  let due = false;
  const write = () => { due = false; if (readOnly) return; const t = `${file}.tmp`; writeFileSync(t, JSON.stringify([...held]), { mode: 0o600 }); renameSync(t, file); };
  const later = () => { if (!due) { due = true; setImmediate(write); } };
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); later(); }, remove: (k) => { held.delete(k); later(); } };
  const seedFile = join(DIR, 'seed.hex');
  if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
  const fed = String(m.LockClient.federationIdOf(invite)).toLowerCase();
  const t0 = Date.now();
  const lc = await m.LockClient.join(invite, fed, readFileSync(seedFile, 'utf8').trim(), store);
  return { lc, fed, openMs: Date.now() - t0, flush: write };
}

const lncli = (args) => new Promise((ok) => {
  const [dir, rpc] = String(env.PAYER || '').split('|');
  execFile(env.FAUCET_LNCLI, [`--lnddir=${dir}`, '--network=testnet4', `--rpcserver=${rpc}`, ...args], { timeout: 90000 }, (e, out, err) => ok({ ok: !e, out: String(out), err: String(err) }));
});

const [cmd, a1, a2, a3] = process.argv.slice(2);
const { lc, fed, openMs, flush } = await openWallet({ readOnly: cmd === 'balance' });
say({ step: 'wallet open', federation: fed.slice(0, 16), ms: openMs, balanceMsat: String(await lc.balanceMsat()) });
const shelf = join(POOL, fed);
mkdirSync(shelf, { recursive: true, mode: 0o700 });
const ready = (msat) => readdirSync(shelf).filter((f) => f.startsWith(`${msat}-`) && f.endsWith('.json')).length;
async function fund(sat) {
  for (const k of ['GATEWAY', 'FAUCET_LNCLI', 'PAYER']) if (!env[k]) throw new Error(`${k} is needed`);
  const r = JSON.parse(await lc.receive(String(BigInt(sat) * 1000n), env.GATEWAY));
  const paid = await lncli(['payinvoice', '--force', '--fee_limit=50', r.invoice]);
  say({ step: 'paid', ok: /SUCCEEDED/.test(paid.out), out: (paid.out + paid.err).trim().slice(-160) });
  say({ step: 'receive', final: await lc.awaitReceive(r.operation), balanceMsat: String(await lc.balanceMsat()) });
}
async function mint(msat) {
  const t0 = Date.now();
  const got = JSON.parse(await lc.sendEcash(String(msat)));
  const name = `${got.msat}-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  writeFileSync(join(shelf, `.${name}.tmp`), JSON.stringify({ msat: got.msat, ecash: got.ecash, federation: fed, madeMs: Date.now() }), { mode: 0o600 });
  renameSync(join(shelf, `.${name}.tmp`), join(shelf, name));
  flush();
  say({ step: 'minted', msat: got.msat, ms: Date.now() - t0, ready: ready(got.msat) });
}
if (cmd === 'fund') await fund(a1);
else if (cmd === 'mint') { for (let i = 0; i < Number(a1); i++) await mint(BigInt(a2)); }
else if (cmd === 'keep') {
  const want = Number(a1), msat = BigInt(a2), fundSat = Number(a3 || 0);
  for (;;) {
    try {
      if (ready(msat) < want) {
        if (BigInt(await lc.balanceMsat()) < msat + 10000n) { if (fundSat > 0) await fund(fundSat); else say({ step: 'short', balanceMsat: String(await lc.balanceMsat()) }); }
        if (BigInt(await lc.balanceMsat()) >= msat + 10000n) { await mint(msat); continue; }
      }
    } catch (e) { say({ step: 'error', why: String(e && e.message ? e.message : e).slice(0, 200) }); }
    await new Promise((ok) => setTimeout(ok, 20000));
  }
} else if (cmd !== 'balance') { console.error('balance | fund <sat> | mint <count> <msat> | keep <count> <msat> <fundSat>'); process.exit(2); }
say({ step: 'balance', balanceMsat: String(await lc.balanceMsat()) });
flush();
await new Promise((ok) => setTimeout(ok, 500));
process.exit(0);
