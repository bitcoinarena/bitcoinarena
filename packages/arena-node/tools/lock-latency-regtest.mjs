#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * HOW LONG A STAKE LOCK TAKES TO BE ACCEPTED BY THE FEDERATION (plan comment 327, Go 2026-10-05: "under 200 ms").
 *
 * The page's own wasm lock client (WASM_PKG), joined to the federation by its invite, funded through one of its gateways
 * (PAYER pays the deposit invoice), then COUNT stake locks, each:
 *   START  lockSubmit has handed the lock transaction to the guardians (its promise resolves)
 *   STOP   lockAccepted's await_tx_accepted resolves - the federation's consensus accepted it (a threshold of guardians)
 * both on this process's one clock (performance.now). A lock not accepted within 10 s is a failure, never skipped.
 * Each lock: { submitMs (the hand-over), acceptMs (submitted -> accepted) }; the summary: p50, p95, max of acceptMs and
 * PASS only if every acceptMs < LIMIT_MS (200). Exit 1 when it does not pass.
 *
 *   INVITE_FILE=… WASM_PKG=… LNCLI=… PAYER_DIR=… PAYER_RPC=… [ARENA_TN4_NETWORK=regtest] [COUNT=20] [AMOUNT_MSAT=10000]
 *     node tools/lock-latency-regtest.mjs
 * Nothing here names a live chain: the federation is the one the invite names, the payer the lnd named.
 */
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
// ECASH_FILE: funded by e-cash notes of the federation (a fedimint-cli client's, from an on-chain peg-in) - no payer
for (const k of ['INVITE_FILE', 'WASM_PKG', ...(env.ECASH_FILE ? [] : ['LNCLI', 'PAYER_DIR', 'PAYER_RPC'])]) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const GAP_MS = Number(env.GAP_MS || 0), COUNT = Number(env.COUNT || 20), AMOUNT = BigInt(env.AMOUNT_MSAT || 10000), LIMIT_MS = Number(env.LIMIT_MS || 200), WAIT_MS = 10000;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
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

if (env.ECASH_FILE) {
  // FUNDED BY NOTES: the federation's own e-cash, handed over
  const got = JSON.parse(await within(lc.receiveEcash(readFileSync(env.ECASH_FILE, 'utf8').trim()), 120000, 'the notes'));
  say({ step: 'funded', by: 'ecash', got, balanceMsat: await lc.balanceMsat() });
} else {
// FUNDED THROUGH A GATEWAY: every lock's amount, and room for the federation's fees
const deposit = AMOUNT * BigInt(COUNT) + 400000n;
const rcv = JSON.parse(await lc.receive(String(deposit), ''));
const paid = await payer('payinvoice', '--force', rcv.invoice);
const final = await within(lc.awaitReceive(rcv.operation), 120000, 'the deposit');
say({ step: 'funded', msat: deposit, paid: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0], final, balanceMsat: await lc.balanceMsat() });
}

