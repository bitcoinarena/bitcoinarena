#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE DAILY'S 2-OF-2 (M3.3-34): two arena-nodes on one machine, threshold 2,
 * bonded, and a free round always joinable in the lobby.
 *
 *   RT=/mnt/bitcoin/blwp-2of2/btc RPCPORT=30401 \
 *   ARENA_WSS_18080=wss://seat.example.com/blwp-a \
 *   ARENA_WSS_18081=wss://seat.example.com/blwp-b \
 *   node tools/run-2of2.mjs
 *
 * Signer node A :18080 and signer node B :18081 (ARENA_PORT_A / ARENA_PORT_B) on the tailnet
 * address (ARENA_BIND). NEVER 8080: signal-cli holds it on this host, so the
 * launcher refuses it by name instead of meeting it as a bind error. Reachable
 * on Tailscale, not LAN (2026-09-08). The Daily page is https, so a
 * browser reaches the signer nodes through the tailnet's https funnel - /blwp-a and
 * /blwp-b proxied to these two ports - and ARENA_WSS_<port> names that public
 * address; the lobby link is built from it (round-2of2.mjs `publicFor`).
 *
 * THE ROUNDS ARE THE OPENER'S (round-2of2.mjs `keepOpen`): whenever no round
 * has a minute of entry left, the next free round is opened on the same two
 * signer nodes - published on the chain and joined under its own beacon block - so
 * the lobby never empties when an entry closes. That chain is the regtest
 * bitcoind named by RT and RPCPORT, which the opener mines: testnet4 cannot be
 * mined on demand, and every round waits on its beacon block. It is a free
 * test round's chain, not a claim about Bitcoin. The signer nodes' stores stay in
 * ARENA_2OF2_DIR, so each signer node keeps its key across restarts. The committee's
 * Lightning endpoint stays opt-in (the four ARENA_LND* settings, read by
 * standUpRound); unset, the signer nodes hold no stakes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { readFileSync } from 'node:fs';
import { standUpRound } from './round-2of2.mjs';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const dir = env.ARENA_2OF2_DIR || '/mnt/bitcoin/blwp-2of2';
const host = env.ARENA_BIND || '198.51.100.7';
const portA = Number(env.ARENA_PORT_A || 18080);
const portB = Number(env.ARENA_PORT_B || 18081);
const page = env.ARENA_PAGE || 'https://testnet.bitcoinarena.io';
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

