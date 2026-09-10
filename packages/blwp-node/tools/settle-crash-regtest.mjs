// KILL A SEAT MID-SETTLEMENT, RESTART IT ON THE SAME STORE, AND COUNT THE SPENDS.
//
// "M3 is done when ... a node killed mid-settlement recovers to the right state
// on restart." Every restart measured before this was a fresh object over the
// same store inside one process (`settle-regtest.mjs`, `pool-settle.test.js`,
// `payout-pay.test.js`). This one is a real process: the seat that settles runs
// as a child on its own store file and its own port, is SIGKILLed at a named
// point, and is started again on that file and that port.
//
//   --point=1  after the table is signed and queued, before it settles
//   --point=2  after the spend is signed and written to disk, before it is sent
//   --point=3  after the spend is handed to bitcoind, before PAID is written
//   --point=4  a takeover: the round's asker is down, the next seat settles at
//              its turn and is killed with its spend on disk; afterwards the
//              original asker comes back too
//
// After each kill, two restarts of the killed seat on the same store and port:
//
//   (a) the real `src/main.js`, with BLWP_BITCOIND_URL and BLWP_BITCOIND_COOKIE
//       and nothing else - a real daemon's launch
//   (b) with the chain it spends on, the RPC its pool watch reads, and the
//       seat and pool key read back from its OWN store (`Dkg.seatFor`)
//
// Measured after each: spends of the pool output counted block by block and in
// the mempool, the winner's key balance against the table's own amount, every
// seat's payout row against the chain, and whether the spend that lands is the
// one written before the kill, byte for byte (no rival).
//
// Own datadir, non-default ports, cookie auth; touches no mainnet and no
// testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/settle-crash-regtest.mjs --point=2 [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Dkg } from '../src/dkg.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { chainBeacon } from '../src/beacon-source.js';
import { serve } from '../src/server.js';
import { askerOrder, PAYOUT_QUEUED, TAKEOVER_BLOCKS } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { poolOutput } from '../../protocol/src/pool.js';
import {
  encodeRoundContract, encodeEntryContract, decodeRoundContract, roundId, entryId,
} from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { regtest } from './regtest-bond.mjs';
import { deriveCensus } from '../../protocol/src/census.js';
import { bondSetFor } from '../src/curve.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const KEEP = process.argv.includes('--keep');
const POINT = Number(process.env.KILL_POINT
  || (process.argv.find((a) => a.startsWith('--point=')) || '--point=2').split('=')[1]);
// Each point on its own ports, so the four can run side by side.
const P = { rpc: 29697 + 10 * (POINT - 1), p2p: 29698 + 10 * (POINT - 1) };
const PORT0 = 18300 + 10 * (POINT - 1);            // daemon i listens on PORT0 + i
// The round's committee time: set by the parent from the chain's own clock,
// handed to each child as NOW_MS.
let NOW = Number(process.env.NOW_MS || 0);
const STAKE_MSAT = 1000000n;                       // a 1000-sat stake
const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const say = (s) => console.log(s);
const SELF = fileURLToPath(import.meta.url);
const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));

// ---------------------------------------------------------------- shared
const btcArgsFor = (dir) => ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cliFor = (dir) => (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgsFor(dir), ...a]);
function chainFor(cli) {
  return {
    async send(raw) {
      try { return { ok: true, txid: fromHex(cli('sendrawtransaction', toHex(raw))).reverse() }; }
      catch (e) {
        const said = (e.stderr || e.message).trim().split('\n').map((l) => l.trim())
          .filter((l) => l && !/^error code:/.test(l) && !/^error message:$/.test(l));
        return { ok: false, why: said.join(' ') || 'refused without saying why' };
      }
    },
    async look(txid) {
      try { cli('getrawtransaction', toHex(new Uint8Array(txid).reverse())); return { known: true }; }
      catch { return { known: false }; }
    },
  };
}
const rpcFor = (dir) => bitcoindRpc({
  url: `http://127.0.0.1:${P.rpc}/`, cookiePath: join(dir, 'btc', 'regtest', '.cookie'),
});

