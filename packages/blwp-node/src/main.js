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
// look up a payout, and read each round's beacon - so a daemon that died in
// the middle of settling, started again on its store, finishes what it owed.
// Measured without them: it recovered nothing at any kill point.
import { openStore } from './store.js';
import { serve } from './server.js';
import { Round } from './round.js';
import { bitcoindRpc } from './chain-rpc.js';
import { chainSpendOver } from './pool-watch.js';
import { chainBeacon } from './beacon-source.js';
import { PAYOUT_QUEUED } from './payout.js';
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

const db = openStore(path);
const options = { port, host };
if (url) {
  const call = bitcoindRpc({ url, cookiePath });
  // A 400-header window, as the 2-of-2 tool reads one: the rule refuses a
  // window that does not reach back before a round's committee_time.
  const beacon = chainBeacon({ call, window: 400 });
  // THE BEACON OF EVERY ROUND THIS STORE STILL OWES A PAYOUT ON, read before
  // the daemon starts: the start-up sweep asks it whose turn it is, and the
  // other readers of a beacon ask synchronously.
  const round = new Round(db);
  for (const row of round.payoutsInState(PAYOUT_QUEUED)) {
    const r = round.get(row.roundId);
    if (!r) continue;
    const seen = await beacon.refresh(decodeRoundContract(new Uint8Array(r.contract)));
    if (!seen.ok) console.error(`[beacon] ${seen.why}`);
  }
  Object.assign(options, {
    poolCall: call,
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
console.log(`blwp-node on http://${host}:${node.port}  (${path})${url ? `, chain ${url}` : ''}`);
