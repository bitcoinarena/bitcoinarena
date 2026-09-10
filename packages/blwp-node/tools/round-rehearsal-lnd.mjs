// A ROUND FOR SATS, REHEARSED ON REGTEST THROUGH THE REAL DAEMONS.
//
// M3 is done when "a round is played for testnet sats, the stake is held rather
// than spent, the winners are paid by a threshold signature no single node
// could have produced, and a node killed mid-settlement recovers". Every piece
// has been measured alone; this runs one whole paying round through the
// daemons' own doors, with a real lnd, and COUNTS where each player's msat end
// up - so every hole left is named with a number, as code, ruling or inbound.
//
// Nothing here moves testnet or mainnet money: its own bitcoind and two lnd
// v0.21.3-beta on an isolated regtest (alice pays, bob is the committee's one
// Lightning endpoint), stopped when the numbers are in.
//
//   two daemons      `standUpRound` - bonded, censused, beacon off this chain -
//                    both on bob through BLWP_LND_* (the launchers' own parse)
//   three players    the page's own steps: settlement seats, stakeFor,
//                    postHandout, entryFor, Client.at, join
//   P1 DELIVERED     a world secret the verifier's own replay says delivers
//   P2 FAILED        one it says fails
//   P3 VOID          seated and paid, never plays
//   the close        both daemons close; the committee's own result decides
//
//   node packages/blwp-node/tools/round-rehearsal-lnd.mjs [--keep]
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { standUpRound } from './round-2of2.mjs';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { replay } from '../src/replay.js';
import { feldmanGroup } from '../src/curve.js';
import { Client } from '../../blwp-client/src/client.js';
import {
  joinFromQuery, tabIdentity, entryFor, fetchSettlementSeats, stakeFor, postHandout,
  worldSeedFor, stakeSeenBy,
} from '../../blwp-client/src/join.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';
import { splitSignedReceipt, decodeCheckpointReceipt, SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const LND = process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta';
const LNCLI = join(LND, 'lncli');
const KEEP = process.argv.includes('--keep');
const STAKE_MSAT = 100000n;
// WHICH DAEMON IS TOLD TO CLOSE FIRST (M3.3-25): AB or BA. Each order on its
// own ports, so the two can run side by side.
const CLOSE_ORDER = (process.argv.find((a) => a.startsWith('--close-order=')) || '--close-order=AB').split('=')[1];
if (!['AB', 'BA'].includes(CLOSE_ORDER)) throw new Error(`--close-order is AB or BA, not ${CLOSE_ORDER}`);
const OFF = CLOSE_ORDER === 'BA' ? 100 : 0;
// NON-DEFAULT, ALL OF THEM; p2p+1 is bitcoind's own; never 8080 (signal-cli).
const P = { rpc: 29901 + OFF, p2p: 29902 + OFF, zmqBlock: 29905 + OFF, zmqTx: 29906 + OFF,
  alice: { rpc: 29907 + OFF, listen: 29908 + OFF, rest: 29909 + OFF },
  bob: { rpc: 29910 + OFF, listen: 29911 + OFF, rest: 29912 + OFF },
  daemonA: 18701 + OFF, daemonB: 18702 + OFF };

const say = (s) => console.log(s);
const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const storage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

async function until(what, check, ms = 120000, every = 1000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await wait(every);
  }
}

/** The drive both searched players use - the node fixture's own pattern. */
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const transcriptOf = (n) => ({ ticks: Array.from({ length: n }, (_, t) => ({ tick: t, words: wordsAt(t) })), liquidations: [] });

/**
 * A WORLD SECRET THIS DRIVE ENDS `want` IN, asked of the verifier's own replay
 * with the round's own randomness - the player chooses the world secret, so
 * choosing one is playing, not arranging. Returns the secret and the first
 * 60-tick boundary at or after the run's end.
 */
