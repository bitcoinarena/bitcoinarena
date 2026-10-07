// HOW OLD ANOTHER PLAYER'S TRUCK IS WHEN IT REACHES MY PAGE (the owner 2026-09-17 19:15: "updates only every 300-600 ms").
//
//     node tools/measure-ghost-lag.mjs [--seconds=10] [--delay=0,40,80] [--node-ms=0]
//
// A real daemon behind a TCP proxy that holds every chunk `delay` ms each way (the page's link to a signer node), a DRIVER
// client stepping the page's own cadence - a tick recorded every 1/60 s and `drain()` on every sixth, as blwp.jslib does -
// and a WATCHER client subscribed to the round through its own proxied socket. For each picture of the driver the watcher
// receives: its age, the watcher's wall clock less the wall clock the driver recorded that tick at, and the gap since the
// previous picture. `--node-ms` holds the daemon's answer to every batch that long (a busy signer node).
import net from 'node:net';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../core/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { assumeStakeSeen } from '../../blwp-node/test/assignment.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';
import { Client } from '../src/client.js';
import { watchGhosts } from '../src/ghost-field.js';
import { NEXTBLOCK } from '../../core/plugin/nextblock.js';
import { NEXTBLOCK_GAME_ID } from '../../core/plugin/nextblock.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SECONDS = Number(arg('seconds', 10));
const DELAYS = arg('delay', '0,40,80').split(',').map(Number);
const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BEACON = b32(0xbe);

/** A TCP proxy to `port` that holds every chunk `ms` in each direction, order kept. */
function slowLink(port, ms) {
  const server = net.createServer((a) => {
    const b = net.connect(port, '127.0.0.1');
    const hold = (from, to) => from.on('data', (d) => setTimeout(() => { if (!to.destroyed) to.write(d); }, ms));
    hold(a, b); hold(b, a);
    const end = () => { a.destroy(); b.destroy(); };
    a.on('error', end); b.on('error', end); a.on('close', end); b.on('close', end);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];

async function once(delay) {
  const node = await serve(openStore(), { plugins: [NEXTBLOCK], port: 0, funded: () => true,
    randomnessFor: () => ({ hash: BEACON, height: 900005, timeMs: 900n }) });
  const link = await slowLink(node.port, delay);
  const base = `http://127.0.0.1:${link.port}`;
  const driver = new Client({ base, core, sign, verify });
  const watcher = new Client({ base, core, sign, verify });
  const c = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
    // A FREE ROUND: this measures ghost lag, and money is nothing to it. FEDERATION, because the custody
    // field has one value (§23.6, RULED 2026-09-22 22:59); a free round names no federation.
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [],
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [node.round.pubkey],
  };
  const rid = await driver.openRound(c);
  const entry = (player) => ({
    roundId: rid, playerPubkey: b32(player), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 0n, feeMsat: entryFeeMsat(0n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(player + 0x50), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  });
  const de = entry(5), we = entry(9);
  const deid = await driver.join(de); assumeStakeSeen(node.round, de);
  const weid = await watcher.join(we); assumeStakeSeen(node.round, we);
  await driver.connect(); driver.setRound({ roundId: rid, entryId: deid, blockTicks: c.blockTicks });
  await watcher.connect(); watcher.setRound({ roundId: rid, entryId: weid, blockTicks: c.blockTicks });
  const field = watchGhosts(watcher, { roundId: rid, entryId: weid });
  await field.watching;

  const recordedAt = [];
  const got = [];
  const was = watcher.onGhost;
  watcher.onGhost = (g) => { if (toHex(g.entryId) === toHex(deid)) got.push([performance.now(), g.tick]); was(g); };

  // THE PAGE'S CADENCE: one tick every 1/60 s on the wall clock (several in one timer when it runs late, as FixedUpdate
  // catches up), `drain()` on every sixth.
  const t0 = performance.now();
  let tick = 0;
  while (performance.now() - t0 < SECONDS * 1000) {
    const due = Math.floor((performance.now() - t0) / (1000 / 60));
    while (tick <= due) {
      recordedAt[tick] = performance.now();
      driver.record([45875, ((tick * 977) % 30000) - 15000, 0, 0, 0]);
      tick++;
      if (tick % 6 === 0) driver.drain();
    }
    await wait(4);
  }
  await wait(300 + 3 * delay);
  const ages = [], gaps = [];
  got.forEach(([at, t], i) => { ages.push(at - recordedAt[t]); if (i) gaps.push(at - got[i - 1][0]); });
  ages.sort((a, b) => a - b); gaps.sort((a, b) => a - b);
  const f = (x) => (x === undefined ? '-' : x.toFixed(0));
  console.log(`delay ${delay} ms each way: ${got.length} pictures in ${SECONDS} s (${(got.length / SECONDS).toFixed(1)}/s), `
    + `${driver.batchesSent} batches; age ms median ${f(pct(ages, 0.5))} p90 ${f(pct(ages, 0.9))} max ${f(ages[ages.length - 1])}; `
    + `gap between pictures ms median ${f(pct(gaps, 0.5))} p90 ${f(pct(gaps, 0.9))} max ${f(gaps[gaps.length - 1])}`);
  driver.ended = true; watcher.ended = true;
  try { driver.sock && driver.sock.close(); watcher.sock && watcher.sock.close(); } catch { /* closing */ }
  link.server.close();
  await node.close();
}

for (const d of DELAYS) await once(d);
process.exit(0);
