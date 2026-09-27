#!/usr/bin/env node
/**
 * THE PAYING TESTNET4 ROUND (the owner 2026-09-27 07:51: "A paid testnet4 round must be open and testable"). Seven signer
 * nodes, 5-of-7, on the testnet4 bitcoind - bonds broadcast and six deep in somebody else's blocks, the round published
 * and joined under the first block past its committee_time, nothing mined. The seven are the seven testnet nodes, each
 * holding one guardian key of the 5-of-7 federation (tools/testnet4-found.mjs; the owner 2026-09-27 10:04: "7 nodes and 7
 * guardians, one each"), on their own stores and ports, so each starts its own guardian (node-start.js) and says so on
 * GET /guardian. The stake goes into a lock in that federation, read through the stake-lock port. The Daily is not
 * touched: its own stores, ports, chain and pin are elsewhere.
 *
 *   PATH=<patched fedimintd, fedimint-cli>:$PATH HOME=<fedimint bundle home> \
 *   BLWP_BITCOIND_URL=http://127.0.0.1:48332 BLWP_BITCOIND_COOKIE=/mnt/bitcoin/tn4/testnet4/.cookie \
 *   BLWP_STAKE_LOCK_BIN=... BLWP_FEDERATION_CLIENT_DIR=... BLWP_FEDERATION_INVITE_FILE=... \
 *   BLWP_WSS_31221=wss://seat.example.com/guardian-1 ... \
 *   node tools/run-testnet4-paid.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { standUpRound } from './round-2of2.mjs';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { toHex } from '../../protocol/src/hash.js';

const env = process.env;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const home = env.BLWP_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
// SEVEN NODES, SEVEN GUARDIANS, ONE EACH (the owner 2026-09-27 10:04): /guardian-1..7 on the Funnel, 127.0.0.1:31221..31281
const guardianPorts = [31221, 31231, 31241, 31251, 31261, 31271, 31281];
const plainPorts = [];
const ports = [...guardianPorts, ...plainPorts];
if (ports.length !== 7 || ports.includes(8080)) throw new Error('seven signer nodes, never 8080');
const missing = ['BLWP_STAKE_LOCK_BIN', 'BLWP_FEDERATION_CLIENT_DIR', 'BLWP_FEDERATION_INVITE_FILE', 'BLWP_BITCOIND_URL',
  'BLWP_BITCOIND_COOKIE'].filter((k) => !env[k]);
if (missing.length) throw new Error(`set ${missing.join(', ')}`);
const stakeMsat = BigInt(env.BLWP_PAID_STAKE_MSAT || 10000000);
const invite = readFileSync(env.BLWP_FEDERATION_INVITE_FILE, 'utf8').replace(/["\s]/g, '');
const lock = stakeLockPort({ bin: env.BLWP_STAKE_LOCK_BIN, dataDir: env.BLWP_FEDERATION_CLIENT_DIR });

const datadir = env.BLWP_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.BLWP_TN4_WALLET || 'testnet';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8' }).trim();
const rpc = bitcoindRpc({ url: `${env.BLWP_BITCOIND_URL.replace(/\/$/, '')}/wallet/${wallet}`, cookiePath: env.BLWP_BITCOIND_COOKIE });
const chainCall = bitcoindRpc({ url: env.BLWP_BITCOIND_URL, cookiePath: env.BLWP_BITCOIND_COOKIE });

// ONE NODE IS ONE GUARDIAN, AND EACH ADVERTISES THE KEY ITS OWN GUARDIAN HOLDS: the federation's keys are read through
// the lock port, and which one is this node's is its guardian's own peer id (<store>.guardian/local.json), not the
// order the ports are written in - and it must be one the federation's own config names.
const fed = await lock.guardians();
if (fed.keys.length !== 7 || fed.threshold !== 5) throw new Error(`the federation is ${fed.threshold} of ${fed.keys.length}, not 5 of 7`);
const storePaths = [...guardianPorts.map((_, i) => `${home}/node-${i + 1}.db`), ...plainPorts.map((p) => `${home}/paid/${p}.db`)];
mkdirSync(join(home, 'paid'), { recursive: true, mode: 0o700 });
const guardianOf = ports.map((_, i) => {
  if (i >= guardianPorts.length) return [];
  const dir = `${storePaths[i]}.guardian`;
  const id = JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity;
  const own = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).broadcast_public_keys[String(id)];
  const key = fed.keys.find((k) => toHex(k) === own);
  if (!key) throw new Error(`${dir}: its guardian's key (peer ${id}) is not one of the federation's the lock port reads`);
  return [{ federationId: fed.federationId, guardianKey: key }];
});

const [pa, pb, pc, ...more] = ports;
const round = await standUpRound({ host: '127.0.0.1', portA: pa, portB: pb, portC: pc, extraPorts: more,
  store: join(home, 'paid'), storePaths, network: 'testnet4', wallet, cli, rpc,
  stakeMsat, federationId: fed.federationId, invite, guardianOf,
  // THE ENTRY WINDOW OUTLASTS THE BEACON: on testnet4 committee_time is passed by somebody else's blocks, about an
  // hour after publication, and entries open only then.
  entryWindowMs: BigInt(env.BLWP_ENTRY_WINDOW_MS || 6 * 3600 * 1000),
  signerNode: { closeAtEnd: true, stakeLocks: lock },
  guardianChain: { bitcoindUrl: env.BLWP_BITCOIND_URL, cookiePath: env.BLWP_BITCOIND_COOKIE, call: chainCall },
  // the signed test set names 18777, which the live Daily holds; this committee answers on its own door
  donationRecipients: { port: Number(env.BLWP_RECIPIENT_PORT || 18787) } });
say({ paid: 'up', network: 'testnet4', custody: round.contract.custody, stakeMsat: String(stakeMsat),
  federation: toHex(fed.federationId), guardians: fed.keys.length, threshold: fed.threshold,
  nodes: round.nodes, firstRound: round.id, beacon: round.beacon && round.beacon.ok ? round.beacon.height : null });
writeFileSync(join(home, 'paid', 'lobby-url.txt'), round.lobbyUrl + '\n');
writeFileSync(join(home, 'paid', 'testnet4.json'),
  JSON.stringify({ node: round.nodes, bond: round.bond, advert: round.advert, federation: invite, round: round.id }, null, 2) + '\n');
console.log(round.lobbyUrl);
round.keepOpen({ onOpen: (id) => say({ opened: id, stakeMsat: String(stakeMsat), custody: 'FEDERATION' }),
  onError: (e) => say({ paidNotOpened: e.message }) });
const stop = async () => { say({ stopping: true }); await round.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