function worldFor(base, randomness, want, { tries = 400, span = 3000, minScore = 1 } = {}) {
  for (let i = 0; i < tries; i++) {
    const worldSecret = new Uint8Array(32);
    worldSecret[0] = i & 255; worldSecret[1] = i >> 8; worldSecret[31] = want === 'DELIVERED' ? 0xd1 : 0xfa;
    const entry = { ...base, worldSecret };
    const r = replay(transcriptOf(span), entry, { roundRandomness: randomness });
    if (!r.ok || r.outcome !== want) continue;
    // A WINNER THAT QUALIFIES. Measured: a delivery scoring 0 under the round's
    // minScore 1 left nobody to hand the pool to, and both closes refused.
    if (want === 'DELIVERED' && r.score < minScore) continue;
    // WHERE IT ENDS, so the run published is the run replayed and no longer.
    let ends = span;
    for (let n = 60; n <= span; n += 60) {
      const s = replay(transcriptOf(n), entry, { roundRandomness: randomness });
      if (s.ok && s.outcome === want) { ends = n; break; }
    }
    return { worldSecret, ticks: ends, tried: i + 1, score: r.score };
  }
  return null;
}

async function main() {
  const dir = process.env.RT_DIR || mkdtempSync(join(tmpdir(), 'round-rehearsal-'));
  for (const d of ['btc', 'alice', 'bob']) mkdirSync(join(dir, d), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const running = [];
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]).trim();
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const lncliFor = (who) => [`--lnddir=${join(dir, who)}`, `--rpcserver=127.0.0.1:${P[who].rpc}`, '--network=regtest'];
  const ln = (who, ...a) => sh(LNCLI, [...lncliFor(who), ...a]);
  const lnj = (who, ...a) => JSON.parse(ln(who, ...a));
  const holes = [];
  const hole = (kind, what) => { holes.push({ kind, what }); say(`  HOLE [${kind}] ${what}`); };
  let round = null;
  const clients = [];

  try {
    // ---- THE CHAIN AND TWO LIGHTNING NODES ----
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex',
      `-zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`, `-zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
      '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'blwp'); } catch { cli('loadwallet', 'blwp'); }
    const addr = cli('getnewaddress');
    const mine = (n) => cli('generatetoaddress', String(n), addr);
    mine(250);
    for (const who of ['alice', 'bob']) {
      running.push(spawn(join(LND, 'lnd'), [`--lnddir=${join(dir, who)}`,
        '--bitcoin.regtest', '--bitcoin.node=bitcoind',
        `--bitcoind.rpchost=127.0.0.1:${P.rpc}`, `--bitcoind.rpccookie=${cookie}`,
        `--bitcoind.zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`,
        `--bitcoind.zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
        `--rpclisten=127.0.0.1:${P[who].rpc}`, `--listen=127.0.0.1:${P[who].listen}`,
        `--restlisten=127.0.0.1:${P[who].rest}`,
        '--noseedbackup', '--nobootstrap', `--alias=${who}`], { stdio: 'ignore' }));
    }
    for (const who of ['alice', 'bob'])
      await until(`${who} to sync`, () => lnj(who, 'getinfo').synced_to_chain);
    const bobKey = lnj('bob', 'getinfo').identity_pubkey;
    cli('sendtoaddress', lnj('alice', 'newaddress', 'p2tr').address, '5');
    mine(6);
    await until('alice to see her coins', () => BigInt(lnj('alice', 'walletbalance').confirmed_balance) > 0n);
    ln('alice', 'connect', `${bobKey}@127.0.0.1:${P.bob.listen}`);
    await until('alice\'s wallet to accept a channel open', () => {
      ln('alice', 'openchannel', `--node_key=${bobKey}`, '--local_amt=2000000', '--push_amt=1000000');
      return true;
    }, 120000, 2000);
    mine(6);
    await until('the channel', () => (lnj('alice', 'listchannels').channels || []).find((c) => c.active));
    const msatOf = (who) => BigInt((lnj(who, 'listchannels').channels[0] || {}).local_balance || 0) * 1000n;
    say(`bitcoind at ${cli('getblockcount')}; channel alice->bob active`);

    // ---- TWO DAEMONS ON BOB, THROUGH THE LAUNCHERS' OWN SETTINGS ----
    Object.assign(process.env, {
      BLWP_LNCLI: LNCLI, BLWP_LND_DIR: join(dir, 'bob'),
      BLWP_LND_RPC: `127.0.0.1:${P.bob.rpc}`, BLWP_LND_NETWORK: 'regtest',
    });
    const rpc = bitcoindRpc({ url: `http://127.0.0.1:${P.rpc}/`, cookiePath: cookie });
    try {
      round = await standUpRound({ host: '127.0.0.1', portA: P.daemonA, portB: P.daemonB,
        rpc, cli, stakeMsat: STAKE_MSAT, page: 'http://127.0.0.1:1' });
    } catch (e) {
      hole('code', `the two daemons could not open a paying round: ${e.message}`);
      throw e;
    }
    say(`round ${round.id.slice(0, 16)} on ${round.nodes.join(' ')}, stake ${STAKE_MSAT} msat`);
    const named = await joinFromQuery(new URL(round.url).search);
    const seats = await fetchSettlementSeats(round.id, named.nodes);
    say(`settlement seats: ${seats.seats.length}, agreed by ${seats.agreed}`);

    // ---- THREE PLAYERS, THE PAGE'S OWN STEPS ----
    const players = [];
    for (const [name, want] of [['P1', 'DELIVERED'], ['P2', 'FAILED'], ['P3', 'VOID']]) {
      const session = ed25519.utils.randomSecretKey();
      const player = tabIdentity({ storage: storage(), random, curve: feldmanGroup });
      const stake = await stakeFor({ ...named.round, id: fromHex(round.id) }, {
        seats: seats.seats, curve: feldmanGroup, random, playerPubkey: player.pubkey,
        needed: named.round.settlementSlots,
      });
      const put = await postHandout(stake, named.nodes, { needed: named.round.settlementSlots });
      if (!put.ok) { hole('code', `${name}'s handout: ${put.why}`); continue; }
      const base = {
        roundId: fromHex(round.id), sessionPubkey: ed25519.getPublicKey(session),
        ...entryFor(named.round, { playerPubkey: player.pubkey, random, stake }),
      };
      players.push({ name, want, session, player, stake, base });
    }

    // THE ROUND'S RANDOMNESS, the one every replay will use.
    const seedOf = await worldSeedFor({ entry: players[0].base, round: round.id, nodes: named.nodes });
    const randomness = seedOf.randomness;
    for (const p of players) {
      if (p.want === 'VOID') { p.entry = p.base; continue; }
      const found = worldFor(p.base, randomness, p.want);
      if (!found) { hole('code', `no world secret in 400 where this drive ends ${p.want}`); p.entry = p.base; continue; }
      p.entry = { ...p.base, worldSecret: found.worldSecret };
      p.ticks = found.ticks;
      say(`  ${p.name}: world secret #${found.tried} ends ${p.want} by tick ${found.ticks} (score ${found.score})`);
    }

    // THE ENTRY DOOR READS THE WALL CLOCK, and committee_time is the chain's
    // median time, which a burst of regtest blocks can carry past now.
    // Measured: "that round's committee forms at 1789077484000 and it is
    // 1789077472424" when the world search happened to be quick. So the
    // harness waits for the round's own committee time before anyone sits.
    const opensAt = Number(named.round.committeeTimeMs) + 1000;
    if (Date.now() < opensAt) {
      say(`  waiting ${opensAt - Date.now()} ms for the round's committee time`);
      await until('the round\'s committee time', () => Date.now() >= opensAt, 180000, 500);
    }
    for (const p of players) {
      const started = Date.now();
      try {
        p.client = await Client.at({
          headers: named.chain.headers, bonds: named.chain.bonds,
          signedAdvert: fromHex(named.advert.signedAdvert), committee: named.round.nodes, nodes: named.nodes,
        }, {
          core: { hash: (st) => core.hash(st) }, sign: (id) => ed25519.sign(id, p.session),
          verify, contract: named.round, roundIdGiven: fromHex(round.id),
        });
      } catch (e) {
        // WHICH PROVIDER DID NOT GIVE A CHAIN, AND HOW LONG IT TOOK - asked
        // of each daemon's own door, not guessed.
        say(`  ${p.name}: Client.at refused after ${Date.now() - started} ms: ${e.message}`);
        for (const base of named.nodes) {
          const t0 = Date.now();
          try {
            const r = await fetch(`${base}/headers`);
            const b = new Uint8Array(await r.arrayBuffer());
            say(`    ${base}/headers -> ${r.status}, ${b.length} bytes (${b.length / 80} headers) in ${Date.now() - t0} ms`);
          } catch (f) { say(`    ${base}/headers -> ${f.message} after ${Date.now() - t0} ms`); }
        }
        throw e;
      }
      clients.push(p.client);
      const rid = await p.client.openRound(named.round);
      p.eid = await p.client.join(p.entry);
      await p.client.connect();
      p.client.setRound({ roundId: rid, entryId: p.eid, blockTicks: named.round.blockTicks | 0 });
      say(`  ${p.name} seated ${toHex(p.eid).slice(0, 12)}, x-hold ${p.client.seatHold.state}`);
    }

    // ---- ALICE PAYS EVERY HOLD ----
    const before = { alice: msatOf('alice'), bob: msatOf('bob') };
    for (const p of players) {
      const q = await p.client.invoice(p.entry, { entryId: p.eid });
      if (!q.ok) { hole('code', `${p.name} got no quote: ${q.why}`); continue; }
      p.hash = toHex(q.paymentHash);
      p.amountMsat = q.amountMsat;
      p.pay = new Promise((resolve) => execFile(LNCLI,
        [...lncliFor('alice'), 'payinvoice', '--force', '--timeout', '900s', q.request],
        { maxBuffer: 8 << 20 }, (err, o) => resolve((o || '') + (err ? err.message : ''))));
    }
    for (const p of players) {
      if (!p.hash) continue;
      const count = await until(`${p.name}'s stake seen by the committee`, async () => {
        const c = await stakeSeenBy({ entryId: p.eid, seats: seats.seats, nodes: named.nodes, contract: named.round });
        return c.committed ? c : null;
      }, 120000, 1000).catch(() => null);
      p.seen = count;
      say(`  ${p.name}: ${count ? `seen by ${count.seen} of ${count.of} (${count.needed} needed), committed` : 'NOT committed'}`);
      if (!count) hole('code', `${p.name}'s paid stake was never seen by the committee`);
    }
    const paidIn = { alice: msatOf('alice'), bob: msatOf('bob') };
    say(`after paying: alice ${before.alice} -> ${paidIn.alice} msat (${before.alice - paidIn.alice} in flight)`);

    // ---- P1 AND P2 DRIVE; P3 NEVER DOES ----
    for (const p of players) {
      if (p.want === 'VOID' || !p.ticks) continue;
      // THE PAGE'S OWN CORE, stepped with the same words, so every mark is the
      // state the committee's replay reaches at that tick.
      const st = coreInit((await worldSeedFor({ entry: p.entry, round: round.id, nodes: named.nodes })).seedWord);
      let t = 0;
      while (t < p.ticks) {
        for (let k = 0; k < 60 && t < p.ticks; k++, t++) { const w = wordsAt(t); p.client.record(w); coreStep(st, ...w); }
        const m = await p.client.markNow(core.hash(st), t);
        if (!m || !m.live) say(`    ${p.name} mark at ${t}: ${m ? m.answer : 'skipped'}`);
      }
      for (let i = 0; i < 400 && (p.client.hold.length || p.client.publishing); i++) {
        await (p.client.drain() || p.client.publishing);
        await p.client.awaitPublishes();
      }
      await p.client.awaitPeers();
      say(`  ${p.name} published ${p.client.nextTick} of ${p.ticks} ticks, ${p.client.refusals} refused`);
    }

    // ---- HOW RECEIPTS SIT BEFORE THE CLOSE (M3.3-22), measured, not read ----
    // Per played run and per daemon: the checkpoints it stores, and the
    // receipts it serves on GET /receipts, split by who signed them.
    const daemonKeys = [round.a.round.pubkey, round.b.round.pubkey].map(toHex);
    for (const p of players) {
      if (!p.ticks) continue;
      for (const [i, base] of named.nodes.entries()) {
        const q = `round=${round.id}&entry=${toHex(p.eid)}`;
        const cp = await fetch(`${base}/checkpoints?${q}`); await cp.arrayBuffer();
        const rc = await fetch(`${base}/receipts?${q}`);
        const bytes = new Uint8Array(await rc.arrayBuffer());
        const by = [0, 0];
        for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES) {
          const r = decodeCheckpointReceipt(splitSignedReceipt(bytes.subarray(at, at + SIGNED_RECEIPT_BYTES)).body);
          const k = daemonKeys.indexOf(toHex(r.nodePubkey));
          if (k >= 0) by[k]++;
        }
        const own = by[i]; const other = by[1 - i];
        say(`    ${p.name} on ${'AB'[i]}: ${cp.headers.get('x-checkpoints')} checkpoint(s), `
          + `${rc.headers.get('x-receipts')} receipt(s) - ${own} its own, ${other} from ${'AB'[1 - i]}`);
      }
    }
    say(`    verifier peers: A ${JSON.stringify(round.a.verifier.peers)}, B ${JSON.stringify(round.b.verifier.peers)}`);

    // ---- THE CLOSE, ON BOTH DAEMONS ----
    const closeOn = (base) => new Promise((resolve) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/play');
      ws.on('open', () => ws.send(`close ${round.id}`));
      ws.on('message', (d) => { resolve(String(d)); ws.close(); });
      ws.on('error', (e) => resolve(`error ${e.message}`));
    });
    const daemons = [['A', round.a], ['B', round.b]];
    const who = (eid) => (players.find((p) => p.eid && toHex(p.eid) === toHex(eid)) || { name: toHex(eid).slice(0, 8) }).name;
    // THE RACE, TIMED (M3.3-25): when each daemon stores its OWN result for a
    // run, and when each gathers one and what it found. Instrumentation only -
    // the daemons' own methods, wrapped; the close path is theirs.
    const t0 = Date.now();
    const stamps = [];
    for (const [name, d] of daemons) {
      const put = d.round.putResult.bind(d.round);
      d.round.putResult = (rid, eid, pub, id, bytes) => {
        if (toHex(pub) === toHex(d.round.pubkey)) stamps.push({ t: Date.now() - t0, what: `${name} stores its own ${who(eid)} result` });
        return put(rid, eid, pub, id, bytes);
      };
      const gather = d.verifier.gather.bind(d.verifier);
      d.verifier.gather = async (rid, eid) => {
        const at = Date.now() - t0;
        const g = await gather(rid, eid);
        stamps.push({ t: at, what: `${name} gathers ${who(eid)} -> ${g.final ? 'FINAL' : `not final: ${g.why}`} (answered +${Date.now() - t0} ms)` });
        return g;
      };
    }
    const order = CLOSE_ORDER === 'BA' ? [named.nodes[1], named.nodes[0]] : named.nodes;
    say(`  close order ${CLOSE_ORDER}`);
    for (const base of order) say(`  close on ${base} at +${Date.now() - t0} ms: ${await closeOn(base)}`);
    for (const [, d] of daemons) { try { await d.verifier.settling; } catch { /* reported below */ } }
    // WHAT EACH DAEMON ENDS WITH (M3.3-25): the close now keeps asking, so its
    // latest result is read until both played runs are final or 30 s pass.
    const played = players.filter((p) => p.ticks && p.eid).map((p) => toHex(p.eid));
    for (const [name, d] of daemons) {
      const stop = Date.now() + 30000;
      let money = await d.stakes();
      while (Date.now() < stop && !played.every((e) => (money.agreed || []).includes(e))) {
        await wait(250);
        money = await d.stakes();
      }
      const row = d.round.payout(fromHex(round.id));
      say(`  ${name} ENDS at +${Date.now() - t0} ms: final ${played.filter((e) => (money.agreed || []).includes(e)).length} of ${played.length} `
        + `(${played.filter((e) => (money.agreed || []).includes(e)).map(who).join(', ') || 'none'}); `
        + `table ${row ? row.state : 'none'}, ${d.round.payoutSignatures(fromHex(round.id)).length} of 2 seats signed`);
    }
    for (const s of stamps.sort((x, y) => x.t - y.t)) say(`    +${String(s.t).padStart(5)} ms  ${s.what}`);
    for (const [name, d] of daemons) {
      for (const p of d.verifier.done || []) { try { await p; } catch { /* reported below */ } }
      // WHAT THIS DAEMON'S CLOSE SAW, instrumented rather than guessed: each
      // entry's replay, and for each stored one the committee's gather.
      let closed = null;
      try { closed = await d.verifier.settling; } catch (e) { say(`  daemon ${name} settling threw: ${e.message}`); }
      for (const r of (closed && closed.replayed) || [])
        say(`    ${name} replay ${who(r.entryId)}: stored ${r.stored}${r.outcome ? `, ${r.outcome} score ${r.score}` : ''}${r.why ? ` - ${r.why}` : ''}`);
      for (const g of (closed && closed.gathered) || [])
        say(`    ${name} gather ${g && g.entryId ? who(g.entryId) : '?'}: ok ${g && g.ok}, final ${g && g.final}${g && g.why ? ` - ${g.why}` : ''}`);
      // WHAT THIS CLOSE CARRIED FROM ITS PEERS (M3.3-22).
      for (const p of players) {
        const c = p.eid && d.verifier.carried && d.verifier.carried.get(`${round.id}:${toHex(p.eid)}`);
        if (c) say(`    ${name} carried ${p.name}: took ${c.taken}, refused ${c.refused.length}, down ${c.down.length}`
          + `${c.down.length ? ` (${c.down.join('; ')})` : ''}${c.refused.length ? ` [${c.refused[0]}]` : ''}`);
      }
      const money = await d.stakes();
      d.money = money;
      say(`  daemon ${name}: ${money.ok === false ? `NOT OK: ${money.why}` : 'ok'}; considered ${money.considered}; `
        + `agreed ${JSON.stringify(money.agreed || [])}${money.why ? `; ${money.why}` : ''}`);
      for (const a of money.actions || []) say(`    ${toHex(a.entryId).slice(0, 12)} ${a.action} -> ${a.state}: ${a.why}`);
      if (money.owed) say(`    payout: ${money.owed.ok ? money.owed.state : money.owed.why}`);
      if (money.paid) say(`    pool spend: ${money.paid.ok ? money.paid.state : money.paid.why}`);
    }

    // ---- M3.3-24: WHO THE PREIMAGE ASK REACHES, a probe after both closes ----
    // Only a seat where the run is final asks during its close, so A (P2 not
    // final there) never asks. The probe is each daemon's own `open`, the one
    // its close calls, run once so both directions are counted.
    const lost = players.find((p) => p.want === 'FAILED' && p.eid);
    if (lost) {
      for (const [name, d] of daemons) {
        const peers = d.preimages.peersOf(fromHex(round.id));
        const o = await d.preimages.open({ roundId: fromHex(round.id), entryId: lost.eid });
        say(`    PROBE ${name} opens ${lost.name}'s preimage: asks ${JSON.stringify(peers)} -> `
          + `${o.ok ? `OPENED with ${o.held} shares` : `${o.held ?? '?'} held - ${o.why}`}`);
      }
      say(`    payout peers per round: A ${JSON.stringify(round.a.payouts.peersOf(fromHex(round.id)))}, `
        + `B ${JSON.stringify(round.b.payouts.peersOf(fromHex(round.id)))}`);
    }

    // ---- AND HOW RECEIPTS SIT AFTER IT: the done criterion, counted ----
    for (const p of players) {
      if (!p.ticks) continue;
      for (const [i, base] of named.nodes.entries()) {
        const q = `round=${round.id}&entry=${toHex(p.eid)}`;
        const cp = await fetch(`${base}/checkpoints?${q}`); await cp.arrayBuffer();
        const rc = await fetch(`${base}/receipts?${q}`);
        const bytes = new Uint8Array(await rc.arrayBuffer());
        const by = [0, 0];
        for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES) {
          const r = decodeCheckpointReceipt(splitSignedReceipt(bytes.subarray(at, at + SIGNED_RECEIPT_BYTES)).body);
          const k = daemonKeys.indexOf(toHex(r.nodePubkey));
          if (k >= 0) by[k]++;
        }
        say(`    after the close, ${p.name} on ${'AB'[i]}: ${cp.headers.get('x-checkpoints')} checkpoint(s), `
          + `${rc.headers.get('x-receipts')} receipt(s) - ${by[i]} its own, ${by[1 - i]} from ${'AB'[1 - i]}`);
      }
    }
    say(`    verifier peers per round: A ${JSON.stringify(round.a.verifier.peersOf(fromHex(round.id)))}, `
      + `B ${JSON.stringify(round.b.verifier.peersOf(fromHex(round.id)))}`);

    // ---- WHERE EVERY MSAT IS ----
    const lookup = (hash) => { try { return lnj('bob', 'lookupinvoice', hash); } catch (e) { return { state: `lookup failed: ${e.message}` }; } };
    await wait(3000);
    const afterClose = { alice: msatOf('alice'), bob: msatOf('bob') };
    // VOID: nobody acts. The HTLC's own timelock returns it; mine past it.
    const voided = players.find((p) => p.want === 'VOID' && p.hash);
    if (voided) {
      const inv = lookup(voided.hash);
      const expiry = inv.htlcs && inv.htlcs[0] ? Number(inv.htlcs[0].expiry_height) : null;
      say(`  P3 (VOID) after the close: lnd ${inv.state}; its HTLC expires at ${expiry}, chain at ${cli('getblockcount')}`);
      if (expiry) {
        await until('the void stake to time out', () => {
          if (lookup(voided.hash).state === 'CANCELED') return true;
          if (Number(cli('getblockcount')) < expiry + 10) mine(10);
          return false;
        }, 300000, 3000).catch((e) => hole('code', `P3's hold did not expire back: ${e.message}`));
      }
    }
    await wait(3000);
    const end = { alice: msatOf('alice'), bob: msatOf('bob') };

    say('\nWHERE EACH PLAYER\'S MSAT ENDED UP (net stake ' + (players[0] && players[0].amountMsat) + ' msat each):');
    for (const p of players) {
      if (!p.hash) continue;
      const inv = lookup(p.hash);
      const wentTo = inv.state === 'SETTLED' ? 'the operator\'s lnd (bob)'
        : inv.state === 'CANCELED' ? 'back to the player (alice)'
          : inv.state === 'ACCEPTED' ? 'still in flight' : inv.state;
      say(`  ${p.name} ${p.want.padEnd(9)} lnd ${String(inv.state).padEnd(9)} -> ${wentTo}`);
      p.lnd = inv.state;
    }
    say(`  alice ${before.alice} -> ${end.alice} msat (${end.alice - before.alice}); `
      + `bob (the operator) ${before.bob} -> ${end.bob} msat (+${end.bob - before.bob}); `
      + `after the close, before P3 expired: alice ${afterClose.alice}, bob ${afterClose.bob}`);

    // ---- THE HOLES, EACH WITH ITS KIND ----
    const p1 = players.find((p) => p.name === 'P1');
    const p2 = players.find((p) => p.name === 'P2');
    if (p2 && p2.lnd === 'SETTLED')
      hole('ruling', `P2's lost stake settled into the operator's lnd (bob +${end.bob - before.bob} msat), not the pool - how a settled stake reaches the pool`);
    // IN EACH DAEMON'S OWN WORDS, not a label guessed from the end state.
    const actOn = (p) => daemons.map(([name, d]) => {
      const a = ((d.money && d.money.actions) || []).find((x) => p && p.eid && toHex(x.entryId) === toHex(p.eid));
      return `${name}: ${a ? `${a.action} -> ${a.state} (${a.why})` : 'no act'}`;
    }).join('; ');
    if (p2 && p2.lnd !== 'SETTLED') hole('code', `P2 (FAILED) was not settled (lnd ${p2.lnd}) - ${actOn(p2)}`);
    if (p1 && p1.lnd !== 'CANCELED') hole('code', `P1 (DELIVERED) was not cancelled back (lnd ${p1.lnd}) - ${actOn(p1)}`);
    const owed = daemons.map(([name, d]) => `${name}: ${d.money && d.money.owed ? (d.money.owed.ok ? d.money.owed.state : d.money.owed.why) : 'nothing owed'}`);
    const paid = daemons.map(([, d]) => d.money && d.money.paid).filter(Boolean);
    if (!paid.some((x) => x.ok)) {
      const short = owed.some((o) => /seats signed this table/.test(o));
      hole(short ? 'code' : 'ruling', `the winner's payout was not paid - ${owed.join('; ')}`
        + `${paid.length ? `; spend: ${paid.map((x) => x.why).join(' | ')}` : ''}`);
    }
    hole('inbound', 'the same round on testnet4 needs 196000 msat of inbound on the operator\'s node, which has 0');
  } catch (e) {
    say(`\nTHE REHEARSAL STOPPED: ${e.stack || e.message}`);
  } finally {
    say('\nHOLES:');
    for (const h of holes) say(`  [${h.kind}] ${h.what}`);
    for (const c of clients) { try { c.endRun && c.endRun('rehearsal over'); c.close(); } catch { /* gone */ } }
    if (round) { try { await round.close(); } catch { /* gone */ } }
    if (!KEEP) {
      for (const p of running) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
      await wait(3000);
      for (const p of running) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* gone */ }
    } else say(`left running, --keep: ${dir}`);
    setTimeout(() => process.exit(0), 2000);
  }
}

await main();
