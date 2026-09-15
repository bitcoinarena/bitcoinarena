#!/usr/bin/env node
/**
 * THE DAILY'S 2-OF-2 (M3.3-34): two blwp-nodes on one machine, threshold 2,
 * bonded, and a free round always joinable in the lobby.
 *
 *   RT=/mnt/bitcoin/blwp-2of2/btc RPCPORT=30401 \
 *   BLWP_WSS_18080=wss://seat.example.com/blwp-a \
 *   BLWP_WSS_18081=wss://seat.example.com/blwp-b \
 *   node tools/run-2of2.mjs
 *
 * Seat A :18080 and seat B :18081 (BLWP_PORT_A / BLWP_PORT_B) on the tailnet
 * address (BLWP_BIND). NEVER 8080: signal-cli holds it on this host, so the
 * launcher refuses it by name instead of meeting it as a bind error. Reachable
 * on Tailscale, not LAN (the owner 2026-09-08). The Daily page is https, so a
 * browser reaches the seats through the tailnet's https funnel - /blwp-a and
 * /blwp-b proxied to these two ports - and BLWP_WSS_<port> names that public
 * address; the lobby link is built from it (round-2of2.mjs `publicFor`).
 *
 * THE ROUNDS ARE THE OPENER'S (round-2of2.mjs `keepOpen`): whenever no round
 * has a minute of entry left, the next free round is opened on the same two
 * seats - published on the chain and seated under its own beacon block - so
 * the lobby never empties when an entry closes. That chain is the regtest
 * bitcoind named by RT and RPCPORT, which the opener mines: testnet4 cannot be
 * mined on demand, and every round waits on its beacon block. It is a free
 * test round's chain, not a claim about Bitcoin. The seats' stores stay in
 * BLWP_2OF2_DIR, so each seat keeps its key across restarts. The committee's
 * Lightning endpoint stays opt-in (the four BLWP_LND* settings, read by
 * standUpRound); unset, the seats hold no stakes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { standUpRound } from './round-2of2.mjs';
import { bitcoindRpc } from '../src/chain-rpc.js';

const env = process.env;
const dir = env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2';
const host = env.BLWP_BIND || '198.51.100.7';
const portA = Number(env.BLWP_PORT_A || 18080);
const portB = Number(env.BLWP_PORT_B || 18081);
const page = env.BLWP_PAGE || 'https://btc-logistics-core.pages.dev';
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

if (portA === 8080 || portB === 8080) {
  console.error('8080 is signal-cli\'s port on this host: the Daily seats never bind it');
  process.exit(2);
}
if (!env.RT) {
  console.error('the Daily opens its rounds on a regtest bitcoind: name its datadir as RT= (and its RPCPORT=)');
  process.exit(2);
}
// A PAYING 2-OF-2 ROUND BESIDE THE FREE ONE (the owner 2026-09-15 12:54, option B): BLWP_PAID_STAKE_MSAT
// names its stake; its custody is THRESHOLD_LN - the committee's own Lightning (the four BLWP_LND*
// settings, a regtest lnd on this chain) holds the stakes, no federation. The keeper keeps one of
// each kind open. Refused here without the four settings: a seat with no Lightning answers every
// paying round 503, and a launcher asking every five seconds would only fill its log.
const paidStake = env.BLWP_PAID_STAKE_MSAT ? BigInt(env.BLWP_PAID_STAKE_MSAT) : 0n;
if (paidStake > 0n && !['BLWP_LNCLI', 'BLWP_LND_DIR', 'BLWP_LND_RPC', 'BLWP_LND_NETWORK'].every((k) => env[k])) {
  console.error('BLWP_PAID_STAKE_MSAT needs the committee\'s Lightning: set BLWP_LNCLI, BLWP_LND_DIR, BLWP_LND_RPC and BLWP_LND_NETWORK');
  process.exit(2);
}
const paid = paidStake > 0n ? { stakeMsat: paidStake, custody: 'THRESHOLD_LN' } : null;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const rpcport = env.RPCPORT || '30401';
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/`, cookiePath: `${env.RT}/regtest/.cookie` });
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  ['-regtest', `-datadir=${env.RT}`, `-rpcport=${rpcport}`, ...a], { encoding: 'utf8' }).trim();

// BOTH SEATS CLOSE EACH ROUND AT ITS END, by their own clocks (server closeAtEnd,
// protocol roundEndMs), so every run is replayed, signed and made final.
const round = await standUpRound({ host, portA, portB, store: dir, rpc, cli, page, seat: { closeAtEnd: true },
  bDownAtStart: !!env.BLWP_START_B_DOWN, paid });
// SEAT B STARTS DOWN (BLWP_START_B_DOWN=1), for an operator's look at seat A
// restarted while it holds a close that needs B; SIGUSR2 brings B up.
if (env.BLWP_START_B_DOWN) { await round.b.close(); say({ seatB: 'down', atStart: true }); }
say({ up: true, a: round.nodes[0], b: round.nodes[1], bound: [`${host}:${portA}`, `${host}:${portB}`],
  slots: 2, threshold: 2, firstRound: round.id,
  beacon: round.beacon && round.beacon.ok ? round.beacon.height : null, chain: `regtest at ${env.RT}` });
// THE LOBBY LINK, where an operator picks it up without reading the log.
writeFileSync(join(dir, 'lobby-url.txt'), round.lobbyUrl + '\n');
// AND THE SAME NAMES AS daily.json, which the Daily page deploys beside itself
// so its bare root shows this lobby (lobby.js `dailyLobbySearch`). The public
// addresses change with the tunnels, and then the page is deployed again.
writeFileSync(join(dir, 'daily.json'),
  JSON.stringify({ node: round.nodes, bond: round.bond, advert: round.advert }, null, 2) + '\n');
console.log(round.lobbyUrl);
round.keepOpen({ onOpen: (id, kind) => say({ opened: id, stakeMsat: String(kind && kind.stakeMsat !== undefined ? kind.stakeMsat : 0n),
  custody: (kind && kind.custody) || 'free' }), onError: (e) => say({ notOpened: e.message }) });

// SEAT B DOWN AND BACK, for an operator's 2-of-2 look: SIGUSR1 closes seat B,
// SIGUSR2 serves it again on the same store and port (standUpRound's own
// restartB). With B down a lobby row must read 1 of 2 and offer no Join.
process.on('SIGUSR1', async () => { await round.b.close(); say({ seatB: 'down' }); });
process.on('SIGUSR2', async () => { await round.restartB(); say({ seatB: 'up' }); });

const stop = async () => { say({ stopping: true }); await round.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
