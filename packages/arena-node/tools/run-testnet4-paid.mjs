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
 *   ARENA_BITCOIND_URL=http://127.0.0.1:48332 ARENA_BITCOIND_COOKIE=/mnt/bitcoin/tn4/testnet4/.cookie \
 *   ARENA_STAKE_LOCK_BIN=... ARENA_FEDERATION_CLIENT_DIR=... ARENA_FEDERATION_INVITE_FILE=... \
 *   BLWP_WSS_31221=wss://seat.example.com/guardian-1 ... \
 *   node tools/run-testnet4-paid.mjs
 *
 * ARENA_ATTACH=1 (the owner 2026-09-29: the seven blwp-tn4-node units own the guardians): the seven nodes already run, one
 * process each (src/main.js on node-<k>.db, each starting its own guardian) - this runner starts none and opens no node
 * store. It reads each node's key from GET /identity and its bond from the chain, publishes and posts the rounds over
 * HTTP, names the paying ones in ARENA_FUNDED_ROUNDS_FILE and writes the page's bond proof to ARENA_ATTACH_PROOF_DIR,
 * both of which the nodes read. Each node makes each round's claim key itself, with its peers, on their own doors.
 *
 * ON ANOTHER CHAIN (kanban #148 step 6, the regtest harness tn4-tools-regtest.sh): ARENA_TN4_NETWORK (default testnet4) is
 * the round's network, and ARENA_TN4_PORTS (default the seven testnet4 seats) the seven node ports. The Funnel paths are
 * testnet4's alone, so another network neither reads nor adds them.
 */
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { standUpRound, keepBackToBack, tableCounter } from './round-2of2.mjs';
import { ROCK_PAPER_SCISSORS, RPS_ROUND_FIELDS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
// PAID_MARKET=1 (kanban #206): the paid round is a round of the regtest market the page pins - its seats host nextblock
// and the market, their bonds advertise both, and the round names the market's game with no core and no config
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET } from '../test/plugins/market/index.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { donationSetInForce } from '../../arena-protocol/src/authority.js';
import { donationKeysForNetworkId } from '../../arena-protocol/src/donation-keys.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { TESTNET4_DONATION_SET } from '../../arena-protocol/src/testnet4-donation-set.js';
import { TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS } from '../../arena-protocol/src/test-donation-sets.js';

const env = process.env;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
// SEVEN NODES, SEVEN GUARDIANS, ONE EACH (the owner 2026-09-27 10:04): /guardian-1..7 on the Funnel, 127.0.0.1:31221..31281
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
const round = await standUpRound({ host: '127.0.0.1', portA: pa, portB: pb, portC: pc, extraPorts: more,
  store: join(home, 'paid'), storePaths, network, wallet, cli, rpc,
  stakeMsat, federationId: fed.federationId, invite, guardianOf,
  // THE ENTRY WINDOW OUTLASTS THE BEACON: on testnet4 committee_time is passed by somebody else's blocks, about an
  // hour after publication, and entries open only then.
  entryWindowMs: BigInt(env.ARENA_ENTRY_WINDOW_MS || 6 * 3600 * 1000),
  // OR AN ENTRY CLOSE AT A WALL-CLOCK INSTANT (ISO), the window then fitted to it once committee_time is known
  ...(env.ARENA_ENTRY_CLOSE_AT ? { entryCloseAtMs: Date.parse(env.ARENA_ENTRY_CLOSE_AT) } : {}),
  signerNode: { closeAtEnd: true, stakeLocks: lock },
  // PAID_FIRST=0 (kanban #293, the RPS grid): no round of its own - only the grid keeper below publishes
  openFirst: env.PAID_FIRST !== '0',
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
// THE FUNDED GATEWAY STAYS IN THE LINK (the owner 2026-09-30 14:30 and the leadMs letter): a start used to write the link
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
// THE NEXT ONE-OFF 4 h BEFORE THE CURRENT ENTRY CLOSES (the owner 2026-09-30: "4 h is the lead"): a round is published first
// and joinable only once its beacon is 6 deep - measured 1.5-3 h on testnet4 - so opening it 60 s before the close left a
// 1.5-3 h gap every 6 h with no paid round to join.
// PAID_KEEP=0 (kanban #325, the regtest succession): no next round - with a short ARENA_ENTRY_WINDOW_MS every round closes
// within the 4 h lead, and the keeper opened one every 10 s (87 in run 13), mining the regtest chain past its federation
if (env.PAID_KEEP !== '0') round.keepOpen({ leadMs: 4 * 3600 * 1000, onOpen: (id) => say({ opened: id, stakeMsat: String(stakeMsat), custody: 'FEDERATION' }),
  onError: (e) => say({ paidNotOpened: e.message }) });
}
// PAID ROCK PAPER SCISSORS ON DEMAND (kanban #293, the owner 2026-10-11, path B - "a grid published on demand: when a table
// waits, one transaction carries the next 30 min of rounds, about an hour ahead"). Every 30 s the seats' GET /h2h-want is
// read; when a page asked within the last 3 min and no published grid runs more than RPS_GRID_AHEAD_MS ahead, the next
// grid is published: committee_time 40 min past the tip's median time (so the publication confirms below its beacon), the
// first close 105 min from now - or 8 s after the last grid's, when that is later, so a table plays on without a hole.
// RPS_GRID_NOW=1 publishes the first grid without waiting for a page's ask.
if (env.PAID_RPS_GRID === '1') {
  const slots = Number(env.RPS_GRID_SLOTS || 225), tables = Number(env.RPS_GRID_TABLES || 2);
  const aheadMs = Number(env.RPS_GRID_AHEAD_MS || 100 * 60000), leadMs = Number(env.RPS_GRID_LEAD_MS || 120 * 60000);
  let lastCloseMs = 0, busy = false, now1 = env.RPS_GRID_NOW === '1';
  const gid = toHex(ROCK_PAPER_SCISSORS.gameId);
  const look = async () => {
    if (busy) return;
    let wantAt = 0;
    try { wantAt = (await (await fetch(`http://127.0.0.1:${pa}/h2h-want`, { signal: AbortSignal.timeout(5000) })).json()).wants[gid] || 0; } catch { if (!now1) return; }
    if (now1) { wantAt = Date.now(); now1 = false; }
    if (Date.now() - wantAt > 180000 || lastCloseMs > Date.now() + aheadMs) return;
    busy = true;
    try {
      const mtp = Number((await chainCall('getblockchaininfo', [])).mediantime) * 1000;
      // 45 min past the tip's median: the median climbs about 20 min a block, so the publication has two blocks to confirm in
      // before the median passes it. On testnet4 the median runs ahead of the clock (74 min at 18:01Z), and a round starts
      // only after its committee time - so the first close is also at least 5 min past it (measured 17:54-17:59Z: with the
      // committee 60 min past a median 2 h ahead, every grid started before its committee time and none was published)
      const committee = mtp + 45 * 60000 + 500;
      const firstClose = Math.max(Date.now() + leadMs, committee + 5 * 60000, lastCloseMs + 8000);
      // THE DONATION SET IN FORCE AT THE GRID'S CENSUS HEIGHT, as every seat checks it (server.js donationSetFor; measured
      // 17:54Z: grid 474c23f1 named the harness's older set and seat 31281 refused its first round - "at census height
      // 156098 this network's donation set in force is serial 3")
      const keys = donationKeysForNetworkId(round.contract.networkId);
      const forced = donationSetInForce({ networkId: round.contract.networkId, authority: keys.authority, recovery: keys.recovery,
        sets: [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS],
        rotations: [], height: round.contract.censusHeight,
        verify: (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } } });
      if (!forced.ok) throw new Error(`no donation set in force at census height ${round.contract.censusHeight}: ${forced.why}`);
      const donationSetId = idOfDonationSet(forced.recipients);
      say({ rpsGrid: 'asked', wantAt: new Date(wantAt).toISOString(), slots, tables, committeeTime: new Date(committee).toISOString(), firstClose: new Date(firstClose).toISOString() });
      say({ rpsGrid: 'donation set', serial: String(forced.serial), id: toHex(donationSetId).slice(0, 16), censusHeight: round.contract.censusHeight });
      const got = await round.openGrid({ fields: { ...RPS_ROUND_FIELDS, donationSetId }, stakeMsat }, { slots, tables, firstCloseMs: BigInt(firstClose), committeeTimeMs: BigInt(committee),
        onPublished: ({ contracts, ...p }) => { writeFileSync(join(home, 'paid', `rps-grid-${p.txid}.json`), JSON.stringify({ ...p, contracts }) + '\n'); say({ rpsGrid: 'published', ...p }); }, onPosted: (p) => say({ rpsGrid: 'posted', ...p }) });
      say({ rpsGrid: got.ok ? 'up' : 'not up', ok: got.ok, why: got.why, txid: got.txid, publishedAt: got.publishedAt, beacon: got.beacon,
        rounds: got.rounds, posted: got.posted, lastClose: got.lastCloseMs ? new Date(Number(got.lastCloseMs)).toISOString() : undefined });
      if (got.ok) lastCloseMs = Number(got.lastCloseMs);
    } catch (e) { say({ rpsGridNotOpened: e.message }); } finally { busy = false; }
  };
  look(); setInterval(look, 30000);
}
// PAID ROCK PAPER SCISSORS BACK TO BACK (kanban #293, the owner 2026-10-10: head-to-head needs no series, and a paid round is
// still paid - 100 sats as Tick Tock's): PAID_RPS=1 keeps a paying RPS round closing every 8 s, published ahead, at this
// runner's stake and custody (ARENA_PUBLISH_AHEAD=1 in this runner's environment)
if (env.PAID_RPS === '1')
  keepBackToBack(round, { fields: RPS_ROUND_FIELDS,
    tables: (() => { const count = tableCounter({ min: Number(env.RPS_MIN_TABLES || 3), spare: 1, gameId: toHex(ROCK_PAPER_SCISSORS.gameId) });
      return async () => { try { const d = await (await fetch(`http://127.0.0.1:${pa}/rounds`)).json(); return count(d.rounds || [], Date.now()); } catch { return 3; } }; })(),
    onOpen: ({ id, entryCloseMs, tookMs }) => say({ rps: id, entryClose: new Date(Number(entryCloseMs)).toISOString(), stakeMsat: String(stakeMsat), tookMs }),
    onError: (e) => say({ rpsNotOpened: e.message }) });
const stop = async () => { say({ stopping: true }); await round.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
