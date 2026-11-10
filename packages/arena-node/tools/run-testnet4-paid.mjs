#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE PAYING TESTNET4 ROUND (2026-09-27 07:51: "A paid testnet4 round must be open and testable"). Seven signer
 * nodes, 5-of-7, on the testnet4 bitcoind - bonds broadcast and six deep in somebody else's blocks, the round published
 * and joined under the first block past its committee_time, nothing mined. The seven are the seven testnet nodes, each
 * holding one guardian key of the 5-of-7 federation (tools/testnet4-found.mjs; 2026-09-27 10:04: "7 nodes and 7
 * guardians, one each"), on their own stores and ports, so each starts its own guardian (node-start.js) and says so on
 * GET /guardian. The stake goes into a lock in that federation, read through the stake-lock port. The Daily is not
 * touched: its own stores, ports, chain and pin are elsewhere.
 *
 *   PATH=<patched fedimintd, fedimint-cli>:$PATH HOME=<fedimint bundle home> \
 *   ARENA_BITCOIND_URL=http://127.0.0.1:48332 ARENA_BITCOIND_COOKIE=/mnt/bitcoin/tn4/testnet4/.cookie \
 *   ARENA_STAKE_LOCK_BIN=... ARENA_FEDERATION_CLIENT_DIR=... ARENA_FEDERATION_INVITE_FILE=... \
 *   ARENA_WSS_31221=wss://seat.example.com/guardian-1 ... \
 *   node tools/run-testnet4-paid.mjs
 *
 * ARENA_ATTACH=1 (2026-09-29: the seven blwp-tn4-node units own the guardians): the seven nodes already run, one
 * process each (src/main.js on node-<k>.db, each starting its own guardian) - this runner starts none and opens no node
 * store. It reads each node's key from GET /identity and its bond from the chain, publishes and posts the rounds over
 * HTTP, names the paying ones in ARENA_FUNDED_ROUNDS_FILE and writes the page's bond proof to ARENA_ATTACH_PROOF_DIR,
 * both of which the nodes read. Each node makes each round's claim key itself, with its peers, on their own doors.
 *
 * ON ANOTHER CHAIN (the regtest harness tn4-tools-regtest.sh): ARENA_TN4_NETWORK (default testnet4) is
 * the round's network, and ARENA_TN4_PORTS (default the seven testnet4 seats) the seven node ports. The Funnel paths are
 * testnet4's alone, so another network neither reads nor adds them.
 */
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { standUpRound, keepBackToBack, tableCounter } from './round-2of2.mjs';
import { ROCK_PAPER_SCISSORS as RPS_V1, RPS_ROUND_FIELDS as RPS_FIELDS_V1 } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { GAME as RPS_V2 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';
import { UPDOWN_TN4 } from '../../btc-updown/plugin/btc-updown.js';
import { GAME as UPDOWN_V2 } from '../../btc-updown/plugin/btc-updown-v2.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
// THE UP/DOWN VERSION THE RUNNER POSTS (2026-10-17: the market's protocol reserve fee): DUTY_UPDOWN_PLUGIN names a
// btc-updown plugin file - btc-updown-v13.js, whose terms pay 0.4 % nodes + 0.4 % donation + 0.2 % protocol reserve; unset, version 2
// A PIN THAT DOES NOT LOAD IS NO PIN (kanban #689, measured 2026-10-24 22:35Z: btc-updown-v24.js copied beside an older arena-protocol threw
// "trailing bytes: 6" at import and the Up/Down runner died at its start): said loudly, and the newest version the seats hold is posted
const pinOrNull = async (name, load) => { try { return await load(); } catch (e) { console.log(JSON.stringify({ at: new Date().toISOString(), dutyVersion: 'PIN UNREADABLE', pin: name, why: e.message })); return null; } };
const UPDOWN_PLUGIN = process.env.DUTY_UPDOWN_PLUGIN || '';
if (UPDOWN_PLUGIN && !/^btc-updown(-v\d+)?\.js$/.test(UPDOWN_PLUGIN)) throw new Error(`DUTY_UPDOWN_PLUGIN names a btc-updown plugin file, not ${UPDOWN_PLUGIN}`);
const UPDOWN_CHOSEN = UPDOWN_PLUGIN ? await pinOrNull(UPDOWN_PLUGIN, async () => (await import(`../../btc-updown/plugin/${UPDOWN_PLUGIN}`)).GAME) : null;
if (UPDOWN_CHOSEN) console.log(`[duty] Up/Down rounds of ${UPDOWN_PLUGIN}: game ${Buffer.from(UPDOWN_CHOSEN.gameId).toString('hex').slice(0, 16)}`);
// AND THE NEXT UP/DOWN VERSION FROM A NAMED DAY ON (kanban #523): DUTY_UPDOWN_NEXT_PLUGIN (btc-updown-v20.js) from DUTY_UPDOWN_NEXT_FROM_SLOT
// on; the days before it keep DUTY_UPDOWN_PLUGIN from DUTY_UPDOWN_FROM_SLOT as before
const UPDOWN_NEXT_PLUGIN = process.env.DUTY_UPDOWN_NEXT_PLUGIN || '';
if (UPDOWN_NEXT_PLUGIN && !/^btc-updown(-v\d+)?\.js$/.test(UPDOWN_NEXT_PLUGIN)) throw new Error(`DUTY_UPDOWN_NEXT_PLUGIN names a btc-updown plugin file, not ${UPDOWN_NEXT_PLUGIN}`);
const UPDOWN_NEXT = UPDOWN_NEXT_PLUGIN ? await pinOrNull(UPDOWN_NEXT_PLUGIN, async () => (await import(`../../btc-updown/plugin/${UPDOWN_NEXT_PLUGIN}`)).GAME) : null;
if (UPDOWN_NEXT) console.log(`[duty] Up/Down rounds from slot ${process.env.DUTY_UPDOWN_NEXT_FROM_SLOT || 0} of ${UPDOWN_NEXT_PLUGIN}: game ${Buffer.from(UPDOWN_NEXT.gameId).toString('hex').slice(0, 16)}`);
// THE TICK TOCK VERSION THE RUNNER POSTS (kanban #523): DUTY_NEXTBLOCK_PLUGIN names a nextblock plugin file (nextblock-v5.js) and
// DUTY_NEXTBLOCK_CORE the core its rounds run on (0847c99f, version 5's larger truck); unset, DUTY_NEXTBLOCK_V3=1 as before (tools/duty-nextblock.mjs)
const NB_PLUGIN_FIELDS = process.env.DUTY_NEXTBLOCK_PLUGIN ? await pinOrNull(process.env.DUTY_NEXTBLOCK_PLUGIN, async () => {
  const r = nextblockDutyFields(await loadNextblockPlugin(process.env.DUTY_NEXTBLOCK_PLUGIN), process.env.DUTY_NEXTBLOCK_CORE || '');
  if (!r.ok) throw new Error(`DUTY_NEXTBLOCK_PLUGIN ${process.env.DUTY_NEXTBLOCK_PLUGIN}: ${r.why}`);
  console.log(`[duty] Tick Tock rounds of ${process.env.DUTY_NEXTBLOCK_PLUGIN}: game ${Buffer.from(r.fields.gameId).toString('hex').slice(0, 16)}, core ${Buffer.from(r.fields.simCoreHash).toString('hex').slice(0, 16)}`);
  return r.fields;
}) : null;
// AND THE NEXT TICK TOCK VERSION FROM A NAMED DAY ON (kanban #523: a day's committee is drawn from the census at its anchor, so a new game
// id can be posted only for a day whose anchor comes after the advertisements naming it): DUTY_NEXTBLOCK_NEXT_PLUGIN (nextblock-v6.js)
// from DUTY_NEXTBLOCK_FROM_SLOT on, on the same DUTY_NEXTBLOCK_CORE; a day before it keeps DUTY_NEXTBLOCK_PLUGIN
const NB_NEXT_FIELDS = process.env.DUTY_NEXTBLOCK_NEXT_PLUGIN ? await pinOrNull(process.env.DUTY_NEXTBLOCK_NEXT_PLUGIN, async () => {
  const r = nextblockDutyFields(await loadNextblockPlugin(process.env.DUTY_NEXTBLOCK_NEXT_PLUGIN), process.env.DUTY_NEXTBLOCK_CORE || '');
  if (!r.ok) throw new Error(`DUTY_NEXTBLOCK_NEXT_PLUGIN ${process.env.DUTY_NEXTBLOCK_NEXT_PLUGIN}: ${r.why}`);
  console.log(`[duty] Tick Tock rounds from slot ${process.env.DUTY_NEXTBLOCK_FROM_SLOT || 0} of ${process.env.DUTY_NEXTBLOCK_NEXT_PLUGIN}: game ${Buffer.from(r.fields.gameId).toString('hex').slice(0, 16)}, core ${Buffer.from(r.fields.simCoreHash).toString('hex').slice(0, 16)}`);
  return r.fields;
}) : null;
// PAID_MARKET=1: the paid round is a round of the regtest market the page pins - its seats host nextblock
// and the market, their bonds advertise both, and the round names the market's game with no core and no config
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { GAME as NEXTBLOCK_V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { TRUCK_F0CC_HASH } from '../../nextblock/plugin/truck-cores.js';
import { nextblockDutyFields, loadNextblockPlugin } from './duty-nextblock.mjs';
import { MARKET } from '../test/plugins/market/index.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { openingFederation } from '../src/opening-federation.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { donationSetInForce as signedSetInForce } from '../../arena-protocol/src/authority.js';
import { createApprovedSets } from '../src/approved-sets.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { donationKeysForNetworkId } from '../../arena-protocol/src/donation-keys.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { TESTNET4_DONATION_SET } from '../../arena-protocol/src/testnet4-donation-set.js';
import { TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS } from '../../arena-protocol/src/test-donation-sets.js';

// 2026.0.2: ARENA_PROTOCOL_VERSION=2 opens the v2 game (its manifest requires the round that names no draw)
const ROCK_PAPER_SCISSORS = Number(process.env.ARENA_PROTOCOL_VERSION || 1) >= 2 ? RPS_V2 : RPS_V1;
const RPS_ROUND_FIELDS = Object.freeze({ ...RPS_FIELDS_V1, gameId: ROCK_PAPER_SCISSORS.gameId });
const toHexOf = (b) => Buffer.from(b).toString('hex');
// THE ROCK PAPER SCISSORS VERSION THE DAILY RUNNER POSTS (kanban #523: the version whose files carry no names or ticket numbers):
// DUTY_RPS_PLUGIN names a rock-paper-scissors plugin file (rock-paper-scissors-v5.js) - its round fields are the module's own
// RPS_ROUND_FIELDS_V<n> (its decide core and config, its game id) - from DUTY_RPS_FROM_SLOT on; unset, version 2 as before
const RPS_PLUGIN = process.env.DUTY_RPS_PLUGIN || '';
if (RPS_PLUGIN && !/^rock-paper-scissors(-v\d+)?\.js$/.test(RPS_PLUGIN)) throw new Error(`DUTY_RPS_PLUGIN names a rock-paper-scissors plugin file, not ${RPS_PLUGIN}`);
const RPS_CHOSEN_FIELDS = RPS_PLUGIN ? await pinOrNull(RPS_PLUGIN, async () => {
  const m = await import(`../../rock-paper-scissors/plugin/${RPS_PLUGIN}`);
  const v = (RPS_PLUGIN.match(/-v(\d+)\.js$/) || [])[1];
  const fields = v ? m[`RPS_ROUND_FIELDS_V${v}`] : m.RPS_ROUND_FIELDS;
  if (!fields || toHexOf(fields.gameId) !== toHexOf(m.GAME.gameId)) throw new Error(`DUTY_RPS_PLUGIN ${RPS_PLUGIN}: no round fields for its own game`);
  console.log(`[duty] Rock Paper Scissors rounds of ${RPS_PLUGIN}: game ${toHexOf(fields.gameId).slice(0, 16)}, core ${toHexOf(fields.simCoreHash).slice(0, 16)}`);
  return fields;
}) : null;
const env = process.env;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
// SEVEN NODES, SEVEN GUARDIANS, ONE EACH (2026-09-27 10:04): /guardian-1..7 on the Funnel, 127.0.0.1:31221..31281
const network = env.ARENA_TN4_NETWORK || 'testnet4';
const guardianPorts = env.ARENA_TN4_PORTS ? env.ARENA_TN4_PORTS.split(',').map(Number) : [31221, 31231, 31241, 31251, 31261, 31271, 31281];
const plainPorts = [];
const ports = [...guardianPorts, ...plainPorts];
if (ports.length !== 7 || ports.includes(8080) || !ports.every((p) => Number.isInteger(p) && p > 0)) throw new Error('seven signer nodes, never 8080');
const missing = ['ARENA_STAKE_LOCK_BIN', 'ARENA_FEDERATION_CLIENT_DIR', 'ARENA_FEDERATION_INVITE_FILE', 'ARENA_BITCOIND_URL',
  'ARENA_BITCOIND_COOKIE'].filter((k) => !env[k]);
if (missing.length) throw new Error(`set ${missing.join(', ')}`);
const stakeMsat = BigInt(env.ARENA_PAID_STAKE_MSAT || 10000000);
// THE INVITE NAMES EVERY GUARDIAN (item 5, 2026-09-28): the file's invite named guardian 1 alone, and while guardian 1
// was down every player join failed "Failed to download client config". Read for its federation id, then written
// again with all seven guardians' endpoints - the peer id of /guardian-k is k - 1, as the founding wrote them.
const fileInvite = readFileSync(env.ARENA_FEDERATION_INVITE_FILE, 'utf8').replace(/["\s]/g, '');
const named = readInvite(fileInvite);
const invite = inviteForGuardians(Uint8Array.from(Buffer.from(named.federationId, 'hex')),
  guardianPorts.map((p, k) => ({ url: `${(env[`ARENA_WSS_${p}`] || `wss://seat.example.com/guardian-${k + 1}`).replace(/\/$/, '')}/guardian`, peer: k })));
const lock = stakeLockPort({ bin: env.ARENA_STAKE_LOCK_BIN, dataDir: env.ARENA_FEDERATION_CLIENT_DIR });

// EVERY /guardian-k IS ON THE FUNNEL, or is put back (item 5, 2026-09-28: /guardian-1 had gone from the Funnel, nobody
// knows how, and a guardian nobody can reach is not in the federation a player joins). Added with `tailscale funnel`,
// never `serve`: `serve --set-path` turns Funnel off for the whole of :443 (measured 2026-09-27).
if (network === 'testnet4') {
  let funnel = null;
  try { funnel = execFileSync('tailscale', ['funnel', 'status', '--json'], { encoding: 'utf8', timeout: 15000 }); } catch { funnel = null; }
  if (funnel === null) say({ funnel: 'unread', why: 'tailscale funnel status did not answer: the guardian paths are not checked' });
  else for (const [k, p] of guardianPorts.entries()) {
    const path = `/guardian-${k + 1}`;
    if (funnel.includes(`"${path}"`)) continue;
    say({ funnel: 'missing', path, port: p });
    execFileSync('tailscale', ['funnel', '--bg', `--set-path=${path}`, `http://127.0.0.1:${p}`], { encoding: 'utf8', timeout: 30000 });
    say({ funnel: 'restored', path, port: p });
  }
}

const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_WALLET || 'testnet';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  // a testnet4 block is read whole as hex: past the 1 MB default buffer (ENOBUFS, measured 2026-10-11 on a 1.4 MB block)
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const rpc = bitcoindRpc({ url: `${env.ARENA_BITCOIND_URL.replace(/\/$/, '')}/wallet/${wallet}`, cookiePath: env.ARENA_BITCOIND_COOKIE });
const chainCall = bitcoindRpc({ url: env.ARENA_BITCOIND_URL, cookiePath: env.ARENA_BITCOIND_COOKIE });

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
// THE SETS THE DEVELOPERS APPROVED (§27A.4.1): every round names the set in force at its census height - an approved
// one too, read from the attached seat's ballots and tallied here; refreshed every 2 min, and once before anything is published
const APPROVED = createApprovedSets({ seatUrl: `http://${env.ARENA_BIND || '127.0.0.1'}:${pa}`,
  known: [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS],
  verifySecp256k1: (sg, d, k) => { try { return secp256k1.verify(sg, d, k); } catch { return false; } }, log: (l) => console.log(l) });
setInterval(() => { APPROVED.refresh().catch(() => {}); }, 120000).unref?.();
const donationSetInForce = (args) => signedSetInForce({ ...args, approved: APPROVED.sets() });
await APPROVED.refresh();
// THE NODES' OWN ADDRESS: attached to nodes that listen on ARENA_BIND - federation B's seven on the test host bind
// its tailnet address - the runner reached for 127.0.0.1 and failed at once (ECONNREFUSED 127.0.0.1:6221, 13:20:45Z)
const NODE_HOST = env.ARENA_BIND || '127.0.0.1';
const round = await standUpRound({ host: NODE_HOST, portA: pa, portB: pb, portC: pc, extraPorts: more,
  store: join(home, 'paid'), storePaths, network, wallet, cli, rpc,
  stakeMsat, federationId: fed.federationId, invite, guardianOf,
  // THE ENTRY WINDOW OUTLASTS THE BEACON: on testnet4 committee_time is passed by somebody else's blocks, about an
  // hour after publication, and entries open only then.
  entryWindowMs: BigInt(env.ARENA_ENTRY_WINDOW_MS || 6 * 3600 * 1000),
  // OR AN ENTRY CLOSE AT A WALL-CLOCK INSTANT (ISO), the window then fitted to it once committee_time is known
  ...(env.ARENA_ENTRY_CLOSE_AT ? { entryCloseAtMs: Date.parse(env.ARENA_ENTRY_CLOSE_AT) } : {}),
  signerNode: { closeAtEnd: true, stakeLocks: lock },
  // PAID_FIRST=0 (the RPS grid): no round of its own - only the grid keeper below publishes
  openFirst: env.PAID_FIRST !== '0',
  // ITS OWN FIRST ROUND NAMES THE DONATION SET IN FORCE, as the grid below does
  donationSetAt: (height, networkId) => {
    const keys = donationKeysForNetworkId(networkId);
    const forced = donationSetInForce({ networkId, authority: keys.authority, recovery: keys.recovery,
      sets: [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS],
      rotations: [], height, verify: (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } } });
    if (!forced.ok) throw new Error(`no donation set in force at census height ${height}: ${forced.why}`);
    say({ donationSet: 'in force', serial: String(forced.serial), id: toHex(idOfDonationSet(forced.recipients)).slice(0, 16), censusHeight: height });
    return idOfDonationSet(forced.recipients);
  },
  ...(env.ARENA_ATTACH === '1' ? { attach: { fundedFile: env.ARENA_FUNDED_ROUNDS_FILE || join(home, 'paid', 'funded-rounds.txt'),
    proofDir: env.ARENA_ATTACH_PROOF_DIR || join(home, 'paid', 'attach-proof') } } : {}),
  guardianChain: { bitcoindUrl: env.ARENA_BITCOIND_URL, cookiePath: env.ARENA_BITCOIND_COOKIE, call: chainCall },
  // the signed test set names 18777, which the live Daily holds; this committee answers on its own door
  donationRecipients: { port: Number(env.ARENA_RECIPIENT_PORT || 18787) },
  ...(env.PAID_MARKET === '1' ? { plugins: [NEXTBLOCK, MARKET.registration, ...(env.PAID_RPS === '1' ? [ROCK_PAPER_SCISSORS] : [])],
    roundFields: { gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32) } } : {}) });
say({ paid: 'up', network, custody: round.contract.custody, stakeMsat: String(stakeMsat),
  federation: toHex(fed.federationId), guardians: fed.keys.length, threshold: fed.threshold,
  nodes: round.nodes, firstRound: round.id, beacon: round.beacon && round.beacon.ok ? round.beacon.height : null });
// THE FUNDED GATEWAY STAYS IN THE LINK (2026-09-30 14:30 and the leadMs letter): a start used to write the link
// without `gateway=`, and a page opened on it deposits through whichever gateway the lock client picks. The gateway the
// link already named is kept.
if (round.id) {
let lobbyUrl = round.lobbyUrl;
try {
  const had = new URL(readFileSync(join(home, 'paid', 'lobby-url.txt'), 'utf8').trim()).searchParams.get('gateway');
  const next = new URL(lobbyUrl);
  if (had && !next.searchParams.get('gateway')) { next.searchParams.set('gateway', had); lobbyUrl = next.toString(); }
} catch { /* no link before: the round's own */ }
writeFileSync(join(home, 'paid', 'lobby-url.txt'), lobbyUrl + '\n');
writeFileSync(join(home, 'paid', 'testnet4.json'),
  JSON.stringify({ node: round.nodes, bond: round.bond, advert: round.advert, federation: invite, round: round.id }, null, 2) + '\n');
console.log(round.lobbyUrl);
// THE NEXT ONE-OFF 4 h BEFORE THE CURRENT ENTRY CLOSES (2026-09-30: "4 h is the lead"): a round is published first
// and joinable only once its beacon is 6 deep - measured 1.5-3 h on testnet4 - so opening it 60 s before the close left a
// 1.5-3 h gap every 6 h with no paid round to join.
// PAID_KEEP=0 (the regtest succession): no next round - with a short ARENA_ENTRY_WINDOW_MS every round closes
// within the 4 h lead, and the keeper opened one every 10 s (87 in run 13), mining the regtest chain past its federation
if (env.PAID_KEEP !== '0') round.keepOpen({ leadMs: 4 * 3600 * 1000, onOpen: (id) => say({ opened: id, stakeMsat: String(stakeMsat), custody: 'FEDERATION' }),
  onError: (e) => say({ paidNotOpened: e.message }) });
}
// THE PUBLISHER NAMES ITSELF (§6 creator_pubkey2026.0.3): with ARENA_PROTOCOL_VERSION=3 and ARENA_CREATOR_KEY_FILE (a
// 32-byte secret, hex) every grid this runner publishes names that key as its creator and signs each series id - the key the series
// publisher's fee is paid back to. A v1/v2 round cannot name one (contracts.js CREATOR_VERSION); every later version can
// (the Tick Tock duty runner moves to version 5 and keeps naming its creator).
const CREATOR = Number(env.ARENA_PROTOCOL_VERSION || 1) >= 3 && env.ARENA_CREATOR_KEY_FILE
  ? { creatorSecret: Uint8Array.from(Buffer.from(readFileSync(env.ARENA_CREATOR_KEY_FILE, 'utf8').trim(), 'hex')) } : {};
// THE NEWEST VERSION, THE DAY'S OWN CENSUS, AND THE SEATS ASKED FIRST (kanban #689, 2026-10-26: "Make sure that we always post rounds properly
// for the next day. Harden it. Always the newest app version. We had too many failures."). Every grid this runner publishes - the day duty's,
// an emergency grid, the Up/Down, RPS and Tick Tock grid keepers - takes the census ARENA_CENSUS_DEPTH (6) below the tip at the time it is
// built (not the one this runner stood up at its start: 10-20 and 10-26 days named a census from before their version's adverts), the
// newest version of its app that census can draw a committee for (src/duty-guard.js pickNewestVersion: GET /games of the seats for the
// manifests, the census's adverts for who hosts them - a DUTY_*_PLUGIN pin older than that is refused, loudly), and is published only when
// a majority of the seats asked follow the chain that census block is on (GET /headers) and the census carries enough game and settlement
// nodes for it (round-2of2.mjs openGrid `mustDraw`).
const guard = await import('../src/duty-guard.js');
const { decodeManifest, gameIdOf } = await import('../../arena-protocol/src/manifest.js');
const { blockHashOf } = await import('../../arena-protocol/src/chain.js');
const PROTOCOL = Number(env.ARENA_PROTOCOL_VERSION || 1);
const CENSUS_DEPTH = Number(env.ARENA_CENSUS_DEPTH ?? 6);
const ZERO32 = new Uint8Array(32);
// THE DEVELOPER KEY EACH APP'S VERSIONS ARE SIGNED BY: a game of the same name under another key is not a version of it
const DEV_OF = { updown: toHex(UPDOWN_TN4.manifest.gameDevPubkey), rps: toHex(RPS_V1.manifest.gameDevPubkey), nextblock: toHex(NEXTBLOCK.manifest.gameDevPubkey) };
const updownOf = (g) => ({ gameId: g.gameId, fields: { gameId: g.gameId, simCoreHash: ZERO32, configHash: ZERO32, minScore: 0 }, periodMs: Number(g.manifest.roundPeriodMs), marketTerms: g.manifest.marketTerms });
// THE PIN FOR A DAY SLOT (DUTY_*_PLUGIN / _NEXT_PLUGIN / _FROM_SLOT, as before #689) - now an override the newest version refuses when older
const pinnedFor = (game, slot) => {
  if (game === 'updown') {
    const g = UPDOWN_NEXT && slot >= Number(env.DUTY_UPDOWN_NEXT_FROM_SLOT || 0) ? UPDOWN_NEXT : UPDOWN_CHOSEN && slot >= Number(env.DUTY_UPDOWN_FROM_SLOT || 0) ? UPDOWN_CHOSEN : null;
    return g ? updownOf(g) : null;
  }
  if (game === 'rps') return RPS_CHOSEN_FIELDS && slot >= Number(env.DUTY_RPS_FROM_SLOT || 0) ? { gameId: RPS_CHOSEN_FIELDS.gameId, fields: RPS_CHOSEN_FIELDS } : null;
  const nb = (NB_NEXT_FIELDS && slot >= Number(env.DUTY_NEXTBLOCK_FROM_SLOT || 0) ? NB_NEXT_FIELDS : NB_PLUGIN_FIELDS)
    || (env.DUTY_NEXTBLOCK_V3 === '1' || env.NB90_V3 === '1' ? { gameId: NEXTBLOCK_V3.gameId, simCoreHash: fromHex(TRUCK_F0CC_HASH) } : null);
  return nb ? { gameId: nb.gameId, fields: nb } : null;
};
// AND THE BUILT-IN ONE: no pin, and neither the seats nor the census read
const builtinFor = (game) => (game === 'updown' ? updownOf(PROTOCOL >= 2 ? UPDOWN_V2 : UPDOWN_TN4)
  : game === 'rps' ? { gameId: RPS_ROUND_FIELDS.gameId, fields: RPS_ROUND_FIELDS } : { gameId: null, fields: {} });
const localSeats = () => ports.map((p) => `http://${NODE_HOST}:${p}`);
const donationSetAt = (height) => {
  const keys = donationKeysForNetworkId(round.contract.networkId);
  const forced = donationSetInForce({ networkId: round.contract.networkId, authority: keys.authority, recovery: keys.recovery,
    sets: [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS],
    rotations: [], height, verify: (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } } });
  if (!forced.ok) throw new Error(`no donation set in force at census height ${height}: ${forced.why}`);
  return idOfDonationSet(forced.recipients);
};
// THE NEWEST DRAWABLE VERSION ON THE CENSUS OF NOW, THE SEATS' CATALOG AND CHAINS (src/duty-day.js createGridBase, kanban #702: the node's
// own duty poster runs the same code) - this runner's seats for the catalog, its seats and the census's others for the chains
const { createGridBase, createDayDuty } = await import('../src/duty-day.js');
const { gridBase, seatCatalog, seatChains, agreementOf } = createGridBase({ chainCall, prepare: (h) => round.dutyChain.viewFor(h),
  censusEntriesAt: (h) => round.dutyChain.censusEntriesAt(h), contractAt: (_game, h) => ({ ...round.contract, censusHeight: h }),
  catalogSeats: localSeats, chainSeats: () => round.dutyChain.seatUrls(), localCount: ports.length, devOf: DEV_OF, protocolFor: () => PROTOCOL,
  pinnedFor, builtinFor, cores: { nextblock: env.DUTY_NEXTBLOCK_CORE, rps: env.DUTY_RPS_CORE },
  rpsBase: { blockTicks: RPS_FIELDS_V1.blockTicks, startDeadlineTicks: RPS_FIELDS_V1.startDeadlineTicks }, donationSetAt,
  censusDepth: CENSUS_DEPTH, checkSeats: Number(env.DUTY_CHECK_SEATS || 16), decode: decodeManifest, idOf: gameIdOf, blockHashOf, say });
// THE DUTY TO POST THE NEXT 24 H (2026-10-13 ~18:35Z; arena-protocol/src/duty.js, spec §5A.5): PAID_DUTY=1 runs ONE
// plan item - DUTY_APP (rps | updown) in DUTY_FEDERATION (federation id hex), named DUTY_ITEM - on every machine of the network. Every
// 30 s it reads the chain: the slot's anchor, the census there, the duty order; when the node on duty for the current slot is one this
// machine runs (DUTY_LOCAL_KEYS, else its own daemons) it posts what slotsToPost names - its own slot and, from 5 min in, every missed
// slot of the last 20, oldest first - one grid of the slot's target hour, carrying the duty marker, then the series to every seat.
// Every other machine posts nothing. DUTY_DRY=1: decide and say, publish nothing.
if (env.PAID_DUTY === '1') {
  const { slotOf, slotStartMs, targetWindow, anchorHeight, dutyOrder, dutyMarkerOutput, dutyMarkersOf, itemTag, slotsToPost, DUTY_COMMITTEE_LEAD_MS }
    = await import('../../arena-protocol/src/duty.js');
  const { medianTimePast } = await import('../../arena-protocol/src/beacon.js');
  const item = env.DUTY_ITEM, game = env.DUTY_APP, fed = String(env.DUTY_FEDERATION || '').toLowerCase();
  if (!item || !['rps', 'updown', 'nextblock'].includes(game) || !/^[0-9a-f]{64}$/.test(fed)) throw new Error('PAID_DUTY=1 needs DUTY_ITEM, DUTY_APP rps|updown|nextblock and DUTY_FEDERATION');
  const tag = toHex(itemTag(item));
  const local = new Set((env.DUTY_LOCAL_KEYS ? env.DUTY_LOCAL_KEYS.split(',') : round.daemons.map((d) => toHex(d.round.pubkey))).map((k) => k.trim().toLowerCase()));
  const feeRate = Number(env.DUTY_FEE_RATE || 2), maxFeeRate = Number(env.DUTY_MAX_FEE_RATE || 8);
  const dry = env.DUTY_DRY === '1';
  // DUTY_FROM_SLOT: the first slot this duty owns - the slots before it were covered by the grids published before the duty began
  // (the 24 h keepers), so they are never caught up
  const fromSlot = Number(env.DUTY_FROM_SLOT || 0);
  const dir = join(home, 'paid', 'duty'); mkdirSync(dir, { recursive: true });
  const fileOf = (slot) => join(dir, `${item}-${slot}.json`);
  const UPDOWN = UPDOWN_CHOSEN || (Number(env.ARENA_PROTOCOL_VERSION || 1) >= 2 ? UPDOWN_V2 : UPDOWN_TN4);
  const inflight = new Set();
  const censusAt = new Map();
  let busy = false, lastSaid = '';
  const donationSet = () => {
    const keys = donationKeysForNetworkId(round.contract.networkId);
    const forced = donationSetInForce({ networkId: round.contract.networkId, authority: keys.authority, recovery: keys.recovery,
      sets: [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS],
      rotations: [], height: round.contract.censusHeight,
      verify: (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } } });
    if (!forced.ok) throw new Error(`no donation set in force at census height ${round.contract.censusHeight}: ${forced.why}`);
    return idOfDonationSet(forced.recipients);
  };
  // ONE GRID FOR THE SLOT'S TARGET HOUR, the marker beside its series; published, saved, then posted to every seat
  const post = async (slot) => {
    const { startMs } = targetWindow(slot);
    const committee = BigInt(startMs - DUTY_COMMITTEE_LEAD_MS);
    const marker = dutyMarkerOutput(slot, item);
    const common = { feeRate, maxFeeRate, committeeTimeMs: committee, extraOutputs: [marker], waitBeacon: false };
    const got = game === 'nextblock'
      // TICK TOCK (the run game): 90 s rounds, entries open 45 s into each (the late join), 40 an hour, the runner's own game and core
      ? await round.openGrid({ ...CREATOR, fields: { donationSetId: donationSet(), federationId: fromHex(fed) }, stakeMsat },
        { ...common, slots: 40, tables: 1, windowMs: 90000n, entryAfterStartMs: 45000n, firstCloseMs: BigInt(startMs + 45000) })
      : game === 'rps'
      ? await round.openGrid({ ...CREATOR, fields: { ...RPS_ROUND_FIELDS, donationSetId: donationSet(), federationId: fromHex(fed) }, stakeMsat },
        { ...common, slots: Number(env.DUTY_RPS_SLOTS || 450), tables: Number(env.DUTY_RPS_TABLES || 2), windowMs: 8000n, entryAfterStartMs: 80000n,
          firstCloseMs: BigInt(startMs + 80000) })
      : await round.openGrid({ ...CREATOR, fields: { gameId: UPDOWN.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32), minScore: 0,
        donationSetId: donationSet(), federationId: fromHex(fed) }, stakeMsat,
        stakeExpiryFor: (t) => { const n = marketExpiryBlocks(t, UPDOWN.manifest.marketTerms); if (!n.ok) throw new Error(n.why); return n.blocks; } },
        { ...common, slots: 3600000 / Number(UPDOWN.manifest.roundPeriodMs), tables: 1, windowMs: BigInt(UPDOWN.manifest.roundPeriodMs), entryAfterStartMs: 0n,
          firstCloseMs: BigInt(startMs) });
    if (got.dry) { say({ duty: 'grid dry', item, slot, accepted: got.accepted, reject: got.reject, rounds: got.rounds, bytes: got.bytes, feeSat: got.feeSat,
      firstStart: got.firstStart, lastClose: got.lastClose, committeeTime: got.committeeTime }); return; }
    if (!got.ok) throw new Error(got.why || 'the grid was not published');
    writeFileSync(fileOf(slot), JSON.stringify({ item, slot, target: new Date(startMs).toISOString(), txid: got.txid, series: got.series, lines: got.lines, posted: null }) + '\n');
    say({ duty: 'published', item, slot, target: new Date(startMs).toISOString(), txid: got.txid, series: got.series.map((x) => x.slice(0, 16)), rounds: got.rounds });
    const posted = [];
    for (const line of got.lines) posted.push(await round.postSeries(line));
    writeFileSync(fileOf(slot), JSON.stringify({ item, slot, target: new Date(startMs).toISOString(), txid: got.txid, series: got.series, lines: got.lines, posted }) + '\n');
    say({ duty: 'posted', item, slot, seats: posted.map((p) => `${p.took}/${p.of}`), refused: posted.flatMap((p) => p.refused).slice(0, 3) });
  };
  const look = async () => {
    if (busy) return;
    busy = true;
    try {
      const view = await round.dutyChain.view();
      const headers = view.blocks.map((b) => b.header);
      const tip = view.firstHeight + headers.length - 1;
      const mtpAt = async (h) => { const m = medianTimePast(headers, view.firstHeight, h); return m === null ? -1 : m; };
      const nowMs = Date.now(), slot = slotOf(nowMs);
      const anchor = await anchorHeight(slot, { mtpAt, tip, low: view.firstHeight + 11 });
      if (anchor === null) { if (lastSaid !== `wait ${slot}`) say({ duty: 'no anchor yet', item, slot }); lastSaid = `wait ${slot}`; return; }
      if (!censusAt.has(anchor)) censusAt.set(anchor, round.dutyChain.censusKeysAt(anchor));
      const order = dutyOrder({ networkId: round.contract.networkId, slot, nodeKeys: censusAt.get(anchor) });
      const onDuty = order.length > 0 && local.has(toHex(order[0]));
      // POSTED: a marker of this item in the chain's last 30 h of blocks or in the mempool - and what this keeper itself has in flight
      const posted = new Set(inflight);
      for (let i = slot - 30; i < fromSlot; i++) posted.add(i);
      for (const b of view.blocks.slice(-200)) for (const raw of b.transactions || []) for (const m of dutyMarkersOf(raw)) if (m.tag === tag) posted.add(m.slot);
      try { for (const txid of await chainCall('getrawmempool', [])) { const hex = await chainCall('getrawtransaction', [txid]); for (const m of dutyMarkersOf(fromHex(hex))) if (m.tag === tag) posted.add(m.slot); } } catch { /* the chain's say only */ }
      const todo = slotsToPost({ nowMs, onDuty, posted });
      const said = `${slot} ${toHex(order[0] || new Uint8Array(32)).slice(0, 8)} ${onDuty} ${todo.join(',')}`;
      if (said !== lastSaid) say({ duty: onDuty ? 'on duty' : 'off duty', item, slot, anchor, dutyNode: toHex(order[0] || new Uint8Array(32)), census: order.length, todo });
      lastSaid = said;
      for (const i of (env.DUTY_ONLY_SLOT ? todo.filter((x) => x === Number(env.DUTY_ONLY_SLOT)) : todo)) {
        if (dry) { say({ duty: 'dry: would post', item, slot: i, target: new Date(targetWindow(i).startMs).toISOString() }); continue; }
        inflight.add(i);
        try { await post(i); if (process.env.ARENA_GRID_DRY === '1') inflight.delete(i); } catch (e) { inflight.delete(i); say({ duty: 'not posted', item, slot: i, why: e.message }); }
      }
    } catch (e) { say({ duty: 'look failed', item, why: e.message }); } finally { busy = false; }
  };
  look(); setInterval(look, 30000);
}
// ONE POSTING PER GAME PER DAY, AT THE LOWEST FEE (2026-10-14 ~11:22Z: "Each game may only have one round posting per day and the
// fees must be as low as possible"). PAID_DUTY_DAILY=1 runs one game (DUTY_APP rps | updown | nextblock) for every federation in
// DUTY_FEDERATIONS (hex, comma-separated) on every machine. Day d's duty node (duty.js: the census at the day's anchor in duty order;
// the next one an hour later while the day is not posted) publishes ONE transaction: the next UTC day's rounds of this game in every
// federation - RPS 2 tables of 8 s rounds each, Up/Down its 96 x 15 min, Tick Tock 960 x 90 s - plus the day's marker, at DUTY_FEE_RATE
// (default 0.1 sat/vB, the network's relay floor). Committee time: the day's start less 6 h. The series lines are kept and posted to
// every seat once the publication confirms (asked again each minute until every seat holds them).
// HARDENED (kanban #689, 2026-10-26: "Make sure that we always post rounds properly for the next day"): the committee 12 h before the day,
// the post no later than rank DUTY_DAY_RANK_CAP, the newest version on the census of the moment the seats follow (gridBase); every look
// judges today's and tomorrow's postings (publication below the beacon, beacon 6 deep, committee drawn on the seats), says a status line
// per day, re-posts no dead posting, and posts an emergency grid of what is left of a day that is dead or not drawable 4 h before it starts.
if (env.PAID_DUTY_DAILY === '1') {
  // DUTY_APP, OR THE NAME THE LIVE ENV FILES STILL CARRY (main 20dab1a renamed DUTY_GAME; the the test host's updown/rps env files name only DUTY_GAME)
  const game = env.DUTY_APP || env.DUTY_GAME;
  const feds = String(env.DUTY_FEDERATIONS || toHex(round.contract.federationId)).split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x));
  if (!['rps', 'updown', 'nextblock'].includes(game) || !feds.length) throw new Error('PAID_DUTY_DAILY=1 needs DUTY_APP rps|updown|nextblock and DUTY_FEDERATIONS');
  const item = env.DUTY_ITEM || `${game}-day`;
  const local = new Set((env.DUTY_LOCAL_KEYS ? env.DUTY_LOCAL_KEYS.split(',') : round.daemons.map((d) => toHex(d.round.pubkey))).map((k) => k.trim().toLowerCase()));
  // THE DAY'S TIMELINE (kanban #689 d; src/duty-guard.js): the committee DUTY_DAY_COMMITTEE_LEAD_MS (12 h) before the day, the post from at most
  // rank DUTY_DAY_RANK_CAP (2) of the duty order, drawable on the seats DUTY_DRAWABLE_BY_MS (4 h) before the day or an emergency grid;
  // DUTY_EMERGENCY=0 turns emergency grids off (said, never posted)
  const committeeLeadMs = Number(env.DUTY_DAY_COMMITTEE_LEAD_MS || guard.DUTY_DAY_COMMITTEE_LEAD_MS);
  const rankCap = Number(env.DUTY_DAY_RANK_CAP ?? guard.DUTY_DAY_RANK_CAP);
  const drawableByMs = Number(env.DUTY_DRAWABLE_BY_MS || guard.DUTY_DRAWABLE_BY_MS);
  const emergencyOn = env.DUTY_EMERGENCY !== '0';
  const { daySlotOf } = await import('../../arena-protocol/src/duty.js');
  say({ dutyDay: 'timeline', item, committeeLeadH: committeeLeadMs / 3600000, rankCap, drawableByH: drawableByMs / 3600000, emergency: emergencyOn,
    next: (() => { const t = guard.dayTimeline(daySlotOf(Date.now()), { committeeLeadMs, cap: rankCap, drawableByMs }); return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k === 'slot' ? v : new Date(v).toISOString()])); })() });
  // A DRAINING FEDERATION'S DAYS GO TO ITS SUCCESSOR (kanban #502/#549, 2026-10-20: "it may not be a manual step"): before each
  // posting the seats' signed records are read (GET /federations, the first seat that answers); a federation named here whose record is
  // DRAINING (or CRITICAL while draining) and names an OPEN successor is posted as that successor - no round names a draining one
  // the seats' public addresses through ARENA_ROUTE_MAP when it is set (a machine that cannot reach its own Funnel)
  const { parseRoutes, routed } = await import('../src/fetch-routes.js');
  const routes = parseRoutes(env.ARENA_ROUTE_MAP);
  const { successorsOf } = await import('../src/duty-poster.js');
  const fedsNow = async () => {
    // DUTY_RECORDS_FROM (a seat's direct address) first: a runner beside its seats reads them there
    for (const n of [...(env.DUTY_RECORDS_FROM ? [env.DUTY_RECORDS_FROM] : []), ...(round.nodes || [])]) {
      try {
        const base = String(n).replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
        const r = await fetch(routed(base + '/federations', routes), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const got = successorsOf(feds, (await r.json()).federations || []);
        for (const m of got.moved) say({ dutyDay: 'successor', item, ...m });
        return got.feds;
      } catch { /* the next seat */ }
    }
    return feds;
  };
  // THE SERIES' CREATORS AS THE LOCAL SEATS HOLD THEM (kanban #1168): read again at most every 2 min, and at once for a series not seen yet
  const { schnorr: { getPublicKey: schnorrPub } } = await import('@noble/curves/secp256k1.js');
  let seatCreators = new Map(), seatCreatorsAt = 0;
  const readSeatCreators = async () => {
    const m = new Map();
    for (const u of localSeats()) {
      for (const path of ['/series', '/expected']) {
        try {
          const r = await fetch(`${u}${path}`, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) continue;
          const j = await r.json();
          for (const x of (path === '/series' ? j.series : j.expected) || []) if (x && x.series && /^[0-9a-f]{64}$/.test(String(x.creator || ''))) m.set(String(x.series), String(x.creator));
        } catch { /* the next seat */ }
      }
      if (m.size) break;
    }
    return m;
  };
  const dutyCreatorOf = async (idHex) => {
    if (!seatCreators.has(idHex) && Date.now() - seatCreatorsAt > 120000) { seatCreators = await readSeatCreators(); seatCreatorsAt = Date.now(); }
    return seatCreators.get(idHex) || null;
  };
  // THE DAY'S DUTY ITSELF (src/duty-day.js, kanban #702): the node's own duty poster runs the same engine
  const duty = createDayDuty({ game, item, networkId: round.contract.networkId, local, dir: join(home, 'paid', 'duty-day'),
    chain: round.dutyChain, chainCall, walletRpc: rpc, gridBase, openGrid: (kind, opts) => round.openGrid(kind, opts),
    postSeries: (line) => round.postSeries(line), fedsNow, seatCatalog, devOf: DEV_OF, creator: CREATOR, stakeMsat,
    feeRate: Number(env.DUTY_FEE_RATE || 0.1), maxFeeRate: Number(env.DUTY_MAX_FEE_RATE || 1), dry: env.DUTY_DRY === '1', gridDry: env.ARENA_GRID_DRY === '1',
    fromDay: Number(env.DUTY_FROM_DAY || 0), committeeLeadMs, rankCap, drawableByMs, emergencyOn,
    emergencyCommitteeLeadMs: Number(env.DUTY_EMERGENCY_COMMITTEE_LEAD_MS || guard.DUTY_EMERGENCY_COMMITTEE_LEAD_MS), seedWaitMs: Number(env.DUTY_SEED_WAIT_MS || guard.DUTY_SEED_WAIT_MS),
    drawSeats: Number(env.DUTY_DRAW_SEATS || 12), dryRank0: env.DUTY_DRY_RANK0 === '1',
    seatsAgreeOn: async (hash) => agreementOf(hash, await seatChains()), say,
    // WHO A DAY MARKER IS FROM (kanban #1168, duty-day.js MARKER): the creator of a series a local seat holds (GET /series) or was announced
    // (GET /expected), its line's signature checked there; this runner's own creator key and DUTY_CREATORS count beside the day's duty order
    creatorOf: dutyCreatorOf, creators: [...(CREATOR.creatorSecret ? [toHex(schnorrPub(CREATOR.creatorSecret))] : []),
      ...String(env.DUTY_CREATORS || '').split(',').map((x) => x.trim()).filter(Boolean)] });
  const look = () => duty.look();
  look(); setInterval(look, 60000);
}
// TICK TOCK IN 90 s ROUNDS, NOW (2026-10-14 ~10:26Z, his phone on the Tick Tock lobby: "Sollte es nicht eine 90s Runde sein?").
// The rounds open were the old grid keeper's - four rounds a grid, each taking entries for six hours - and the duty publisher's
// 90 s grids (40 an hour) start only where those end (DUTY_FROM_SLOT, 10-16 03:00Z). PAID_NB90_GRID=1 publishes ONE grid in the
// duty's own Tick Tock shape - 90 s rounds, entry closing 45 s into each (the late join), the runner's game and core - from the
// first start a grid published now can have to NB90_UNTIL (ms or ISO), in NB90_FEDERATION (hex, default the runner's own), posts
// it to every seat and exits. Timing as the on-demand RPS grid: committee 45 min past the tip's median, the first start at least
// 45 min after the committee and NB90_LEAD_MS (default 2 h) from now.
if (env.PAID_NB90_GRID === '1') {
  const until = Number.isFinite(Number(env.NB90_UNTIL)) ? Number(env.NB90_UNTIL) : Date.parse(env.NB90_UNTIL || '');
  if (!Number.isFinite(until)) throw new Error('PAID_NB90_GRID=1 needs NB90_UNTIL (ms or ISO)');
  const fed = String(env.NB90_FEDERATION || toHex(round.contract.federationId)).toLowerCase();
  const mtp = Number((await chainCall('getblockchaininfo', [])).mediantime) * 1000;
  const committee = mtp + Number(env.NB90_COMMITTEE_LEAD_MS || 45 * 60000) + 500;
  const firstStart = Math.ceil(Math.max(Date.now() + Number(env.NB90_LEAD_MS || 2 * 3600000), committee + 45 * 60000 + 1000) / 90000) * 90000;
  // AT MOST ONE DAY: a grid series runs at most 24 h (series.js gridIsValid) - the duty takes over where it ends
  const slots = Math.min(Math.floor((until - firstStart) / 90000), 960);
  if (slots < 1) throw new Error(`no 90 s round fits between ${new Date(firstStart).toISOString()} and ${new Date(until).toISOString()}`);
  // THE NEWEST TICK TOCK THE CENSUS CAN DRAW (kanban #689; 10-25: this path posted the built-in core a5c5766a no seat held, and NB90_V3=1
  // an old version): the day's census and version as the duty's own (gridBase) - NB90_V3 / DUTY_NEXTBLOCK_PLUGIN a pin it refuses when older
  const base = await gridBase('nextblock');
  if (!base.ok) throw new Error(`PAID_NB90_GRID: nothing published: ${base.why}`);
  say({ nb90: 'asked', federation: fed.slice(0, 16), game: String(base.id || 'the runner\'s').slice(0, 16), version: base.version, censusHeight: base.censusHeight, committeeTime: new Date(committee).toISOString(), firstStart: new Date(firstStart).toISOString(),
    until: new Date(until).toISOString(), slots });
  const got = await round.openGrid({ ...CREATOR, fields: { ...base.fields, censusHeight: base.censusHeight, donationSetId: base.donationSetId, federationId: fromHex(fed) }, stakeMsat, mustDraw: true },
    { slots, tables: 1, windowMs: 90000n, entryAfterStartMs: 45000n, firstCloseMs: BigInt(firstStart + 45000), committeeTimeMs: BigInt(committee),
      feeRate: Number(env.NB90_FEE_RATE || 1), maxFeeRate: Number(env.NB90_MAX_FEE_RATE || 4),
      onPublished: ({ contracts, ...p }) => { writeFileSync(join(home, 'paid', `nb90-grid-${p.txid}.json`), JSON.stringify({ ...p, contracts }) + '\n'); say({ nb90: 'published', ...p }); },
      onPosted: (p) => say({ nb90: 'posted', ...p }) });
  say({ nb90: got.ok ? 'up' : 'not up', ok: got.ok, why: got.why, txid: got.txid, publishedAt: got.publishedAt, beacon: got.beacon, rounds: got.rounds,
    firstStart: got.firstStart, lastClose: got.lastClose, posted: got.posted });
  process.exit(got.ok ? 0 : 1);
}
// PAID ROCK PAPER SCISSORS ON DEMAND (2026-10-11, path B - "a grid published on demand: when a table
// waits, one transaction carries the next 30 min of rounds, about an hour ahead"). Every 30 s the seats' GET /h2h-want is
// read; when a page asked within the last 3 min and no published grid runs more than RPS_GRID_AHEAD_MS ahead, the next
// grid is published - one short series per table since 2026-10-12 (round-2of2.mjs openGrid): committee_time 45 min past
// the tip's median time (so the publication confirms below its beacon), the
// first close 105 min from now - or 8 s after the last grid's, when that is later, so a table plays on without a hole.
// RPS_GRID_NOW=1 publishes the first grid without waiting for a page's ask.
if (env.PAID_RPS_GRID === '1') {
  // THE CHOSEN VERSION, AS A DAY POSTS IT (kanban #689, 2026-10-26, the owner: "Always the newest app version"): the grid built every
  // round from the built-in version's fields (RPS_ROUND_FIELDS) and ignored DUTY_RPS_PLUGIN
  const RPS_GRID_FIELDS = RPS_CHOSEN_FIELDS || RPS_ROUND_FIELDS;
  const slots = Number(env.RPS_GRID_SLOTS || 225), tables = Number(env.RPS_GRID_TABLES || 2);
  const aheadMs = Number(env.RPS_GRID_AHEAD_MS || 100 * 60000), leadMs = Number(env.RPS_GRID_LEAD_MS || 120 * 60000);
  // RPS_GRID_FEE_RATE (sat/vB, 2026-10-12 "Mach das deutlich sparsamer"): under the wallet's 1 sat/vB down to the
  // node's 0.1 - a block without the grid raises it (doubling, to RPS_GRID_MAX_FEE_RATE)
  const feeRate = Number(env.RPS_GRID_FEE_RATE || 1), maxFeeRate = Number(env.RPS_GRID_MAX_FEE_RATE || 4);
  // RPS_GRID_AFTER_MS: a grid already running when this keeper starts (its last close, ms) - the next one's first close comes
  // 8 s after it, so a restart does not lay a second grid over the running one
  let lastCloseMs = Number(env.RPS_GRID_AFTER_MS || 0), busy = false, now1 = env.RPS_GRID_NOW === '1';
  const gid = toHex(RPS_GRID_FIELDS.gameId);
  // A PAGE'S ASK FOR ANY VERSION OF THE GAME (kanban #689): the lobby asks for the version it shows, the newest, not the built-in one
  const rpsIds = async () => new Set([gid, ...[...((await seatCatalog().catch(() => null)) || new Map()).values()].filter((g) => g.name === guard.DUTY_APP_NAMES.rps && g.dev === DEV_OF.rps).map((g) => g.id)]);
  const look = async () => {
    if (busy) return;
    let wantAt = 0;
    try { const w = (await (await fetch(`http://${NODE_HOST}:${pa}/h2h-want`, { signal: AbortSignal.timeout(5000) })).json()).wants || {}; const ids = await rpsIds();
      wantAt = Math.max(0, ...Object.entries(w).filter(([k]) => ids.has(k)).map(([, v]) => Number(v) || 0)); } catch { if (!now1) return; }
    if (now1) { wantAt = Date.now(); now1 = false; }
    // RPS_GRID_ALWAYS=1 (2026-10-13 ~21:45Z: paid rounds of all 3 games in both federations by 10:00): tables are kept
    // published ahead whether or not a page asked - since pick (c) an empty table makes no claim key and is seated once
    if (env.RPS_GRID_ALWAYS === '1') wantAt = Date.now();
    if (Date.now() - wantAt > 180000 || lastCloseMs > Date.now() + aheadMs) return;
    busy = true;
    try {
      const mtp = Number((await chainCall('getblockchaininfo', [])).mediantime) * 1000;
      // 45 min past the tip's median: the median climbs about 20 min a block, so the publication has two blocks to confirm in
      // before the median passes it. On testnet4 the median runs ahead of the clock (74 min at 18:01Z), and a round starts
      // only after its committee time - so the first close is also at least 5 min past it (measured 17:54-17:59Z: with the
      // committee 60 min past a median 2 h ahead, every grid started before its committee time and none was published)
      // RPS_GRID_COMMITTEE_LEAD_MS (measured 2026-10-12: testnet4's coinbase-only blocks move the median ~20 min each
      // while a block that takes transactions came 2.5 h apart - grid 39101772 (committee 45 min out) saw its beacon before
      // its publication confirmed): how far past the tip's median the committee time is, so a real block has that long
      const committee = mtp + Number(env.RPS_GRID_COMMITTEE_LEAD_MS || 45 * 60000) + 500;
      // AND A SHORT SERIES' LEAD (2026-10-12, S; series.js gridIsValid): the first start - 80 s before the first close -
      // at least 45 min after the committee time
      // AND THE BEACON SIX DEEP BEFORE THE FIRST SEATING (kanban #494/#543, measured 2026-10-21): a grid's table is seated once, by
      // its first round, and the seats post a round only once its beacon is 6 deep - grid 2887838f (published 157,165, beacon
      // 157,178) was posted at 157,184, 05:47Z, after its first round's start 05:28Z, so no table was ever seated and every paid
      // entry was refused ("no certificate naming its game signer nodes"). With blocks 20 min apart the first close is at least
      // RPS_GRID_SEED_WAIT_MS (default 7 blocks, 140 min) past the committee time
      const seedWait = Number(env.RPS_GRID_SEED_WAIT_MS || 140 * 60000);
      const firstClose = Math.max(Date.now() + leadMs, committee + Math.max(45 * 60000, seedWait) + 80000 + 1000, lastCloseMs + 8000);
      // THE DONATION SET IN FORCE AT THE GRID'S CENSUS HEIGHT, as every seat checks it (server.js donationSetFor; measured
      // 17:54Z: grid 474c23f1 named the harness's older set and seat 31281 refused its first round - "at census height
      // 156098 this network's donation set in force is serial 3")
      // AND THE NEWEST VERSION ON THE CENSUS OF NOW (kanban #689: this path built the built-in version and ignored DUTY_RPS_PLUGIN - the
      // Up/Down grid's fault of cff99fe5 again): gridBase, as every grid of this runner
      const base = await gridBase('rps');
      if (!base.ok) throw new Error(`nothing published: ${base.why}`);
      const donationSetId = base.donationSetId;
      say({ rpsGrid: 'asked', wantAt: new Date(wantAt).toISOString(), slots, tables, version: base.version, game: String(base.id || '').slice(0, 16), committeeTime: new Date(committee).toISOString(), firstClose: new Date(firstClose).toISOString() });
      say({ rpsGrid: 'donation set', id: toHex(donationSetId).slice(0, 16), censusHeight: base.censusHeight });
      // THE FEDERATION THIS GRID NAMES (§23A.3,: "A seat opening a round names the OPEN federation with the
      // lowest load among those its own bond qualifies it to serve"): the seats' signed records (GET /federations), over the
      // federations this opener holds an invite for - its own, and ARENA_OTHER_FEDERATION_INVITES (comma-separated)
      const own = toHex(round.contract.federationId);
      const serves = [own, ...String(env.ARENA_OTHER_FEDERATION_INVITES || '').split(',').map((x) => x.trim()).filter(Boolean)
        .map((inv) => { try { return String(readInvite(inv).federationId); } catch { return null; } }).filter(Boolean)];
      let fedPick = { federationId: own, load: null, why: 'the seats\' federation records were not read: its own' };
      try {
        const fl = await (await fetch(`http://${NODE_HOST}:${pa}/federations`, { signal: AbortSignal.timeout(15000) })).json();
        fedPick = openingFederation({ listed: fl.federations || [], serves, own });
      } catch { /* its own, said above */ }
      say({ rpsGrid: 'federation', ...fedPick, serves: serves.map((f) => f.slice(0, 16)) });
      // A HEAD-TO-HEAD ROUND'S 60 s WINDOW (§13A, RULED 2026-11-10, kanban #1398): named only with RPS_H2H_WINDOW=1, once every seat takes it
      const h2hWindow = env.RPS_H2H_WINDOW === '1' ? { objectionWindowMs: 60_000n } : {};
      const got = await round.openGrid({ ...CREATOR, fields: { ...base.fields, ...h2hWindow, censusHeight: base.censusHeight, donationSetId, federationId: fromHex(fedPick.federationId) }, stakeMsat, mustDraw: true }, { slots, tables, feeRate, maxFeeRate, firstCloseMs: BigInt(firstClose), committeeTimeMs: BigInt(committee),
        onPublished: ({ contracts, ...p }) => { writeFileSync(join(home, 'paid', `rps-grid-${p.txid}.json`), JSON.stringify({ ...p, contracts }) + '\n'); say({ rpsGrid: 'published', ...p }); }, onPosted: (p) => say({ rpsGrid: 'posted', ...p }) });
      if (got.dry) { say({ rpsGrid: 'dry', ...got }); return; }
      say({ rpsGrid: got.ok ? 'up' : 'not up', ok: got.ok, why: got.why, txid: got.txid, publishedAt: got.publishedAt, beacon: got.beacon,
        rounds: got.rounds, posted: got.posted, lastClose: got.lastCloseMs ? new Date(Number(got.lastCloseMs)).toISOString() : undefined });
      if (got.ok) lastCloseMs = Number(got.lastCloseMs);
    } catch (e) { say({ rpsGridNotOpened: e.message }); } finally { busy = false; }
  };
  look(); setInterval(look, 30000);
}
// TICK TOCK AS A 24 H GRID (2026-10-13 ~22:00Z: "Poste immer 24h Runden"): PAID_NEXTBLOCK_GRID=1 keeps one table of
// NB_GRID_SLOTS (default 4: 24 h) rounds of the single rounds' own shape - NB_GRID_PERIOD_MS (default 6 h) apart, each open for
// entries its whole period, so one closes as the next starts - published NB_GRID_AHEAD_MS (default 30 h) ahead in the runner's
// own federation, game and core, each table right after the last (NB_GRID_AFTER_MS: a table already published, its last close).
if (env.PAID_NEXTBLOCK_GRID === '1') {
  const slots = Number(env.NB_GRID_SLOTS || 4), period = Number(env.NB_GRID_PERIOD_MS || 6 * 3600000);
  const aheadMs = Number(env.NB_GRID_AHEAD_MS || 30 * 3600000);
  const feeRate = Number(env.NB_GRID_FEE_RATE || 2), maxFeeRate = Number(env.NB_GRID_MAX_FEE_RATE || 8);
  let lastCloseMs = Number(env.NB_GRID_AFTER_MS || 0), busy = false;
  const keep = async () => {
    if (busy || lastCloseMs > Date.now() + aheadMs) return;
    busy = true;
    try {
      const mtp = Number((await chainCall('getblockchaininfo', [])).mediantime) * 1000;
      const committee = mtp + Number(env.NB_GRID_COMMITTEE_LEAD_MS || 4 * 3600000) + 500;
      const firstClose = Math.max(committee + 45 * 60000 + period + 1000, Date.now() + 60000, lastCloseMs + period);
      // THE NEWEST TICK TOCK ON THE CENSUS OF NOW (kanban #689), as every grid of this runner
      const base = await gridBase('nextblock');
      if (!base.ok) throw new Error(`nothing published: ${base.why}`);
      const own = toHex(round.contract.federationId);
      say({ nbGrid: 'asked', slots, version: base.version, game: String(base.id || '').slice(0, 16), committeeTime: new Date(committee).toISOString(), firstClose: new Date(firstClose).toISOString(), federation: own.slice(0, 16) });
      const got = await round.openGrid({ ...CREATOR, fields: { ...base.fields, censusHeight: base.censusHeight, donationSetId: base.donationSetId, federationId: fromHex(own) }, stakeMsat, mustDraw: true },
        { slots, tables: 1, windowMs: BigInt(period), entryAfterStartMs: BigInt(period), firstCloseMs: BigInt(firstClose), committeeTimeMs: BigInt(committee), feeRate, maxFeeRate,
          onPublished: ({ contracts, ...p }) => { writeFileSync(join(home, 'paid', `nb-grid-${p.txid}.json`), JSON.stringify({ ...p, contracts }) + '\n'); say({ nbGrid: 'published', ...p }); },
          onPosted: (p) => say({ nbGrid: 'posted', ...p }) });
      if (got.dry) { say({ nbGrid: 'dry', ...got }); return; }
      say({ nbGrid: got.ok ? 'up' : 'not up', ok: got.ok, why: got.why, txid: got.txid, beacon: got.beacon, rounds: got.rounds, posted: got.posted,
        lastClose: got.lastCloseMs ? new Date(Number(got.lastCloseMs)).toISOString() : undefined });
      if (got.ok) lastCloseMs = Number(got.lastCloseMs);
    } catch (e) { say({ nbGridNotOpened: e.message }); } finally { busy = false; }
  };
  keep(); setInterval(keep, 60000);
}
// BITCOIN UP OR DOWN AS A GRID (2026-10-13 "Ja": Up/Down rounds tonight in every federation - a daily
// series needs 24 h from its committee to its start; a grid needs 45 min): PAID_UPDOWN_GRID=1 publishes one table of
// UPDOWN_GRID_SLOTS (default 96, 24 h) 15-minute windows on the UTC grid - each round's entries close at its start, its window
// the 15 min before (attested.js marketWindowOf) - on the lowest-load OPEN federation this opener serves, its locks lasting
// through the grid's last window (lock-expiry.js marketExpiryBlocks), and keeps the next one UPDOWN_GRID_AHEAD_MS ahead.
if (env.PAID_UPDOWN_GRID === '1') {
  // THE VERSION A DAY OF TODAY WOULD POST (2026-10-26 08:4xZ, the owner: "We should always play the newest version not v13"): the 10-26
  // emergency grid took DUTY_UPDOWN_PLUGIN (v13) and ignored DUTY_UPDOWN_NEXT_PLUGIN (v24 from day 20751). Since kanban #689 every grid
  // takes the newest version its census can draw (gridBase), read again for each grid - a version released while this keeper runs is posted
  const slots = Number(env.UPDOWN_GRID_SLOTS || 96);
  const aheadMs = Number(env.UPDOWN_GRID_AHEAD_MS || 3 * 3600000);
  const feeRate = Number(env.UPDOWN_GRID_FEE_RATE || 2), maxFeeRate = Number(env.UPDOWN_GRID_MAX_FEE_RATE || 4);
  let lastCloseMs = Number(env.UPDOWN_GRID_AFTER_MS || 0), busy = false;
  const keep = async () => {
    if (busy || lastCloseMs > Date.now() + aheadMs) return;
    busy = true;
    try {
      const base = await gridBase('updown');
      if (!base.ok) throw new Error(`nothing published: ${base.why}`);
      const UPDOWN = { gameId: base.fields.gameId, manifest: { name: 'btc-updown-15m', version: base.version, roundPeriodMs: base.periodMs, marketTerms: base.marketTerms } };
      const period = BigInt(base.periodMs);
      const mtp = Number((await chainCall('getblockchaininfo', [])).mediantime) * 1000;
      const committee = mtp + Number(env.UPDOWN_GRID_COMMITTEE_LEAD_MS || env.RPS_GRID_COMMITTEE_LEAD_MS || 45 * 60000) + 500;
      // the first close on the 15-minute UTC grid, at least 45 min past the committee time and right after the last grid's
      const p = Number(period);
      const firstClose = Math.ceil(Math.max(committee + 45 * 60000 + 1000, Date.now() + 60000, lastCloseMs + p) / p) * p;
      const own = toHex(round.contract.federationId);
      const serves = [own, ...String(env.ARENA_OTHER_FEDERATION_INVITES || '').split(',').map((x) => x.trim()).filter(Boolean)
        .map((inv) => { try { return String(readInvite(inv).federationId); } catch { return null; } }).filter(Boolean)];
      let fedPick = { federationId: own, load: null, why: 'the seats\' federation records were not read: its own' };
      try {
        const fl = await (await fetch(`http://${NODE_HOST}:${pa}/federations`, { signal: AbortSignal.timeout(15000) })).json();
        fedPick = openingFederation({ listed: fl.federations || [], serves, own });
      } catch { /* its own */ }
      say({ updownGrid: 'asked', game: toHex(UPDOWN.gameId).slice(0, 16), version: base.version, censusHeight: base.censusHeight, slots, committeeTime: new Date(committee).toISOString(),
        firstClose: new Date(firstClose).toISOString(), federation: fedPick.federationId.slice(0, 16) });
      const got = await round.openGrid({ ...CREATOR, fields: { ...base.fields, censusHeight: base.censusHeight,
        donationSetId: base.donationSetId, federationId: fromHex(fedPick.federationId) }, stakeMsat, mustDraw: true,
        stakeExpiryFor: (t) => { const n = marketExpiryBlocks(t, UPDOWN.manifest.marketTerms); if (!n.ok) throw new Error(n.why); return n.blocks; } },
        { slots, tables: 1, windowMs: period, entryAfterStartMs: 0n, firstCloseMs: BigInt(firstClose), committeeTimeMs: BigInt(committee), feeRate, maxFeeRate,
          onPublished: ({ contracts, ...p }) => { writeFileSync(join(home, 'paid', `updown-grid-${p.txid}.json`), JSON.stringify({ ...p, contracts }) + '\n'); say({ updownGrid: 'published', ...p });
            // AND WHAT IS ON ITS WAY, for the seats' GET /expected (kanban #559 aside, 2026-10-20: "Add an estimated message to markets
            // when it's currently no rounds but a new round is expected"): the market's page says when the first window opens and which block it waits for
            if (env.ARENA_EXPECTED_FILE) { try { writeFileSync(env.ARENA_EXPECTED_FILE, JSON.stringify({ game: UPDOWN.manifest.name || 'btc-updown-15m', gameId: toHex(UPDOWN.gameId),
              firstWindowMs: firstClose - Number(period), firstCloseMs: firstClose, lastCloseMs: firstClose + (slots - 1) * Number(period), slots, committeeTimeMs: committee,
              publication: { txid: p.txid, height: p.height ?? null }, federation: fedPick.federationId }) + '\n'); } catch (e) { say({ expectedNotWritten: e.message }); } } },
          onPosted: (p) => say({ updownGrid: 'posted', ...p }) });
      if (got.dry) { say({ updownGrid: 'dry', ...got }); return; }
      say({ updownGrid: got.ok ? 'up' : 'not up', ok: got.ok, why: got.why, txid: got.txid, beacon: got.beacon, rounds: got.rounds, posted: got.posted,
        lastClose: got.lastCloseMs ? new Date(Number(got.lastCloseMs)).toISOString() : undefined });
      if (got.ok) lastCloseMs = Number(got.lastCloseMs);
    } catch (e) { say({ updownGridNotOpened: e.message }); } finally { busy = false; }
  };
  keep(); setInterval(keep, 60000);
}
// PAID ROCK PAPER SCISSORS BACK TO BACK (2026-10-10: head-to-head needs no series, and a paid round is
// still paid - 100 sats as Tick Tock's): PAID_RPS=1 keeps a paying RPS round closing every 8 s, published ahead, at this
// runner's stake and custody (ARENA_PUBLISH_AHEAD=1 in this runner's environment)
if (env.PAID_RPS === '1')
  keepBackToBack(round, { fields: RPS_ROUND_FIELDS,
    tables: (() => { const count = tableCounter({ min: Number(env.RPS_MIN_TABLES || 3), spare: 1, gameId: toHex(ROCK_PAPER_SCISSORS.gameId) });
      return async () => { try { const d = await (await fetch(`http://${NODE_HOST}:${pa}/rounds?all=1`)).json(); return count(d.rounds || [], Date.now()); } catch { return 3; } }; })(),
    onOpen: ({ id, entryCloseMs, tookMs }) => say({ rps: id, entryClose: new Date(Number(entryCloseMs)).toISOString(), stakeMsat: String(stakeMsat), tookMs }),
    onError: (e) => say({ rpsNotOpened: e.message }) });
const stop = async () => { say({ stopping: true }); await round.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
