// One process, one round.
//
//     node src/main.js [port] [database]
//
// The database defaults to a file so a round survives the process; pass
// `:memory:` for a node that forgets, which is what the tests use.
//
// CHAIN ACCESS COMES FROM TWO SETTINGS AND NO OTHERS:
//
//     BLWP_BITCOIND_URL      the bitcoind RPC, e.g. http://127.0.0.1:8332/
//     BLWP_BITCOIND_COOKIE   the path of its .cookie file
//     BLWP_FUNDED_ROUNDS     round ids this operator funds (paying rounds only)
//     BLWP_FUNDED_ROUNDS_FILE  the same, one id per line, read on every ask
//     BLWP_STAKE_LOCK_BIN    blwp-stake-lock (tools/stake-lock), for stake-lock rounds
//     BLWP_FEDERATION_CLIENT_DIR  the data dir of a client joined to the round's federation
//
// AND WHAT A LAUNCHER USED TO HAND ITS IN-PROCESS NODES, for nodes that run as their own processes (attach, the owner
// 2026-09-29: the seven blwp-tn4-node units own the guardians; tools/run-testnet4-paid.mjs BLWP_ATTACH=1):
//     BLWP_CLOSE_AT_END=1         this node closes every round that is over, itself
//     BLWP_DONATION_NETWORK       regtest | testnet4: the network's signed test donation set, which the rounds name
//     BLWP_ATTACH_PROOF_DIR       the launcher's headers.bin and bond.json, served on GET /headers and GET /bond,
//                                 read at every ask (the launcher writes them once the nodes are up)
//     BLWP_SERIES_FILE            the series this node holds: one Round Contract template per line, hex (serve's
//                                 `series`). Measured 2026-09-29: without it a node process could hold no series at all,
//                                 so every series round was refused - the doors were proved only on in-process nodes.
//
// Both or neither. With them the daemon can read each round's beacon and derive each round's census - which is where it
// learns the other signer nodes' addresses, from the advertisements in their bonds. (It no longer finds a pool output or
// sends a pool payout: that was the withdrawn custody's, §23.6, RULED 2026-09-25.)
//
// HOW FAR BACK A CENSUS IS READ: CENSUS_LOOKBACK blocks before a round's
// census height. A bond funded earlier than that is not seen by a restarted
// daemon, and a round whose committee holds one is refused by name.
const CENSUS_LOOKBACK = 2016;
import { TESTNET4_DONATION_SET } from '../../protocol/src/testnet4-donation-set.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../protocol/src/testnet4-donation-set-keys.js';
import { openStore } from './store.js';
import { tipHeaderView } from './tip-view.js';
import { isOldTestnet4Id, isOldTestnet4Series, OLD_TESTNET4_SERIES_BOND_HEIGHT } from '../../protocol/src/old-series.js';
import { bitcoindRpc, blocksOver, blockCache } from './chain-rpc.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { chainBeacon } from './beacon-source.js';
import { lightningFromEnv } from './node-start.js';
import { stakeLocksFromEnv } from './stake-lock-port.js';
import { fundingFromEnv } from './funding.js';
import { startNode } from './node-start.js';
import { NEXTBLOCK } from '../../core/plugin/nextblock.js';
import { hostsFromEnv, hostsReader } from './hosts.js';
import { statSync, readFileSync } from 'node:fs';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS } from '../../protocol/src/test-donation-sets.js';

const port = Number(process.argv[2] || 8080);
const path = process.argv[3] || 'round.db';
const host = process.env.BLWP_BIND || '127.0.0.1';
const url = process.env.BLWP_BITCOIND_URL || '';
const cookiePath = process.env.BLWP_BITCOIND_COOKIE || '';
if (Boolean(url) !== Boolean(cookiePath)) {
  console.error('BLWP_BITCOIND_URL and BLWP_BITCOIND_COOKIE go together: set both, or neither');
  process.exit(2);
}

