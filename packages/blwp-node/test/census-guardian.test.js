// A CENSUS OVER REAL BLOCKS SAYS WHICH NODES ARE GUARDIANS, off the adverts their bonds carry (spec §5A.1 v4.6.4,
// §23A.2 one node is one guardian, drawn from the guardian-capable census). The blocks are the ones
// tools/census-regtest.mjs recorded (fixtures/regtest-census.json), where the honest node's bond says it is a guardian
// and the others' do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveCensus, resolveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
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
const byTxid = new Map();
for (const block of blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
const resolve = (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; };
const whoIs = (pubkey) => Object.keys(CHAIN.nodes).find((k) => CHAIN.nodes[k].pubkey === toHex(pubkey));

test('the census of real blocks lists the guardian node as guardian-capable, with its own endpoint', () => {
  const out = deriveCensus(view, { contract, resolve, bond: BOND });
  assert.equal(out.ok, true, out.why);
  assert.equal(out.entries.length, 1);
  const [honest] = out.entries;
  assert.equal(whoIs(honest.pubkey), 'honest');
  assert.equal(honest.advert.guardianCapable, true);
  assert.equal(honest.advert.guardianEndpoint, 'ws://honest/guardian');
});

test('and a node whose bond does not say so is not listed as a guardian', () => {
  // the same bonds read without a view, so the non-guardians' adverts are in the list too
  const listed = ['honest', 'doomed', 'shallow'].map((who) => ({
    txid: fromHex(CHAIN.nodes[who].txid).reverse(), vout: 0, pubkey: fromHex(CHAIN.nodes[who].pubkey),
    bondSats: 50000000n, height: CHAIN.funded, spent: false, roles: ['game'],
  }));
  const read = resolveCensus(listed, { contract, resolve, bond: BOND });
  assert.equal(read.ok, true, read.why);
  const capable = Object.fromEntries(read.eligible.map((e) => [whoIs(e.pubkey), e.advert.guardianCapable]));
  assert.deepEqual(capable, { honest: true, doomed: false, shallow: false });
  for (const e of read.eligible.filter((x) => whoIs(x.pubkey) !== 'honest')) assert.equal(e.advert.guardianEndpoint, '');
});
