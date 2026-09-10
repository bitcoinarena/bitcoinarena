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
//
// Both or neither. With them the daemon can find the pool's output, send and
// look up a payout, read each round's beacon, and derive each round's census -
// which is where it learns the other seats' addresses, from the advertisements
// in their bonds. So a daemon that died in the middle of settling, started
// again on its store, finishes what it owed. Measured without them: it
// recovered nothing at any kill point.
//
// HOW FAR BACK A CENSUS IS READ: CENSUS_LOOKBACK blocks before a round's
// census height. A bond funded earlier than that is not seen by a restarted
// daemon, and a round whose committee holds one is refused by name.
const CENSUS_LOOKBACK = 2016;
import { openStore } from './store.js';
import { serve } from './server.js';
import { Round } from './round.js';
import { bitcoindRpc, blocksOver } from './chain-rpc.js';
import { chainSpendOver } from './pool-watch.js';
import { chainBeacon } from './beacon-source.js';
import { PAYOUT_QUEUED } from './payout.js';
import { lightningFromEnv } from './lnd-settings.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';

const port = Number(process.argv[2] || 8080);
const path = process.argv[3] || 'round.db';
const host = process.env.BLWP_BIND || '127.0.0.1';
const url = process.env.BLWP_BITCOIND_URL || '';
const cookiePath = process.env.BLWP_BITCOIND_COOKIE || '';
if (Boolean(url) !== Boolean(cookiePath)) {
  console.error('BLWP_BITCOIND_URL and BLWP_BITCOIND_COOKIE go together: set both, or neither');
  process.exit(2);
}

// LIGHTNING COMES FROM FOUR SETTINGS, ALL OR NONE - BLWP_LNCLI, BLWP_LND_DIR,
// BLWP_LND_RPC, BLWP_LND_NETWORK - parsed in `lnd-settings.js`. With them the
// daemon holds stakes, and on start asks that lnd about every stake it died in
// the middle of settling or cancelling. Measured without them
// (tools/custody-restart-lnd.mjs): a custodian killed inside a settle and
// restarted as this file left the stake ACTING whatever lnd said.
const ln = lightningFromEnv(process.env);
if (!ln.ok) {
  console.error(ln.why);
  process.exit(2);
}

const db = openStore(path);
const options = { port, host };
if (ln.given) {
  options.lightning = ln.lightning;
  if (ln.preflight) options.preflight = ln.preflight;
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
  // synchronously, and the seats' addresses are in it.
  const views = new Map();
  // UP TO THE BEACON, AND AS DEEP PAST IT AS THE ROUND ASKS. The beacon comes
  // after the census height in the normal order, and the roster checks the
  // seed block against this same view - at the round's own confirmation depth.
  // Measured: stopping at the census height, "no block in this view is after
  // this round's committee time"; stopping at the beacon, "the block that
  // seeds this round is 1 deep and this round asks for 6". Never past the tip.
  const viewOf = async (contract) => {
    const seen = await beacon.refresh(contract);
    const tip = Number(await call('getblockcount'));
    const deep = seen.ok ? seen.height + contract.censusConfirmations - 1 : 0;
    const to = Math.min(tip, Math.max(contract.censusHeight, deep));
    return blocksOver(call, Math.max(0, contract.censusHeight - CENSUS_LOOKBACK), to);
  };
  const round = new Round(db);
  for (const row of round.payoutsInState(PAYOUT_QUEUED)) {
    const r = round.get(row.roundId);
    if (!r) continue;
    const contract = decodeRoundContract(new Uint8Array(r.contract));
    const seen = await beacon.refresh(contract);
    if (!seen.ok) console.error(`[beacon] ${seen.why}`);
    try { views.set(Buffer.from(row.roundId).toString('hex'), await viewOf(contract)); }
    catch (e) { console.error(`[census] ${e.message}`); }
  }
  Object.assign(options, {
    poolCall: call,
    chainFor: ({ contract, roundIdBytes } = {}) => {
      const key = roundIdBytes ? Buffer.from(roundIdBytes).toString('hex') : null;
      if (key && views.has(key)) return views.get(key);
      if (key && contract) viewOf(contract).then((v) => views.set(key, v)).catch(() => {});
      return undefined;
    },
    chainSpend: chainSpendOver(call),
    // A round seen for the first time is read now and answered from then on.
    randomnessFor: (q) => {
      const got = beacon.for(q);
      if (!got && q && q.contract) beacon.refresh(q.contract).catch(() => {});
      return got;
    },
  });
}
const node = await serve(db, options);
console.log(`blwp-node on http://${host}:${node.port}  (${path})${url ? `, chain ${url}` : ''}`
  + `${ln.given ? `, lnd ${ln.rpc} (${ln.network})` : ''}`);
