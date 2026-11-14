// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT EVERY E2E FLOW IS HANDED (kanban #2642): the devnet (its nodes, chain, control door), the page, a Chrome, and the way to say
// "this flow cannot be driven here" (Skip) instead of faking a pass.
//
// A flow module (e2e/flows/<area>.mjs) exports `flows`: [{ id, area, title, money (0 none, 1 reads money, 2 moves money),
// reach (0..3, how many users touch it), needs: ['devnet'|'chrome'|'liquidity'|'faucet'], timeoutMs, run: async (ctx) => evidence }].
// `run` answers an evidence object (what was measured), throws an Error for a fail, or throws new Skip(why) when it cannot be driven.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export class Skip extends Error { constructor(why) { super(why); this.skip = true; } }
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const req = createRequire(process.env.E2E_DEPS ? `${process.env.E2E_DEPS}/` : import.meta.url);

/** Throws when `cond` is false, with what was expected and what was seen. */
export function check(cond, what, seen) {
  if (!cond) throw new Error(`${what}${seen !== undefined ? ` (seen: ${typeof seen === 'string' ? seen.slice(0, 400) : JSON.stringify(seen, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 400)})` : ''}`);
}

/** JSON from a URL, or throws with the status and the body's start. */
export async function getJson(url, { ms = 15000, headers = {} } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`${url}: ${r.status} ${t.slice(0, 200)}`); e.status = r.status; e.body = t; throw e; }
  try { return JSON.parse(t); } catch { return t; }
}
export async function post(url, body, { ms = 30000, headers = {}, raw = false } = {}) {
  const r = await fetch(url, { method: 'POST', headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
    body: raw ? body : JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? String(v) : v)), signal: AbortSignal.timeout(ms) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, ok: r.ok, body: j };
}

/** The devnet's handles, read from its own directory (devnet.mjs up wrote them). */
export function devnetOf({ dir, base, btcBin, lndBin, fedBin }) {
  const b = Number(base);
  const nodes = Array.from({ length: 7 }, (_, k) => `http://127.0.0.1:${b + 100 + 10 * k}`);
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${b + 1}`];
  const cli = (...a) => execFileSync(join(btcBin, 'bitcoin-cli'), [...btcArgs, ...(['getblockcount', 'getblockchaininfo', 'getblockhash', 'getblock', 'getrawtransaction', 'getrawmempool'].includes(a[0]) ? [] : ['-rpcwallet=devnet']), ...a],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const lnd = { a: b + 10, b: b + 20, c: b + 50 };
  const lncli = (x, ...a) => {
    const r = spawnSync(join(lndBin, 'lncli'), [`--lnddir=${join(dir, `lnd-${x}`)}`, `--rpcserver=127.0.0.1:${lnd[x]}`, '--network=regtest', ...a], { encoding: 'utf8', timeout: 90000 });
    if (r.status !== 0) throw new Error(`lncli ${x} ${a[0]}: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
    try { return JSON.parse(r.stdout); } catch { return r.stdout; }
  };
  const state = () => { try { return JSON.parse(readFileSync(join(dir, 'runner', 'state.json'), 'utf8')); } catch { return null; } };
  const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
  return { dir, base: b, nodes, cli, lncli, mine, state, control: `http://127.0.0.1:${b + 5}`, lnurl: `http://127.0.0.1:${b + 8}`,
    rpcUrl: `http://127.0.0.1:${b + 1}`, cookie: join(dir, 'btc', 'regtest', '.cookie'), fedBin, btcBin, lndBin,
    gateways: [`http://127.0.0.1:${b + 30}`, `http://127.0.0.1:${b + 40}`] };
}

/** A fresh directory for one flow's evidence (screenshots, logs). */
export function flowDir(out, id) { const d = join(out, 'flows', id.replace(/[^a-z0-9._-]/gi, '_')); mkdirSync(d, { recursive: true }); return d; }
export const has = (p) => existsSync(p);
