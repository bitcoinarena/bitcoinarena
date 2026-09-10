// KILL THE ASKER MID-SETTLEMENT, RESTART IT ON THE SAME STORE, AND COUNT THE SPENDS.
//
// "M3 is done when ... a node killed mid-settlement recovers to the right state
// on restart." Every restart measured before this was a fresh object over the
// same store inside one process (`settle-regtest.mjs`, `pool-settle.test.js`,
// `payout-pay.test.js`). This one is a real process: the round's asker runs as a
// child on its own store file and its own port, is SIGKILLed at a named point,
// and is started again on that file and that port.
//
// KILL POINT 2: the spend is signed by five of seven and written to the asker's
// store as PAYOUT_QUEUED with its raw bytes, and the process dies before it is
// handed to bitcoind. Then two restarts, each on the same store and port:
//
//   (a) as a real daemon starts: `serve(openStore(path), { port, host })`,
//       exactly what `src/main.js` passes
//   (b) with the chain it spends on, the RPC its pool watch reads, and the
//       seat and pool key read back from its OWN store (`Dkg.seatFor`)
//
// After each: spends of the pool output counted block by block and in the
// mempool, the winner's key balance, every daemon's payout row, and whether
// the spend that lands is byte-for-byte the one on disk (no rival).
//
// Own datadir, non-default ports, cookie auth; touches no mainnet and no
// testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/settle-crash-regtest.mjs [--keep]
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
import { serve } from '../src/server.js';
import { askerOrder, PAYOUT_QUEUED } from '../src/payout.js';
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
import { assumeSeated } from '../test/seating.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const KEEP = process.argv.includes('--keep');
const P = { rpc: 29697, p2p: 29698 };
const PORT0 = 18300;                               // daemon i listens on PORT0 + i
const NOW = 1788700000000;
const STAKE_MSAT = 1000000n;                       // 1000 sats owed to the winner
const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const say = (s) => console.log(s);
const SELF = fileURLToPath(import.meta.url);

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
// env: DIR, STORE, PORT, RID, PEERS (comma-separated), BEACON_HEIGHT, BEACON_HASH
async function child(mode) {
  const { DIR, STORE, PORT, RID, PEERS, BEACON_HEIGHT, BEACON_HASH } = process.env;
  const rid = fromHex(RID);
  const port = Number(PORT);
  const beacon = { hash: fromHex(BEACON_HASH), height: Number(BEACON_HEIGHT), timeMs: BigInt(NOW) };
  const peers = PEERS ? PEERS.split(',') : [];
  const out = (o) => writeFileSync(join(DIR, `${mode}.json`), JSON.stringify(o, null, 1));

  if (mode === 'launcher') {
    // EXACTLY WHAT src/main.js PASSES.
    const node = await serve(openStore(STORE), { port, host: '127.0.0.1' });
    const r = await node.reconcilingPayouts;
    out({ reconcile: r, row: node.round.payout(rid) ? { state: node.round.payout(rid).state,
      raw: !!node.round.payout(rid).raw } : null, canSpend: node.payouts.canSpend });
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

  if (mode === 'kill-before-send') {
    // The process that settles: started as settle-regtest starts one, then it
    // settles the round it owes, and dies at the moment it would hand the
    // signed spend to bitcoind - the row with the raw bytes already written.
    const node = await serve(db, {
      port, host: '127.0.0.1', funded: () => true, now: () => NOW,
      poolCurve: curve, chainSpend: chain, randomnessFor: () => beacon,
    });
    node.signing.seat = held.seat; node.signing.pool = held.pool;
    node.payouts.pool = held.pool; node.poolWatch.pool = held.pool;
    node.poolWatch.call = rpcFor(DIR);
    node.payouts.peers = peers;
    chain.send = async (raw) => {
      const row = node.round.payout(rid);
      writeFileSync(join(DIR, 'killed.json'), JSON.stringify({
        raw: toHex(raw), rowState: row.state, rowRawMatches: !!row.raw && toHex(row.raw) === toHex(raw),
      }));
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    };
    await node.payouts.settleQueued({ roundId: rid, contract, signing: node.signing, watch: node.poolWatch });
    out({ ok: false, why: 'settleQueued returned without reaching the send' });
    process.exit(4);
  }

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
  throw new Error(`no such mode ${mode}`);
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
  const dir = process.env.SETTLECRASHRT || mkdtempSync(join(tmpdir(), 'settle-crash-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const cli = cliFor(dir);
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const problems = [];
  const nodes = [];
  let closed = null;
  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgsFor(dir), `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'committee'); } catch { cli('loadwallet', 'committee'); }
    const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
    if (Number(cli('getblockcount')) < 200) mine(200 - Number(cli('getblockcount')));
    const chain = chainFor(cli);
    const beacon = {
      hash: fromHex(cli('getblockhash', cli('getblockcount'))),
      height: Number(cli('getblockcount')), timeMs: BigInt(NOW),
    };
    say(`bitcoind at height ${beacon.height}, rpc ${P.rpc}; the round's beacon is block ${beacon.height}`);

    for (let i = 0; i < SHARES_TOTAL; i++) {
      nodes.push(await serve(openStore(join(dir, `node-${i}.db`)), {
        port: PORT0 + i, host: '127.0.0.1', funded: () => true, now: () => NOW,
        poolCurve: curve, chainSpend: chain, randomnessFor: () => beacon,
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

    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
      gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
      slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
      censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: 9000,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: committee,
    };
    const rid = roundId(contract);
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
      if ((await post(n.port, '/round', encodeRoundContract(contract))).status !== 201)
        problems.push('a node refused the round');
      assumeSeated(n.round, rid, contract.nodes);
      for (const p of players) {
        if ((await post(n.port, '/entry', encodeEntryContract(p.contract))).status !== 201)
          problems.push('a node refused an entry');
        const result = {
          roundId: rid, playerPubkey: p.pubkey, outcome: p.outcome, score: p.score,
          transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
        };
        const id = resultId(result);
        n.round.putResult(rid, entryId(p.contract), n.round.pubkey, id,
          joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
      }
    }
    const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
    for (const n of nodes) n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
    let owedMsat = null;
    for (const n of nodes) {
      n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
      await n.payouts.gather({ roundId: rid });
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
    say(`all seven queued the payout: the table owes the winner ${owedSats} sats (stake ${STAKE_MSAT / 1000n}); `
      + `the pool holds 1200 sats, ${fundTxid.slice(0, 16)}…:${fundVout}`);

    // WHAT THE CHAIN SAYS, counted rather than inferred.
    const onChain = () => {
      const inBlocks = [];
      for (let h = fundHeight; h <= Number(cli('getblockcount')); h++) {
        const block = JSON.parse(cli('getblock', cli('getblockhash', String(h)), '2'));
        for (const tx of block.tx)
          if (tx.vin.some((v) => v.txid === fundTxid && v.vout === fundVout)) inBlocks.push({ height: h, hex: tx.hex, txid: tx.txid });
      }
      const inMempool = [];
      for (const t of JSON.parse(cli('getrawmempool'))) {
        const tx = JSON.parse(cli('getrawtransaction', t, 'true'));
        if (tx.vin.some((v) => v.txid === fundTxid && v.vout === fundVout)) inMempool.push({ hex: tx.hex, txid: tx.txid });
      }
      const w = JSON.parse(cli('scantxoutset', 'start', JSON.stringify([`addr(${winnerAddress})`])));
      return { inBlocks, inMempool, winnerSats: Math.round((w.total_amount || 0) * 1e8) };
    };
    const rows = () => nodes.map((n, i) => (n === closed ? null : n.round.payout(rid).state));
    const rowOnDisk = (store) => {
      const db = openStore(store);
      const r = new Round(db, () => NOW).payout(rid);
      const row = r ? { state: r.state, raw: r.raw ? toHex(r.raw) : null } : null;
      try { db.close(); } catch { /* node:sqlite */ }
      return row;
    };

    // THE ASKER, as a real process.
    const ring = askerOrder(rid, nodes[0].round.seats(rid));
    const askerIdx = nodes.findIndex((n) => toHex(n.round.pubkey) === toHex(ring.order[0]));
    const asker = nodes[askerIdx];
    const store = join(dir, `node-${askerIdx}.db`);
    const env = {
      DIR: dir, STORE: store, PORT: String(PORT0 + askerIdx), RID: toHex(rid),
      PEERS: nodes.filter((n) => n !== asker).map((n) => `http://127.0.0.1:${n.port}`).join(','),
      BEACON_HEIGHT: String(beacon.height), BEACON_HASH: toHex(beacon.hash),
    };
    await asker.close();
    closed = asker;
    say(`\nthe round's asker is daemon ${askerIdx} (port ${PORT0 + askerIdx}); it now runs as its own process`);

    // ---- KILL POINT 2: signed, written down, not sent. ----
    const k = await run('kill-before-send', env);
    const killed = existsSync(join(dir, 'killed.json')) ? JSON.parse(readFileSync(join(dir, 'killed.json'), 'utf8')) : null;
    const afterKill = onChain();
    const diskAfterKill = rowOnDisk(store);
    say(`\nKILL POINT 2 - after the spend is written to disk, before it is sent`);
    say(`  the process: ${k.signal || 'exit ' + k.code}; at the kill the row was ${killed ? killed.rowState : '?'} with `
      + `the same raw bytes: ${killed ? killed.rowRawMatches : '?'}`);
    say(`  on disk after: ${diskAfterKill.state}, raw ${diskAfterKill.raw ? 'kept' : 'MISSING'}`);
    say(`  chain: ${afterKill.inBlocks.length} spend(s) in blocks, ${afterKill.inMempool.length} in the mempool; winner ${afterKill.winnerSats} sats`);
    if (k.signal !== 'SIGKILL') problems.push(`the child was not killed at the send: ${k.signal || k.code}`);

    // ---- RESTART (a): as src/main.js starts a daemon. ----
    const a = await run('launcher', env);
    const la = JSON.parse(readFileSync(join(dir, 'launcher.json'), 'utf8'));
    mine(1);
    const afterA = onChain();
    say(`\n  RESTART (a), as src/main.js starts it (same store, port ${PORT0 + askerIdx}): ${a.code === 0 ? 'up and down' : 'exit ' + a.code}`);
    say(`    canSpend ${la.canSpend}; start-up recovery said: ${la.reconcile.ok === false ? la.reconcile.why : JSON.stringify(la.reconcile)}`);
    say(`    row ${la.row ? la.row.state : 'none'}; chain: ${afterA.inBlocks.length} spend(s) in blocks, `
      + `${afterA.inMempool.length} in the mempool; winner ${afterA.winnerSats} sats`);

    // ---- RESTART (b): chain access, and the seat and key from its own store. ----
    const b = await run('restore', env);
    const lb = JSON.parse(readFileSync(join(dir, 'restore.json'), 'utf8'));
    mine(1);
    const afterB = onChain();
    const landed = afterB.inBlocks[0];
    say(`\n  RESTART (b), chain + RPC + seat and key from its own store: ${b.code === 0 ? 'up and down' : 'exit ' + b.code}`);
    say(`    canSpend ${lb.canSpend}; start-up reconcile asked ${JSON.stringify((lb.reconcile.asked || []).map((x) => x.state))}, `
      + `swept ${JSON.stringify(((lb.reconcile.swept || {}).settled || []).map((x) => (x.ok ? x.state : x.why)))}`);
    say(`    row ${lb.row ? lb.row.state : 'none'}; chain: ${afterB.inBlocks.length} spend(s) in blocks, `
      + `${afterB.inMempool.length} in the mempool; winner ${afterB.winnerSats} sats`);
    if (landed && killed)
      say(`    the spend that landed is the one written before the kill, byte for byte: ${landed.hex === killed.raw}`);
    say(`    every daemon's row: ${JSON.stringify(rows().map((s, i) => (i === askerIdx ? `asker:${lb.row && lb.row.state}` : s)))}`);

    const total = afterB.inBlocks.length + afterB.inMempool.length;
    if (total !== 1) problems.push(`${total} spends of the pool output, not 1`);
    if (afterB.winnerSats !== owedSats) problems.push(`the winner holds ${afterB.winnerSats} sats, not the table's ${owedSats}`);
    // EVERY SEAT'S ROW AGAINST THE CHAIN: the payment is in a block, so a row
    // that still says PAYOUT_QUEUED disagrees with it.
    const stale = rows().filter((st, i) => i !== askerIdx && st !== 'PAID' && st !== 'PAID_IN_PART').length;
    if (total === 1 && stale)
      problems.push(`${stale} of ${SHARES_TOTAL - 1} other seats still say PAYOUT_QUEUED while the chain carries the payment`);
    if (la.canSpend === false && afterA.inBlocks.length + afterA.inMempool.length === 0)
      problems.push('restarted as src/main.js starts a daemon, the asker recovers nothing: no chain, no seat, no sweep');
    if (landed && killed && landed.hex !== killed.raw) problems.push('the spend that landed is not the one written before the kill');
  } finally {
    for (const n of nodes) if (n !== closed) { try { await n.close(); } catch { /* going down */ } }
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