// ---------------------------------------------------------------- the child: one daemon process
//
// env: DIR, STORE, PORT, RID, PEERS (comma-separated), BEACON_HEIGHT, BEACON_HASH, TAG
async function child(mode) {
  const { DIR, STORE, PORT, RID, PEERS, BEACON_HEIGHT, BEACON_HASH, TAG } = process.env;
  const rid = fromHex(RID);
  const port = Number(PORT);
  const beacon = { hash: fromHex(BEACON_HASH), height: Number(BEACON_HEIGHT), timeMs: BigInt(NOW) };
  const peers = PEERS ? PEERS.split(',') : [];
  const out = (o) => writeFileSync(join(DIR, `${TAG}-${mode}.json`), JSON.stringify(o, null, 1));
  const killedAt = (o) => writeFileSync(join(DIR, `${TAG}-killed.json`), JSON.stringify(o));
  const die = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };

  if (mode === 'launcher') {
    // EXACTLY WHAT src/main.js PASSES.
    const node = await serve(openStore(STORE), { port, host: '127.0.0.1' });
    const r = await node.reconcilingPayouts;
    const row = node.round.payout(rid);
    out({ reconcile: r, canSpend: node.payouts.canSpend,
      row: row ? { state: row.state, raw: row.raw ? toHex(row.raw) : null } : null });
    await node.close();
    process.exit(0);
  }

  // The seat and the pool key, read back from this daemon's OWN store.
  const db = openStore(STORE);
  const reader = new Round(db, () => NOW);
  const contract = decodeRoundContract(new Uint8Array(reader.get(rid).contract));
  const held = new Dkg(reader, { curve, random: rand, peers: [] }).seatFor(contract.nodes);
  if (!held.ok) { out({ ok: false, why: `no seat in its own store: ${held.why}` }); process.exit(3); }
  const cli = cliFor(DIR);
  const chain = chainFor(cli);

  if (mode === 'restore') {
    const node = await serve(db, {
      port, host: '127.0.0.1', funded: () => true, now: () => NOW,
      poolCurve: curve, chainSpend: chain, randomnessFor: () => beacon,
      poolKey: held.pool, poolSeat: held.seat, poolCall: rpcFor(DIR), peers,
    });
    const r = await node.reconcilingPayouts;
    const row = node.round.payout(rid);
    out({ reconcile: r, canSpend: node.payouts.canSpend,
      row: row ? { state: row.state, raw: row.raw ? toHex(row.raw) : null } : null });
    await node.close();
    process.exit(0);
  }

  // A SEAT THAT SETTLES, started as settle-regtest starts one: the seat, the
  // key, the pool RPC and the peers handed over after start. It dies at its
  // point.
  const node = await serve(db, {
    port, host: '127.0.0.1', funded: () => true, now: () => NOW,
    poolCurve: curve, chainSpend: chain, randomnessFor: () => beacon,
  });
  node.signing.seat = held.seat; node.signing.pool = held.pool;
  node.payouts.pool = held.pool; node.poolWatch.pool = held.pool;
  node.poolWatch.call = rpcFor(DIR);
  node.payouts.peers = peers;
  const rowNow = () => { const r = node.round.payout(rid); return r ? { state: r.state, raw: r.raw ? toHex(r.raw) : null } : null; };

  if (mode === 'kill-after-table') {
    const entries = new PoolSigning(node.round, {}).entriesFor(rid).entries;
    const q = node.payouts.queue({ roundId: rid, entries, minScore: contract.minScore, contract });
    killedAt({ queued: q.ok ? q.state : q.why, row: rowNow() });
    await die();
  }
  if (mode === 'kill-before-send') {
    chain.send = async (raw) => { killedAt({ raw: toHex(raw), row: rowNow() }); await die(); };
  }
  if (mode === 'kill-after-send') {
    const real = chain.send.bind(chain);
    chain.send = async (raw) => {
      const sent = await real(raw);
      killedAt({ raw: toHex(raw), sent: sent.ok ? 'accepted by bitcoind' : sent.why, row: rowNow() });
      await die();
    };
  }
  const r = await node.payouts.settleQueued({ roundId: rid, contract, signing: node.signing, watch: node.poolWatch });
  out({ ok: false, why: `settleQueued returned without reaching the kill: ${r.why || r.state}` });
  process.exit(4);
}