// THE LOBBY'S WAIT: the tweak queue full before the first lock (TWEAKS_BEFORE, default 200; 0 skips)
const TWEAKS_BEFORE = Number(env.TWEAKS_BEFORE ?? 200);
if (TWEAKS_BEFORE > 0 && typeof lc.tweaksReady === 'function') {
  const f0 = performance.now();
  while (lc.tweaksReady() < TWEAKS_BEFORE && performance.now() - f0 < 300000) await new Promise((r) => setTimeout(r, 250));
  say({ step: 'tweaks', ready: lc.tweaksReady(), wanted: TWEAKS_BEFORE, waitedMs: Math.round(performance.now() - f0) });
}
const locks = [];
const statusCalls = [];      // POLL_STATUS: how long each lockStatus (two threshold reads) took; negative when it threw
for (let i = 0; i < COUNT; i++) {
  // GAP_MS: idle time before each lock (a player locks once per join; the previous lock's change notes are finished by then)
  if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
  // the client's one thread: how long it was blocked during this lock (split)
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const t0 = performance.now();
  let submitted = null, t1 = null, t2 = null, why = null, statusMs = null, timing = null, acceptedWall = null, rawSeen = null, tickGaps = null, hookSeen = null;
  try {
    submitted = JSON.parse(await within(lc.lockSubmit(key(), String(AMOUNT), '', '0', key(), key(), 150, '[]'), WAIT_MS, 'the hand-over'));
    t1 = performance.now();
    // POLL_STATUS=1 (the split): beside lockAccepted, read the stake output's status every 25 ms - when the
    // guardians' stored answer is first readable by this client, set against when lockAccepted reports the acceptance
    let polled = null;
    const poll = env.POLL_STATUS === '1' ? (async () => {
      for (let k = 0; k < 400 && polled === null; k++) {
        const q0 = performance.now();
        try { const st = JSON.parse(await lc.lockStatus(String(submitted.txid), 0)); statusCalls.push(Math.round(performance.now() - q0)); if (st && st.stored) { polled = performance.now(); break; } } catch { statusCalls.push(-Math.round(performance.now() - q0)); }
        await new Promise((r) => setTimeout(r, 25));
      }
    })() : null;
    // step 1: the raw wasm promise's own settle time, and the longest gap of a 1 ms ticker while it is open
    let hook = null;
    // the hook at the answer: a microtask and a timer, each stamped - a late timer means the thread itself was busy
    globalThis.__blwp178 = (ms) => { const h = { returned: ms, hookAt: Date.now(), microAt: null, timerAt: null }; hook = h; queueMicrotask(() => { h.microAt = Date.now(); }); setTimeout(() => { h.timerAt = Date.now(); }, 0); };
    const rawP = lc.lockAccepted(JSON.stringify(submitted));
    let lastTick = Date.now(); const ticks = [];
    const ticker = setInterval(() => { const n = Date.now(); ticks.push([n, n - lastTick]); lastTick = n; }, 1);
    rawP.then(() => { rawSeen = Date.now(); }, () => {});
    const accRaw = await within(rawP, WAIT_MS, 'the federation\'s acceptance').finally(() => clearInterval(ticker));
    // STOP: the client knows - taken at once, before any probe below waits (a probe's wait once inflated this)
    t2 = performance.now();
    acceptedWall = Date.now();   // step 1: the same clock as the wasm's own marks
    tickGaps = ticks.filter(([, g]) => g >= 20).map(([n, g]) => [n, g]);
    if (hook && hook.timerAt === null) await new Promise((r) => setTimeout(r, 5));
    hookSeen = hook;
    const acc = JSON.parse(accRaw);
    timing = acc.timing || null;
    if (poll) { await within(poll, WAIT_MS, 'the status poll'); statusMs = polled === null ? null : Math.round(polled - t1); }
  } catch (e) { why = String(e && e.message ? e.message : e).slice(0, 200); }
  // the wall clock beside each instant, to set against the guardians' own logs (their "Transaction accepted" lines)
  const wall = (t) => (t === null ? null : Math.round(performance.timeOrigin + t));
  loop.disable();
  // the host's load beside the clocks (2026-10-05: the live seats, donors and tn4 guardians share this host)
  const pressure = (() => { try { return Number((readFileSync('/proc/pressure/cpu', 'utf8').match(/some avg10=([\d.]+)/) || [])[1]); } catch { return null; } })();
  const host = { load1: Math.round(loadavg()[0] * 10) / 10, cpuPressure10: pressure };
  const blockedMs = { max: Math.round(loop.max / 1e6), p50: Math.round(loop.percentile(50) / 1e6), mean: Math.round(loop.mean / 1e6) };
  const lock = { i, host, blockedMs, txid: submitted ? String(submitted.txid) : null, startAt: wall(t0), submittedAt: wall(t1), acceptedAt: wall(t2),
    submitMs: t1 === null ? null : Math.round(t1 - t0),
    acceptMs: t2 === null ? null : Math.round(t2 - t1), statusMs, submitTiming: submitted && submitted.timing ? submitted.timing : null, timing, acceptedWall, rawSeen, tickGaps, hookSeen, why };
  locks.push(lock);
  say({ step: 'lock', ...lock });
}
const accepted = locks.filter((l) => l.acceptMs !== null).map((l) => l.acceptMs);
const missing = locks.filter((l) => l.acceptMs === null).length;
const over = accepted.filter((ms) => ms >= LIMIT_MS).length;
const pass = missing === 0 && over === 0;
say({ step: 'summary', count: COUNT, limitMs: LIMIT_MS, accepted: accepted.length, missing, over,
  acceptMs: accepted.length ? { p50: pct(accepted, 0.5), p95: pct(accepted, 0.95), max: Math.max(...accepted), min: Math.min(...accepted) } : null,
  submitMs: { p50: pct(locks.filter((l) => l.submitMs !== null).map((l) => l.submitMs), 0.5) },
  ...(statusCalls.length ? { statusCallMs: { n: statusCalls.length, p50: pct(statusCalls.map(Math.abs), 0.5), p95: pct(statusCalls.map(Math.abs), 0.95), max: Math.max(...statusCalls.map(Math.abs)), threw: statusCalls.filter((x) => x < 0).length } } : {}), pass });
// THE LEFTOVER NOTES BACK: a run's lock client keeps its wallet in memory only - what the locks did not use is
// handed back to ECASH_FILE.back for the federation's own client to receive, not lost with the process
if (env.ECASH_FILE) {
  try { const back = JSON.parse(await within(lc.sendAllEcash(), 60000, 'the leftover notes'));
    if (back.ecash) writeFileSync(`${env.ECASH_FILE}.back`, back.ecash);
    say({ step: 'returned', msat: back.msat }); } catch (e) { say({ step: 'returned', error: String(e && e.message || e).slice(0, 200) }); }
}
process.exit(pass ? 0 : 1);
