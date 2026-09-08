// THE CENSUS ON BLOCKS BITCOIN ACTUALLY PRODUCED.
//
// Every census test before this one ran on composed blocks: a fixture chose
// the spend state, the depth and the height, and a fixture cannot lie about
// Bitcoin. That sounds like a virtue and is the opposite - it means nothing
// had asked a real node whether these rules survive real bytes: real headers,
// a real witness carrying the advertisement body (5A.2), a real 5-of-7 slash
// spending a bond, and a real depth at a real tip.
//
// `tools/census-regtest.mjs` posts four bonds on an isolated regtest, spends
// one by the slash leaf, leaves one two blocks deep, marks one for another
// network, and writes the node's own blocks out. This replays those bytes.
// Nothing here is composed: the headers, the transactions, the witnesses and
// the spend are what bitcoin-31.1 served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveCensus, resolveCensus, chainViewOf } from '../../protocol/src/census.js';
import { parseTransaction, blockMerkleRoot } from '../../protocol/src/tx.js';
import { splitBlock } from '../../protocol/src/block.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { BOND } from './curve.js';

const CHAIN = JSON.parse(readFileSync(new URL('./fixtures/regtest-census.json', import.meta.url)));
const blocks = CHAIN.blocks.map((b) => splitBlock(fromHex(b.hex)));
const view = { blocks, firstHeight: CHAIN.firstHeight };
const contract = {
  bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST,
  censusHeight: CHAIN.censusHeight, censusConfirmations: 6,
};
// A peer that hands back the funding transaction, which here means finding it
// in the blocks themselves - the same bytes, nothing composed.
const byTxid = new Map();
for (const block of blocks)
  for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
const resolve = (e) => {
  const raw = byTxid.get(toHex(e.txid));
  return raw ? { transaction: raw } : null;
};
const keyOf = (who) => fromHex(CHAIN.nodes[who].pubkey);
const has = (list, who) => list.some((e) => toHex(e.pubkey) === CHAIN.nodes[who].pubkey);

test('a real chain from a real node is a chain this census accepts', () => {
  const checked = chainViewOf(view);
  assert.equal(checked.ok, true, checked.why);
  assert.equal(checked.tipHeight, CHAIN.tip);
  assert.equal(checked.blocks.length, CHAIN.blocks.length);

  // AND THE TIP IS PAST THE CENSUS, which is the case that separates "deep at
  // census_height" from "deep by now". A chain that stopped at the census
  // could not tell the two rules apart, and for a while nothing here did.
  assert.equal(CHAIN.tip > CHAIN.censusHeight, true, 'this chain cannot tell the depth rules apart');
  assert.equal(CHAIN.censusHeight - CHAIN.shallowAt + 1, 2, 'the shallow bond is not two deep at the census');
  assert.equal(CHAIN.tip - CHAIN.shallowAt + 1 >= 6, true,
    'the shallow bond is not deep enough by the tip for the old rule to have counted it');

  // the split is not trusted: every block's transactions hash to the merkle
  // root its own header commits to, which is what would catch a wrong span
  for (let i = 0; i < blocks.length; i++) {
    const ids = blocks[i].transactions.map((raw) => parseTransaction(raw).txid);
    const claimed = blocks[i].header.slice(36, 68);
    assert.deepEqual(toHex(blockMerkleRoot(ids)), toHex(claimed),
      `block ${CHAIN.firstHeight + i} did not split where its header says it does`);
  }
});

test('the census of real blocks counts the honest bond and no other', () => {
  const out = deriveCensus(view, { contract, resolve, bond: BOND });
  assert.equal(out.ok, true, out.why);

  assert.equal(out.entries.length, 1,
    `expected the honest bond alone; excluded: ${out.excluded.map((e) => e.why).join(' | ')}`);
  assert.deepEqual(out.entries[0].pubkey, keyOf('honest'));
  assert.deepEqual(toHex(out.root), CHAIN.root, 'the root over real blocks moved');

  // AND THE TEMPLATE WAS CHECKED, on a key a real node paid to: the output on
  // chain recomputes from the body in its own witness.
  assert.equal(out.unchecked.some((u) => /script template/.test(u)), false);
  assert.equal(out.chainChecked, true);
});

test('a bond a real slash spent is excluded by the chain, and so is a shallow one', () => {
  const out = deriveCensus(view, { contract, resolve, bond: BOND });

  const spent = out.excluded.find((e) => toHex(e.pubkey) === CHAIN.nodes.doomed.pubkey);
  assert.ok(spent, 'the slashed bond was counted');
  assert.equal(spent.step, 'scan');
  assert.match(spent.why, /already spent at the census height/);

  const thin = out.excluded.find((e) => toHex(e.pubkey) === CHAIN.nodes.shallow.pubkey);
  assert.ok(thin, 'the two-confirmation bond was counted');
  assert.equal(thin.step, 'scan');
  assert.match(thin.why, /is 2 confirmations deep where this round needs 6/);
});

test('a bond marked for another network is not scanned off a real chain', () => {
  const out = deriveCensus(view, { contract, resolve, bond: BOND });
  assert.equal(has(out.entries, 'elsewhere'), false);
  assert.equal(has(out.excluded, 'elsewhere'), false,
    'a bond paying testnet4\'s marker was scanned by a regtest round');
});

test('a list that lies about these blocks does not move the census', () => {
  const lying = ['honest', 'doomed', 'shallow'].map((who) => ({
    txid: fromHex(CHAIN.nodes[who].txid).reverse(), vout: 0, pubkey: keyOf(who),
    bondSats: 50000000n, height: CHAIN.funded, spent: false, roles: ['game'],
  }));

  const told = deriveCensus(view, { contract, resolve, bond: BOND, candidates: lying });
  assert.equal(told.ok, true, told.why);
  assert.equal(told.entries.length, 1);
  assert.deepEqual(toHex(told.root), CHAIN.root,
    'a list claiming a spent bond was unspent changed the census');
  assert.match(told.excluded.find((e) => toHex(e.pubkey) === CHAIN.nodes.doomed.pubkey).why,
    /already spent at the census height/);

  // AND THE SAME LIST WITH NOTHING TO CHECK IT AGAINST is what this used to
  // be: RESOLVE without a view has only the claims, so all three stand. That
  // is the "before" of letter 25, measured here on real blocks.
  const believed = resolveCensus(lying, { contract, resolve, bond: BOND });
  assert.equal(believed.ok, true, believed.why);
  assert.equal(believed.eligible.length, 3,
    'the claims-only path is meant to show what believing a list costs');
  assert.equal(believed.chainChecked, false);
});