if (portA === 8080 || portB === 8080) {
  console.error('8080 is signal-cli\'s port on this host: the Daily signer nodes never bind it');
  process.exit(2);
}
if (!env.RT) {
  console.error('the Daily opens its rounds on a regtest bitcoind: name its datadir as RT= (and its RPCPORT=)');
  process.exit(2);
}
// A PAYING ROUND BESIDE THE FREE ONE IS A FEDERATION ROUND (HARD, 2026-09-23 10:19: "New paying
// rounds are FEDERATION now"). ARENA_PAID_STAKE_MSAT names its stake, and the stake goes into a lock in the
// round's federation - never into the committee's Lightning, which is the withdrawn Lightning custody and withdrawn (§23.6).
//
// IT IS ITS OWN COMMITTEE, SEVEN SIGNER NODES (ruled 2026-09-21: the fork is the 5-of-7 already in the
// protocol). §23.6 wants the federation's threshold in DISTINCT bonded census nodes, the smallest federation
// fedimintd builds is 3-of-4, and two signer nodes cannot be three; `receiptsNeeded` defines 2 and 7 and
// nothing between. So the free round keeps its 2-of-2 on A and B, unchanged, and the paying round stands on
// ARENA_PAID_PORTS - seven ports - whose first nodes each advertise ONE guardian key of the federation, every key
// on its own node (testnet 3 of 4: four guardian nodes, one node one guardian, 2026-09-26), the others
// guarding nothing. The federation is read through the same port a signer node
// verifies a lock with: ARENA_STAKE_LOCK_BIN, ARENA_FEDERATION_CLIENT_DIR (a client joined to it), and its
// invite in ARENA_FEDERATION_INVITE or the file ARENA_FEDERATION_INVITE_FILE. Refused here, by name, without
// them: a paying round nobody can lock a stake into would only fill the lobby with rows nobody can pay.
const paidStake = env.ARENA_PAID_STAKE_MSAT ? BigInt(env.ARENA_PAID_STAKE_MSAT) : 0n;
let paidSetup = null;
if (paidStake > 0n) {
  const missing = ['ARENA_STAKE_LOCK_BIN', 'ARENA_FEDERATION_CLIENT_DIR', 'ARENA_PAID_PORTS'].filter((k) => !env[k]);
  if (!env.ARENA_FEDERATION_INVITE && !env.ARENA_FEDERATION_INVITE_FILE) missing.push('ARENA_FEDERATION_INVITE');
  if (missing.length) {
    console.error(`ARENA_PAID_STAKE_MSAT opens FEDERATION rounds and needs their federation: set ${missing.join(', ')}`);
    process.exit(2);
  }
  const ports = env.ARENA_PAID_PORTS.split(',').map((x) => Number(x.trim()));
  if (ports.length !== 7 || ports.some((p) => !Number.isInteger(p) || p <= 0) || new Set(ports).size !== 7) {
    console.error(`ARENA_PAID_PORTS names ${ports.length} port(s): a paying round's committee is seven signer nodes (5-of-7)`);
    process.exit(2);
  }
  if (ports.includes(8080) || ports.includes(portA) || ports.includes(portB)) {
    console.error('ARENA_PAID_PORTS names 8080 (signal-cli\'s) or a free round\'s port: the paying committee binds its own');
    process.exit(2);
  }
  const invite = (env.ARENA_FEDERATION_INVITE || readFileSync(env.ARENA_FEDERATION_INVITE_FILE, 'utf8')).replace(/["\s]/g, '');
  paidSetup = { ports, invite,
    lock: stakeLockPort({ bin: env.ARENA_STAKE_LOCK_BIN, dataDir: env.ARENA_FEDERATION_CLIENT_DIR }) };
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const rpcport = env.RPCPORT || '30401';
// A CHAIN THAT ANSWERS TO A USER AND PASSWORD (RPCAUTH=user:password) rather than its cookie - a probe's
// regtest is started that way. The Daily's own chain is read by its cookie, as before.
// AND ONE WALLET NAMED (RPCWALLET) where more than one is loaded - "Multiple wallets are loaded" is what
// such a chain answers a call that does not say which.
const rpcUrl = `http://127.0.0.1:${rpcport}/${env.RPCWALLET ? `wallet/${env.RPCWALLET}` : ''}`;
const rpc = env.RPCAUTH
  ? bitcoindRpc({ url: rpcUrl, readCookie: () => env.RPCAUTH })
  : bitcoindRpc({ url: rpcUrl, cookiePath: `${env.RT}/regtest/.cookie` });
const auth = [
  ...(env.RPCAUTH ? [`-rpcuser=${env.RPCAUTH.split(':')[0]}`, `-rpcpassword=${env.RPCAUTH.split(':').slice(1).join(':')}`] : []),
  ...(env.RPCWALLET ? [`-rpcwallet=${env.RPCWALLET}`] : []),
];
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  ['-regtest', `-datadir=${env.RT}`, `-rpcport=${rpcport}`, ...auth, ...a], { encoding: 'utf8' }).trim();

// BOTH SIGNER NODES CLOSE EACH ROUND AT ITS END, by their own clocks (server closeAtEnd,
// protocol roundEndMs), so every run is replayed, signed and made final.
// A ROUND IS ABOUT ONE RUN LONG (2026-09-16 15:36: the lobby said "closes 30 min" beside a two-minute
// play, and the same round id came back for half an hour). Entries close 150 s after the round starts - a run's
// 9000 ticks - and the keeper opens the next with a minute to go. ARENA_ENTRY_WINDOW_MS names another.
const entryWindowMs = BigInt(env.ARENA_ENTRY_WINDOW_MS || 150000);
// ARENA_ROUND_PERIOD_MS=90000 (SPECTATE-2158): free rounds every 90 s, each run starting together at its round's start and
// entry closing there - set with ARENA_ENTRY_WINDOW_MS=0 so the first round has the same shape.
const roundPeriodMs = env.ARENA_ROUND_PERIOD_MS ? Number(env.ARENA_ROUND_PERIOD_MS) : null;
// ATTACH (ARENA_ATTACH=1; the free grid gapless across a restart, 2026-10-01: "The two free nodes run as their own
// processes, so an opener restart does not touch them"): the signer nodes run as units of their own on portA and portB, on
// this pair's stores, and this tool opens rounds for them and starts none.
const attach = env.ARENA_ATTACH === '1' ? { fundedFile: `${dir}/funded-rounds.txt`, proofDir: `${dir}/attach-proof` } : null;
const round = await standUpRound({ host, portA, portB, store: dir, rpc, cli, page, signerNode: { closeAtEnd: true },
  bDownAtStart: !!env.ARENA_START_B_DOWN, entryWindowMs, roundPeriodMs, attach });
// SIGNER NODE B STARTS DOWN (ARENA_START_B_DOWN=1), for an operator's look at signer node A
// restarted while it holds a close that needs B; SIGUSR2 brings B up.
if (env.ARENA_START_B_DOWN) { await round.b.close(); say({ signerNodeB: 'down', atStart: true }); }
say({ up: true, a: round.nodes[0], b: round.nodes[1], bound: [`${host}:${portA}`, `${host}:${portB}`],
  slots: 2, threshold: 2, firstRound: round.id,
  beacon: round.beacon && round.beacon.ok ? round.beacon.height : null, chain: `regtest at ${env.RT}` });
// THE PAYING COMMITTEE, stood beside the free one on the same chain, with its own stores (ARENA_2OF2_DIR/paid).
// The federation's own facts are read through the lock port - its id, its guardian keys, its threshold -
// not written down here; §23.6 counts against them.
let paidRound = null;
if (paidSetup) {
  const fed = await paidSetup.lock.guardians();
  if (!fed.keys || fed.keys.length < fed.threshold)
    throw new Error(`the federation names ${fed.keys ? fed.keys.length : 0} guardian key(s) under a threshold of ${fed.threshold}`);
  receiptsNeeded(paidSetup.ports.length);
  // ONE NODE IS ONE GUARDIAN (2026-09-26 22:54, spec §23A.2): every guardian key of the federation is advertised
  // by its own node - all four of a 3-of-4, not the first threshold-many - and the rest are bonded census nodes that
  // guard nothing. A federation with more guardians than the committee has nodes cannot be seated one to a node.
  if (fed.keys.length > paidSetup.ports.length)
    throw new Error(`the federation has ${fed.keys.length} guardians and the committee ${paidSetup.ports.length} nodes: one node is one guardian`);
  const guardianOf = paidSetup.ports.map((_, i) => (i < fed.keys.length
    ? [{ federationId: fed.federationId, guardianKey: fed.keys[i] }] : []));
  const [pa, pb, pc, ...more] = paidSetup.ports;
  mkdirSync(join(dir, 'paid'), { recursive: true, mode: 0o700 });
  paidRound = await standUpRound({ host, portA: pa, portB: pb, portC: pc, extraPorts: more, store: join(dir, 'paid'),
    rpc, cli, page, stakeMsat: paidStake, entryWindowMs, federationId: fed.federationId, invite: paidSetup.invite,
    signerNode: { closeAtEnd: true, stakeLocks: paidSetup.lock }, guardianOf,
    // THE DONATION SET'S TEST RECIPIENTS' DOOR: 18777, the port the signed test set names, unless an operator
    // measuring beside the live Daily - which holds 18777 - names another.
    ...(env.ARENA_RECIPIENT_PORT ? { donationRecipients: { port: Number(env.ARENA_RECIPIENT_PORT) } } : {}) });
  say({ paid: 'up', custody: paidRound.contract.custody, stakeMsat: String(paidRound.contract.stakeMsat),
    federation: toHex(fed.federationId).slice(0, 16), guardians: fed.keys.length, threshold: fed.threshold,
    nodes: paidRound.nodes, firstRound: paidRound.id });
}
// THE LOBBY LINK, where an operator picks it up without reading the log.
writeFileSync(join(dir, 'lobby-url.txt'), round.lobbyUrl + '\n');
// AND THE SAME NAMES AS daily.json, which the Daily page deploys beside itself
// so its bare root shows this lobby (lobby.js `dailyLobbySearch`). The public
// addresses change with the tunnels, and then the page is deployed again.
// The paying committee's nodes are listed beside the free pair, and its federation's invite goes with them,
// so the lobby shows both kinds and a player can lock a stake into the federation the round names.
writeFileSync(join(dir, 'daily.json'),
  JSON.stringify({ node: [...round.nodes, ...(paidRound ? paidRound.nodes : [])], bond: round.bond, advert: round.advert,
    ...(paidRound ? { federation: paidSetup.invite } : {}) }, null, 2) + '\n');
console.log(round.lobbyUrl);
round.keepOpen({ onOpen: (id) => say({ opened: id, stakeMsat: '0', custody: 'free' }),
  onError: (e) => say({ notOpened: e.message }) });
if (paidRound) paidRound.keepOpen({ onOpen: (id) => say({ opened: id, stakeMsat: String(paidStake), custody: 'FEDERATION' }),
  onError: (e) => say({ paidNotOpened: e.message }) });

// SIGNER NODE B DOWN AND BACK, for an operator's 2-of-2 look: SIGUSR1 closes signer node B,
// SIGUSR2 serves it again on the same store and port (standUpRound's own
// restartB). With B down a lobby row must read 1 of 2 and offer no Join.
process.on('SIGUSR1', async () => { await round.b.close(); say({ signerNodeB: 'down' }); });
process.on('SIGUSR2', async () => { await round.restartB(); say({ signerNodeB: 'up' }); });

const stop = async () => { say({ stopping: true }); await round.close(); if (paidRound) await paidRound.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
