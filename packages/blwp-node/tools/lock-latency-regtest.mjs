#!/usr/bin/env node
/**
 * HOW LONG A STAKE LOCK TAKES TO BE ACCEPTED BY THE FEDERATION (kanban #178, plan comment 327, Go 2026-10-05: "under 200 ms").
 *
 * The page's own wasm lock client (WASM_PKG), joined to the federation by its invite, funded through one of its gateways
 * (PAYER pays the deposit invoice), then COUNT stake locks, each:
 *   START  lockSubmit has handed the lock transaction to the guardians (its promise resolves)
 *   STOP   lockAccepted's await_tx_accepted resolves - the federation's consensus accepted it (a threshold of guardians)
 * both on this process's one clock (performance.now). A lock not accepted within 10 s is a failure, never skipped.
 * Each lock: { submitMs (the hand-over), acceptMs (submitted -> accepted) }; the summary: p50, p95, max of acceptMs and
 * PASS only if every acceptMs < LIMIT_MS (200). Exit 1 when it does not pass.
 *
 *   INVITE_FILE=… WASM_PKG=… LNCLI=… PAYER_DIR=… PAYER_RPC=… [BLWP_TN4_NETWORK=regtest] [COUNT=20] [AMOUNT_MSAT=10000]
 *     node tools/lock-latency-regtest.mjs
 * Nothing here names a live chain: the federation is the one the invite names, the payer the lnd named.
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toHex } from '../../protocol/src/hash.js';

const env = process.env;
for (const k of ['INVITE_FILE', 'WASM_PKG', 'LNCLI', 'PAYER_DIR', 'PAYER_RPC']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const COUNT = Number(env.COUNT || 20), AMOUNT = BigInt(env.AMOUNT_MSAT || 10000), LIMIT_MS = Number(env.LIMIT_MS || 200), WAIT_MS = 10000;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.BLWP_TN4_NETWORK || 'testnet4'}`, ...a]);
const key = () => toHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer within ${ms} ms`)), ms))]);
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `blwp-lock-client-latency-${process.pid}.mjs`);
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasm = await import(esm);
await wasm.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const held = new Map();
const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const lc = await wasm.LockClient.join(invite, wasm.LockClient.federationIdOf(invite), toHex(new Uint8Array(randomBytes(32))), store);
say({ step: 'joined' });

// FUNDED THROUGH A GATEWAY: every lock's amount, and room for the federation's fees
const deposit = AMOUNT * BigInt(COUNT) + 400000n;
const rcv = JSON.parse(await lc.receive(String(deposit), ''));
const paid = await payer('payinvoice', '--force', rcv.invoice);
const final = await within(lc.awaitReceive(rcv.operation), 120000, 'the deposit');
say({ step: 'funded', msat: deposit, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, balanceMsat: await lc.balanceMsat() });

const locks = [];
for (let i = 0; i < COUNT; i++) {
  const t0 = performance.now();
  let submitted = null, t1 = null, t2 = null, why = null;
  try {
    submitted = JSON.parse(await within(lc.lockSubmit(key(), String(AMOUNT), '', '0', key(), key(), 150, '[]'), WAIT_MS, 'the hand-over'));
    t1 = performance.now();
    await within(lc.lockAccepted(JSON.stringify(submitted)), WAIT_MS, 'the federation\'s acceptance');
    t2 = performance.now();
  } catch (e) { why = String(e && e.message ? e.message : e).slice(0, 200); }
  // the wall clock beside each instant, to set against the guardians' own logs (their "Transaction accepted" lines)
  const wall = (t) => (t === null ? null : Math.round(performance.timeOrigin + t));
  const lock = { i, txid: submitted ? String(submitted.txid) : null, startAt: wall(t0), submittedAt: wall(t1), acceptedAt: wall(t2),
    submitMs: t1 === null ? null : Math.round(t1 - t0),
    acceptMs: t2 === null ? null : Math.round(t2 - t1), why };
  locks.push(lock);
  say({ step: 'lock', ...lock });
}
const accepted = locks.filter((l) => l.acceptMs !== null).map((l) => l.acceptMs);
const missing = locks.filter((l) => l.acceptMs === null).length;
const over = accepted.filter((ms) => ms >= LIMIT_MS).length;
const pass = missing === 0 && over === 0;
say({ step: 'summary', count: COUNT, limitMs: LIMIT_MS, accepted: accepted.length, missing, over,
  acceptMs: accepted.length ? { p50: pct(accepted, 0.5), p95: pct(accepted, 0.95), max: Math.max(...accepted), min: Math.min(...accepted) } : null,
  submitMs: { p50: pct(locks.filter((l) => l.submitMs !== null).map((l) => l.submitMs), 0.5) }, pass });
process.exit(pass ? 0 : 1);
