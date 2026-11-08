#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * ONE ROUND THE TWO DAEMONS AGREE ON, AND THE URL THAT OPENS IT.
 *
 *   node packages/arena-node/tools/round-2of2.mjs
 *
 * The page can be SENT to a round now - `?round=` names an id and the client
 * refuses a contract that does not hash to it - and it names three other
 * things: who holds the round, where a chain is read, and where the bond
 * proof is asked for. The daemons publish the first. THEY PUBLISH NEITHER OF
 * THE OTHER TWO, and they should not: section 25.1 wants block headers "from
 * several independent sources", and a node serving the chain that proves its
 * own bond is one source wearing two hats. So the providers stand beside the
 * daemons, on their own ports, which is what an operator runs.
 *
 * WHAT THIS IS NOT. It is not a lobby: it agrees one round between two daemons
 * that already exist and prints the address of it. Nothing here is in the
 * page, and the page still invents nothing - it is handed names and it checks
 * them.
 *
 * THE CHAIN IS A FIXTURE AND IS SAID SO. Bitcoin's real genesis header with
 * one block mined on top of it at trivial difficulty, carrying the bond. That
 * is enough for `Client.at` to do every check it makes - the anchor is
 * genesis and comes from the client, the header must link and be mined, the
 * bond must be proven into it by a merkle branch, and the advertisement must
 * be signed by the key the committee names - and it is not a claim about
 * Bitcoin. A round played on it is a local test round. Reading a real chain is
 * the operator's own bitcoind, and no live node is touched from here.
 */
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { CORE_HASH } from './core-hash.mjs';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4 } from '../../arena-protocol/src/test-donation-sets.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync as writeProof, mkdirSync as mkProofDir } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { openStore, nodeIdentity } from '../src/store.js';
import { chainBeacon } from '../src/beacon-source.js';
import { awaitPublishedBeacon } from '../src/publication-wait.js';
import { buildGrid, publishGridTx, announceGrid, postSeriesLine } from '../src/grid-build.js';
import { beaconFromChain, medianTimePast } from '../../arena-protocol/src/beacon.js';
import { regtest } from './regtest-bond.mjs';
import { chainOf, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bitcoindRpc, blocksOver } from '../src/chain-rpc.js';
import { timed } from '../src/slow.js';
import { operatorFunding, freeOrOperatorFunding } from '../src/funding.js';
import { startNode } from '../src/node-start.js';
import { lightningFromEnv } from '../src/node-start.js';
import { serveDonationRecipients, TEST_RECIPIENT_PORT } from '../src/lnurl-recipients.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { configForNewRound } from '../../arena-protocol/src/ballot-chain.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf, blockTimeOf } from '../../arena-protocol/src/chain.js';
import { publicationPayload } from '../../arena-protocol/src/publication.js';
import { seriesId, seriesRound } from '../../arena-protocol/src/series.js';
import { hash256, parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { bondSetFor, tweakPoint, combine } from '../src/curve.js';
import { bondOutputKey, bondInternalKey, BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { NEXTBLOCK_GAME_ID, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
// A LAUNCHER HANDS ITS NODES THE APPS THEY HOST (§0A.4): Next Block, as the installer's apps step does (ARENA_APPS).
const launchNode = (store, options, chain) => startNode(store, { plugins: [NEXTBLOCK], ...options }, chain);


const b32 = (n) => new Uint8Array(32).fill(n);
/**
 * Two daemons, one agreed round, and the providers a page needs to check it.
 *
 * Exported so the test can drive exactly what an operator runs, rather than a
 * second arrangement that looks like it.
 */
// WHETHER A NODE IS A GUARDIAN, AS ITS ADVERT SAYS IT (§5A.1 v4.6.4; §23A.2, one node is one guardian - RULED the owner
// 2026-09-26 22:54): read ONLY off the running node's own HTTP GET /guardian (the slice accepted 2026-09-27). Its
// {guardian: true, endpoint} is guardian_capable 1 with that endpoint; {guardian: false} is 0 and no endpoint. Nothing an
// operator types sets either, and a node that does not answer is refused by name rather than guessed at.
export async function guardianFieldsFromNode(url) {
  // NOT KEPT ALIVE: the launcher asks a node served only for this question and then closed, and a pooled socket to it
  // would be reused for the next request to the same port and find the other side gone.
  const r = await fetch(`${url}/guardian`, { headers: { connection: 'close' } });
  if (!r.ok) throw new Error(`${url}/guardian answered ${r.status}: a node that cannot say whether it is a guardian gets no advert`);
  const body = await r.json();
  return body && body.guardian === true && typeof body.endpoint === 'string'
    ? { guardianCapable: true, guardianEndpoint: body.endpoint }
    : { guardianCapable: false, guardianEndpoint: '' };
}

/**
 * THE 82/90 HARD FORK (2026-10-01: "Prepare new rounds with 82/90 seconds for free and paid in 24 hours ... Change
 * the core, it's basically a hard fork"; "The round length must be part of the contract"): a round starting at or after
 * RUN_82_FROM_MS names 4920 ticks - 82 s at the core's 65536/1092 ticks a second - and every run of it ends there; one
 * starting before names the core's old 10800. The instant is series k=2's start on the testnet4 grid, 2026-10-03 00:00Z,
 * where free and paid switch together; ARENA_RUN82_FROM_MS moves it for a harness.
 */
export const RUN_82_TICKS = 4920;
/** Rounds of each kind kept published ahead on the 90 s period: 10 is 15 minutes (with PUBLISH_AHEAD; without it one
 * period, each open waiting for its beacon). */
export const ROUNDS_AHEAD = Number(process.env.ARENA_ROUNDS_AHEAD || 10);
const COMMITTEE_LEAD_MS = process.env.ARENA_COMMITTEE_LEAD_MS ? Math.max(Number(MIN_ENTRY_WINDOW_MS), Number(process.env.ARENA_COMMITTEE_LEAD_MS)) : null;
/**
 * PUBLISH AHEAD (ARENA_PUBLISH_AHEAD=1; the free grid gapless across a restart, 2026-10-01): each round is mined into
 * a block and posted to the signer nodes as soon as it is drafted - they store it and assign its signer nodes once the
 * block past its committee time is on the chain (server.js) - and the chain's own block clock, a unit of its own, makes
 * that block. Unset, the opener waits for each beacon itself, as before.
 */
export const PUBLISH_AHEAD = process.env.ARENA_PUBLISH_AHEAD === '1';
export const RUN_82_FROM_MS = BigInt(process.env.ARENA_RUN82_FROM_MS || Date.UTC(2026, 9, 3, 0, 0, 0));
/** The versions a bond of this run names: 1 up to ARENA_PROTOCOL_VERSION, the version its rounds are written at. */
const bondVersions = () => (process.env.ARENA_PROTOCOL_VERSION ? Array.from({ length: Number(process.env.ARENA_PROTOCOL_VERSION) }, (_, i) => i + 1) : [1]);
export const runTicksAt = (startMs) => (BigInt(startMs) >= RUN_82_FROM_MS ? RUN_82_TICKS : BLOCK_TICKS);

export async function standUpRound({ host = '127.0.0.1', portA = 8080, portB = 8081,
                                     // A THIRD SIGNER NODE, OPT-IN (§23.6). A 3-of-4 federation needs its
                                     // threshold in DISTINCT bonded census nodes and two nodes cannot be
                                     // three, so a paying FEDERATION round needs a third bonded operator.
                                     // None by default: every existing caller stands the same 2-of-2.
                                     portC = null,
                                     // AND ANY FURTHER ONES. Seven is the other committee size the
                                     // protocol defines (5-of-7); `receiptsNeeded` knows 2 and 7 and
                                     // nothing between, so these are the two shapes a round may take.
                                     extraPorts = [],
                                     bDownAtStart = false,
                                     // EACH SEAT CLOSES A ROUND ITSELF AT ITS END, as a live seat does with
                                     // ARENA_CLOSE_AT_END=1 - for a stack nobody else closes rounds on (the demo)
                                     closeAtEnd = false,
                                     // NO FIRST ROUND (the on-demand head-to-head grid): the template is built and the
                                     // seats attached, and nothing is published or posted until openGrid / openNext is asked
                                     openFirst = true,
                                     store = ':memory:', rpc = null, cli = null,
                                     page = 'https://testnet.bitcoinarena.io',
                                     // A PAYING ROUND, for a rehearsal with Lightning. Every
                                     // existing caller asks for none and gets a free round.
                                     stakeMsat = 0n,
                                     // THE ROUND'S CONFIG: the truck's current one - one world per round - unless a
                                     // caller that is about per-player worlds names the v3 config (f51759b6).
                                     configHash = TRUCK_CONFIG_HASH,
                                     // HOW LONG A ROUND TAKES ENTRIES after its start (2026-09-16 15:36:
                                     // "FREE shows closes 30 min but a play is ~2 min"). Half an hour unless the
                                     // caller names a window - the Daily names one run's length.
                                     entryWindowMs = 1_800_000n,
                                     // THE ROUND'S OBJECTION WINDOW (M3.3-32): nothing moves
                                     // until it has closed. The spec's reference unless a
                                     // rehearsal names a shorter one to watch both sides of it.
                                     objectionWindowMs = 600000n,
                                     // A HARNESS'S WAIT JUST BEFORE THE ROUND IS POSTED - after
                                     // the beacon loop has mined its last block, which is when
                                     // a daemon's Lightning preflight asks whether its lnd is
                                     // synced. None by default: nothing changes for a launcher.
                                     beforeRound = null,
                                     // THE POOL'S CHAIN, OPT-IN: both daemons get the regtest
                                     // bitcoind to find the pool's output and send its
                                     // payout. Off by default - a launcher spends nothing.
                                     poolChain = false,
                                     // THE FEDERATION'S RECEIVING SIDE (invoice first): both
                                     // daemons answer `/federation-invoice` through it. None
                                     // by default.
                                     federation = null,
                                     // A ROUND WHOSE STAKE GOES INTO A FEDERATION LOCK (W1b):
                                     // the federation's id on the contract, its invite in the
                                     // join link, and what each signer node needs to verify a lock
                                     // (`claimKeyFor`, `stakeLocks`). None by default: every
                                     // existing caller's round names no federation, as before.
                                     federationId = new Uint8Array(32), invite = null, signerNode = {},
                                     // WHAT EACH SIGNER NODE'S BOND SAYS IT GUARDS: `[{federationId,
                                     // guardianKey}]`, the same shape §5A.1 puts in an advertisement.
                                     // A caller that stands its own federation knows these; none by
                                     // default, and then no bond claims to guard anything.
                                     //
                                     // ONE LIST PER NODE, when the caller nests it: `[[g0], [g1], [g2]]`
                                     // gives node A guardian 0, B guardian 1, C guardian 2. §23.6 counts
                                     // DISTINCT nodes and "a node vouches for one guardian", so three
                                     // operators each advertising the one key they actually run is the
                                     // honest shape - not one list of every key repeated three times,
                                     // which says each operator runs the whole federation.
                                     guardianOf = [],
                                     // A SECOND KIND OF ROUND KEPT OPEN BESIDE THE FIRST (the owner
                                     // 2026-09-15 12:54, option B): `{ stakeMsat, custody:
                                     // the withdrawn Lightning custody }` - a paying round on the same two signer nodes, its
                                     // stakes held by the committee's Lightning, no federation. None
                                     // by default: one kind of round, as before.
                                     paid = null,
                                     // THE DONATION SET'S TWO LOCAL TEST RECIPIENTS (M3.2 6e): bound
                                     // for a paid round, at the address the signed set names. A
                                     // free round asks no donation and binds nothing.
                                     // WHAT A NODE THAT HOLDS A GUARDIAN KEY READS THE CHAIN WITH, for its guardian
                                     // (node-start.js): { bitcoindUrl, cookiePath, call }. A node without a key starts
                                     // no guardian whatever this says; the Daily's nodes hold none.
                                     guardianChain = {},
                                     // THE CHAIN THE BONDS AND THE ROUND ARE ON. Regtest, which the opener mines, unless
                                     // the caller names testnet4 (2026-09-27 07:51: the paying round on testnet4):
                                     // then `cli` is that bitcoind's, `wallet` the one that pays the bonds, and every
                                     // block is somebody else's - waited for, never mined. A member's store may be named
                                     // outright (`storePaths`, in member order), for nodes that already hold their key.
                                     network = 'regtest', wallet = undefined, storePaths = [],
                                     // AN ENTRY CLOSE AT A WALL-CLOCK INSTANT, for the first round (2026-09-27
                                     // 17:24: the testnet4 round finished by 23:00). On testnet4 committee_time is the
                                     // tip's own timestamp, which runs up to two hours ahead of the wall clock, so no
                                     // window can be sized before the census: the window is what is left from
                                     // committee_time to this instant, never under thirty minutes. Unset: as before.
                                     entryCloseAtMs = null,
                                     // ATTACH (2026-09-29: the seven blwp-tn4-node units own the guardians): the nodes
                                     // already run, one process each, on `portA`, `portB`, ... - this tool starts none and opens
                                     // no store. `{ fundedFile, proofDir }`: the paying rounds it opens are named in
                                     // `fundedFile` (the nodes' ARENA_FUNDED_ROUNDS_FILE); the bond proof the page reads is
                                     // written to `proofDir` (the nodes' ARENA_ATTACH_PROOF_DIR). Identities come from each
                                     // node's GET /identity, bonds from the chain by public key; no bond is posted.
                                     attach = null,
                                     // 90 s ROUNDS (2026-09-29 21:58, SPECTATE-2158: "Free rounds are also 90 s rounds, same
                                     // as paying. A new free round every 90 s, run at most 82 s"): with `roundPeriodMs` the keeper
                                     // opens each next round of a kind at the last one's start + the period, its entry closing
                                     // at that start - the series' round shape (protocol series.js seriesRound).
                                     roundPeriodMs = null,
                                     // THE GAMES THE SEATS HOST (a market beside nextblock), and fields over every round
                                     // this tool opens (a market's game id, no core, no config) - none given: nextblock, as before
                                     plugins = null, roundFields = null,
                                     // THE DONATION SET IN FORCE AT THE CENSUS HEIGHT (measured 2026-10-12 22:0xZ: federation
                                     // B's first round named the built-in test set efffd27f and every seat refused it - "at census height
                                     // 156288 this network's donation set in force is serial 3 (a5dc55c1...)"): (height, networkId) ->
                                     // the set's id bytes, as the grid keeper reads it; null keeps the built-in set
                                     donationSetAt = null,
                                     donationRecipients = stakeMsat > 0n || (paid && BigInt(paid.stakeMsat) > 0n)
                                       ? { port: TEST_RECIPIENT_PORT } : null } = {}) {
  // WHAT THESE DAEMONS FUND (M3.3-31): a PAYING round goes through the
  // launcher's own rule - the round its operator names, and entries into a
  // paying round the node holds when it reaches Lightning - not a harness's
  // `() => true`. A free round keeps `() => true`: the launcher opens none.
  // With a paying kind beside a free first round, both: the free round and its
  // entries as before, the paying rounds by the operator's rule, each named
  // by this tool as it opens it.
  const funded = attach
    ? Object.assign(() => true, { nameRound: (rid) => appendFileSync(attach.fundedFile, `${toHex(rid)}\n`) })
    : stakeMsat > 0n ? operatorFunding() : paid ? freeOrOperatorFunding() : () => true;
  if (attach) {
    if (!attach.fundedFile || !attach.proofDir) throw new Error('attach names its fundedFile and its proofDir');
    if (!cli) throw new Error('attach reads the nodes\' bonds off a chain: it needs a bitcoind');
  }

  // THE BEACON IS THE CHAIN'S OR THERE IS NONE.
  //
  // This used to answer `{ hash: 0xbe repeated, height: 900005, timeMs: 900 }`
  // to every question - a committee drawn on a constant, which is a committee
  // its operator chose, and the exact thing 5A.5 exists to stop. It is gone.
  //
  // Given a bitcoind (RT and RPCPORT), the seed is the first block whose median
  // time is after this round's committee_time, read over RPC. Given none, this
  // node HAS no beacon: `randomnessFor` is not passed at all, the daemons'
  // defaults answer nothing, and 27's rule turns that into "this node has no
  // beacon for that round, so it cannot say who the census assigns". A round
  // still opens and a player still plays; nobody is assigned on an invented
  // number.
  // THE WINDOW REACHES BACK BEFORE committee_time OR THE RULE REFUSES IT, and
  // that refusal was earned: measured on a real regtest, a 64-header window to
  // the tip named block 69 where a view beginning at 103 named 112, of the same
  // chain, for the same round. The window is the operator's business and the
  // rule's job is to refuse one that cannot know - so this asks for enough of
  // the chain that the answer is the chain's and not the window's.

  // THE KEY BEFORE THE DAEMON. The advertisement names the key that signs it,
  // the bond commits to the advertisement, and the daemon serves the chain
  // that bond is mined into - so the identity has to be in hand before any of
  // it is built. It comes out of the store, which is where it lives.
  if (network !== 'regtest' && network !== 'testnet4') throw new Error(`no round is stood on ${network}`);
  const NETWORK_ID = network === 'regtest' ? NETWORK_ID_REGTEST : NETWORK_ID_TESTNET4;
  // ON REGTEST THE KEY SET WHEN THE SEATS SERVE IT (ARENA_REGTEST_DONATION_SET=keys, main.js): a round names the set its seats hold, and a protocol-11 entry pays keys
  const DONATION_SET = network === 'regtest' ? (process.env.ARENA_REGTEST_DONATION_SET === 'keys' ? TEST_DONATION_SET_KEYS_REGTEST : TEST_DONATION_SET_REGTEST) : TEST_DONATION_SET_TESTNET4;
  const pathOf = (name, i) => storePaths[i] || (store === ':memory:' ? ':memory:' : `${store}/${name}.db`);
  const pathA = pathOf('a', 0), pathB = pathOf('b', 1);
  // ATTACHED, NO STORE IS OPENED HERE: each node's store is its own process's.
  const dbA = attach ? null : openStore(pathA);
  const dbB = attach ? null : openStore(pathB);
  // EVERY SIGNER NODE BEYOND THE FIRST TWO, in the order their bonds are mined.
  const beyond = [...(portC ? [portC] : []), ...extraPorts];
  const pathsBeyond = beyond.map((_, i) => pathOf(String.fromCharCode(99 + i), 2 + i));
  const dbsBeyond = pathsBeyond.map((p) => (attach ? null : openStore(p)));
  // ATTACHED, A NODE'S KEY IS WHAT ITS OWN GET /identity ANSWERS - the public key only; nothing here signs for it.
  const identityOver = async (port) => {
    const r = await fetch(`http://${host}:${port}/identity`);
    if (!r.ok) throw new Error(`the node on ${port} answered /identity ${r.status}: attach needs it running`);
    return { pubkey: new Uint8Array(await r.arrayBuffer()) };
  };
  const idA = attach ? await identityOver(portA) : nodeIdentity(dbA);

  // THE ADVERTISEMENT IS SIGNED BY THE NODE IT NAMES. A stranger's signature
  // is refused at the door - the committee is the round's, and the key that
  // wrote the advertisement has to be the key the committee names.
  // THE ENDPOINT IS DECIDED BEFORE THE PORT IS BOUND, because the bond commits
  // to the advertisement and the advertisement carries the address. So a fixed
  // port is asked for and the daemon must get it; port 0 would name an address
  // nobody can put in a bond that is already mined.
  if (!portA || !portB)
    throw new Error('this needs fixed ports: a bond commits to the address it advertises');
  {
    const all = [portA, portB, ...beyond];
    if (new Set(all).size !== all.length)
      throw new Error(`every signer node needs its own port: two bonds cannot advertise one address (${all.join(', ')})`);
  }
  const idB = attach ? await identityOver(portB) : nodeIdentity(dbB);

  // EVERY SIGNER NODE THIS ROUND HAS, in the order their bonds are mined. Two
  // unless the caller asked for more.
  const members = [
    { id: idA, port: portA, db: dbA, path: pathA, name: 'A' },
    { id: idB, port: portB, db: dbB, path: pathB, name: 'B' },
    ...await Promise.all(beyond.map(async (port, i) => ({ id: attach ? await identityOver(port) : nodeIdentity(dbsBeyond[i]),
      port, db: dbsBeyond[i], path: pathsBeyond[i], name: String.fromCharCode(67 + i) }))),
  ];
  // AND WHICH GUARDIAN EACH ONE SAYS IT RUNS. A flat list is every node's, as
  // before; a nested one is read per node, so no two operators claim one key.
  const guardianOfFor = (i) => (Array.isArray(guardianOf[0]) ? (guardianOf[i] || []) : guardianOf);

  // WHETHER EACH ONE IS A GUARDIAN, ASKED OF THE NODE ITSELF BEFORE ITS ADVERT IS SIGNED. The node is started on its own
  // port and store - nothing else: no chain, no funding, no closing, so it touches no round it holds - asked its
  // GET /guardian, and closed; the advert and the bond are built from that answer, and the node is started in full
  // below, once the census is there. The node decides whether it is a guardian (node-start.js: the key beside its
  // store); this tool starts nodes only, and the Daily's nodes hold no key, so they answer {guardian: false}.
  for (const m of members) {
    if (attach) { m.guardian = await guardianFieldsFromNode(`http://${host}:${m.port}`); continue; }
    const probe = await launchNode({ db: m.db, path: m.path }, { port: m.port, host }, guardianChain);
    try { m.guardian = await guardianFieldsFromNode(`http://${host}:${probe.port}`); }
    finally { await probe.close(); }
  }

  // ONE BOND EACH, AND THAT IS NOT A DETAIL. `assignSignerNodes` compares the signer nodes
  // the census gives with the keys the contract names and refuses when they
  // differ - letter 26's ruling that the assigned set is the only list that
  // counts. A 2-of-2 whose chain bonded one of its two nodes would be refused
  // by its own daemons, which is exactly what should happen and is why both
  // are bonded here.
  const bonded = members.map(({ id, port }, at) => {
    const advert = {
      nodePubkey: id.pubkey, operatorId: '2of2', protocolVersions: bondVersions(),
      // ALL THREE ROLES, because this network's genesis asks for two nodes in
      // each and there are only two nodes. A 2-of-2 where one signer node is a game
      // node and the other a settlement node is not a 2-of-2, it is two
      // committees of one. Measured: with 'game' and 'verify' alone the census
      // carried 0 settlement nodes where regtest was born needing 2.
      hostedGames: plugins ? plugins.map((p) => p.gameId).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))) : [NEXTBLOCK_GAME_ID],
      roles: ['game', 'verify', 'settlement'],
      endpoint: process.env[`ARENA_WSS_${port}`] || `ws://${host}:${port}`,
      region: 'eu-west', capacityClass: 2, softwareHash: b32(3),
      settlementCapabilities: 0, lightningCapabilities: 0,
      bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
      payoutPubkey: b32(4), guardianOf: guardianOfFor(at),
      ...members[at].guardian,   // the node's own GET /guardian, above
      timestamp: BigInt(Date.now()),
    };
    // BIP-340, because letter 26 made a node's identity ITS BOND KEY: every
    // signature a node makes is schnorr under the key its bond was posted
    // with, and an ed25519 signature here is refused at the door by name.
    // ATTACHED, NOTHING IS SIGNED HERE: the bond's own advertisement and signature are read off the chain below.
    const signature = attach ? new Uint8Array(64) : schnorr.sign(advertId(advert), id.secret);
    // THE OUTPUT KEY IS THE ONE 5A.3B BUILDS, not the fixture filler. Letter 24
    // made the census rebuild a bond's key from the node key, the network's
    // arbitration set and its maturity, and refuse one that does not rebuild -
    // so a bond paying 0x77 repeated is a bond the census counts as nothing.
    // Measured: with the filler the census carried 0 game nodes where regtest
    // was born needing 2.
    const g = genesisFor(network);
    const built = bondOutputKey({
      nodeKey: id.pubkey,
      arbitrationKeys: g.arbitrationKeys,
      arbitrationK: g.arbitrationK,
      bondMaturity: g.bondMaturity,
      internalKey: bondInternalKey(
        { nodeKey: id.pubkey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
    }, { tweakPoint, combine });
    const transaction = bondTransaction(advert, { signature, outputKey: built.outputKey });
    return { advert, signature, transaction, txid: parseTransaction(transaction).txid };
  });

  // ONE BLOCK EACH AND ONE TRANSACTION IN IT. A chain view checks that a
  // block's transactions hash to the root ITS OWN header commits to, so every
  // leaf has to be a real transaction - a bare 32-byte sibling is a txid and
  // is refused by name ("carries something that is not a transaction"). With
  // a single leaf the root IS the txid and the merkle branch is empty, which
  // is a proof this tool can write down without a proof builder.
  const headersOf = (list) => {
    const built = [];
    let previous = blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER);
    for (const one of list) {
      const { header } = blockOf(hash256, [one.txid], { previous });
      built.push({ header, transactions: [one.transaction] });
      previous = blockHashOf(header);
    }
    const chain = [BITCOIN_MAINNET_GENESIS_HEADER, ...built.map((b) => b.header)];
    const bytes = new Uint8Array(chain.length * 80);
    chain.forEach((h, i) => bytes.set(h, i * 80));
    return bytes;
  };
  // `let`: ATTACHED, it is built again from the bonds' own advertisements once they are read off the chain.
  let headerBytes = headersOf(bonded);

  // THE VIEW THE CENSUS IS DERIVED FROM.
  //
  // ONE CHAIN FOR THE CENSUS AND THE BEACON when there is a bitcoind: the bonds
  // are posted to it, the blocks are read back from it, and the beacon comes
  // off the same chain - which is what lets the roster ask "is this beacon the
  // block my chain names" and get an answer. With a fixture census beside a
  // bitcoind beacon that question could never pass, because the fixture has no
  // such block.
  //
  // WITHOUT a bitcoind, the two-block fixture stays. It assigns nobody - there
  // is no beacon either - so nothing is being pretended: `POST /round` refuses
  // by name and the tool says so.
  let censusView;
  let censusHeight = 2;
  let censusConfirmations = 1;
  let onChain = null;
  let bondHeight = 0;
  let bondFloor = 0;
  let localChain = null;
  let localBlocks = null;
  if (cli) {
    const rt = regtest(cli, { network, ...(wallet ? { wallet } : {}) });
    onChain = rt;
    // ARENA_BOND_SATS ON REGTEST (a federation whose bonds cover little, so its load is high - Move is offered
    // only from one above 90 %): each bond that amount, out of a funding output 5 000 sats larger, instead of half a coin
    const bondOverride = rt.minable && process.env.ARENA_BOND_SATS ? BigInt(process.env.ARENA_BOND_SATS) : null;
    const bondAmount = bondOverride !== null ? { bondSats: bondOverride, fundBtc: (Number(bondOverride + 5000n) / 1e8).toFixed(8) }
      : rt.minable ? {} : { bondSats: 50000n, fundBtc: '0.00055' };
    // WHAT EACH NODE'S BOND MUST SAY: the advert the node would post now
    const wantFor = (m, i) => ({
      endpoint: process.env[`ARENA_WSS_${m.port}`] || `ws://${host}:${m.port}`,
      ...(guardianOfFor(i).length ? { guardianOf: guardianOfFor(i) } : {}),
      ...m.guardian,
      ...(bondAmount.bondSats !== undefined ? { bondSats: bondAmount.bondSats } : {}),
    });
    // A BOND THAT ONCE CONFIRMED STAYS VALID (spec §5A.3; 2026-09-28 07:39: "The operator does not post again.
    // Change the node so a confirmed unspent bond for that node key is reused"). Off regtest - where every block is
    // somebody else's and a fresh set costs a confirmation and six more - each node's newest confirmed, unspent bond
    // that says what the node says now is used as it stands; a node posts only when it has none. Regtest keeps posting:
    // a fresh regtest has nothing to reuse and mines its own.
    // ATTACHED, EVERY NETWORK REUSES: a node's bond is found by its public key, and one that is missing stops the run.
    const reused = rt.minable && !attach ? members.map(() => null)
      : members.map((m, i) => rt.findBond(attach ? { pubkey: m.id.pubkey } : m.id.secret, wantFor(m, i)));
    for (const [i, b] of reused.entries())
      if (b) console.log(`[bond] node ${members[i].name} reuses ${b.txid}:${b.vout} (${b.sats} sats, height ${b.height})`);
    for (const [i, b] of reused.entries())
      if (b && b.updatedBy) console.log(`[bond] node ${members[i].name}: its advertisement is the update ${b.updatedBy.txid} (height ${b.updatedBy.height})`);
    const toPost = members.map((m, i) => (reused[i] ? null : i)).filter((i) => i !== null);
    // A FIRST BOND FOR A NODE THAT HAS NONE (2026-10-12: "Poste neue bonds wenn nötig, du kannst auch neue
    // nodes auf dem macOS dafür starten, für eine zweite Federation"): with ARENA_POST_FIRST_BONDS=1 an attached node whose
    // key has no confirmed unspent bond AT ALL is bonded here - its secret read from its own store, read-only, beside the
    // running node. A node with any bond is never bonded again (the 2026-09-28 rule below stands for it).
    const firstBond = new Set();
    if (attach && process.env.ARENA_POST_FIRST_BONDS === '1') {
      const { DatabaseSync } = await import('node:sqlite');
      for (const i of toPost) {
        const m = members[i];
        if (rt.bondsOf({ pubkey: m.id.pubkey }).length) continue;
        const db = new DatabaseSync(m.path, { readOnly: true });
        let row; try { row = db.prepare('SELECT secret FROM identity WHERE one = 0').get(); } finally { db.close(); }
        const secret = row ? new Uint8Array(row.secret) : null;
        if (!secret || toHex(schnorr.getPublicKey(secret)) !== toHex(m.id.pubkey))
          throw new Error(`node ${m.name}: the store ${m.path} does not hold the key its /identity names - no first bond`);
        m.id = { ...m.id, secret };
        firstBond.add(i);
        console.log(`[bond] node ${m.name} has no bond on chain: its first one is posted (ARENA_POST_FIRST_BONDS)`);
      }
    }
    // OFF REGTEST A MISSING BOND STOPS THE RUN, IT IS NOT POSTED (§5A.2; 2026-09-28, the advertisement-update
    // letter: "accept an updated advert and select the existing bond. If none matches, stop. Do not post a bond"). A
    // node whose bond says something else is given an advertisement update (tools/testnet4-advert-update.mjs), not a
    // second bond.
    const blocked = toPost.filter((i) => !firstBond.has(i));
    if ((!rt.minable || attach) && blocked.length)
      throw new Error(`no confirmed unspent bond, as bonded or as updated, says what node(s) ${blocked.map((i) => members[i].name).join(', ')} `
        + 'say now: publish an advertisement update for the existing bond; no bond is posted here');
    // EACH BOND INCLUDED AS IT IS BUILT (measured on the test host regtest stack 2026-10-11 15:58Z: "names 7
    // committee keys and the census assigns 6"): a template-2 bond fixes its maturity (the tip + 1 + 6 + the offset) when it
    // is built, and on regtest each bond's funding mines a block while the stack's own miner adds one every 20 s - seven
    // built first and included together left the first confirming more than 6 blocks later, short of its maturity, and the
    // census excluded it. The same fix as tools/seating-regtest.mjs.
    const postedAt = [];
    const template3Key = rt.minable && process.env.ARENA_BOND_TEMPLATE3_KEY ? fromHex(process.env.ARENA_BOND_TEMPLATE3_KEY) : null;
    const posted = toPost.map((i) => members[i]).map((m, j) => {
      const p = rt.postBond(m.id.secret, {
        // THE PUBLIC ENDPOINT, THE SAME ONE THE ADVERT NAMES (2026-09-25 21:41: the replay link a player copies
        // is built from these, and "a copied link that only opens on 127.0.0.1 does not count"). The bond said
        // ws://<host>:<port> - on the Daily 198.51.100.98, a tailnet address no phone off this machine can open -
        // while the advert already said ARENA_WSS_<port>; the census reads the bond.
        endpoint: process.env[`ARENA_WSS_${m.port}`] || `ws://${host}:${m.port}`,
        // THE GAMES IT HOSTS, as its advertisement above names them
        hostedGames: plugins ? plugins.map((p) => p.gameId).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))) : [NEXTBLOCK_GAME_ID],
        // THE VERSIONS IT SPEAKS, as the advertisement above: a round of version v draws only nodes whose bond names v (kanban #397)
        protocolVersions: bondVersions(),
        // A LONGER LOCK WHEN ASKED (ARENA_BOND_SLACK_BLOCKS): a bond votes only when it stays locked past the vote (§27A.9.5 rule 1)
        ...(process.env.ARENA_BOND_SLACK_BLOCKS ? { slackBlocks: Number(process.env.ARENA_BOND_SLACK_BLOCKS) } : {}),
        // AND WHICH FEDERATION THIS SIGNER NODE GUARDS, when the caller named one. Without it
        // `federationIsBonded` counts zero of the federation's threshold and every paying FEDERATION
        // round is refused on a bonded-federation check the bonds could not satisfy. Per node, so
        // three operators cover a 3-of-4 rather than one operator claiming it three times.
        ...(guardianOfFor(toPost[j]).length ? { guardianOf: guardianOfFor(toPost[j]) } : {}),
        // AND WHETHER IT IS A GUARDIAN, as the node itself answered (above)
        ...m.guardian,
        // ON TESTNET4 THE BOND IS THE ROUND'S MINIMUM, not regtest's half a coin: 50 000 sats, the contract's
        // bond_min_sats, out of a 55 000-sat funding output (the rest is the marker, the fee and the change).
        ...bondAmount,
        // A DEVNET THAT SLASHES (ARENA_BOND_TEMPLATE3_KEY, regtest only, kanban #1044 B1 phase 4): the bond on template 3 under that census key, so a
        // filed proof can start its slash; its presig goes in the same block
        ...(template3Key ? { template: BOND_TEMPLATE_V3, censusKey: template3Key } : {}),
      });
      rt.include([p.hex, ...(template3Key ? [rt.postBondPresig(m.id.secret, p).hex] : [])]);
      postedAt.push(rt.height());
      return p;
    });
    // THE CENSUS HEIGHT IS ABOVE THE BONDS, NOT AT THEM. Depth is measured at
    // `census_height` - "spentness, height and depth off REAL BLOCKS with depth
    // at census_height" (15) - so a bond in the census height's own block is
    // one confirmation deep and a round asking for six excludes it. Measured:
    // "that census carries 0 game nodes where regtest was born needing 2".
    // THE NEWEST BOND sets the depth the census must wait for; the OLDEST sets where the census view begins
    const heights = reused.filter(Boolean).map((b) => b.height);
    heights.push(...postedAt);
    bondHeight = Math.max(...heights);
    bondFloor = Math.min(...heights);
    // SIX DEEP, AND ON A REAL CHAIN THOSE ARE SOMEBODY ELSE'S BLOCKS (RULED 2026-09-21 17:01).
    //
    // `rt.bury(6)` mines on regtest, exactly as `rt.mine(6)` did, and WAITS everywhere else. The round's
    // beacon is the first block after `committee_time`, so an operator who can make blocks on the round's
    // own chain can make the beacon he wants - which is fine for a free regtest round and is not fine for
    // one holding money. Measured on testnet4: 723.3 s a block, so six is about 72 minutes.
    censusHeight = rt.height() - bondHeight + 1 >= 7 ? rt.height() : rt.bury(bondHeight + 6 - rt.height());
    // AND OFF REGTEST NOT THE TIP ITSELF BUT ARENA_CENSUS_DEPTH (6) BELOW IT (kanban #633, measured 2026-10-25/26 on testnet4: the
    // runners stood their census at the tip - 157,476, 157,609, 157,616 - and each of those blocks was replaced by a reorg within
    // hours, so every day they posted named a census root the chain no longer gives, and no page could join a round of it).
    // Only while the bonds stay seven deep at that height: a census the bonds are too shallow for keeps the height above.
    if (network !== 'regtest') {
      const depth = Number(process.env.ARENA_CENSUS_DEPTH ?? 6);
      const deeper = rt.height() - depth;
      if (Number.isInteger(depth) && depth > 0 && deeper < censusHeight && deeper - bondHeight + 1 >= 7) censusHeight = deeper;
    }
    if (censusHeight - bondHeight + 1 < 7)
      throw new Error('the bonds are not deep enough at the census height');
    // ATTACHED, THE CENSUS IS READ OVER THE NODES' OWN WINDOW - main.js's CENSUS_LOOKBACK, 2016 blocks below the census
    // height - so the root this tool names is the root each node derives (measured on regtest: from 20 below the bonds,
    // an older unspent bond the nodes counted gave them another root, and every round was refused).
    // AND NO HIGHER THAN THAT WINDOW STILL REACHES THE OLDEST BOND (ORDER-2116, measured on the free pair 2026-10-01): the
    // 10 s block clock grows the regtest chain 2016 blocks in 5.6 h; an opener restarted then named the tip, its bonds
    // 2027 blocks below, and every round it opened read "that census carries 0 game nodes where regtest was born needing 2".
    if (attach && posted.length === 0) {
      const reach = bondFloor + 2016 - 20;
      if (censusHeight > reach && reach - bondHeight + 1 >= 7) censusHeight = reach;
    }
    if (attach) bondFloor = Math.max(20, censusHeight - 2016 + 20);
    for (const [j, p] of posted.entries()) bonded[toPost[j]].onChainTxid = p.txid;
    for (const [i, b] of reused.entries()) if (b) bonded[i].onChainTxid = b.txid;
    // ATTACHED: the advertisement and signature the bond itself committed to, so the page's proof is the chain's words.
    // A FIRST BOND POSTED IN THIS RUN (ARENA_POST_FIRST_BONDS) has no `reused` entry: it is read back off the chain
    // now that it is buried (measured 19:40Z on federation B: "Cannot read properties of null (reading 'maturity')")
    if (attach) for (const [i, b0] of reused.entries()) {
      const b = b0 || rt.findBond({ pubkey: members[i].id.pubkey }, wantFor(members[i], i));
      if (!b) throw new Error(`node ${members[i].name}: its bond is not on chain as posted - no census can name it`);
      const built = bondOutputKey({ nodeKey: members[i].id.pubkey, arbitrationKeys: rt.genesis.arbitrationKeys,
        arbitrationK: rt.genesis.arbitrationK, bondMaturity: b.maturity ?? rt.genesis.bondMaturity,  // template 2: the bond's own
        internalKey: bondInternalKey({ nodeKey: members[i].id.pubkey, arbitrationKeys: rt.genesis.arbitrationKeys }, { combine }).internalKey,
      }, { tweakPoint, combine });
      const transaction = bondTransaction(b.bondAdvert, { signature: b.bondSignature, outputKey: built.outputKey });
      bonded[i] = { advert: b.bondAdvert, signature: b.bondSignature, transaction, txid: parseTransaction(transaction).txid, onChainTxid: b.txid };
    }
    if (attach) headerBytes = headersOf(bonded);
    censusConfirmations = 6;
    censusView = null;                  // read after committee_time, below
  } else {
    // NO BITCOIND: ONE CHAIN ALL THE SAME, built here.
    //
    // The bonds used to sit in a two-block fixture while the beacon came from
    // whatever header source a caller passed - two chains again, in miniature,
    // and a roster cannot ask a two-block fixture which block is first after
    // committee_time. So this builds ONE chain that carries the bonds and can
    // name a beacon: forty blocks ten minutes apart, straddling now, with a
    // bond in each of two of them.
    //
    // It is a fixture and says so. What it is not is two fixtures pretending
    // to be one chain.
    // Mined by the same helper the fixtures use, which gives every block its
    // own time ten minutes after the one before - a chain where every header
    // claims the same second has no first-after and no order to find it in.
    const carried = [];
    for (let i = 0; i < 40; i++)
      carried.push({ transactions: i === 2 ? [bonded[0].transaction]
        : i === 3 ? [bonded[1].transaction] : [] });
    localBlocks = carried;
    const mined = chainOf(carried, 0);
    censusView = mined;
    censusHeight = 9;                 // six clear of the deeper bond at height 3
    censusConfirmations = 6;
    localChain = mined.blocks.map((b) => b.header);
  }

  // THE TWO DOORS THE JOIN URL NEEDS, on the daemons themselves.
  //
  // the owner's ruling, and the objection is recorded rather than argued: a node
  // serving the chain that proves its own bond is one source wearing two hats,
  // and 25.1 asks for independent ones. What makes it hold here is that there
  // are TWO daemons and `agreedChain` counts ORIGINS - and that this is a
  // local test round on a fixture chain, not a claim about Bitcoin.
  const bondProof = { hex: toHex(bonded[0].transaction), merkle: [], pos: 0 };
  // AND THE DAEMONS SEE THE CHAIN, which is what makes `POST /round` signer node
  // anybody at all: `server.js` assigns only when it has a view, and this tool
  // gave none, so the beacon was read and nobody was ever assigned on it.
  // THE BEACON READS THE SAME CHAIN THE CENSUS DOES, whichever chain that is.
  // A caller may still hand an `rpc` - the regtest path does - but a header
  // source that is not the chain the bonds are on is the two-chain fault this
  // letter closed, so with no bitcoind the local chain answers both.
  const localCall = localChain
    ? async (method, params = []) => {
        if (method === 'getblockcount') return localChain.length - 1;
        if (method === 'getblockhash') return toHex(blockHashOf(localChain[params[0]]));
        if (method === 'getblockheader')
          return toHex(localChain[localChain.findIndex(
            (h) => toHex(blockHashOf(h)) === params[0])]);
        throw new Error('this chain was asked ' + method);
      }
    : null;
  const source = rpc || localCall;
  const beacon = source ? chainBeacon({ call: source, window: 400 }) : null;
  // A ROUND POSTED AHEAD IS READ WHEN IT IS FIRST ASKED ABOUT, as the seat daemon does (main.js randomnessFor):
  // `beacon.for` only answers what was read, and nothing here read a round published ahead - the demo's 8 s rounds posted
  // ahead stayed "this node has no beacon for that round" and were never joinable
  const randomnessFor = beacon ? (q) => { const got = beacon.for(q); if (!got && q && q.contract) beacon.refresh(q.contract).catch(() => {}); return got; } : undefined;

  // AN OLDER ROUND GETS A VIEW THAT REACHES BACK TO IT (M3.3-34). The signer nodes'
  // view begins 20 below the bonds this start posted, and every start posts
  // them again: measured, a view from 2232 against a round whose beacon is 2139,
  // so both restarted signer nodes held that round for ever on "this view begins at
  // height 2232 ... after this round's committee time". Moving the signer nodes' own
  // view back was measured too and is wrong: its census then counted earlier
  // starts' bonds and the next round was refused ("the census assigns 1"). So a
  // round whose census height is below the signer nodes' view gets its own - from 20
  // below that height to the tip, read once: its bonds and beacon are deep.
  const older = new Map();
  // AND IT IS READ OFF THE LOOP (2026-09-17 19:15, the ghost lag). Measured live with the daemon's own timing:
  // one close held the event loop 7,627 ms in `beacon` - this read, two synchronous bitcoin-cli spawns a block from
  // twenty below an old round's census to the tip, on the thread that answers /play and pushes a pictured truck. The
  // read now runs on bitcoind's RPC without holding the loop, once per height; until it is there the round is PENDING,
  // which every reader of this view refuses on, and the close's own cadence asks again. Nothing is answered from a
  // view that is not the round's own.
  const reading = new Map();
  const chainFor = ({ contract } = {}) => {
    if (!onChain || !censusView || !contract) return censusView;
    const from = Math.max(0, contract.censusHeight - 20);
    if (from >= censusView.firstHeight) return censusView;
    if (older.has(from)) return older.get(from);
    if (!reading.has(from)) {
      console.log(`[view] a round with census ${contract.censusHeight} needs its own view from ${from}; the signer nodes' begins at ${censusView.firstHeight} - reading it without holding the loop`);
      reading.set(from, (async () => {
        const tip = Number(await chainRpc('getblockcount', []));
        const got = await blocksOver(chainRpc, from, tip);
        older.set(from, got);
        console.log(`[view] the view from ${from} is read: ${got.blocks.length} blocks`);
      })().catch((e) => console.error(`[view] the view from ${from} could not be read: ${e.message}`))
        .finally(() => reading.delete(from)));
    }
    return { pending: true };
  };
  // A LIGHTNING INVOICE READER, OPT-IN: the four ARENA_LND* settings, the same parse src/main.js uses. It
  // reads what a federation's LNv2 invoice commits to, and nothing else. There used to be far more here -
  // the committee's one Lightning endpoint holding the stakes, a preflight asking whether it could, and the
  // chain's block pace read and re-read to size each hold's HTLC - and all of it was the withdrawn Lightning custody's hold
  // invoice, which does not exist (§23.6, RULED 2026-09-22 22:59).
  const ln = lightningFromEnv(process.env);
  if (!ln.ok) throw new Error(ln.why);
  const lightning = ln.given ? { lightning: ln.lightning } : {};
  // THIS CHAIN'S HEIGHT, from the regtest bitcoind when there is one (M3.3-30):
  // a hold past its HTLC's expiry is written EXPIRED on it. Not `poolCall`,
  // which would also switch on the pool's spending.
  const chainTip = rpc ? { chainTip: async () => Number(await rpc('getblockcount', [])) } : {};
  // AND, ASKED FOR, THE POOL'S CHAIN: `poolCall` finds the pool's output and
  // `chainSpend` sends the committee's payout, both through the same bitcoind.
  const hexOf = (u8) => Buffer.from(u8).toString('hex');
  const spendOn = poolChain && rpc ? {
    poolCall: rpc,
    chainSpend: {
      async send(raw) {
        try { return { ok: true, txid: Uint8Array.from(Buffer.from(await rpc('sendrawtransaction', [hexOf(raw)]), 'hex')).reverse() }; }
        catch (e) { return { ok: false, why: e.message }; }
      },
      async look(txid) {
        try { await rpc('getrawtransaction', [hexOf(Uint8Array.from(txid).reverse())]); return { known: true }; }
        catch { return { known: false }; }
      },
    },
  } : {};
  // A TEST OWNER (the CRITICAL rehearsal): ARENA_TEST_OWNER_PUBKEY=<hex> gives every seat this harness starts an
  // owner already claimed by that key, kept in memory - so a test signs a leave as an owner page would (POST /owner/leave)
  // THE FEDERATION'S INVITE, AS A SEAT'S ARENA_FEDERATION_INVITE GIVES IT (main.js): without it a harness seat signs no
  // FederationRecord - "this seat names no invite for that federation" (measured on the test host stack)
  const seatInvite = () => (invite ? { federationInvite: invite } : {});
  const testOwner = () => (process.env.ARENA_TEST_OWNER_PUBKEY ? { owner: { store: (() => { let o = { pubkey: String(process.env.ARENA_TEST_OWNER_PUBKEY).toLowerCase(), claimedAtMs: Date.now() };
    return { read: () => o, write: (x) => { o = x; }, writeCode: () => {} }; })() } } : {});
  const optsA = { port: portA, host, funded, donationSets: [DONATION_SET], headerBytes, bondProof, chainFor, ...(plugins ? { plugins } : {}),
    ...(randomnessFor ? { randomnessFor } : {}), ...lightning, ...chainTip, ...spendOn,
    ...(federation ? { federation } : {}), ...signerNode, ...(closeAtEnd ? { closeAtEnd: true } : {}), ...testOwner(), ...seatInvite() };
  // ATTACHED: the page's bond proof for the running nodes to serve (their ARENA_ATTACH_PROOF_DIR), and no node started -
  // each member is its port and its key, the node itself another process's.
  if (attach) {
    mkProofDir(attach.proofDir, { recursive: true });
    writeProof(`${attach.proofDir}/headers.bin`, headerBytes);
    writeProof(`${attach.proofDir}/bond.json`, JSON.stringify(bondProof));
  }
  const attached = (m) => ({ port: m.port, round: { pubkey: m.id.pubkey }, attached: true, close: async () => {} });
  let a = attach ? attached(members[0]) : await launchNode({ db: dbA, path: pathA }, optsA, guardianChain);
  const optsB = { port: portB, host, funded, donationSets: [DONATION_SET], headerBytes, bondProof, chainFor, ...(plugins ? { plugins } : {}),
    ...(randomnessFor ? { randomnessFor } : {}), ...lightning, ...chainTip, ...spendOn,
    ...(federation ? { federation } : {}), ...signerNode, ...(closeAtEnd ? { closeAtEnd: true } : {}), ...testOwner(), ...seatInvite() };
  // B DOWN AT START (`bDownAtStart`, an operator's look at signer node A restarted
  // while it holds a close that needs B): B is served on a port nobody names -
  // the bond, the relays and every peer say `portB` - only so the first round
  // can be posted to it; the caller closes it, and restartB serves it on portB.
  let b = attach ? attached(members[1]) : await launchNode({ db: dbB, path: pathB }, bDownAtStart ? { ...optsB, port: 0 } : optsB, guardianChain);
  // AND THE THIRD, WHEN THERE IS ONE. Served exactly like the other two - a
  // bonded census node that is not also a running daemon would be a bond
  // vouching for a guardian nobody can reach.
  const optsBeyond = members.slice(2).map((m) => ({ port: m.port, host, funded, ...(plugins ? { plugins } : {}),
    donationSets: [DONATION_SET], headerBytes, bondProof, chainFor,
    ...(randomnessFor ? { randomnessFor } : {}), ...lightning, ...chainTip, ...spendOn,
    ...(federation ? { federation } : {}), ...signerNode, ...testOwner(), ...seatInvite() }));
  const rest = [];
  for (const o of optsBeyond) {
    const m = members[2 + rest.length];
    rest.push(attach ? attached(m) : await launchNode({ db: m.db, path: m.path }, o, guardianChain));
  }
  const nodeC = rest[0] || null;
  if (a.port !== portA)
    throw new Error(`node A came up on ${a.port} and the bond names ${portA}`);
  rest.forEach((d, i) => {
    if (d.port !== members[2 + i].port)
      throw new Error(`node ${members[2 + i].name} came up on ${d.port} and the bond names ${members[2 + i].port}`);
  });

  // THE ROUND. Its times are real instants, because a node refuses an entry
  // before committee_time and refuses a round whose entry window is shorter
  // than the protocol's own minimum.
  //
  // `blockTicks` is how long the round IS, AND IT IS THE CORE'S OWN NUMBER, not one written here. It was 9000 - two
  // and a half minutes - chosen when the core's own BLOCK_TICKS was 9000. The core went to 10800 with the
  // three-minute ruling (WAR_TACTICS, c01cc65) and this literal stayed behind, so the Daily served rounds whose
  // run length disagreed with the core they named: seen in the cab on 2026-09-19, "the node refuses this run's
  // inputs at tick 8948 ... inputs past the end are inputs for a run that is over", and a node started on the new
  // core then refused its own round outright. A contract that names a core may not disagree with it, so the number
  // comes from the core.
  // COMMITTEE_TIME IS SET ON THE CHAIN'S OWN CLOCK, not on this machine's.
  //
  // Measured, and it is why the first attempt found no beacon: a median lags.
  // The tip's median time past was sixteen seconds BEHIND `Date.now()` on a
  // freshly mined regtest, so a committee_time taken from the wall clock is an
  // instant the chain has not reached and no block can be after it yet. The
  // median at the tip is a time this chain has passed, by construction.
  //
  // On a live network committee_time is a protocol instant and the chain
  // reaches it by itself; here nothing waits ten minutes a block, so the tool
  // names an instant the chain is at and then mines past it.
  let committeeTimeMs = BigInt(Date.now());
  if (localChain) {
    // THE FIXTURE CHAIN'S OWN CLOCK, for the same reason the regtest path uses
    // its median: a committee_time this chain has not reached is an instant no
    // block of it can be after, and the round would name a beacon that does not
    // exist. Twelve blocks back leaves the answer deep enough to use.
    committeeTimeMs = BigInt(medianTimePast(localChain, 0, localChain.length - 12)) * 1000n;
  }
  if (onChain) {
    // JUST PAST THE TIP'S OWN TIMESTAMP, not its median (v4.6.2). The round is
    // published in the NEXT block, and a publication counts only strictly
    // below the beacon block - the first whose median time passes
    // committee_time. That block's median is over eleven timestamps, ten of
    // them at or before the tip's, so it cannot pass the tip's own time: the
    // publication block is never the beacon. The tip's MEDIAN, used before,
    // is already passed by the next block's on a fast regtest.
    const tip = onChain.blocksFrom(onChain.height(), onChain.height()).blocks[0].header;
    committeeTimeMs = (BigInt(blockTimeOf(tip)) + 2n) * 1000n;
    // FROM WELL BEFORE THE BONDS: the census is read from here now, and the
    // beacon's view below reaches back past committee_time from the same start.
    censusView = onChain.blocksFrom(Math.max(0, bondFloor - 20), onChain.height());
  }
  // THE CONFIG THE BALLOT MADE LIVE AT THIS CENSUS HEIGHT (§27A.7.5): an attached seat that counts the ballot answers
  // GET /config, and a round created after an activation names the new hash (configForNewRound) - one whose config the ballot
  // never named keeps the caller's. A seat that counts none answers 404 and nothing changes. The keeper's later rounds keep this
  // round's census height, so they keep its config too: rounds created under one census are bound to the config live there.
  if (attach) {
    try {
      const r = await fetch(`http://${host}:${portA}/config`);
      if (r.ok) {
        const live = await r.json();
        const history = (live.history || []).map((h) => ({ configHash: fromHex(h.configHash), since: h.since }));
        const named = configForNewRound({ wanted: configHash, height: censusHeight, history });
        if (toHex(named) !== toHex(configHash)) console.log(`[config] the ballot made ${toHex(named).slice(0, 16)} live at ${censusHeight}: the round names it, not ${toHex(configHash).slice(0, 16)}`);
        configHash = named;
      }
    } catch (e) { console.error(`[config] GET /config not read (${e.message}): the round names ${toHex(configHash).slice(0, 16)}`); }
  }
  const contract = {
    networkId: NETWORK_ID, configHash, censusConfirmations,
    // ONE SLOT PER SIGNER NODE THERE IS. `assignSignerNodes` checks the census's
    // assigned set against `nodes` EXACTLY, both ways, so with three bonded
    // nodes and two slots the sortition would seat two of the three and the
    // contract could not know which - it would be refused by its own daemons.
    gameVerifySlots: members.length, settlementSlots: members.length, gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH,
    committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + (entryCloseAtMs == null ? BigInt(entryWindowMs)
      : (BigInt(entryCloseAtMs) - committeeTimeMs - MIN_ENTRY_WINDOW_MS > 1_800_000n
        ? BigInt(entryCloseAtMs) - committeeTimeMs - MIN_ENTRY_WINDOW_MS : 1_800_000n)),
    objectionWindowMs, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId, stakeExpiryBlocks: 144,
    // WHERE THE SIGNER NODES POST EACH RUN'S TRANSCRIPT (v4.6.2 §13A, P2): the two
    // daemons' own relay doors. A result is final only once both have posted
    // it, and a round naming no relay could never settle a stake.
    // ARENA_PUBLICATION_RELAYS (kanban #808): the seats' public addresses when `host` is only where this tool reaches them. A contract is
    // signed for the day, so a machine's address in it outlives that machine (10-31 07:19Z: 5e7fe7e0 VOID, its relays on the retired macOS).
    publicationRelays: process.env.ARENA_PUBLICATION_RELAYS ? process.env.ARENA_PUBLICATION_RELAYS.split(',') : members.map((m) => `http://${host}:${m.port}`),
    donationSetId: (donationSetAt && donationSetAt(censusHeight, NETWORK_ID)) || idOfDonationSet(DONATION_SET.recipients), censusHeight,
    censusRoot: new Uint8Array(32), stakeMsat, bondMinSats: 50000n, blockTicks: runTicksAt(committeeTimeMs + MIN_ENTRY_WINDOW_MS),
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 100000, rankNumerator: 3, rankDenominator: 4,   // min_score 1 point, in the score's 1e-5 points
    nodes: [a.round.pubkey, b.round.pubkey, ...rest.map((d) => d.round.pubkey)],
    ...(roundFields || {}),
  };
  // 2026.0.2 - THE ROUND NAMES NO DRAW (RULED 2026-10-13): ARENA_PROTOCOL_VERSION=2 writes a v2 contract
  // with no nodes; every seat draws its 7 from the census and the beacon and writes them in itself. A census of 14 nodes
  // (two federations) can then open a round at all.
  // AND 2026.0.3: ARENA_PROTOCOL_VERSION=3 is a v2 round (no draw named) at version 3, which may name its
  // creator and its rules; every node of testnet4 advertises 1,2,3 since 156545/156546
  const VERSION = Number(process.env.ARENA_PROTOCOL_VERSION || 1);
  const V2 = VERSION >= 2;
  if (V2) { contract.protocolVersion = VERSION; contract.nodes = []; }
  // AND A COMMITTEE THE PROTOCOL HAS A THRESHOLD FOR, said here rather than
  // discovered half an hour later. `dkg.deal` asks `receiptsNeeded(nodes.length)`
  // and only 2 (2-of-2) and 7 (5-of-7) have an answer; for anything else it
  // refuses, no claim key is ever dealt, and `makeClaimKey` retries in the
  // background until entry close without logging a thing. Measured on the first
  // three-node round: all three daemons answered "this signer node holds no
  // claim key for that round yet" for 240 s and no stake could be locked.
  try { receiptsNeeded(V2 ? contract.settlementSlots : contract.nodes.length); }
  catch (e) {
    await a.close(); await b.close(); for (const d of rest) await d.close();
    throw new Error(`${contract.nodes.length} signer nodes cannot hold a round's key: ${e.message}. `
      + 'The committee sizes the protocol defines are 2 (2-of-2) and 7 (5-of-7); a round assigned any '
      + 'other number opens and can never settle, because its claim key is never dealt.');
  }

  // THE CENSUS ROOT IS THE CHAIN'S, NOT A NUMBER THIS TOOL LIKES.
  //
  // It was 32 bytes of 2, which is why joining could never have run here even
  // with a chain view: `censusFor` refuses a round whose named root is not the
  // one its own blocks derive to. Derived from the SAME contract the round
  // will carry and the same view the daemons are handed, so the two cannot
  // disagree - the root is the only field that is filled in afterwards,
  // because it is the hash OF the answer.
  // DERIVED FROM THE CONTRACT AS THE DAEMON WILL SEE IT: encoded and decoded
  // back. `protocolVersion` is written by the encoder and read by the decoder
  // rather than typed into a literal, and the census refuses a round that
  // names none - so deriving from the object in hand would ask a different
  // question from the one the node asks.
  // A FUNCTION OF THE CONTRACT AND THE VIEW, because every round this tool
  // opens (M3.3-34's opener) derives its own root the same way.
  let lastCensusEntries = [];         // the census the root was derived from: a v2 round is posted to every node of it
  const censusRootFor = (c) => {
  const byTxid = new Map();
  for (const block of censusView.blocks)
    for (const raw of block.transactions || []) {
      try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ }
    }

  const asSeen = decodeRoundContract(encodeRoundContract(c));
  const census = deriveCensus(censusView, {
    contract: asSeen,
    // A DEVNET THAT SLASHES (ARENA_BOND_TEMPLATE3_KEY): its template-3 bonds count under census key 0, standing from height 0, as the seats' own scan reads it
    bond: process.env.ARENA_BOND_TEMPLATE3_KEY && network === 'regtest'
      ? { ...bondSetFor(network), standingKeys: [{ epoch: 0, publicKey: fromHex(process.env.ARENA_BOND_TEMPLATE3_KEY), height: 0 }] } : bondSetFor(network),
    // AS THE SEATS DERIVE IT (roster.js): updates and re-affirmed ancestor bonds checked with BIP-340
    verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    // RESOLVED FROM THE VIEW ITSELF, the way `roster.censusFor` does it: 5A.2
    // puts the advertisement body in the witness of the funding transaction,
    // so a holder of the blocks needs nobody to serve it one. Doing it the same
    // way here is what makes the root this tool computes the root the daemons
    // compute.
    resolve: (e) => {
      const raw = byTxid.get(toHex(e.txid));
      return raw ? { transaction: raw } : null;
    },
  });
  if (!census.ok) throw new Error('this tool could not derive its own census: ' + census.why);
  lastCensusEntries = census.entries;
  return census.root;
  };
  contract.censusRoot = censusRootFor(contract);

  // AND THE ROUND IS PUBLISHED BELOW ITS BEACON BLOCK (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published strictly before the
  // beacon. On the local chain the publication goes into block 10 - above the
  // census height (9), far below the beacon - and the chain is mined again.
  // The times do not move, so committee_time and the beacon's index do not;
  // the census root does not either, because it is the bonds', not the hashes'.
  if (localBlocks) {
    localBlocks[10] = { transactions: [publicationOf(contract)] };
    const again = chainOf(localBlocks, 0);
    censusView = again;
    localChain = again.blocks.map((x) => x.header);
  }
  // ON REGTEST: bitcoind's own OP_RETURN data output, funded and signed by its
  // wallet, in the next block - then the chain moves past committee_time.
  // Mined in batches until the rule names a block, waiting out the seconds the
  // chain's clock needs, and bounded, so a chain that never names one says so.
  // One function for every round this tool publishes: the first, and each one
  // the opener adds (M3.3-34) - each under its own beacon block.
  // NOTHING HERE BLOCKS THE SIGNER NODES (2026-09-17 19:15: ghosts "only every 300-600 ms"). Both signer nodes
  // share this process's event loop, and every round this keeper opened read the WHOLE chain since the start again -
  // two synchronous bitcoin-cli spawns a block, from 20 below the bonds to the tip, twice or more an opening. The Daily
  // mines ~10 blocks a minute, so twenty minutes after a start that was ~440 blocking spawns every round: measured from
  // outside, both nodes answered nothing for 28.1 s at once, and 300-650 ms stalls every 1-3 s besides. The view now
  // GROWS - only blocks above the one it holds are read - and every call on this path is bitcoind's RPC, awaited.
  // bitcoind's RPC when the caller gave one (the Daily does); a tool that gave only its cli keeps the cli, synchronous
  // as it always was - only an argument that is not a string is written as JSON for it.
  const chainCall = rpc || (async (method, params = []) => {
    const out = cli(method, ...params.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
    return /^[[{]/.test(out) ? JSON.parse(out) : out;
  });
  // A BUSY BITCOIND IS ASKED AGAIN, NOT GIVEN UP ON. Measured on the Daily: with the node at ~5 cores of this host, one
  // `getblockcount` came back "fetch failed" during stand-up and took the whole launcher down with it - the signer nodes
  // then restart-looped. Reading the chain is not a decision; a read that fails is retried five times, 300 ms apart,
  // and only then thrown, which is what a spawned bitcoin-cli did by being a fresh connection every time.
  const chainRpc = async (method, params = []) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try { return await chainCall(method, params); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300)); }
    }
    throw last;
  };
  async function viewToTip() {
    const from = Math.max(0, bondFloor - 20);
    const tip = Number(await chainRpc('getblockcount', []));
    let have = censusView && censusView.firstHeight === from ? censusView : { blocks: [], firstHeight: from };
    // A REORG REPLACES BLOCKS THIS VIEW ALREADY HOLDS: drop them back to the last one the chain still has, or the
    // next block read does not follow the view's end and every later look is "not a chain" (measured testnet4
    // 2026-09-28 09:00: a 2-block reorg at 154203 held round 919acf85's beacon wait on a stale view).
    let keep = have.blocks.length;
    while (keep > 0) {
      const ours = blockHashOf(have.blocks[keep - 1].header);
      const theirs = String(await chainRpc('getblockhash', [from + keep - 1]));
      if (theirs === toHex(ours) || theirs === toHex(Uint8Array.from(ours).reverse())) break;
      keep--;
    }
    if (keep < have.blocks.length) {
      console.log(`[view] reorg: ${have.blocks.length - keep} block(s) from ${from + keep} replaced; reading them again`);
      have = { blocks: have.blocks.slice(0, keep), firstHeight: from };
    }
    const next = from + have.blocks.length;
    if (next > tip) return have;
    const more = await blocksOver(chainRpc, next, tip);
    return { blocks: have.blocks.concat(more.blocks), firstHeight: from };
  }
  const tipHeader = async () => {
    const h = Number(await chainRpc('getblockcount', []));
    return (await blocksOver(chainRpc, h, h)).blocks[0].header;
  };
  const mineAsync = async (n) => chainRpc('generatetoaddress', [n, await chainRpc('getnewaddress', [])]);

  async function publishOnChain(c) {
    const raw = await chainRpc('createrawtransaction', [[], [{ data: toHex(publicationPayload(roundId(c))) }]]);
    // REPLACEABLE, so a publication left in the mempool can have its fee raised (awaitPublishedBeacon).
    const paid = (await chainRpc('fundrawtransaction', onChain.minable ? [raw] : [raw, { fee_rate: 2, replaceable: true }])).hex;
    const signed = (await chainRpc('signrawtransactionwithwallet', [paid])).hex;
    // ON TESTNET4 IT IS BROADCAST, and the chain's own blocks carry it and then pass committee_time: nothing is
    // mined, so nothing here can choose the beacon. ITS OWN PUBLICATION FIRST (2026-09-30, the fcb15cca refusal):
    // no beacon is named, and nothing is posted, until the publication has confirmed below the beacon block; its fee is
    // raised while it waits; a round whose beacon block came first answers `dead` and is never posted.
    if (!onChain.minable) {
      const txid = await chainRpc('sendrawtransaction', [signed]);
      console.log(`[publish] round ${toHex(roundId(c)).slice(0, 16)} published in ${txid}; waiting for it to confirm, then its beacon, on ${network}`);
      const got = await awaitPublishedBeacon({ contract: c, txid, rpc: chainRpc, view: async () => (censusView = await viewToTip()),
        sleepMs: Number(process.env.ARENA_PUBLISH_LOOK_MS || 60000) });
      if (got.dead) console.log(`[publish] ${got.why}`);
      else console.log(`[publish] round ${toHex(roundId(c)).slice(0, 16)} confirmed at ${got.publishedAt}; its beacon is block ${got.named.height}`);
      return got.dead ? got : got.named;
    }
    await chainRpc('generateblock', [await chainRpc('getnewaddress', []), [signed]]);
    // PUBLISHED AHEAD (2026-10-01: "publish each round as soon as it is drafted; the block clock names the beacon
    // later"): mined into a block now, and the beacon left to the chain's own block clock - the round is posted at once.
    if (PUBLISH_AHEAD && c.committeeTimeMs > BigInt(Date.now()) + 5000n) return { ahead: true };
    let tries = 0;
    for (;;) {
      censusView = await viewToTip();
      const named = beaconFromChain(c,
        { headers: censusView.blocks.map((b) => b.header), firstHeight: censusView.firstHeight });
      if (named.ok) return named;
      if (++tries > 8) throw new Error('this chain names no beacon after 8 batches: ' + named.why);
      const wait = Number(c.committeeTimeMs) + 1500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await mineAsync(6);
    }
  }
  // A ROUND WHOSE BEACON CAME BEFORE ITS PUBLICATION IS DRAFTED AGAIN - a new committee time just past the tip, the
  // same windows after it, its own census root and its own publication - never posted as it was.
  if (onChain && openFirst) {
    for (let drafts = 1; ; drafts++) {
      const got = await publishOnChain(contract);
      if (!got || !got.dead) break;
      if (drafts >= 6) throw new Error(`six rounds in a row were not published before their beacons: ${got.why}`);
      const tip = (await blocksOver(chainRpc, Number(await chainRpc('getblockcount', [])), Number(await chainRpc('getblockcount', [])))).blocks[0].header;
      const shift = (BigInt(blockTimeOf(tip)) + 2n) * 1000n - contract.committeeTimeMs;
      contract.committeeTimeMs += shift; contract.startTimeMs += shift; contract.entryCloseMs += shift;
      censusView = await viewToTip();
      contract.censusRoot = censusRootFor(contract);
      console.log(`[publish] drafted again as round ${toHex(roundId(contract)).slice(0, 16)}: committee time ${new Date(Number(contract.committeeTimeMs)).toISOString()}`);
    }
  }

  // AND THE BEACON IS READ BEFORE THE ROUND IS POSTED, because posting is when
  // a node signer nodes: `POST /round` calls `assignSignerNodes`, joining needs the committee
  // seed, and the seed is this beacon. Read after, the daemons refuse the
  // round with "this node has no beacon for that round" - measured, that is
  // exactly what happened the first time this was wired.
  //
  // It is also the real order. 5A.5 has the committee form AT committee_time;
  // a node that has not seen the beacon has nothing to form it from.
  let beaconSeen = null;
  if (beacon && openFirst) {
    // A CHAIN THAT CANNOT BE READ IS NOT A ROUND THAT CANNOT EXIST for the
    // caller of this tool: the refusal is carried out rather than thrown, so
    // an operator reads one line instead of a stack. The daemons will still
    // refuse to signer node, by name, which is the honest end of it.
    try { beaconSeen = await beacon.refresh(contract); }
    catch (e) { beaconSeen = { ok: false, why: e.message }; }
  }

  // WHAT IS OPENED IS CLOSED, even when the round is refused. A daemon left
  // listening after a throw is a port nobody frees and a test run that never
  // exits - measured, the first version of this hung the suite.
  // THE OPERATOR NAMES ITS ROUND, now that the contract that names both
  // daemons gives it an id - what ARENA_FUNDED_ROUNDS does for main.js.
  if (funded.nameRound && openFirst) funded.nameRound(roundId(contract));
  if (beforeRound) await beforeRound();
  // BOTH DAEMONS, ONE ROUND: posted to each, and both must name it the same.
  /** THE OTHER NODES OF THE CENSUS a v2 round is drawn from: [node key hex, https root], ARENA_ROUTE_MAP applied. */
  function otherCensusSeats() {
    const own = new Set([a, b, ...rest].map((d) => toHex(d.round.pubkey)));
    const routes = (process.env.ARENA_ROUTE_MAP || '').split(',').filter(Boolean).map((x) => x.split('='));
    const reach = (u) => routes.reduce((v, [from, to]) => v.replace(`//${from}`, `//${to}`), String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, ''));
    return [...new Map(lastCensusEntries.filter((e) => !own.has(toHex(e.pubkey)) && e.advert && e.advert.endpoint)
      .map((e) => [toHex(e.pubkey), reach(e.advert.endpoint)])).entries()];
  }
  async function postRound(c) {
    const body = encodeRoundContract(c);
    const opened = [];
    // EVERY DAEMON THIS ROUND HAS, not the first two. Measured after the third
    // node was added and the round was posted to A and B alone: C answered
    // "404 this node holds no such round" to the claim key, and the round could
    // not be played at all. A committee member that was never told of the round
    // is not a committee member.
    // ALL OF THEM AT ONCE (measured on the paid regtest stack: one after another, each seat's first "no chain
    // view" and its 3 s retry added up - 11-20 s an opening, and 8 s head-to-head rounds closed 11-20 s apart)
    await Promise.all([a, b, ...rest].map(async (node, at) => {
      // ATTACHED, A NODE READS A ROUND'S VIEW OFF ITS OWN BITCOIND THE FIRST TIME IT IS ASKED (main.js chainFor) and
      // refuses until it has it: asked again, 3 s apart, for up to five minutes - that refusal only.
      let r, why = '';
      for (let tries = 0; ; tries++) {
        r = await fetch(`http://${host}:${node.port}/round`, { method: 'POST', body });
        if (r.ok) break;
        why = await r.text();
        // AND A NODE WHOSE OWN VIEW HAS NOT YET READ THE PUBLICATION this tool saw confirm below the beacon: asked again,
        // not exited on (2026-09-30). A round whose beacon came first never gets here - it is drafted again.
        if (!(attach && /no chain view|view .*pending|no beacon|no publication transaction/i.test(why)) || tries >= 100) break;
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (!r.ok) throw new Error(`${node.port} refused the round: ${why}`);
      opened[at] = toHex(new Uint8Array(await r.arrayBuffer()));
    }));
    const rid = toHex(roundId(c));
    if (opened.some((o) => o !== rid))
      throw new Error(`the ${opened.length} daemons named the round differently: ` + opened.join(' '));
    // A V2 ROUND GOES TO EVERY NODE OF ITS CENSUS: any of them may be drawn, and a drawn node that never held
    // the round signs no PRESENT. Each at its advertised endpoint (wss -> https), through ARENA_ROUTE_MAP's host aliases
    // ("from=to,..."; the test host reaches the the test host's seats at tn4.bitcoin-arena.io); best effort, each answer logged.
    if (V2) {
      const others = otherCensusSeats();
      const said = await Promise.all(others.map(async ([k, url]) => {
        for (let tries = 0; ; tries++) {
          try {
            const r = await fetch(`${url}/round`, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
            if (r.ok) return `${k.slice(0, 8)} ok`;
            const why = await r.text();
            if (!/no chain view|view .*pending|no beacon|no publication transaction/i.test(why) || tries >= 40) return `${k.slice(0, 8)} ${r.status} ${why.slice(0, 80)}`;
          } catch (e) { if (tries >= 40) return `${k.slice(0, 8)} unreachable ${e.message}`; }
          await new Promise((res) => setTimeout(res, 3000));
        }
      }));
      console.log(`[publish] v2 round ${rid.slice(0, 16)} posted to the other ${others.length} census nodes: ${said.join('; ')}`);
    }
    return rid;
  }
  let id = null;
  if (openFirst) try { id = await postRound(contract); } catch (e) {
    await a.close(); await b.close(); if (nodeC) await nodeC.close();
    throw e;
  }

  // WHERE A BROWSER CAN ACTUALLY REACH THESE DAEMONS.
  //
  // An https page cannot fetch `http://100.x.y.z:8090` - the browser blocks it
  // as mixed content, and what the player sees is a round that never loads and
  // a play socket that never comes up. Photographed 07:40 and again at 09:44
  // as "play - A dropped".
  //
  // `ARENA_WSS_<port>` already names where that daemon is reachable from
  // outside, because the socket endpoint had the same problem first. The same
  // origin serves its http doors, so the URL is built from it rather than from
  // the address this process happens to be bound to. Two daemons behind one
  // reverse proxy differ by their first path segment, which is exactly what
  // the client's own two-source rule was taught to count.
  const publicFor = (port, fallback) => {
    const wss = process.env[`ARENA_WSS_${port}`];
    if (!wss) return fallback;
    try {
      const u = new URL(wss);
      if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return fallback;
      return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch { return fallback; }
  };
  const reach = [
    publicFor(a.port, `http://${host}:${a.port}`),
    publicFor(portB, `http://${host}:${portB}`),
    ...rest.map((d) => publicFor(d.port, `http://${host}:${d.port}`)),
  ];

  // `headers=` is not named: the client already forms `<node>/headers` from
  // the nodes, and a URL that repeats what the default already says is a
  // second place to get it wrong.
  const url = `${page}/?round=${id}`
    + `&node=${reach.join(',')}`
    + `&bond=${reach[0]}/bond`
    + `&advert=${toHex(bonded[0].signature)}`
    + (invite ? `&federation=${invite}` : '');
  // THE LOBBY'S LINK (M3.3-34): the same names, and no round. The page asks the
  // named nodes what they hold and checks every round it is told of.
  const lobbyUrl = `${page}/?node=${reach.join(',')}`
    + `&bond=${reach[0]}/bond`
    + `&advert=${toHex(bonded[0].signature)}`
    + (invite ? `&federation=${invite}` : '');

  // THE NEXT ROUND, ON THE SAME TWO DAEMONS AND THE SAME CHAIN (M3.3-34).
  //
  // A lobby with one round in it is empty two minutes after that round's entry
  // closes. So the tool opens another the way it opened the first: the same
  // committee's contract with new times - committee_time just past the tip's
  // own timestamp, the same entry window - its census root derived again, its
  // hash published in the next block and the chain mined until its beacon block
  // is named ABOVE that publication, and then posted to both daemons.
  //
  // ONLY ON A BITCOIND. The fixture chain's clock is fixed (its blocks are dated
  // from 2026-09-06), so a round opened on it today would be past its entry
  // close before anybody saw it: refused by name rather than listed as open.
  const held = openFirst ? [contract] : [];
  // NO GAP BETWEEN 90 s ROUNDS ACROSS A RESTART (2026-10-01: "There may be no gaps between 90 sec rounds"): the rounds
  // this pair already holds - written by the opener before it stopped, still in the signer nodes' stores - are the grid it
  // goes on from. Without them a restart began a new grid at its own first round, and the slots in between went unplayed.
  if (roundPeriodMs && a && a.round && typeof a.round.openRounds === 'function') {
    const nowMs = BigInt(Date.now());
    for (const r of a.round.openRounds()) {
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (c.startTimeMs > nowMs && !held.some((h) => toHex(roundId(h)) === toHex(roundId(c)))) held.push(c);
    }
  } else if (roundPeriodMs && attach) {
    // ATTACHED, THE HELD ROUNDS ARE ASKED OF NODE A: the rounds it announces, each contract by its id.
    const nowMs = BigInt(Date.now());
    try {
      const listed = (await (await fetch(`http://${host}:${portA}/rounds?ahead=${2 * 3600000}`)).json()).rounds || [];
      for (const r of listed) {
        const got = await fetch(`http://${host}:${portA}/round?id=${r.id}`);
        if (!got.ok) continue;
        let c; try { c = decodeRoundContract(new Uint8Array(await got.arrayBuffer())); } catch { continue; }
        if (c.startTimeMs > nowMs && !held.some((h) => toHex(roundId(h)) === toHex(roundId(c)))) held.push(c);
      }
    } catch (e) { console.error(`[keeper] the held rounds could not be read from node A: ${e.message}`); }
  }
  // `kind` overrides the first round's stake and custody - `paid` for the paying
  // round kept beside the free one; nothing else of the contract changes, so both
  // kinds name the same core, config and signer nodes.
  async function openNext(kind = {}) {
    if (!onChain) throw new Error('a later round needs a bitcoind: the fixture chain\'s clock is fixed, '
      + 'so a round opened on it now would already be past its entry close');
    // JUST PAST THE LATER OF THE TIP'S TIME AND NOW. The tip's own time is what
    // keeps the publication block from being the beacon (its median cannot pass
    // it) - and it is the LAST block's time, not the clock's. Measured: with no
    // block mined since the first round, the tip was two minutes old, the next
    // round opened with 59 s of its 180 s entry left, and the keeper opened a
    // second one 6 s later. Now is later than that tip, so the rule still holds.
    const tip = await tipHeader();
    let committee = (BigInt(Math.max(blockTimeOf(tip), Math.floor(Date.now() / 1000))) + 2n) * 1000n;
    // `kind.committeeAtMs`: a committee time further ahead - with ARENA_PUBLISH_AHEAD the round is mined into a
    // block and posted at once, and the chain's own block clock names its beacon later. Without it every opening waited for
    // its committee time and mined six blocks: 12-23 s each, so 8 s head-to-head rounds could not follow each other
    if (kind.committeeAtMs !== undefined && BigInt(kind.committeeAtMs) > committee) committee = BigInt(kind.committeeAtMs);
    let start = committee + MIN_ENTRY_WINDOW_MS;
    // `kind.entryAfterStartMs`: this kind's own entry window after its start - a head-to-head round closes its
    // entries a couple of minutes in, not when the first round's (a 30-minute nextblock window) would
    let close = start + (kind.entryAfterStartMs !== undefined ? BigInt(kind.entryAfterStartMs) : (contract.entryCloseMs - contract.startTimeMs));
    // `kind.entryCloseAtMs`: an exact entry close - a market on its own period closes on its UTC grid
    if (kind.entryCloseAtMs !== undefined) close = BigInt(kind.entryCloseAtMs);
    if (roundPeriodMs) {
      // ON THE PERIOD: the last round of this kind's start + 90 s, stepped on until its committee time is still ahead of
      // the chain and the clock (a committee time the chain has passed cannot name a beacon after its publication).
      const stake = kind.stakeMsat !== undefined ? BigInt(kind.stakeMsat) : contract.stakeMsat;
      const last = held.filter((c) => BigInt(c.stakeMsat) === stake).reduce((m, c) => (c.startTimeMs > m ? c.startTimeMs : m), 0n);
      // A WHOLE PERIOD OF LEAD, not the protocol's 60 s minimum: a round is listed once its committee time has passed
      // (its beacon is the first block after it), so with a 90 s lead round i+1 is listed as round i starts - before any
      // run of round i can end, and the countdown has its number from the first second (measured with 60 s: a run over
      // 9.5 s into its round waited 20 s for the next round to be listed).
      // ARENA_COMMITTEE_LEAD_MS (ORDER-2116, measured on the free pair 2026-10-01): a round posted ahead is assigned by each
      // node once its beacon - the first block whose median time passes committee_time - is 6 deep on its own chain. On the
      // 10 s regtest clock that is ~95 s after committee_time (median lags ~50 s, six blocks ~50 s): with a 90 s lead every
      // free round was assigned after its entry had closed, and none was joinable. 180 s leaves ~85 s to join. The start
      // grid is unchanged: one round every period.
      const lead = COMMITTEE_LEAD_MS !== null ? BigInt(COMMITTEE_LEAD_MS)
        : BigInt(roundPeriodMs) > MIN_ENTRY_WINDOW_MS ? BigInt(roundPeriodMs) : MIN_ENTRY_WINDOW_MS;
      start = last > 0n ? last + BigInt(roundPeriodMs) : start;
      while (start - lead < committee) start += BigInt(roundPeriodMs);
      committee = start - lead;
      close = start;
    }
    const next = { ...contract,
      ...(kind.stakeMsat !== undefined ? { stakeMsat: BigInt(kind.stakeMsat) } : {}),
      ...(kind.custody ? { custody: kind.custody } : {}),
      committeeTimeMs: committee, startTimeMs: start, entryCloseMs: close, blockTicks: runTicksAt(start),
      // ANOTHER GAME'S ROUND ON THE SAME SEATS: its fields over this one (a market's game id, no core, no config)
      ...(kind.fields || {}) };
    // `kind.stakeExpiryFor(round)`: a market round's own lock span, sized from its times (lock-expiry.js)
    if (typeof kind.stakeExpiryFor === 'function') next.stakeExpiryBlocks = kind.stakeExpiryFor(next);
    censusView = await viewToTip();
    // THE KEEPER'S OWN WORK, NAMED (2026-09-17 19:15, the ghost lag). Eight of twelve stalls over 300 ms still
    // name nothing but 0-20 ms of frames while this thread burns 190-250 ms, and the keeper opening a round is the
    // last stretch of this thread nobody timed: it runs in the same process as both signer nodes, so whatever it holds,
    // the pictured trucks wait for. One name, on both of its stretches; nothing is moved.
    next.censusRoot = timed('keeper opening a round', () => censusRootFor(next), { over: 20 });
    const published = await publishOnChain(next);
    // NOT PUBLISHED BEFORE ITS BEACON: not opened; the keeper drafts the next one from the chain as it stands then.
    if (published && published.dead) throw new Error(`the next round was not opened: ${published.why}`);
    const seen = published && published.ahead ? { ok: true, ahead: true } : beacon ? await beacon.refresh(next) : { ok: false, why: 'no beacon' };
    if (!seen.ok) throw new Error('the next round names no beacon: ' + seen.why);
    if (funded.nameRound) funded.nameRound(roundId(next));
    const nextId = await timed('keeper opening a round', () => postRound(next), { over: 20 });
    held.push(next);
    return nextId;
  }

  // A GRID ON DEMAND (2026-10-11, path B: "When a table waits, one transaction carries the next 30 min
  // of rounds, about an hour ahead"): `slots` slots `windowMs` apart, `tables` rounds side by side in each, every one a
  // whole round contract of `kind`. PUBLISHED AS ONE SHORT SERIES PER TABLE (2026-10-12: "Pick S ... one ARN S
  // series_id output per table, two per grid"; series.js gridIsValid - lead >= 45 min, at most 30 min of rounds, its own
  // entry window): table k is a template - the first slot's round, its committee time k ms before the grid's so the
  // tables' ids differ - with `grid`, its period and its count; round i of it is derived, never authored, and nothing per
  // round is chosen after the beacon. Until 2026-10-12 every round was its own OP_RETURN "ARN" ROUND - 450 outputs, ~21,000
  // sat at 1 sat/vB. One committee time, so one beacon: once the publication has confirmed below it and it is deep, each
  // table's line is posted to every seat (POST /series - one post per table, not 450 round posts), and the seats' series
  // writers open the rounds. A beacon that came before the publication confirmed answers `dead`: nothing is posted.
  async function openGrid(kind = {}, { slots = 225, tables = 2, windowMs = 8000n, entryAfterStartMs = 80000n, firstCloseMs,
    committeeTimeMs, feeRate = 1, maxFeeRate = 4, onPublished = () => {}, onPosted = () => {}, extraOutputs = [], waitBeacon = true } = {}) {
    if (!onChain || onChain.minable) throw new Error('a grid is published on a chain nobody here mines (testnet4)');
    if (firstCloseMs === undefined || committeeTimeMs === undefined) throw new Error('a grid names its first close and its committee time');
    // A GRID OF ITS OWN CENSUS HEIGHT (kanban #689: the duty names the census of the day it posts, not the one this tool stood up at its
    // start - 10-20 and 10-26 days named a census from before their version's adverts): the view's window moves with it
    if (kind.fields && kind.fields.censusHeight !== undefined) censusFloorTo(Number(kind.fields.censusHeight));
    censusView = await viewToTip();
    // THE TABLES, THEIR IDS, LINES AND OUTPUTS (src/grid-build.js, kanban #702: the node's own duty poster builds a grid the same way)
    const built = buildGrid({ contract, kind, slots, tables, windowMs, entryAfterStartMs, firstCloseMs, committeeTimeMs, censusRootFor,
      censusEntries: () => lastCensusEntries, blockTicksAt: runTicksAt, extraOutputs });
    const { templates, ids, lines, outs, start, first, committee } = built;
    tables = built.tables;
    const grid = [];
    for (let s = 0; s < slots; s++) for (let k = 0; k < tables; k++) grid.push(seriesRound(templates[k], s));
    // THE COINS CHOSEN HERE, AT feeRate - under the wallet's 1 sat/vB floor when asked (fund-at-rate.js; 2026-10-12
    // "Mach das deutlich sparsamer"); the wallet signs. ARENA_GRID_DRY=1: built, signed and asked of the node's mempool - not sent
    const sent = await publishGridTx({ outs, rpc: chainRpc, feeRate, dry: process.env.ARENA_GRID_DRY === '1' });
    const { hex: signed, vsize, fee } = sent;
    if (sent.dry) {
      return { ok: false, dry: true, accepted: sent.accepted, reject: sent.reject, bytes: vsize, feeSat: String(fee), outputs: outs.length,
        series: ids.map((id) => toHex(id)), lines, rounds: grid.length, firstStart: new Date(Number(start)).toISOString(),
        lastClose: new Date(Number(grid[grid.length - 1].entryCloseMs)).toISOString(), committeeTime: new Date(Number(committee)).toISOString(),
        leadMs: String(start - committee) };
    }
    const txid = sent.txid;
    onPublished({ txid, rounds: grid.length, bytes: vsize, feeSat: String(fee), series: ids.map((id) => toHex(id)), lines,
      // the first 900 rounds' contracts for the tools that read them (a 24 h grid derives 21,600; every seat derives them itself)
      contracts: grid.slice(0, 900).map((c) => toHex(encodeRoundContract(c))), firstClose: new Date(Number(first)).toISOString(),
      committeeTime: new Date(Number(committee)).toISOString() });
    // AND ANNOUNCED AT ONCE (kanban #560, 2026-10-20: "it will work on future testnet and mainnet with nodes not operated by us"): every
    // seat this tool runs and every other node of the census gets the signed line and the publication (POST /expected), checks both and
    // says when the grid's first window comes - its rounds are posted only once its beacon block is 6 deep. Not waited for.
    announceGrid({ lines, tx: signed, targets: [...[a, b, ...rest].map((n) => `http://${host}:${n.port}`), ...[...otherCensusSeats()].map(([, url]) => url)] })
      .then((said) => console.log(`[grid] ${txid.slice(0, 16)} announced at ${said.took} of ${said.of} seat(s)`)).catch(() => {});
    // THE DUTY KEEPER waits for nothing here: it posts the series to the seats itself once the publication confirms
    if (!waitBeacon) for (const sid of ids) if (funded.nameRound) funded.nameRound(sid);   // named funded before any seat is asked
    if (!waitBeacon) return { ok: true, published: true, txid, series: ids.map((id) => toHex(id)), lines, rounds: grid.length,
      lastCloseMs: grid[grid.length - 1].entryCloseMs, firstStartMs: start };
    // LOOKED FOR UNTIL THE GRID'S LAST ROUND HAS STARTED, not 240 looks (measured 2026-10-12: grid 8290176f was
    // published at 156211 and its beacon 156216 was 4 deep when the keeper gave up after 2 h - "neither a beacon above its
    // publication nor a dead round after 240 looks" - testnet4's coinbase-only blocks came one per 20 min)
    const sleepMs = Number(process.env.ARENA_PUBLISH_LOOK_MS || 60000);
    const lastStartMs = Number(grid[grid.length - 1].startTimeMs);
    const maxLooks = Math.max(240, Math.ceil((lastStartMs - Date.now()) / sleepMs) + 10);
    const got = await awaitPublishedBeacon({ contract: grid[0], txid, rpc: chainRpc, view: async () => (censusView = await viewToTip()),
      feeRate, maxFeeRate, sleepMs, maxLooks });
    if (got.dead) return { ok: false, dead: true, why: got.why, txid };
    if (beacon) {
      const seen = await beacon.refresh(grid[0]);
      if (!seen.ok) return { ok: false, why: 'the grid names no beacon: ' + seen.why, txid: got.txid };
    }
    // ONE POST PER TABLE TO EVERY SEAT, its series id named funded first; a seat whose own view has not read the publication
    // yet is asked again, 3 s apart
    const posted = [];
    for (let k = 0; k < tables; k++) {
      if (funded.nameRound) funded.nameRound(ids[k]);
      const answers = await Promise.all([a, b, ...rest].map(async (node) => {
        let why = '';
        for (let t = 0; t < 100; t++) {
          try {
            const r = await fetch(`http://${host}:${node.port}/series`, { method: 'POST', body: lines[k] });
            if (r.ok) return { port: node.port, ok: true, ...(await r.json()) };
            why = await r.text();
            if (!/no chain view|view .*pending|fetch failed|nobody has funded/i.test(why) || t >= 20) break;
          } catch (e) { why = e.message; }
          await new Promise((res) => setTimeout(res, 3000));
        }
        return { port: node.port, ok: false, why };
      }));
      // AND A V2 GRID TO EVERY OTHER NODE OF ITS CENSUS: any of them may be drawn for a round of it
      if (V2) for (const [key, url] of otherCensusSeats()) {
        let ok = false, why = '';
        for (let t = 0; t < 20 && !ok; t++) {
          try { const r = await fetch(`${url}/series`, { method: 'POST', body: lines[k], signal: AbortSignal.timeout(30000) }); ok = r.ok; if (!ok) why = await r.text(); }
          catch (e) { why = e.message; }
          // a seat of the other federation may not hold the funding yet (measured 2026-10-13 18:57Z: 7 of 14 "nobody has funded"; the A<->B
          // funding sync runs every 30 s): asked again
          if (!ok && !/no chain view|view .*pending|fetch failed|unreachable|nobody has funded/i.test(why)) break;
          if (!ok) await new Promise((res) => setTimeout(res, 3000));
        }
        answers.push({ port: key.slice(0, 8), ok, why });
      }
      for (const x of answers) if (!x.ok) console.log(`[grid] series ${toHex(ids[k]).slice(0, 16)} refused by ${x.port}: ${x.why}`);
      posted.push({ series: toHex(ids[k]), seats: answers.filter((x) => x.ok).length, of: answers.length });
    }
    // THE PUBLISHER'S FEE, ASKED AGAIN: the seats that did not take a proof yet, every 10 min until each has, 30 h at most
    function proveLater(id, txHex, parents, seats, untilMs = Date.now() + 30 * 3600 * 1000) {
      setTimeout(async () => {
        const still = [];
        for (const u of seats) {
          try { const r = await fetch(`${u}/series-publication`, { method: 'POST', body: JSON.stringify({ series: toHex(id), tx: txHex, parents }), signal: AbortSignal.timeout(30000) });
            if (r.ok) console.log(`[grid] series ${toHex(id).slice(0, 16)}: publication fee proven at ${u}`); else still.push(u); } catch { still.push(u); }
        }
        if (still.length && Date.now() < untilMs) proveLater(id, txHex, parents, still, untilMs);
        else if (still.length) console.log(`[grid] series ${toHex(id).slice(0, 16)}: publication fee never proven at ${still.length} seat(s)`);
      }, 600000);
    }
    // THE PUBLISHER'S FEE, PROVEN (§5A.5): a grid that names its creator posts its publication and that transaction's
    // parents (the wallet's own, so it holds them) to every seat it posted the series to - each seat proves the fee from the bytes and
    // pays it back (capped) to the creator's key in the series' first round with entries
    let proven = null;
    if (kind.creatorSecret) {
      try {
        const txHex = (await chainRpc('gettransaction', [got.txid])).hex;
        const tx = parseTransaction(fromHex(txHex));
        const parents = [];
        for (const i of tx.inputs) parents.push((await chainRpc('gettransaction', [toHex(Uint8Array.from(i.previousTxid).reverse())])).hex);
        const seats = [...[a, b, ...rest].map((node) => `http://${host}:${node.port}`), ...(V2 ? [...otherCensusSeats()].map(([, url]) => url) : [])];
        proven = [];
        for (const id of ids) {
          const said = await Promise.all(seats.map(async (u) => {
            try { const r = await fetch(`${u}/series-publication`, { method: 'POST', body: JSON.stringify({ series: toHex(id), tx: txHex, parents }), signal: AbortSignal.timeout(30000) });
              return r.ok ? { ok: true, ...(await r.json()) } : { ok: false, why: (await r.text()).slice(0, 120) }; } catch (e) { return { ok: false, why: e.message }; }
          }));
          proven.push({ series: toHex(id), seats: said.filter((x) => x.ok).length, of: seats.length, feeSats: (said.find((x) => x.ok) || {}).feeSats || null,
            why: (said.find((x) => !x.ok) || {}).why || null });
          // AND AGAIN UNTIL EVERY SEAT HOLDS IT (measured 2026-10-15: the 10-16 postings went out unconfirmed, every seat answered "no
          // confirmed publication of that series yet", and a seat reads the publication only once its view of the round refreshes -
          // after the series' committee time, hours later - so the one try at publish time proved nothing and round 0 would have paid
          // nothing back): each seat that has not taken it is asked again every 10 min, for up to 30 h
          const left = seats.filter((u, k) => !said[k].ok);
          if (left.length) proveLater(id, txHex, parents, left);
        }
      } catch (e) { proven = [{ why: `the publication was not proven: ${e.message}` }]; }
    }
    for (const c of grid) held.push(c);
    onPosted({ posted, proven, rounds: grid.length, publishedAt: got.publishedAt, beacon: got.named.height, firstStart: new Date(Number(start)).toISOString() });
    return { ok: true, txid: got.txid, publishedAt: got.publishedAt, beacon: got.named.height, rounds: grid.length, posted,
      lastCloseMs: grid[grid.length - 1].entryCloseMs, ids: grid.map((c) => toHex(roundId(c))), series: ids.map((id) => toHex(id)) };
  }

  // AND KEEP ONE JOINABLE OF EACH KIND: whenever no round of a kind this tool
  // opened has more than `leadMs` of entry left, open the next of that kind -
  // the free round, and the paying one beside it when `paid` is given (the owner
  // 2026-09-15 12:54: both at once). One opening at a time; a failure is handed
  // to `onError` and the next check tries again.
  let keeper = null;
  function keepOpen({ everyMs = 5000, leadMs = 60000, onOpen = () => {}, onError = () => {},
    kinds = [{}, ...(paid ? [paid] : [])] } = {}) {
    if (keeper) return keeper;
    let opening = null;
    const stakeOf = (k) => BigInt(k.stakeMsat !== undefined ? k.stakeMsat : contract.stakeMsat);
    const check = () => {
      if (opening) return;
      const now = BigInt(Date.now());
      // ON THE PERIOD a kind is due while fewer than two of its rounds are still to start: round i+2 is published during
      // round i+1's lead, before its committee time (round i+1's start), and listed as round i+1 begins
      const due = kinds.find((k) => (roundPeriodMs
        ? held.filter((c) => BigInt(c.stakeMsat) === stakeOf(k) && c.startTimeMs > now).length < ROUNDS_AHEAD
        : !held.some((c) => BigInt(c.stakeMsat) === stakeOf(k) && c.entryCloseMs > now + BigInt(leadMs))));
      if (!due) return;
      opening = openNext(due).then((id) => onOpen(id, due), onError).finally(() => { opening = null; });
    };
    const timer = setInterval(check, everyMs);
    check();
    keeper = { stop() { clearInterval(timer); keeper = null; }, get opening() { return opening; } };
    return keeper;
  }

  // THE RECIPIENTS A PAID ROUND'S PAGE PAYS (M3.2 6e, ruled 2026-09-13), bound
  // LAST - once the round is up - so a round that is refused leaves nothing
  // listening (measured: bound first, a refused paid round kept 18777 bound). The
  // signed set names http://127.0.0.1:18777/lnurlp/blwp-test-a and -b, and until
  // this nothing listened there. They invoice from this launcher's own Lightning
  // endpoint - the same one that holds the stakes - and without one they answer
  // and refuse to invoice, by name.
  const recipients = donationRecipients
    ? await serveDonationRecipients({ host: '127.0.0.1', port: donationRecipients.port ?? TEST_RECIPIENT_PORT,
      invoice: donationRecipients.invoice || (ln.given ? (o) => ln.lightning.invoice(o) : null) })
    : null;

  // THE VIEW'S WINDOW FOR A CENSUS AT `height` (attached): the nodes read a census over the 2016 blocks below its height (main.js
  // CENSUS_LOOKBACK, as at the start above), so a later census height moves the window up - the blocks below it are dropped, nothing is
  // read again; a lower one reads its window afresh at the next viewToTip
  function censusFloorTo(height) {
    if (!attach || !Number.isInteger(height)) return;
    const floor = Math.max(20, height - 2016 + 20), from = Math.max(0, floor - 20);
    if (floor === bondFloor) return;
    if (censusView && Array.isArray(censusView.blocks) && from > censusView.firstHeight && from < censusView.firstHeight + censusView.blocks.length)
      censusView = { ...censusView, firstHeight: from, blocks: censusView.blocks.slice(from - censusView.firstHeight) };
    bondFloor = floor;
  }
  // THE CENSUS AT A HEIGHT, derived as the seats derive it, from this tool's view
  function censusEntriesAt(height) {
    const byTxid = new Map();
    for (const block of censusView.blocks) for (const raw of block.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
    const at = decodeRoundContract(encodeRoundContract({ ...contract, censusHeight: height }));
    const c = deriveCensus(censusView, { contract: at, bond: bondSetFor(network),
      verifyUpdate: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
      resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
    if (!c.ok) throw new Error('no census at ' + height + ': ' + c.why);
    return c.entries;
  }
  return {
    id, url, lobbyUrl, contract, openNext, openGrid, keepOpen,
    // A SERIES LINE TO EVERY SEAT THIS TOOL RUNS AND EVERY OTHER NODE OF THE CENSUS (as openGrid posts a grid's): the
    // seats that took it, and why the others did not
    postSeries: async (line) => postSeriesLine(line, [...[a, b, ...rest].map((n) => [String(n.port), `http://${host}:${n.port}`]), ...otherCensusSeats()]),
    // THE CHAIN, FOR THE DUTY KEEPER: the view to the tip, and the census's node keys at a height - derived as the seats do
    dutyChain: {
      view: async () => (censusView = await viewToTip()),
      // AND THE ENTRIES THEMSELVES (kanban #689: which versions the census's game nodes host - roles and hostedGames per entry)
      censusEntriesAt: (height) => censusEntriesAt(height),
      // the view's window for a census at that height, then the view to the tip
      viewFor: async (height) => { censusFloorTo(Number(height)); return (censusView = await viewToTip()); },
      // THE SEATS TO ASK whether they follow the chain a census was taken on: this tool's own and every other node of the last census
      seatUrls: () => [...[a, b, ...rest].map((n) => `http://${host}:${n.port}`), ...[...otherCensusSeats()].map(([, url]) => url)],
    },
    // THE ADVERTS THIS START BONDED, one per signer node, in member order.
    adverts: bonded.map((m) => m.advert),
    rounds: () => held.map((c) => ({ id: toHex(roundId(c)), committeeTimeMs: c.committeeTimeMs, entryCloseMs: c.entryCloseMs })),
    get a() { return a; }, get b() { return b; }, get c() { return nodeC; },
    // EVERY DAEMON, so a caller does not have to know how many there are.
    get daemons() { return [a, b, ...rest]; }, beacon: beaconSeen,
    // AND DAEMON A, the same way (M3.3-34 path 2: a forward to A lost while A is down).
    async restartA() { await a.close(); a = await launchNode({ db: dbA, path: pathA }, optsA, guardianChain); return a; },
    // DAEMON B RESTARTS: the same store, identity, options and port, served
    // again - what an operator's restart is, for measuring what a client does
    // across one. Nothing it held is lost, because the store is the same.
    async restartB() { await b.close(); b = await launchNode({ db: dbB, path: pathB }, optsB, guardianChain); return b; },
    // AND ANY FURTHER ONE, by its place after A and B - the same store, identity, options and port.
    async restartRest(i) {
      await rest[i].close();
      rest[i] = await launchNode({ db: members[2 + i].db, path: members[2 + i].path }, optsBeyond[i], guardianChain);
      return rest[i];
    },
    nodes: reach,
    headers: reach.map((r) => `${r}/headers`),
    bond: `${reach[0]}/bond`,
    advert: toHex(bonded[0].signature),
    donationRecipients: recipients,
    async close() { if (keeper) keeper.stop(); await a.close(); await b.close(); for (const d of rest) await d.close(); if (recipients) await recipients.close(); },
  };
}

/**
 * THE BUILT PAGE, FROM THIS MACHINE, OVER http.
 *
 * The daily is https and these daemons are http on loopback or a tailnet. An
 * https page fetching `http://127.0.0.1` is a mixed-content request and a
 * browser may refuse it - and that refusal looks exactly like a chain provider
 * that never answered, which is the worst kind of wall: it fails where the
 * evidence points somewhere else.
 *
 * So the same build is served here, over the same scheme as the daemons. The
 * page is byte for byte the deployed one; only where it is fetched from
 * changes. The daemons are still a different ORIGIN (a different port), which
 * is why their doors carry access-control-allow-origin.
 *
 * The content types matter: Unity's loader will not start a wasm module served
 * as text/plain, and Cloudflare gets them from `_headers`, which is not a
 * thing a plain server reads.
 */
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.data': 'application/octet-stream',
  '.bundle': 'application/octet-stream', '.symbols': 'application/octet-stream',
};
const typeOf = (file) => {
  if (file.endsWith('.wasm.unityweb')) return 'application/wasm';
  if (file.endsWith('.js.unityweb')) return 'application/javascript';
  if (file.endsWith('.data.unityweb')) return 'application/octet-stream';
  return MIME[extname(file)] || 'application/octet-stream';
};

export function servePage(build, { host = '127.0.0.1', port = 8000 } = {}) {
  return new Promise((ok, no) => {
    const s = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      // No climbing out of the build directory, even from a local page.
      const file = join(build, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(build) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); return res.end('no');
      }
      res.writeHead(200, { 'content-type': typeOf(file) });
      res.end(readFileSync(file));
    });
    s.on('error', no);
    s.listen(port, host, () => ok({ server: s, port: s.address().port }));
  });
}

// Run directly: stand it up on the addresses an operator can reach, and print
// the one line a person opens in two tabs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.ARENA_BIND || '127.0.0.1';
  const build = process.env.ARENA_BUILD
    || new URL('../../../.apps/arena-app-next-block/unity/build/webgl', import.meta.url).pathname;

  // THE PAGE IS SERVED FROM HERE unless somebody names another one, because
  // the daily is https and these daemons are not. Same build, same scheme as
  // the nodes, no mixed content to lose the evidence in.
  let page = process.env.ARENA_PAGE;
  let pageServer = null;
  if (!page) {
    if (existsSync(join(build, 'index.html'))) {
      pageServer = await servePage(build, { host, port: Number(process.env.ARENA_PAGE_PORT || 8000) });
      page = `http://${host}:${pageServer.port}`;
    } else {
      page = 'https://testnet.bitcoinarena.io';
      console.log('NOTE: no build at ' + build + ', so the daily is named instead.');
    }
  }

  // A BITCOIND IF ONE IS NAMED, AND NO PRETENDING IF NOT.
  //   RT=<datadir> RPCPORT=<port> node tools/round-2of2.mjs
  // Its own datadir and its own port: this is not the node anybody's money is
  // on, and it is not the 2-of-2's own store.
  const rt = process.env.RT;
  const rpcport = process.env.RPCPORT || '29643';
  const rpc = rt
    ? bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/`, cookiePath: `${rt}/regtest/.cookie` })
    : null;
  // The same daemon, over its own cli - the bonds are posted with it, and the
  // census is read back from the chain the beacon comes off.
  const cli = rt
    ? (...a) => execFileSync(process.env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
        ['-regtest', `-datadir=${rt}`, `-rpcport=${rpcport}`, ...a], { encoding: 'utf8' }).trim()
    : null;

  const round = await standUpRound({
    host,
    portA: Number(process.env.ARENA_PORT_A || 8080),
    portB: Number(process.env.ARENA_PORT_B || 8081),
    rpc,
    cli,
    page,
  });
  console.log('round     ' + round.id);
  console.log('daemons   ' + round.nodes.join('  '));
  console.log('headers   ' + round.headers.join('  '));
  console.log('bond      ' + round.bond);
  console.log('page      ' + (pageServer ? 'served here from ' + build : page));
  console.log('beacon    ' + (!rpc
    ? 'NONE - no RT= bitcoind named, so these nodes assign nobody rather than '
      + 'joining on an invented number'
    : round.beacon && round.beacon.ok
      ? `block ${round.beacon.height}, ${round.beacon.depth} deep, `
        + `hash ${toHex(round.beacon.hash)}`
      : `NONE - ${round.beacon ? round.beacon.why : 'the chain was not read'}`));
  console.log('');
  console.log('Open this in TWO tabs - each tab is its own player, because the');
  console.log('key is kept in sessionStorage:');
  console.log('');
  console.log(round.url);
  console.log('');
  // THE LOBBY (M3.3-34): the same link with no round - the page lists what the
  // daemons hold. With a bitcoind the tool keeps a free round joinable; on the
  // fixture chain it cannot (its clock is fixed) and says so.
  console.log('Or open the LOBBY, which lists the rounds these daemons hold:');
  console.log('');
  console.log(round.lobbyUrl);
  console.log('');
  if (rpc) {
    round.keepOpen({
      onOpen: (id) => console.log(`opened   ${id} - the lobby lists it`),
      onError: (e) => console.log(`NOT OPENED: ${e.message}`),
    });
  } else {
    console.log('NOTE: no bitcoind, so no further round is opened: the lobby empties when this one\'s entry closes.');
  }

  // MIXED CONTENT IS A REAL WALL AND IS NAMED HERE RATHER THAN DISCOVERED.
  // An https page fetching http://127.0.0.1 is a mixed-content request; a
  // browser may treat loopback as trustworthy and may not, and the failure
  // looks like a chain provider that never answered. Two ways out, both the
  // operator's: serve the built page over http from this machine, or put the
  // daemons behind https on the tailnet.
  if (round.url.startsWith('https://') && round.nodes[0].startsWith('http://')) {
    console.log('NOTE: this is an https page asking for http:// nodes, which a browser');
    console.log('may block as mixed content. Serve the build over http and point at it:');
    console.log('  ARENA_PAGE=http://' + host + ':8000 node ' + process.argv[1].split('/').slice(-3).join('/'));
    console.log('');
  }
  console.log('Ctrl-C stops the daemons.');
}

// HEAD-TO-HEAD ROUNDS BACK TO BACK, NO HOLE (2026-10-10: no series, "8 second rounds with no delays
// at all, seamless"): one round closing every `windowMs` on a grid kept `leadMs` ahead. Each round's committee time is
// `committeeAheadMs` before its close - more than 5 s ahead, so with ARENA_PUBLISH_AHEAD=1 it is published ahead and posted at
// once (measured on the demo seats: 1.9 s an opening, 135 of 135 closes 8.0 s apart); its beacon comes from the chain's own
// blocks and each seat assigns it ~65 s after committee time, before its window. Opening one round per tick fell behind the
// grid (12-23 s an opening); this opens until the grid is `leadMs` ahead.
// TABLES (2026-10-10: "When one player is waiting, one round is being opened. A 2nd player joins that
// round. A 3rd player gets a second round, the 4th player joins that round. 5th player gets the 3rd round and so on"): a
// round cannot be opened the moment a player comes (its committee needs a beacon 6 deep), so each slot of the grid holds
// `tables()` rounds side by side, opened ahead as one. Table k's committee time is k ms before table 0's - the one field
// that tells two tables of one slot apart (the same close, so every table of a slot plays the same 8 s).
export function tablesNeeded(rows, nowMs, { windowMs = 8000, spare = 1, gameId = null } = {}) {
  // the tables in play: the rounds of the slot taking picks now (and the next) that someone entered
  const now = Number(nowMs);
  const live = (rows || []).filter((r) => (!gameId || (r.game && r.game.id === gameId)) && Number(r.entryCloseMs) > now
    && Number(r.entryCloseMs) <= now + 2 * Number(windowMs));
  const bySlot = new Map();
  for (const r of live) { const k = String(r.entryCloseMs); bySlot.set(k, (bySlot.get(k) || 0) + (Number(r.joined) > 0 ? 1 : 0)); }
  const inPlay = Math.max(0, ...bySlot.values());
  return inPlay + Math.max(0, spare);
}
// AND REMEMBERED (measured with 5 bots on the demo seats: a slot's table count read from the slots taking picks at
// the moment it was opened - 150 s before it plays - stayed 1 for 20 slots after five players came and then swung 1-2-3, and
// pairs were split for lack of tables): at least `min` tables a slot, and the busiest in-play count of the last `holdMs` plus
// the spare - a burst of up to `min` players' pairs is seated at once, and a table count does not drop while a match goes on.
export function tableCounter({ min = 3, spare = 1, holdMs = 120000, windowMs = 8000, gameId = null } = {}) {
  const seen = [];
  return (rows, nowMs) => {
    const now = Number(nowMs);
    seen.push([now, tablesNeeded(rows, now, { windowMs, spare: 0, gameId }) - 0]);
    while (seen.length && seen[0][0] < now - holdMs) seen.shift();
    const peak = Math.max(0, ...seen.map(([, n]) => n));
    return Math.max(min, peak + Math.max(1, spare));
  };
}
export function keepBackToBack(round, { fields, windowMs = 8000n, leadMs = 150000n, committeeAheadMs = 140000n, everyMs = 2000,
  kind = {}, tables = () => 1, onOpen = () => {}, onError = () => {} }) {
  if (!PUBLISH_AHEAD) throw new Error('rounds back to back are published ahead: set ARENA_PUBLISH_AHEAD=1');
  let lastClose = 0n, opening = false;
  const keep = async () => {
    if (opening) return;
    opening = true;
    try {
      for (let n = 0; n < 40; n++) {
        const now = BigInt(Date.now());
        if (lastClose > now + leadMs + windowMs) break;
        // the next on the grid; after a stop (or at the start) the grid begins again leadMs ahead
        const want = lastClose + windowMs > now + leadMs ? lastClose + windowMs : now + leadMs;
        const n = Math.max(1, Math.floor(Number(await tables())) || 1);
        let close = want;
        for (let k = 0; k < n; k++) {
          const committeeAtMs = want - committeeAheadMs - BigInt(k);
          // openNext starts a round MIN_ENTRY_WINDOW_MS after its committee time: the entry window after that start closes on `want`
          const id = await round.openNext({ ...kind, fields, committeeAtMs, entryAfterStartMs: Number(want - (committeeAtMs + MIN_ENTRY_WINDOW_MS)) });
          const held = round.rounds().find((r) => r.id === id);
          close = held ? BigInt(held.entryCloseMs) : want;
          onOpen({ id, entryCloseMs: close, table: k, tables: n, tookMs: Date.now() - Number(now) });
        }
        lastClose = close;
      }
    } catch (e) { onError(e); } finally { opening = false; }
  };
  keep();
  const timer = setInterval(keep, everyMs);
  return { stop: () => clearInterval(timer) };
}