// THE REAL LAUNCHER, on the seat's store and port, with the two settings. It is
// stopped once its start-up recovery has said something about this round (or
// after 25 s); what it printed is kept.
function runMain(env, ridPrefix) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [MAIN, env.PORT, env.STORE], {
      env: { ...process.env, BLWP_BIND: '127.0.0.1', BLWP_BITCOIND_URL: `http://127.0.0.1:${P.rpc}/`,
        BLWP_BITCOIND_COOKIE: join(env.DIR, 'btc', 'regtest', '.cookie') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = [];
    let done = false;
    const finish = () => { if (done) return; done = true; setTimeout(() => c.kill('SIGTERM'), 300); };
    const take = (chunk) => {
      for (const l of String(chunk).split('\n').filter(Boolean)) {
        lines.push(l);
        if (/^\[payout\]/.test(l) && l.includes(ridPrefix)) finish();
      }
    };
    c.stdout.on('data', take);
    c.stderr.on('data', take);
    const bail = setTimeout(finish, 25000);
    c.on('exit', (code, signal) => { clearTimeout(bail); resolve({ code, signal, lines }); });
  });
}

function run(mode, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SELF, mode], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const bail = setTimeout(() => c.kill('SIGKILL'), 90000);
    c.on('exit', (code, signal) => { clearTimeout(bail); resolve({ code, signal }); });
  });
}

