// HOW OFTEN DOES `Client.at` REFUSE, AND WHY (M3.3-27) - a probe, not a rehearsal.
//
// The regtest rehearsal stopped before play in 4 of 13 runs: `Client.at`
// refused in 9 ms, "only 1 of 2 providers gave a chain", while each daemon's
// /headers answered 200 straight after. A rehearsal takes minutes and meets the
// flake about one run in four, so this stands up only what `Client.at` touches
// - its own bitcoind and the two daemons of `standUpRound`, no lnd, a free
// round - and asks it N times with mixed idle gaps, some near the 5 s an idle
// keep-alive socket lives. Every refusal is printed with each provider's own
// words, how long that origin had been idle, and the tip it answered straight
// after. Nothing here changes what `Client.at` does.
//
//   node tools/client-at-probe.mjs [--calls=50]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from './round-2of2.mjs';
import { watchSockets } from './socket-watch.mjs';
const sockets = watchSockets();
import { bitcoindRpc } from '../src/chain-rpc.js';
import { Client } from '../../blwp-client/src/client.js';
import { joinFromQuery } from '../../blwp-client/src/join.js';
import { fromHex } from '../../protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const CALLS = Number((process.argv.find((a) => a.startsWith('--calls=')) || '--calls=50').split('=')[1]);
// --block=MS: before each ask, hold the event loop SYNCHRONOUSLY for MS ms -
// what a replay or an execFileSync does - instead of sleeping.
const BLOCK = Number((process.argv.find((a) => a.startsWith('--block=')) || '--block=0').split('=')[1]);
const P = { rpc: 29951, p2p: 29952, daemonA: 18751, daemonB: 18752 };   // not 8080: signal-cli
const say = (s) => console.log(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const sh = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function until(what, check, ms = 120000, every = 500) {
  const stop = Date.now() + ms;
  for (;;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what}`);
    await wait(every);
  }
}

// EVERY FETCH IN THIS PROCESS, TIMED PER ORIGIN - the client's own included,
// because `headersOverHttp` reads the global fetch when it is called.
const lastFetch = new Map();
// HOW LONG THE EVENT LOOP WAS HELD SINCE THE LAST FETCH, from a 100 ms tick:
// the longest gap between ticks, and the gap still open now - a hold that has
// just ended has not yet let a tick run, so it shows only as the open gap.
let lastTick = Date.now();
let longestGap = 0;
setInterval(() => { const t = Date.now(); longestGap = Math.max(longestGap, t - lastTick); lastTick = t; }, 100).unref();
const stallMs = () => Math.max(longestGap, Date.now() - lastTick);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const origin = new URL(String(url)).origin;
  try { return await realFetch(url, opts); } finally { lastFetch.set(origin, Date.now()); longestGap = 0; lastTick = Date.now(); }
};
const idleOf = (base) => {
  const at = lastFetch.get(new URL(base).origin);
  return at === undefined ? 'never fetched' : `idle ${Date.now() - at} ms`;
};
const tipOf = (b) => (b.length >= 80
  ? Buffer.from(createHash('sha256').update(createHash('sha256').update(b.subarray(b.length - 80)).digest()).digest())
    .reverse().toString('hex').slice(0, 16)
  : 'none');

// MIXED GAPS, idle time before each ask: a burst, the seconds up to the
// keep-alive edge, the edge itself, and past it.
const GAPS = [0, 0, 10, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 3800, 3900, 3950,
  4000, 4050, 4100, 4200, 4500, 4800, 4900, 4950, 4990, 5000, 5010, 5050, 5100, 5200, 5500,
  6000, 7000, 0, 4000, 5000, 100, 3990, 4010, 4995, 5005, 2000, 4900, 5100, 4000, 5000,
  50, 4050, 3950, 6000, 10000];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'client-at-probe-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]).trim();
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  let round = null;
  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'blwp'); } catch { cli('loadwallet', 'blwp'); }
    cli('generatetoaddress', '250', cli('getnewaddress'));

    const rpc = bitcoindRpc({ url: `http://127.0.0.1:${P.rpc}/`, cookiePath: cookie });
    round = await standUpRound({ host: '127.0.0.1', portA: P.daemonA, portB: P.daemonB,
      rpc, cli, stakeMsat: 0n, page: 'http://127.0.0.1:1' });
    sockets.watchServer('A', round.a.http);
    sockets.watchServer('B', round.b.http);
    const named = await joinFromQuery(new URL(round.url).search);
    say(`round ${round.id.slice(0, 16)} on ${named.nodes.join(' ')}; ${CALLS} asks follow${BLOCK ? `, each after the loop is held ${BLOCK} ms` : ''}`);

    const reasons = new Map();
    let refused = 0;
    for (let i = 0; i < CALLS; i++) {
      const gap = BLOCK > 0 ? BLOCK : GAPS[i % GAPS.length];
      if (BLOCK > 0) { const end = Date.now() + BLOCK; while (Date.now() < end) { /* held */ } }
      else await wait(gap);
      const idle = named.nodes.map((b) => `${new URL(b).port} ${idleOf(b)}`).join(', ')
        + `, loop stalled up to ${stallMs()} ms`;
      const t0 = Date.now();
      try {
        await Client.at({
          headers: named.chain.headers, bonds: named.chain.bonds,
          signedAdvert: fromHex(named.advert.signedAdvert), committee: named.round.nodes, nodes: named.nodes,
        }, {
          core: { hash: (st) => core.hash(st) }, sign: (id) => ed25519.sign(id, ed25519.utils.randomSecretKey()),
          verify, contract: named.round, roundIdGiven: fromHex(round.id),
        });
        say(`  ${String(i + 1).padStart(2)} gap ${String(gap).padStart(5)} ms  ok       ${Date.now() - t0} ms   [${idle}]`);
      } catch (e) {
        refused++;
        const took = Date.now() - t0;
        say(`  ${String(i + 1).padStart(2)} gap ${String(gap).padStart(5)} ms  REFUSED  ${took} ms   [${idle}]`);
        say(`       ${e.message}`);
        for (const f of sockets.report(t0)) say(`       socket: ${JSON.stringify(f)}`);
        const key = (e.refused || e.message).replace(/[0-9a-f]{16,}/g, '<hash>').replace(/\d+ ms/g, 'N ms');
        reasons.set(key, (reasons.get(key) || 0) + 1);
        for (const base of named.nodes) {
          const t1 = Date.now();
          try {
            const r = await fetch(`${base}/headers`);
            const b = new Uint8Array(await r.arrayBuffer());
            say(`       straight after: ${base}/headers -> ${r.status}, ${b.length / 80} headers, tip ${tipOf(b)}, ${Date.now() - t1} ms`);
          } catch (f) { say(`       straight after: ${base}/headers -> ${f.message}${f.cause ? `: ${f.cause.code || ''} ${f.cause.message || ''}` : ''}`); }
        }
      }
    }
    say(`\n${refused} of ${CALLS} refused`);
    for (const [why, n] of reasons) say(`  ${n} x ${why}`);
  } catch (e) {
    say(`\nTHE PROBE STOPPED: ${e.stack || e.message}`);
  } finally {
    if (round) { try { await round.close(); } catch { /* gone */ } }
    try { cli('stop'); } catch { /* gone */ }
    setTimeout(() => process.exit(0), 2000);
  }
}

await main();
