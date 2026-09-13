#!/usr/bin/env node
/**
 * ONE ROUND THE TWO DAEMONS AGREE ON, AND THE URL THAT OPENS IT.
 *
 *   node packages/blwp-node/tools/round-2of2.mjs
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
import { CORE_HASH } from './core-hash.mjs';
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { openStore, nodeIdentity } from '../src/store.js';
import { chainBeacon } from '../src/beacon-source.js';
import { beaconFromChain, medianTimePast } from '../../protocol/src/beacon.js';
import { regtest } from './regtest-bond.mjs';
import { chainOf, publicationOf } from '../../protocol/tools/chainview.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { operatorFunding } from '../src/funding.js';
import { serve } from '../src/server.js';
import { lightningFromEnv } from '../src/lnd-settings.js';
import { toHex } from '../../protocol/src/hash.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf, blockTimeOf } from '../../protocol/src/chain.js';
import { publicationPayload } from '../../protocol/src/publication.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import { advertId } from '../../protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { bondSetFor, tweakPoint, combine } from '../src/curve.js';
import { bondOutputKey, bondInternalKey } from '../../protocol/src/bond-script.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
/**
 * Two daemons, one agreed round, and the providers a page needs to check it.
 *
 * Exported so the test can drive exactly what an operator runs, rather than a
 * second arrangement that looks like it.
 */