// LIGHTNING COMES FROM FOUR SETTINGS, ALL OR NONE - BLWP_LNCLI, BLWP_LND_DIR, BLWP_LND_RPC,
// BLWP_LND_NETWORK - parsed in `node-start.js` (lightningFromEnv). It is used to READ an invoice (what the federation's
// LNv2 invoice commits to) and nothing else. It no longer holds stakes, and there is no start-up ask
// about a stake died inside a settle: the hold invoice was the withdrawn Lightning custody's, and the custody field has one
// value, FEDERATION (§23.6, RULED 2026-09-22 22:59).
const ln = lightningFromEnv(process.env);
// AND THE ROUND'S FEDERATION, when this node takes stake-lock rounds (23.1
// step 5): BLWP_STAKE_LOCK_BIN and BLWP_FEDERATION_CLIENT_DIR, both or neither.
const fed = stakeLocksFromEnv(process.env);
if (!fed.ok) { console.error(fed.why); process.exit(2); }
if (!ln.ok) {
  console.error(ln.why);
  process.exit(2);
}

const db = openStore(path);
// WHAT THIS DAEMON FUNDS (M3.3-31): the paying rounds its operator names, and
// entries into them - off by default, so an unnamed round is still 402.
// THE GAMES THIS NODE HOSTS (kanban #202, §0A.4): the reference launcher hands nextblock - its manifest as its developer
// signed it with the dev client (blwp-donor/bin/sign-game-manifest.mjs, the owner 2026-10-07 15:40), public bytes only. The
// node verifies that signature and refuses a manifest that does not stand (plugins.js); it holds no developer key and
// never signs a game. The engine imports no game; this launcher is where one is chosen.
const options = { port, host, funded: fundingFromEnv(process.env), plugins: [NEXTBLOCK], ...(fed.given ? { stakeLocks: fed.stakeLocks } : {}) };
if (ln.given) options.lightning = ln.lightning;
if (process.env.BLWP_CLOSE_AT_END === '1') options.closeAtEnd = true;
{
  const net = process.env.BLWP_DONATION_NETWORK;
  if (net && net !== 'regtest' && net !== 'testnet4') { console.error(`BLWP_DONATION_NETWORK is regtest or testnet4, not ${net}`); process.exit(2); }
  // testnet4 also holds the set series 3cfbe516 names, under the old id (PICK B, protocol/src/old-series.js)
  // AND TESTNET4'S SET WITH REAL RECIPIENTS (LNURL-0822, serial 2): for the contracts that name it; a contract names its set
  // by id (22A), so the rounds already written keep theirs
  // AND, FROM ITS valid_from (154965), TESTNET4'S SET OF KEYS (serial 3; the owner 2026-10-03, FEDERATION.md "Donations in the
// federation"): every round whose census reaches it names it; the rounds already written keep the set they named
if (net) options.donationSets = net === 'regtest' ? [TEST_DONATION_SET_REGTEST] : [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS];
}
// ONE SERIES A LINE: its template, hex; then `count=N` for a tail (the 82/90 fork: fewer than a day's 960 rounds - its id
// is taken over that count) and `cut=N` for a series replaced from round N by its tail.
const readSeriesFile = (path) => readFileSync(path, 'utf8').split(/\n/).map((l) => l.trim().split(/\s+/))
  .filter((w) => w[0] && /^[0-9a-f]+$/i.test(w[0]))
  .map(([h, ...more]) => {
    const t = decodeRoundContract(new Uint8Array(Buffer.from(h, 'hex')));
    for (const m of more) {
      const kv = /^(count|cut)=(\d+)$/.exec(m);
      if (!kv) throw new Error(`a series line names ${m}, not count=N or cut=N`);
      if (kv[1] === 'count') t.seriesCount = Number(kv[2]); else t.seriesCutFrom = Number(kv[2]);
    }
    return t;
  });
