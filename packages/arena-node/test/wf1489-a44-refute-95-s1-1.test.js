// kanban #1489 fix-refute a44 item 95 (kanban #1841, sm3-census-1): the #1841 check in main.js chainCensusKept compares the view's
// block at the census height with blocksKept.get(hash) - but passes whenever the cache does NOT hold the key's block
// (keptBlock === undefined). A chain that goes A -> B -> A during the walk (an equal-work flip and back, chain-agree's
// preciousblock) on a seat whose cache never held A's block at that height (a fresh start, or evicted past max): the re-read
// getblockhash answers A's hash again, the view is all branch B, keptBlock is undefined - B's census is kept under A's key and
// answered for three days. The view's block is never hashed and compared with the key (roster.js does: hashOfBlock).
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

const H = 30, FORK = 28;
const hashOf = (branch, h) => (h < FORK ? 'c' : branch === 'A' ? 'a' : 'b').repeat(2) + String(h).padStart(62, '0');
const setup = ({ cacheA }) => {
  const blocksKept = blockCache();
  for (let h = 0; h <= H; h++) {
    blocksKept.put(hashOf('B', h), { header: new Uint8Array(80), transactions: [], branch: h < FORK ? 'common' : 'B' });
    if (cacheA) blocksKept.put(hashOf('A', h), { header: new Uint8Array(80), transactions: [], branch: h < FORK ? 'common' : 'A' });
  }
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE census_kept (key TEXT PRIMARY KEY, body TEXT NOT NULL, kept_ms INTEGER NOT NULL)');
  const censusOfView = (view) => ({ ok: true, entries: [], branch: view.blocks[view.blocks.length - 1].branch });
  return { blocksKept, db, censusOfView };
};
const net = Buffer.from(NETWORK_ID_REGTEST).toString('hex');
const contract = { networkId: NETWORK_ID_REGTEST, censusHeight: H, censusConfirmations: 1 };

test('#1489 a44-refute-95-s1-1: A -> B -> A during the walk, A\'s block not in the cache: B\'s census is kept under A\'s hash', async () => {
  const { blocksKept, db, censusOfView } = setup({ cacheA: false });
  let branch = 'A'; let reads = 0;
  const call = async (method, params = []) => {
    if (method === 'getbestblockhash') return hashOf(branch, H);
    if (method === 'getblockcount') return H;
    if (method === 'getblockhash') {
      const [h] = params; const answer = hashOf(branch, h);
      if (h === H) { reads++; if (reads === 1) branch = 'B'; else if (reads === 2) branch = 'A'; }  // key on A, walk on B, back to A
      return answer;
    }
    throw new Error(`no ${method} here`);
  };
  const ck = make(call, db, censusFirstBlock, networkOf, blocksOver, blocksKept, censusWithFreshHashes, censusOfView, censusReviver, censusReplacer);
  const first = await ck('ballot', net, H, contract);
  // the fake bitcoind answers no getblock: A's blocks reach the cache as a read of them would put them there (kanban #2191)
  for (let h = FORK; h <= H; h++) blocksKept.put(hashOf('A', h), { header: new Uint8Array(80), transactions: [], branch: 'A' });
  const again = await ck('ballot', net, H, contract);   // the chain is on A; nothing moves now
  const keys = db.prepare('SELECT key FROM census_kept').all().map((r) => r.key.split(':')[4].slice(0, 4));
  console.log('  ABA:', JSON.stringify({ first: first.ok ? first.branch : first.why, again: again.ok ? again.branch : again.why, keptUnderHashOf: keys }));
  assert.notEqual(first.branch, 'B', 'a census derived from branch B is never answered for A\'s block at the census height');
  assert.equal(again.branch, 'A', 'asked again on branch A, the census is branch A\'s');
});

test('#1489 a44-refute-95-s1-1 control: A -> B -> A with A\'s block in the cache is refused (the fix\'s own case)', async () => {
  const { blocksKept, db, censusOfView } = setup({ cacheA: true });
  let branch = 'A'; let reads = 0;
  const call = async (method, params = []) => {
    if (method === 'getbestblockhash') return hashOf(branch, H);
    if (method === 'getblockcount') return H;
    if (method === 'getblockhash') { const [h] = params; const a = hashOf(branch, h); if (h === H) { reads++; if (reads === 1) branch = 'B'; else if (reads === 2) branch = 'A'; } return a; }
    throw new Error(`no ${method} here`);
  };
  const ck = make(call, db, censusFirstBlock, networkOf, blocksOver, blocksKept, censusWithFreshHashes, censusOfView, censusReviver, censusReplacer);
  const first = await ck('ballot', net, H, contract);
  assert.equal(first.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM census_kept').get().n, 0);
});

test('#1489 a44-refute-95-s1-1 honest: no reorg, empty cache for A: the census is kept and answered again from the store', async () => {
  const { blocksKept, db, censusOfView } = setup({ cacheA: false });
  for (let h = FORK; h <= H; h++) blocksKept.put(hashOf('A', h), { header: new Uint8Array(80), transactions: [], branch: 'A' });
  const call = async (method, params = []) => {
    if (method === 'getbestblockhash') return hashOf('A', H);
    if (method === 'getblockcount') return H;
    if (method === 'getblockhash') return hashOf('A', params[0]);
    throw new Error(`no ${method} here`);
  };
  const ck = make(call, db, censusFirstBlock, networkOf, blocksOver, blocksKept, censusWithFreshHashes, censusOfView, censusReviver, censusReplacer);
  const first = await ck('ballot', net, H, contract);
  assert.equal(first.ok, true); assert.equal(first.branch, 'A');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM census_kept').get().n, 1);
});