export async function standUpRound({ host = '127.0.0.1', portA = 8080, portB = 8081, bDownAtStart = false,
                                     store = ':memory:', rpc = null, cli = null,
                                     page = 'https://btc-logistics-core.pages.dev',
                                     // A PAYING ROUND, for a rehearsal with Lightning. Every
                                     // existing caller asks for none and gets a free round.
                                     stakeMsat = 0n,
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
                                     // join link, and what each seat needs to verify a lock
                                     // (`claimKeyFor`, `stakeLocks`). None by default: every
                                     // existing caller's round names no federation, as before.
                                     federationId = new Uint8Array(32), invite = null, seat = {} } = {}) {
  // WHAT THESE DAEMONS FUND (M3.3-31): a PAYING round goes through the
  // launcher's own rule - the round its operator names, and entries into a
  // paying round the node holds when it reaches Lightning - not a harness's
  // `() => true`. A free round keeps `() => true`: the launcher opens none.
  const funded = stakeMsat > 0n ? operatorFunding() : () => true;

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
  // beacon for that round, so it cannot say who the census seats". A round
  // still opens and a player still plays; nobody is seated on an invented
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
  const dbA = openStore(store === ':memory:' ? ':memory:' : store + '/a.db');
  const dbB = openStore(store === ':memory:' ? ':memory:' : store + '/b.db');
  const idA = nodeIdentity(dbA);

  // THE ADVERTISEMENT IS SIGNED BY THE NODE IT NAMES. A stranger's signature
  // is refused at the door - the committee is the round's, and the key that
  // wrote the advertisement has to be the key the committee names.
  // THE ENDPOINT IS DECIDED BEFORE THE PORT IS BOUND, because the bond commits
  // to the advertisement and the advertisement carries the address. So a fixed
  // port is asked for and the daemon must get it; port 0 would name an address
  // nobody can put in a bond that is already mined.
  if (!portA || !portB)
    throw new Error('this needs fixed ports: a bond commits to the address it advertises');
  const idB = nodeIdentity(dbB);

  // ONE BOND EACH, AND THAT IS NOT A DETAIL. `seatRound` compares the seats
  // the census gives with the keys the contract names and refuses when they
  // differ - letter 26's ruling that the seated set is the only list that
  // counts. A 2-of-2 whose chain bonded one of its two nodes would be refused
  // by its own daemons, which is exactly what should happen and is why both
  // are bonded here.
  const bonded = [
    { id: idA, port: portA, db: dbA },
    { id: idB, port: portB, db: dbB },
  ].map(({ id, port }) => {
    const advert = {
      nodePubkey: id.pubkey, operatorId: '2of2', protocolVersions: [1],
      // ALL THREE ROLES, because this network's genesis asks for two nodes in
      // each and there are only two nodes. A 2-of-2 where one seat is a game
      // node and the other a settlement node is not a 2-of-2, it is two
      // committees of one. Measured: with 'game' and 'verify' alone the census
      // carried 0 settlement nodes where regtest was born needing 2.
      roles: ['game', 'verify', 'settlement'],
      endpoint: process.env[`BLWP_WSS_${port}`] || `ws://${host}:${port}`,
      region: 'eu-west', capacityClass: 2, softwareHash: b32(3),
      settlementCapabilities: 0, lightningCapabilities: 0,
      bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
      payoutPubkey: b32(4), guardianOf: [], timestamp: BigInt(Date.now()),
    };
    // BIP-340, because letter 26 made a node's identity ITS BOND KEY: every
    // signature a node makes is schnorr under the key its bond was posted
    // with, and an ed25519 signature here is refused at the door by name.
    const signature = schnorr.sign(advertId(advert), id.secret);
    // THE OUTPUT KEY IS THE ONE 5A.3B BUILDS, not the fixture filler. Letter 24
    // made the census rebuild a bond's key from the node key, the network's
    // arbitration set and its maturity, and refuse one that does not rebuild -
    // so a bond paying 0x77 repeated is a bond the census counts as nothing.
    // Measured: with the filler the census carried 0 game nodes where regtest
    // was born needing 2.
    const g = genesisFor('regtest');
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
  const built = [];
  let previous = blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER);
  for (const one of bonded) {
    const { header } = blockOf(hash256, [one.txid], { previous });
    built.push({ header, transactions: [one.transaction] });
    previous = blockHashOf(header);
  }
  const chain = [BITCOIN_MAINNET_GENESIS_HEADER, ...built.map((b) => b.header)];
  const headerBytes = new Uint8Array(chain.length * 80);
  chain.forEach((h, i) => headerBytes.set(h, i * 80));

  // THE VIEW THE CENSUS IS DERIVED FROM.
  //
  // ONE CHAIN FOR THE CENSUS AND THE BEACON when there is a bitcoind: the bonds
  // are posted to it, the blocks are read back from it, and the beacon comes
  // off the same chain - which is what lets the roster ask "is this beacon the
  // block my chain names" and get an answer. With a fixture census beside a
  // bitcoind beacon that question could never pass, because the fixture has no
  // such block.
  //
  // WITHOUT a bitcoind, the two-block fixture stays. It seats nobody - there
  // is no beacon either - so nothing is being pretended: `POST /round` refuses
  // by name and the tool says so.
  let censusView;
  let censusHeight = 2;
  let censusConfirmations = 1;
  let onChain = null;
  let bondHeight = 0;
  let localChain = null;
  let localBlocks = null;
  if (cli) {
    const rt = regtest(cli);
    onChain = rt;
    const posted = bonded.map((one, i) =>
      rt.postBond(i === 0 ? idA.secret : idB.secret, { endpoint: `ws://${host}:${i === 0 ? portA : portB}` }));
    rt.include(posted.map((p) => p.hex));
    // THE CENSUS HEIGHT IS ABOVE THE BONDS, NOT AT THEM. Depth is measured at
    // `census_height` - "spentness, height and depth off REAL BLOCKS with depth
    // at census_height" (15) - so a bond in the census height's own block is
    // one confirmation deep and a round asking for six excludes it. Measured:
    // "that census carries 0 game nodes where regtest was born needing 2".
    bondHeight = rt.height();
    rt.mine(6);
    censusHeight = rt.height();
    if (censusHeight - bondHeight + 1 < 7)
      throw new Error('the bonds are not deep enough at the census height');
    for (const [i, p] of posted.entries()) bonded[i].onChainTxid = p.txid;
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
  // AND THE DAEMONS SEE THE CHAIN, which is what makes `POST /round` seat
  // anybody at all: `server.js` seats only when it has a view, and this tool
  // gave none, so the beacon was read and nobody was ever seated on it.
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
  const randomnessFor = beacon ? beacon.for : undefined;

  // AN OLDER ROUND GETS A VIEW THAT REACHES BACK TO IT (M3.3-34). The seats'
  // view begins 20 below the bonds this start posted, and every start posts
  // them again: measured, a view from 2232 against a round whose beacon is 2139,
  // so both restarted seats held that round for ever on "this view begins at
  // height 2232 ... after this round's committee time". Moving the seats' own
  // view back was measured too and is wrong: its census then counted earlier
  // starts' bonds and the next round was refused ("the census seats 1"). So a
  // round whose census height is below the seats' view gets its own - from 20
  // below that height to the tip, read once: its bonds and beacon are deep.
  const older = new Map();
  const chainFor = ({ contract } = {}) => {
    if (!onChain || !censusView || !contract) return censusView;
    const from = Math.max(0, contract.censusHeight - 20);
    if (from >= censusView.firstHeight) return censusView;
    if (!older.has(from)) {
      older.set(from, onChain.blocksFrom(from, onChain.height()));
      console.log(`[view] a round with census ${contract.censusHeight} reads its own view from ${from}; the seats' begins at ${censusView.firstHeight}`);
    }
    return older.get(from);
  };
  // THE COMMITTEE'S ONE LIGHTNING ENDPOINT, OPT-IN (§23.1): the four BLWP_LND*
  // settings, the same parse src/main.js uses, and the same port for both
  // daemons - the second takes up the hold the first issued. Unset, both hold
  // no stakes, exactly as before.
  const ln = lightningFromEnv(process.env);
  if (!ln.ok) throw new Error(ln.why);
  const lightning = ln.given
    ? { lightning: ln.lightning, ...(ln.preflight ? { preflight: ln.preflight } : {}) } : {};
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
  const optsA = { port: portA, host, funded, headerBytes, bondProof, chainFor,
    ...(randomnessFor ? { randomnessFor } : {}), ...lightning, ...chainTip, ...spendOn,
    ...(federation ? { federation } : {}), ...seat };
  let a = await serve(dbA, optsA);
  const optsB = { port: portB, host, funded, headerBytes, bondProof, chainFor,
    ...(randomnessFor ? { randomnessFor } : {}), ...lightning, ...chainTip, ...spendOn,
    ...(federation ? { federation } : {}), ...seat };
  // B DOWN AT START (`bDownAtStart`, an operator's look at seat A restarted
  // while it holds a close that needs B): B is served on a port nobody names -
  // the bond, the relays and every peer say `portB` - only so the first round
  // can be posted to it; the caller closes it, and restartB serves it on portB.
  let b = await serve(dbB, bDownAtStart ? { ...optsB, port: 0 } : optsB);
  if (a.port !== portA)
    throw new Error(`node A came up on ${a.port} and the bond names ${portA}`);

  // THE ROUND. Its times are real instants, because a node refuses an entry
  // before committee_time and refuses a round whose entry window is shorter
  // than the protocol's own minimum.
  //
  // `blockTicks` is how long the round IS, and this one is sized for a PERSON
  // rather than for a harness: 9000 ticks is two and a half minutes at the
  // core's own tick, and both tabs have to load a nineteen-megabyte player
  // before either of them can drive. The browser harness uses a thirty-second
  // round because nothing there waits on a human.
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
    censusView = onChain.blocksFrom(Math.max(0, bondHeight - 20), onChain.height());
  }
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: CORE_HASH,
    committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + 1_800_000n,
    objectionWindowMs, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'BURN', federationId, stakeExpiryBlocks: 144,
    // WHERE THE SEATS POST EACH RUN'S TRANSCRIPT (v4.6.2 §13A, P2): the two
    // daemons' own relay doors. A result is final only once both have posted
    // it, and a round naming no relay could never settle a stake.
    publicationRelays: [`http://${host}:${portA}`, `http://${host}:${portB}`],
    donationSetId: b32(0xd0), censusHeight,
    censusRoot: new Uint8Array(32), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey],
  };
  // THE CENSUS ROOT IS THE CHAIN'S, NOT A NUMBER THIS TOOL LIKES.
  //
  // It was 32 bytes of 2, which is why seating could never have run here even
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
  const censusRootFor = (c) => {
  const byTxid = new Map();
  for (const block of censusView.blocks)
    for (const raw of block.transactions || []) {
      try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ }
    }

  const asSeen = decodeRoundContract(encodeRoundContract(c));
  const census = deriveCensus(censusView, {
    contract: asSeen,
    bond: bondSetFor('regtest'),
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
  return census.root;
  };
  contract.censusRoot = censusRootFor(contract);

  // AND THE ROUND IS PUBLISHED BELOW ITS BEACON BLOCK (5A.5, v4.6.2): a node
  // seats only a round its own chain shows published strictly before the
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
  async function publishOnChain(c) {
    const raw = cli('createrawtransaction', '[]',
      JSON.stringify([{ data: toHex(publicationPayload(roundId(c))) }]));
    const paid = JSON.parse(cli('fundrawtransaction', raw)).hex;
    onChain.include([JSON.parse(cli('signrawtransactionwithwallet', paid)).hex]);
    let tries = 0;
    for (;;) {
      censusView = onChain.blocksFrom(Math.max(0, bondHeight - 20), onChain.height());
      const named = beaconFromChain(c,
        { headers: censusView.blocks.map((b) => b.header), firstHeight: censusView.firstHeight });
      if (named.ok) return named;
      if (++tries > 8) throw new Error('this chain names no beacon after 8 batches: ' + named.why);
      const wait = Number(c.committeeTimeMs) + 1500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      onChain.mine(6);
    }
  }
  if (onChain) await publishOnChain(contract);

  // AND THE BEACON IS READ BEFORE THE ROUND IS POSTED, because posting is when
  // a node seats: `POST /round` calls `seatRound`, seating needs the committee
  // seed, and the seed is this beacon. Read after, the daemons refuse the
  // round with "this node has no beacon for that round" - measured, that is
  // exactly what happened the first time this was wired.
  //
  // It is also the real order. 5A.5 has the committee form AT committee_time;
  // a node that has not seen the beacon has nothing to form it from.
  let beaconSeen = null;
  if (beacon) {
    // A CHAIN THAT CANNOT BE READ IS NOT A ROUND THAT CANNOT EXIST for the
    // caller of this tool: the refusal is carried out rather than thrown, so
    // an operator reads one line instead of a stack. The daemons will still
    // refuse to seat, by name, which is the honest end of it.
    try { beaconSeen = await beacon.refresh(contract); }
    catch (e) { beaconSeen = { ok: false, why: e.message }; }
  }

  // WHAT IS OPENED IS CLOSED, even when the round is refused. A daemon left
  // listening after a throw is a port nobody frees and a test run that never
  // exits - measured, the first version of this hung the suite.
  // THE OPERATOR NAMES ITS ROUND, now that the contract that names both
  // daemons gives it an id - what BLWP_FUNDED_ROUNDS does for main.js.
  if (funded.nameRound) funded.nameRound(roundId(contract));
  if (beforeRound) await beforeRound();
  // BOTH DAEMONS, ONE ROUND: posted to each, and both must name it the same.
  async function postRound(c) {
    const body = encodeRoundContract(c);
    const opened = [];
    for (const node of [a, b]) {
      const r = await fetch(`http://${host}:${node.port}/round`, { method: 'POST', body });
      if (!r.ok) throw new Error(`${node.port} refused the round: ${await r.text()}`);
      opened.push(toHex(new Uint8Array(await r.arrayBuffer())));
    }
    const rid = toHex(roundId(c));
    if (opened.some((o) => o !== rid))
      throw new Error('the two daemons named the round differently: ' + opened.join(' '));
    return rid;
  }
  let id;
  try { id = await postRound(contract); } catch (e) {
    await a.close(); await b.close();
    throw e;
  }

  // WHERE A BROWSER CAN ACTUALLY REACH THESE DAEMONS.
  //
  // An https page cannot fetch `http://100.x.y.z:8090` - the browser blocks it
  // as mixed content, and what the player sees is a round that never loads and
  // a play socket that never comes up. Photographed 07:40 and again at 09:44
  // as "play - A dropped".
  //
  // `BLWP_WSS_<port>` already names where that daemon is reachable from
  // outside, because the socket endpoint had the same problem first. The same
  // origin serves its http doors, so the URL is built from it rather than from
  // the address this process happens to be bound to. Two daemons behind one
  // reverse proxy differ by their first path segment, which is exactly what
  // the client's own two-source rule was taught to count.
  const publicFor = (port, fallback) => {
    const wss = process.env[`BLWP_WSS_${port}`];
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
  ];

  // `headers=` is not named: the client already forms `<node>/headers` from
  // the nodes, and a URL that repeats what the default already says is a
  // second place to get it wrong.
  const url = `${page}/?round=${id}`
    + `&node=${reach[0]},${reach[1]}`
    + `&bond=${reach[0]}/bond`
    + `&advert=${toHex(bonded[0].signature)}`
    + (invite ? `&federation=${invite}` : '');
  // THE LOBBY'S LINK (M3.3-34): the same names, and no round. The page asks the
  // named nodes what they hold and checks every round it is told of.
  const lobbyUrl = `${page}/?node=${reach[0]},${reach[1]}`
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
  const held = [contract];
  async function openNext() {
    if (!onChain) throw new Error('a later round needs a bitcoind: the fixture chain\'s clock is fixed, '
      + 'so a round opened on it now would already be past its entry close');
    // JUST PAST THE LATER OF THE TIP'S TIME AND NOW. The tip's own time is what
    // keeps the publication block from being the beacon (its median cannot pass
    // it) - and it is the LAST block's time, not the clock's. Measured: with no
    // block mined since the first round, the tip was two minutes old, the next
    // round opened with 59 s of its 180 s entry left, and the keeper opened a
    // second one 6 s later. Now is later than that tip, so the rule still holds.
    const tip = onChain.blocksFrom(onChain.height(), onChain.height()).blocks[0].header;
    const committee = (BigInt(Math.max(blockTimeOf(tip), Math.floor(Date.now() / 1000))) + 2n) * 1000n;
    const next = { ...contract, committeeTimeMs: committee, startTimeMs: committee + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: committee + MIN_ENTRY_WINDOW_MS + (contract.entryCloseMs - contract.startTimeMs) };
    censusView = onChain.blocksFrom(Math.max(0, bondHeight - 20), onChain.height());
    next.censusRoot = censusRootFor(next);
    await publishOnChain(next);
    const seen = beacon ? await beacon.refresh(next) : { ok: false, why: 'no beacon' };
    if (!seen.ok) throw new Error('the next round names no beacon: ' + seen.why);
    if (funded.nameRound) funded.nameRound(roundId(next));
    const nextId = await postRound(next);
    held.push(next);
    return nextId;
  }

  // AND KEEP ONE JOINABLE: whenever no round this tool opened has more than
  // `leadMs` of entry left, open the next. One at a time; a failure is handed
  // to `onError` and the next check tries again.
  let keeper = null;
  function keepOpen({ everyMs = 5000, leadMs = 60000, onOpen = () => {}, onError = () => {} } = {}) {
    if (keeper) return keeper;
    let opening = null;
    const check = () => {
      if (opening) return;
      const now = BigInt(Date.now());
      if (held.some((c) => c.entryCloseMs > now + BigInt(leadMs))) return;
      opening = openNext().then(onOpen, onError).finally(() => { opening = null; });
    };
    const timer = setInterval(check, everyMs);
    check();
    keeper = { stop() { clearInterval(timer); keeper = null; }, get opening() { return opening; } };
    return keeper;
  }

  return {
    id, url, lobbyUrl, contract, openNext, keepOpen,
    rounds: () => held.map((c) => ({ id: toHex(roundId(c)), committeeTimeMs: c.committeeTimeMs, entryCloseMs: c.entryCloseMs })),
    get a() { return a; }, get b() { return b; }, beacon: beaconSeen,
    // AND DAEMON A, the same way (M3.3-34 path 2: a forward to A lost while A is down).
    async restartA() { await a.close(); a = await serve(dbA, optsA); return a; },
    // DAEMON B RESTARTS: the same store, identity, options and port, served
    // again - what an operator's restart is, for measuring what a client does
    // across one. Nothing it held is lost, because the store is the same.
    async restartB() { await b.close(); b = await serve(dbB, optsB); return b; },
    nodes: reach,
    headers: [`${reach[0]}/headers`, `${reach[1]}/headers`],
    bond: `${reach[0]}/bond`,
    advert: toHex(bonded[0].signature),
    async close() { if (keeper) keeper.stop(); await a.close(); await b.close(); },
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
  const host = process.env.BLWP_BIND || '127.0.0.1';
  const build = process.env.BLWP_BUILD
    || new URL('../../../unity-proto/build/webgl', import.meta.url).pathname;

  // THE PAGE IS SERVED FROM HERE unless somebody names another one, because
  // the daily is https and these daemons are not. Same build, same scheme as
  // the nodes, no mixed content to lose the evidence in.
  let page = process.env.BLWP_PAGE;
  let pageServer = null;
  if (!page) {
    if (existsSync(join(build, 'index.html'))) {
      pageServer = await servePage(build, { host, port: Number(process.env.BLWP_PAGE_PORT || 8000) });
      page = `http://${host}:${pageServer.port}`;
    } else {
      page = 'https://btc-logistics-core.pages.dev';
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
    portA: Number(process.env.BLWP_PORT_A || 8080),
    portB: Number(process.env.BLWP_PORT_B || 8081),
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
    ? 'NONE - no RT= bitcoind named, so these nodes seat nobody rather than '
      + 'seating on an invented number'
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
    console.log('  BLWP_PAGE=http://' + host + ':8000 node ' + process.argv[1].split('/').slice(-3).join('/'));
    console.log('');
  }
  console.log('Ctrl-C stops the daemons.');
}