// THE OPERATOR'S REFUSE-ROUNDS FILE (kanban #191): round ids this node refuses at every door, read again when it changes
if (process.env.BLWP_REFUSE_ROUNDS_FILE) options.refuseRoundsFile = process.env.BLWP_REFUSE_ROUNDS_FILE;
if (process.env.BLWP_SERIES_FILE) {
  const path = process.env.BLWP_SERIES_FILE;
  try { options.series = readSeriesFile(path); } catch (e) { console.error(`BLWP_SERIES_FILE: a line is not a series: ${e.message}`); process.exit(2); }
  // A SERIES ADDED TO THE FILE IS TAKEN WITHOUT A RESTART (the owner 2026-10-02: "find out the reason for the restarts and
  // find a way to recover from them"): the 82/90 waiter restarted the seven seats one at a time, 10 min apart, after each
  // day's series - one restarted between a player's join and the round's start lost his session and his run went FORFEIT
  // (round 798ebc79, seat 1, 11:45:56Z), one restarted inside the objection window never signed FINAL (seat 2). The file is
  // read again when it changes; the series writer pass takes what is new.
  let seen = (() => { try { return statSync(path).mtimeMs; } catch { return null; } })();
  options.seriesReload = () => {
    let m; try { m = statSync(path).mtimeMs; } catch { return null; }
    if (m === seen) return null;
    const read = readSeriesFile(path);
    seen = m;
    return read;
  };
}
// WHERE THE OTHER SIGNER NODES ANSWER, as the operator knows it (serve's `peers`; ORDER-2116, measured on the free pair):
// with none named, a node finds its peers off the round's census - the bond adverts at its census height - and a seat
// whose address moved since answers there no more. The free pair's nodes run as their own units (the owner 2026-10-01) and
// lost the peers the 2-of-2 launcher handed them: 44 runs sat at 1 of 2 FINAL signatures. Comma-separated base URLs.
// WHAT THIS NODE HOSTS (the owner 2026-10-03 22:50): node 1 gateway A + LND 1, node 2 gateway B + LND 2 - read for its /dashboard
{ const hc = hostsFromEnv(); if (hc) { options.hosts = hostsReader(hc).start(); console.log(`hosts: ${hc.lnd ? 'LND ' + hc.lnd.rest : 'no LND'}, ${hc.gateway ? 'gateway ' + hc.gateway.name + ' ' + hc.gateway.base : 'no gateway'}`); } }
if (process.env.BLWP_PEERS) options.peers = process.env.BLWP_PEERS.split(',').map((s) => s.trim()).filter(Boolean);
if (process.env.BLWP_ATTACH_PROOF_DIR) {
  const dir = process.env.BLWP_ATTACH_PROOF_DIR;
  options.headerBytes = () => { try { return new Uint8Array(readFileSync(`${dir}/headers.bin`)); } catch { return null; } };
  options.bondProof = () => { try { return JSON.parse(readFileSync(`${dir}/bond.json`, 'utf8')); } catch { return null; } };
}
if (url) {
  const call = bitcoindRpc({ url, cookiePath });
  // A 400-header window, as the 2-of-2 tool reads one: the rule refuses a
  // window that does not reach back before a round's committee_time.
  const beacon = chainBeacon({ call, window: 400 });
  // THE BEACON OF EVERY ROUND THIS STORE STILL OWES A PAYOUT ON, read before
  // the daemon starts: the start-up sweep asks it whose turn it is, and the
  // other readers of a beacon ask synchronously.
  // AND ITS CENSUS BLOCKS, for the same reason: the roster reads a view
  // synchronously, and the signer nodes' addresses are in it.
  const views = new Map();                     // view key -> the view
  const blocksKept = blockCache();             // block hash -> its one parsed copy, shared by every view
  const reading = new Map();                   // view key -> its one read in flight
  const keyOfRound = new Map();                // round id hex -> the view key it was asked under
  const viewFailed = new Map();                // view key -> { atMs, why } of its last failed read
  // UP TO THE BEACON, AND AS DEEP PAST IT AS THE ROUND ASKS. The beacon comes
  // after the census height in the normal order, and the roster checks the
  // seed block against this same view - at the round's own confirmation depth.
  // Measured: stopping at the census height, "no block in this view is after
  // this round's committee time"; stopping at the beacon, "the block that
  // seeds this round is 1 deep and this round asks for 6". Never past the tip.
  const VIEW_REREAD_MS = 10000;
  const toHexMain = (b) => Buffer.from(b).toString('hex');
  const viewOf = async (contract) => {
    const seen = await beacon.refresh(contract);
    const tip = Number(await call('getblockcount'));
    const deep = seen.ok ? seen.height + contract.censusConfirmations - 1 : 0;
    const to = Math.min(tip, Math.max(contract.censusHeight, deep));
    const view = await blocksOver(call, Math.max(0, contract.censusHeight - CENSUS_LOOKBACK), to, { cache: blocksKept });
    // SHORT OF THE BEACON'S DEPTH, a view is read again later (ORDER-2116, measured on the free pair 2026-10-01: a round
    // posted 15 min ahead was read before its beacon existed, kept for good, and never drew a committee - "no block in
    // this view is after this round's committee time"; no free round posted ahead was joinable).
    if (view && typeof view === 'object') {
      Object.defineProperty(view, 'shortOfBeacon', { value: !(seen.ok && tip >= deep), enumerable: false });
      Object.defineProperty(view, 'readAtMs', { value: Date.now(), enumerable: false, writable: true });
      Object.defineProperty(view, 'tipAtRead', { value: tip, enumerable: false });
    }
    return view;
  };
  // (No census is read ahead for rounds owing an on-chain pool payout: that payout is gone with the withdrawn custody -
  // §23.6, RULED 2026-09-25. A round's view is read the first time it is asked for, below.)
  Object.assign(options, {
    // THE CHAIN'S TIP, for the settlement's takeover order (M3.3-19) and a lock's expiry, as the launcher gave its nodes
    chainTip: async () => Number(await call('getblockcount')),
    // ONE VIEW PER WHAT IT DEPENDS ON - census height, committee_time, confirmation depth - NOT PER ROUND, AND ONE READ
    // OF IT IN FLIGHT (the owner 2026-09-30, measured on testnet4): a node holding series 3cfbe516 lists ~508 rounds that
    // all name the same census and beacon, and a view read per round id - ~100 blocks each, re-asked on every listing
    // while unread - flooded the testnet4 bitcoind from seven nodes: "Too many open files" at 07:10Z, the daemon
    // restarted, and the LNDs on it shut down. A round asked by id alone answers from the key it was read under.
    chainFor: ({ contract, roundIdBytes } = {}) => {
      const rid = roundIdBytes ? Buffer.from(roundIdBytes).toString('hex') : null;
      // A ROUND ASKED BY ID ALONE AFTER A RESTART (the owner 2026-10-02: "find a way to recover from them"): the id -> view key
      // map lives in memory, so a seat restarted inside a round's objection window answered "no chain view for that round",
      // could not say who is bonded, gathered no FINAL signature and kept none - seat 2 stayed PROVISIONALLY_FINAL on round
      // 798ebc79 while the other six signed FINAL 7 of 7. The round's own contract is in the store: its key is read from it.
      if (!contract && rid && !keyOfRound.has(rid)) {
        try {
          const row = db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(Buffer.from(rid, 'hex'));
          if (row) contract = decodeRoundContract(new Uint8Array(row.contract));
        } catch { contract = undefined; }
      }
      const key = contract ? `${contract.censusHeight}:${contract.committeeTimeMs}:${contract.censusConfirmations}` : rid && keyOfRound.get(rid);
      if (!key) return undefined;
      if (rid && contract) keyOfRound.set(rid, key);
      if (views.has(key)) {
        const had = views.get(key);
        // the one held is answered meanwhile; a fresh read replaces it once it lands
        if (had && had.shortOfBeacon && contract && !reading.has(key) && Date.now() - had.readAtMs >= VIEW_REREAD_MS)
          // and only once the beacon is on the chain at the round's depth - one header asked per tip, the beacon read once
          // the tip's median time has passed committee_time; a view is many blocks, and re-reading it on every new block
          // held 46 RPC calls open per node on the free pair (measured 2026-10-01).
          reading.set(key, (async () => {
            had.readAtMs = Date.now();
            const tip = Number(await call('getblockcount'));
            if (tip === had.tipAtRead) return;
            let seen = beacon.for({ contract });
            if (!seen) {
              const head = await call('getblockheader', [await call('getblockhash', [tip])]);
              if (!(BigInt(head.mediantime) * 1000n > BigInt(contract.committeeTimeMs))) return;
              const read = await beacon.refresh(contract);
              if (!read.ok) return;
              seen = read;
            }
            if (tip < seen.height + contract.censusConfirmations - 1) return;
            // EXTENDED, NOT READ AGAIN: the blocks after the held view's end are appended (a whole view is ~2000 blocks
            // past the census lookback; ten rounds re-reading theirs on the 10 s clock finished minutes after their entry
            // closed, measured). A first new block that does not link to the held tip - a reorganised chain - reads the
            // whole view again.
            const end = had.firstHeight + had.blocks.length - 1;
            const to = Math.min(tip, Math.max(contract.censusHeight, seen.height + contract.censusConfirmations - 1));
            const more = to > end ? await blocksOver(call, end + 1, to, { cache: blocksKept }) : { blocks: [] };
            const links = !more.blocks.length || toHexMain(more.blocks[0].header.subarray(4, 36)) === toHexMain(blockHashOf(had.blocks[had.blocks.length - 1].header));
            if (!links) { views.set(key, await viewOf(contract)); return; }
            const view = { ...had, blocks: [...had.blocks, ...more.blocks] };
            Object.defineProperty(view, 'shortOfBeacon', { value: false, enumerable: false });
            Object.defineProperty(view, 'readAtMs', { value: Date.now(), enumerable: false, writable: true });
            Object.defineProperty(view, 'tipAtRead', { value: tip, enumerable: false });
            views.set(key, view);
          })().catch(() => {}).finally(() => reading.delete(key)));
        return had;
      }
      // A READ THAT FAILED IS SAID ONCE AND TRIED AGAIN A MINUTE LATER, not on every pass (the owner 2026-10-02, the load): the
      // error was dropped, so every close and verify pass over a round whose view would not read - on all seven testnet4
      // seats, rounds from days back and today's alike - read ~2,100 blocks from bitcoind again, and the seat said only
      // "no chain view for that round".
      const failed = viewFailed.get(key);
      if (failed && Date.now() - failed.atMs < 60000) return undefined;
      if (contract && !reading.has(key))
        reading.set(key, viewOf(contract).then((v) => { views.set(key, v); viewFailed.delete(key); })
          .catch((e) => {
            const why = String((e && e.message) || e);
            if (!failed || failed.why !== why) console.error(`[chain] view ${key} did not read: ${why}`);
            viewFailed.set(key, { atMs: Date.now(), why });
          })
          .finally(() => reading.delete(key)));
      return undefined;
    },
    // THE CHAIN A §13A/§13C WINDOW IS READ ON, AND THE TIP A POSTING OR RE-RUN NAMES: one header view that follows the tip
    // (src/tip-view.js). The round's census view above stops at its beacon's depth, and answered for these too - measured
    // on testnet4, series round fbd8294e: agreed and posted by all 7, never final, never settled.
    windowChain: tipHeaderView({ call, log: (s) => console.log(s) }),
    // A round seen for the first time is read now and answered from then on.
    randomnessFor: (q) => {
      const got = beacon.for(q);
      if (!got && q && q.contract) beacon.refresh(q.contract).catch(() => {});
      return got;
    },
  });
  // A HELD SERIES' VIEWS ARE READ AT START (TWO-GAMES-1407, measured on testnet4 2026-09-30 12:37Z): the first paying
  // POST /round after a restart was refused by every node - "this node has no chain view for that round, so it cannot
  // say who is bonded" - because the old series' bonding is read at its own census height (OLD_TESTNET4_SERIES_BOND_HEIGHT),
  // a view key nothing had asked for yet, and chainFor answers no view while a read is in flight. The deposit had landed
  // and its lock was made; the join was dropped. Both keys of each held series are asked for now, so they are read before
  // the first player's round is.
  for (const c of options.series || []) {
    options.chainFor({ contract: c });
    if (c.seriesId instanceof Uint8Array && isOldTestnet4Id(c.networkId) && isOldTestnet4Series(c.seriesId))
      options.chainFor({ contract: { ...c, censusHeight: OLD_TESTNET4_SERIES_BOND_HEIGHT } });
  }
}
// THE NODE, AND ITS GUARDIAN WHEN IT HOLDS A GUARDIAN KEY (node-start.js; §23A.2, RULED the owner 2026-09-26 22:54 and
// 2026-09-27): nothing here is guardian config - whether this node is a guardian is the key beside its store, and the
// network, bitcoind, data, ports and public endpoint are all read off what this node already has (guardian.js).
const node = await startNode({ db, path }, options,
  { bitcoindUrl: url, cookiePath, call: url ? bitcoindRpc({ url, cookiePath }) : null });
// AND STOPS WITH IT: a signal closes the node, and its close() stops its guardian - never one without the other.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await node.close().catch(() => {});
    process.exit(0);
  });
}
console.log(`blwp-node on http://${host}:${node.port}  (${path})${url ? `, chain ${url}` : ''}`
  + `${ln.given ? `, lnd ${ln.rpc} (${ln.network})` : ''}`);
