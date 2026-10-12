#!/usr/bin/env node
/**
 * DEPOSITS THROUGH ANY LISTED GATEWAY, MEASURED LIVE (kanban #319, §23.1 / 23.6) - the page's own functions without a browser:
 * a player wallet in the round's federation reads the gateways the guardians list (federationGateways), then
 *   1. a deposit through NAMED (one gateway, first in the order) - its invoice paid by the payer lnd, its end awaited;
 *   2. the same with DOWN_CMD run first (it makes NAMED unreachable): invoiceThroughGateways passes it over after 10 s
 *      (GATEWAY_INVOICE_MS) and the next gateway in the order makes the invoice; paid and awaited the same way.
 * UP_CMD runs at the end (and on a failure).
 *
 *   ROUND_FILE=<contract bytes> INVITE=<file> WASM_PKG=<dir> PAYER=<command that runs lncli> NAMED=<gateway url>
 *   DOWN_CMD=<sh> UP_CMD=<sh> [DEPOSIT_MSAT=20000] node tools/gateway-failover-live.mjs
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { playerWallet, federationGateways, gatewayOrder, invoiceThroughGateways, GATEWAY_INVOICE_MS } from '../../arena-client/src/page-lock.js';

const env = process.env;
for (const k of ['ROUND_FILE', 'INVITE', 'WASM_PKG', 'PAYER', 'NAMED', 'DOWN_CMD', 'UP_CMD']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const pay = (invoice) => new Promise((done) => execFile('/bin/sh', ['-c', `${env.PAYER} payinvoice --force --timeout 120s ${invoice}`], { timeout: 180000 },
  (err, out, errOut) => done((String(out).match(/Payment status: [A-Z_]+/) || [String(errOut || (err && err.message) || '').slice(0, 160)])[0])));
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', timeout: 60000 }).trim().slice(0, 200); } catch (e) { return `failed: ${String(e.message).slice(0, 160)}`; } };
let code = 0;
try {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasm = await import(esm);
  await wasm.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const kept = new Map();
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k),
    get length() { return kept.size; }, key: (i) => [...kept.keys()][i] ?? null };
  const c = decodeRoundContract(new Uint8Array(readFileSync(env.ROUND_FILE)));
  const round = { ...c, id: roundId(c) };
  const t0 = Date.now();
  const w = await playerWallet({ round, invite: readFileSync(env.INVITE, 'utf8').trim(), seed: new Uint8Array(randomBytes(32)), LockClient: wasm.LockClient, storage });
  const listed = await federationGateways(w);
  const named = env.NAMED.split(',').map((u) => u.trim()).filter(Boolean);
  const order = gatewayOrder(named, listed);
  log({ step: 'wallet', ms: Date.now() - t0, listed, order });
  const amount = BigInt(env.DEPOSIT_MSAT || 20000);
  const deposit = async (label) => {
    const t = Date.now();
    const got = await invoiceThroughGateways(w, amount, order);
    const invoiceMs = Date.now() - t;
    const paid = await pay(got.invoice);
    const final = await w.awaitReceive(got.operation);
    const out = { step: label, gateway: got.gateway, tried: got.tried, invoiceMs, paid, final, totalMs: Date.now() - t, balanceMsat: String(await w.balanceMsat()) };
    log(out);
    return out;
  };
  const a = await deposit('deposit, every gateway up');
  log({ step: 'down', gateway: named[0], said: sh(env.DOWN_CMD) });
  await new Promise((r) => setTimeout(r, 5000));
  const b = await deposit('deposit, the named gateway down');
  const passed = b.tried.length >= 1 && b.tried[0].gateway === named[0] && b.tried[0].ms >= GATEWAY_INVOICE_MS - 500 && b.gateway !== named[0];
  log({ step: 'summary', upThrough: a.gateway, upFinal: a.final, downThrough: b.gateway, downFinal: b.final, passedOverMs: b.tried[0] && b.tried[0].ms, failedOver: passed });
  if (a.final !== 'Claimed' || b.final !== 'Claimed' || !passed) code = 1;
} catch (e) { code = 1; log({ step: 'stopped', why: String(e.stack || e.message).slice(0, 500) }); }
log({ step: 'up', said: sh(env.UP_CMD) });
process.exit(code);