// ---------------------------------------------------------------- the parent
async function until(what, check, ms = 60000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

async function main() {
  if (![1, 2, 3, 4].includes(POINT)) throw new Error(`no kill point ${POINT}`);
  const dir = process.env.SETTLECRASHRT || mkdtempSync(join(tmpdir(), `settle-crash-${POINT}-`));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`KILL POINT ${POINT}, an isolated regtest of its own: ${dir}`);
  const cli = cliFor(dir);
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const problems = [];
  const nodes = [];
  const closed = new Set();
  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgsFor(dir), `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'committee'); } catch { cli('loadwallet', 'committee'); }
    const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
    if (Number(cli('getblockcount')) < 200) mine(200 - Number(cli('getblockcount')));
    const chain = chainFor(cli);
    // THE ROUND'S COMMITTEE TIME IS A REAL INSTANT ON THIS CHAIN'S CLOCK: blocks
    // before it, then blocks after it, so the beacon rule can name the first
    // block past it - read off the chain by every daemon, as a real one reads
    // it, rather than handed in. (A fixed date before this chain existed made a
    // real launcher refuse: "already after this round's committee time".)
    let beacon = null;
    let censusView = null;
    say(`bitcoind at height ${cli('getblockcount')}, rpc ${P.rpc}`);

    for (let i = 0; i < SHARES_TOTAL; i++) {
      nodes.push(await serve(openStore(join(dir, `node-${i}.db`)), {
        port: PORT0 + i, host: '127.0.0.1', funded: () => true, now: () => NOW,
        poolCurve: curve, chainSpend: chain, randomnessFor: () => beacon,
        chainFor: () => censusView,
      }));
    }
    const committee = nodes.map((n) => n.round.pubkey);
    for (const n of nodes) n.dkg.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    for (const n of nodes) await n.dkg.run(committee);
    for (const n of nodes) await n.dkg.run(committee);
    const seats = nodes.map((n) => n.dkg.seatFor(committee));
    if (seats.some((h) => !h.ok)) throw new Error('a daemon ended the key ceremony with no share');
    const pool = { groupPublicKey: seats[0].pool.groupPublicKey };
    for (const [i, n] of nodes.entries()) {
      n.signing.seat = seats[i].seat; n.signing.pool = pool;
      n.payouts.pool = pool; n.poolWatch.pool = pool;
    }
    say(`seven daemons on ports ${PORT0}..${PORT0 + SHARES_TOTAL - 1}, one share each`);

    // EVERY SEAT BONDED ON THIS CHAIN, its signed advertisement - and so its
    // address - in the bond's witness: the spec's record of where a node
    // lives, which a restarted daemon reads back the way a first seating does.
    const rt = regtest(cli, { wallet: 'committee' });
    const posted = nodes.map((n, i) => rt.postBond(n.round.identity.secret,
      { endpoint: `ws://127.0.0.1:${PORT0 + i}` }));
    rt.include(posted.map((b) => b.hex));
    const bondHeight = rt.height();
    mine(6);
    const censusHeight = rt.height();
    say(`seven bonds in block ${bondHeight}, census height ${censusHeight}`);
    // THE ROUND'S COMMITTEE TIME IS A REAL INSTANT ON THIS CHAIN'S CLOCK: blocks
    // before it, then blocks after it, so the beacon rule can name the first
    // block past it - read off the chain by every daemon, as a real one reads
    // it, rather than handed in. (A fixed 2026-09-06 date before this chain
    // existed made a real launcher refuse: "already after this round's
    // committee time".)
    //
    // TAKEN FROM THE CHAIN'S OWN MEDIAN TIME at the census height, as
    // `round-2of2.mjs` takes it - not the wall clock: fast regtest mining runs
    // block times ahead of the clock, and a wall-clock committee time put the
    // beacon at block 151, below census height 214, so the normal order (beacon
    // after the census) was never measured.
    const censusMtp = Number(JSON.parse(cli('getblockheader', cli('getblockhash', String(censusHeight)))).mediantime);
    NOW = censusMtp * 1000 + 1000;
    mine(20);
    censusView = rt.blocksFrom(0, rt.height());

    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
      gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
      slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight,
      censusRoot: new Uint8Array(32), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: 9000,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: committee,
    };
    // THE CENSUS ROOT IS THE CHAIN'S, derived from these blocks the way every
    // seat will derive it when the round is opened on it.
    const byTxid = new Map();
    for (const block of censusView.blocks)
      for (const raw of block.transactions || []) {
        try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ }
      }
    const census = deriveCensus(censusView, {
      contract: decodeRoundContract(encodeRoundContract(contract)), bond: bondSetFor('regtest'),
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
    });
    if (!census.ok) throw new Error(`the harness could not derive its own census: ${census.why}`);
    contract.censusRoot = census.root;
    say(`the census seats ${census.entries.length}; root ${toHex(census.root).slice(0, 16)}…`);
    const rid = roundId(contract);
    const beaconSrc = chainBeacon({ call: rpcFor(dir), window: 400 });
    const seenBeacon = await beaconSrc.refresh(contract);
    if (!seenBeacon.ok) throw new Error(`the chain names no beacon for this round: ${seenBeacon.why}`);
    beacon = beaconSrc.for({ contract });
    say(`the round's beacon, read off the chain: block ${beacon.height} (census height ${censusHeight})`);
    // THE ENTRY DOOR READS THE WALL CLOCK, and fast regtest mining runs the
    // chain's clock ahead of it - measured: "that round's committee forms at
    // 1789059126000 and it is 1789059118169: entry opens then". So the round
    // is opened once the wall clock has passed the committee time.
    const early = NOW - Date.now();
    if (early > 120000) throw new Error(`the chain's clock is ${early} ms ahead of the wall clock`);
    if (early > 0) { say(`waiting ${early + 500} ms for the wall clock to reach the committee time`); await new Promise((r) => setTimeout(r, early + 500)); }
    if (beacon.height <= censusHeight) problems.push(`the beacon (block ${beacon.height}) is not after the census height ${censusHeight}`);
    const winnerSecret = rand(32);
    const session = ed25519.utils.randomSecretKey();
    const players = [
      { pubkey: schnorr.getPublicKey(winnerSecret), outcome: DELIVERED, score: 9 },
      { pubkey: schnorr.getPublicKey(rand(32)), outcome: FORFEIT, score: 0 },
    ].map((p) => ({ ...p, contract: {
      roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: b32(7), stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    } }));
    for (const n of nodes) {
      const opened = await post(n.port, '/round', encodeRoundContract(contract));
      if (opened.status !== 201) throw new Error(`a node refused the round: ${opened.status} ${await opened.text()}`);
      if (n.round.seats(rid).length !== SHARES_TOTAL) problems.push('a node did not seat all seven off the chain');
      for (const p of players) {
        const joined = await post(n.port, '/entry', encodeEntryContract(p.contract));
        if (joined.status !== 201)
          throw new Error(`a node refused an entry: ${joined.status} ${(await joined.text()).trim()}`);
        const result = {
          roundId: rid, playerPubkey: p.pubkey, outcome: p.outcome, score: p.score,
          transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
        };
        const id = resultId(result);
        n.round.putResult(rid, entryId(p.contract), n.round.pubkey, id,
          joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
      }
    }

    // WHO SETTLES: the round's asker, or - at point 4 - the seat after it.
    const ring = askerOrder(rid, nodes[0].round.seats(rid));
    const indexOf = (k) => nodes.findIndex((n) => toHex(n.round.pubkey) === toHex(ring.order[k]));
    const askerIdx = indexOf(0);
    const victimIdx = POINT === 4 ? indexOf(1) : askerIdx;

    const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
    for (const n of nodes) n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
    let owedMsat = null;
    for (const [i, n] of nodes.entries()) {
      n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
      await n.payouts.gather({ roundId: rid });
      // At point 1 the seat that settles queues the table ITSELF, and dies right after.
      if (POINT === 1 && i === victimIdx) continue;
      const q = n.payouts.queue({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract });
      if (!q.ok || q.state !== PAYOUT_QUEUED) problems.push(`a seat did not queue: ${q.why}`);
      if (owedMsat === null) owedMsat = q.owedMsat;
      else if (q.owedMsat !== owedMsat) problems.push('two seats queued different amounts');
    }
    // THE TABLE'S OWN AMOUNT, read off the queue - not the stake. The winnings
    // are computed on the net stake (6e), so this is what the key must hold.
    const owedSats = Number(BigInt(owedMsat) / 1000n);
    const call = rpcFor(dir);
    for (const n of nodes) n.poolWatch.call = call;

    const out = poolOutput({ groupPublicKey: pool.groupPublicKey, curve });
    const poolAddress = JSON.parse(cli('decodescript', toHex(out.script))).address;
    const fundTxid = cli('sendtoaddress', poolAddress, '0.00001200');
    mine(1);
    const fundTx = JSON.parse(cli('getrawtransaction', fundTxid, 'true'));
    const fundVout = fundTx.vout.find((o) => o.scriptPubKey.hex === toHex(out.script)).n;
    const fundHeight = Number(cli('getblockcount'));
    const winnerAddress = JSON.parse(cli('decodescript', '5120' + toHex(schnorr.getPublicKey(winnerSecret)))).address;
    say(`the table owes the winner ${owedSats} sats (stake ${STAKE_MSAT / 1000n}); the pool holds 1200 sats`);

    // WHAT THE CHAIN SAYS, counted rather than inferred.
    const onChain = () => {
      const inBlocks = [];
      for (let h = fundHeight; h <= Number(cli('getblockcount')); h++) {
        const block = JSON.parse(cli('getblock', cli('getblockhash', String(h)), '2'));
        for (const tx of block.tx)
          if (tx.vin.some((v) => v.txid === fundTxid && v.vout === fundVout)) inBlocks.push({ height: h, hex: tx.hex });
      }
      const inMempool = [];
      for (const t of JSON.parse(cli('getrawmempool'))) {
        const tx = JSON.parse(cli('getrawtransaction', t, 'true'));
        if (tx.vin.some((v) => v.txid === fundTxid && v.vout === fundVout)) inMempool.push({ hex: tx.hex });
      }
      const w = JSON.parse(cli('scantxoutset', 'start', JSON.stringify([`addr(${winnerAddress})`])));
      return { inBlocks, inMempool, winnerSats: Math.round((w.total_amount || 0) * 1e8) };
    };
    const line = (c) => `${c.inBlocks.length} spend(s) in blocks, ${c.inMempool.length} in the mempool; winner ${c.winnerSats} sats`;
    const rowOnDisk = (i) => {
      if (!closed.has(i)) { const r = nodes[i].round.payout(rid); return r ? r.state : 'none'; }
      const db = openStore(join(dir, `node-${i}.db`));
      const r = new Round(db, () => NOW).payout(rid);
      try { db.close(); } catch { /* node:sqlite */ }
      return r ? r.state : 'none';
    };
    // KILL_POINT goes with the child, or it computes point 2's bitcoind port.
    const envFor = (i, tag) => ({
      KILL_POINT: String(POINT), NOW_MS: String(NOW),
      DIR: dir, STORE: join(dir, `node-${i}.db`), PORT: String(PORT0 + i), RID: toHex(rid), TAG: tag,
      PEERS: nodes.filter((_, j) => j !== i).map((n) => `http://127.0.0.1:${n.port}`).join(','),
      BEACON_HEIGHT: String(beacon.height), BEACON_HASH: toHex(beacon.hash),
    });
    const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);

    // ---- THE KILL ----
    const killMode = { 1: 'kill-after-table', 2: 'kill-before-send', 3: 'kill-after-send', 4: 'kill-before-send' }[POINT];
    const what = {
      1: 'after the table is signed and queued, before it settles',
      2: 'after the spend is written to disk, before it is sent',
      3: 'after the spend is handed to bitcoind, before PAID is written',
      4: 'a takeover: the asker is down, the next seat is killed with its spend on disk',
    }[POINT];
    await nodes[askerIdx].close(); closed.add(askerIdx);
    if (victimIdx !== askerIdx) { await nodes[victimIdx].close(); closed.add(victimIdx); }
    if (POINT === 4) {
      const need = beacon.height + TAKEOVER_BLOCKS - Number(cli('getblockcount'));
      if (need > 0) mine(need);
      say(`the round's asker (daemon ${askerIdx}) is down; the chain is at ${cli('getblockcount')}, `
        + `the next seat's turn (beacon + ${TAKEOVER_BLOCKS})`);
    }
    say(`\nKILL POINT ${POINT} - ${what}; the seat is daemon ${victimIdx} (port ${PORT0 + victimIdx}), its own process`);
    const k = await run(killMode, envFor(victimIdx, 'victim'));
    const killed = read('victim-killed.json');
    const afterKill = onChain();
    say(`  the process: ${k.signal || 'exit ' + k.code}; at the kill: ${killed ? JSON.stringify({ ...killed, raw: killed.raw ? `${killed.raw.length / 2} bytes` : undefined, row: killed.row && { state: killed.row.state, raw: !!killed.row.raw, rawIsSent: !!(killed.raw && killed.row.raw === killed.raw) } }) : 'nothing recorded'}`);
    say(`  chain after the kill: ${line(afterKill)}`);
    if (k.signal !== 'SIGKILL') {
      problems.push(`the seat was not killed at its point: ${k.signal || k.code} ${JSON.stringify(read('victim-' + killMode + '.json'))}`);
    }

    // ---- RESTART (a): as src/main.js starts a daemon. ----
    const a = await runMain(envFor(victimIdx, 'victim'), toHex(rid).slice(0, 16));
    mine(1);
    const afterA = onChain();
    const rowA = rowOnDisk(victimIdx);
    say(`\n  RESTART (a), the real src/main.js with BLWP_BITCOIND_URL and BLWP_BITCOIND_COOKIE, same store and port:`);
    for (const l of a.lines) say(`    | ${l}`);
    say(`    its row ${rowA}; chain (a block mined after): ${line(afterA)}`);

    // ---- RESTART (b): chain access, and the seat and key from its own store. ----
    const b = await run('restore', envFor(victimIdx, 'victim'));
    const lb = read('victim-restore.json');
    mine(1);
    const afterB = onChain();
    say(`\n  RESTART (b), chain + RPC + seat and key from its own store: ${b.code === 0 ? 'up and down' : 'exit ' + b.code}`);
    say(`    canSpend ${lb && lb.canSpend}; reconcile asked ${JSON.stringify(((lb && lb.reconcile.asked) || []).map((x) => x.state))}, `
      + `swept ${JSON.stringify((((lb && lb.reconcile.swept) || {}).settled || []).map((x) => (x.ok ? x.state : x.why)))}`);
    say(`    its row ${lb && lb.row ? lb.row.state : 'none'}; chain (a block mined after): ${line(afterB)}`);
    let final = afterB;

    // ---- POINT 4: AND THE ORIGINAL ASKER COMES BACK. ----
    if (POINT === 4) {
      const c = await runMain(envFor(askerIdx, 'asker'), toHex(rid).slice(0, 16));
      mine(1);
      final = onChain();
      say(`\n  THE ORIGINAL ASKER COMES BACK (daemon ${askerIdx}), the real src/main.js:`);
      for (const l of c.lines) say(`    | ${l}`);
      say(`    its row ${rowOnDisk(askerIdx)}; chain: ${line(final)}`);
    }

    const landed = final.inBlocks[0];
    if (landed && killed && killed.raw)
      say(`\n  the spend that landed is the one written before the kill, byte for byte: ${landed.hex === killed.raw}`);
    // EVERY RUNNING SEAT'S NEXT SWEEP, as a live daemon makes it, now that the
    // payment is on the chain. The seats that ran as processes (the killed one,
    // and at point 4 the returning asker) answer from their own store.
    const sweeps = [];
    for (const [i, n] of nodes.entries()) {
      if (closed.has(i)) continue;
      const r = await n.payouts.settleQueued({ roundId: rid, contract, signing: n.signing, watch: n.poolWatch });
      sweeps.push(`${i}:${r.ok ? r.state : r.why}`);
    }
    say(`  the other seats' next sweep: ${sweeps.join(' | ')}`);
    const states = nodes.map((_, i) => rowOnDisk(i));
    say(`  every seat's row: ${JSON.stringify(states.map((s, i) => (i === victimIdx ? `killed:${s}` : i === askerIdx ? `asker:${s}` : s)))}`);

    const total = final.inBlocks.length + final.inMempool.length;
    if (total !== 1) problems.push(`${total} spends of the pool output, not 1`);
    if (final.winnerSats !== owedSats) problems.push(`the winner holds ${final.winnerSats} sats, not the table's ${owedSats}`);
    if (landed && killed && killed.raw && landed.hex !== killed.raw)
      problems.push('the spend that landed is not the one written before the kill');
    const stale = states.filter((s, i) => i !== victimIdx && s !== 'PAID' && s !== 'PAID_IN_PART').length;
    const victimStale = states[victimIdx] !== 'PAID' && states[victimIdx] !== 'PAID_IN_PART';
    if (total === 1 && victimStale) problems.push(`the killed seat's row says ${states[victimIdx]} while the chain carries the payment`);
    if (total === 1 && stale) problems.push(`${stale} of ${SHARES_TOTAL - 1} other seats still say PAYOUT_QUEUED while the chain carries the payment`);
    // RESTARTED THE WAY A REAL DAEMON STARTS, IT MUST RECOVER - not only when the
    // harness hands it its chain and key.
    const totalA = afterA.inBlocks.length + afterA.inMempool.length;
    if (totalA !== 1 || (rowA !== 'PAID' && rowA !== 'PAID_IN_PART'))
      problems.push(`restarted as the real src/main.js, the killed seat did not recover: ${totalA} spend(s), its row ${rowA}`);
  } finally {
    for (const [i, n] of nodes.entries()) if (!closed.has(i)) { try { await n.close(); } catch { /* going down */ } }
    try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgsFor(dir), 'stop']); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 1500));
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) { say(`\nPROBLEMS:\n  ${problems.join('\n  ')}`); process.exit(1); }
  say('\nno problems');
}

const mode = process.argv[2];
if (mode && !mode.startsWith('--')) await child(mode);
else await main();
