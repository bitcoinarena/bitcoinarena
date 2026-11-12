// kanban #1489 state-machine audit round 3, area census, finding 1.
// main.js chainCensusKept (the census the ballot tally, the proposal intake, the founding and the duty poster read): the key is
// built from the census height's hash read FIRST (getblockhash), the census is then derived from a block walk that runs for
// minutes (2,016+ blocks) and reads the top heights LAST. A reorg in between: the census of the NEW branch is kept in
// census_kept under the OLD branch's block hash. When the chain goes back to that block (an equal-work flip, chain-agree's
// preciousblock, a longer branch), the seat answers the other branch's census for it - for good (three days kept), while a seat
// that read it without a reorg answers the right one: two seats count a proposal's ballot with different censuses.
//
// The real chainCensusKept is taken out of main.js's source (it is a closure inside the daemon's start) and run over the real
// blocksOver, blockCache and censusWithFreshHashes, a node:sqlite census_kept table and a fake bitcoind with two branches.
// Only the derivation (censusOfView) is a stand-in: it names the branch of the view's top block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { blocksOver, blockCache, censusWithFreshHashes } from '../src/chain-rpc.js';
import { censusReplacer, censusReviver } from '../src/roster.js';
import { censusFirstBlock } from '../../arena-protocol/src/census.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';

const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const from = src.indexOf('const chainCensusInFlight = new Map();');
const to = src.indexOf('const reading = new Map();', from);
assert.ok(from > 0 && to > from, 'chainCensusKept found in main.js');
// eslint-disable-next-line no-new-func
const make = new Function('call', 'db', 'censusFirstBlock', 'networkOf', 'blocksOver', 'blocksKept', 'censusWithFreshHashes', 'censusOfView',
  'censusReviver', 'censusReplacer', `${src.slice(from, to)}\nreturn chainCensusKept;`);

test('#1489 sm3-census-1: a reorg during a chain census read keeps the new branch\'s census under the old branch\'s block hash', async () => {
  const H = 30, FORK = 28;                         // branches A and B share 0..27 and differ at 28..30
  const hashOf = (branch, h) => (h < FORK ? 'c' : branch === 'A' ? 'a' : 'b').repeat(2) + String(h).padStart(62, '0');
  const blocksKept = blockCache();
  for (const b of ['A', 'B']) for (let h = 0; h <= H; h++) blocksKept.put(hashOf(b, h), { header: new Uint8Array(80), transactions: [], branch: h < FORK ? 'common' : b });
  let branch = 'A';
  let keyReads = 0;
  const call = async (method, params = []) => {
    if (method === 'getbestblockhash') return hashOf(branch, H);
    if (method === 'getblockcount') return H;
    if (method === 'getblockhash') {
      const [h] = params;
      const answer = hashOf(branch, h);
      // the key's read of the census height: the chain reorgs to B right after it (the walk below takes minutes on a seat)
      if (h === H && ++keyReads === 1) branch = 'B';
      return answer;
    }
    throw new Error(`no ${method} here`);
  };
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE census_kept (key TEXT PRIMARY KEY, body TEXT NOT NULL, kept_ms INTEGER NOT NULL)');
  const censusOfView = (view) => ({ ok: true, entries: [], branch: view.blocks[view.blocks.length - 1].branch });
  const chainCensusKept = make(call, db, censusFirstBlock, networkOf, blocksOver, blocksKept, censusWithFreshHashes, censusOfView, censusReviver, censusReplacer);
  const net = Buffer.from(NETWORK_ID_REGTEST).toString('hex');
  const contract = { networkId: NETWORK_ID_REGTEST, censusHeight: H, censusConfirmations: 1 };

  const first = await chainCensusKept('ballot', net, H, contract);
  console.log('  first read (reorg A -> B during it):', JSON.stringify({ derivedFrom: first.branch }));
  // the chain goes back to branch A (an equal-work flip): the census at H on A is asked again
  branch = 'A';
  blocksKept.topHashes.clear(); blocksKept.hashes.clear();
  const again = await chainCensusKept('ballot', net, H, contract);
  const keys = db.prepare('SELECT key FROM census_kept').all().map((r) => r.key.split(':')[4].slice(0, 4));
  console.log('  asked again on branch A:', JSON.stringify({ answered: again.branch, keptUnderHashOf: keys }));
  assert.equal(again.branch, 'A', 'the census answered for branch A\'s block at the census height is branch A\'s');
});
