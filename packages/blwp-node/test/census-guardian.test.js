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

// THE CENSUS READS THE NEWEST ADVERTISEMENT (§5A.2; the owner 2026-09-28, the advertisement-update letter: "the node
// census: read the newest update, not the original bond advert"). One block on top of the recorded chain carries an
// update of the honest bond naming a new guardian key; with the census height there, the honest entry is the same bond
// with the updated advertisement. The fixture holds no node secret, so the signature check is the test's: an update
// the check refuses is not applied, and the bond's own advertisement stands.
test('an update of the honest bond at or below the census height replaces its advertisement; a refused one does not', async () => {
  const { advertUpdateTransaction, blockOf } = await import('../../protocol/tools/bond.js');
  const { hash256 } = await import('../../protocol/src/tx.js');
  const { blockHashOf } = await import('../../protocol/src/chain.js');
  const base = deriveCensus(view, { contract, resolve, bond: BOND });
  const honest = base.entries[0];
  const newKey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x7a)]);
  const fed = new Uint8Array(32).fill(0x33);
  const a = { ...honest.advert, guardianOf: [{ federationId: fed, guardianKey: newKey }], timestamp: 1790000000000n };
  const tx = advertUpdateTransaction(a, { bondTxid: honest.txid, bondVout: honest.vout, signature: new Uint8Array(64).fill(1) });
  const last = blocks.at(-1).header;
  const time = new DataView(last.buffer, last.byteOffset).getUint32(68, true) + 600;
  const { header } = blockOf(hash256, [parseTransaction(tx).txid], { previous: blockHashOf(last), time });
  const tipHeight = view.firstHeight + blocks.length;
  const longer = { blocks: [...blocks, { header, transactions: [tx] }], firstHeight: view.firstHeight };
  const at = { ...contract, censusHeight: tipHeight };
  const seen = [];
  const applied = deriveCensus(longer, { contract: at, resolve, bond: BOND, verifyUpdate: (sig, msg, key) => { seen.push(toHex(key)); return true; } });
  assert.equal(applied.ok, true, applied.why);
  const e = applied.entries.find((x) => whoIs(x.pubkey) === 'honest');
  assert.deepEqual(e.advert.guardianOf[0].guardianKey, newKey, 'the census names the updated guardian key');
  assert.equal(toHex(e.txid), toHex(honest.txid), 'the same bond');
  assert.equal(e.updatedBy.height, tipHeight);
  assert.deepEqual(seen, [CHAIN.nodes.honest.pubkey], 'the update is checked against the bond\'s own node key');
  const refused = deriveCensus(longer, { contract: at, resolve, bond: BOND, verifyUpdate: () => false });
  const kept = refused.entries.find((x) => whoIs(x.pubkey) === 'honest');
  assert.equal(kept.advert.guardianCapable, true);
  assert.equal(kept.advert.guardianOf.length, honest.advert.guardianOf.length, 'a refused update leaves the bond\'s own advertisement');
  assert.equal(kept.updatedBy, undefined);
  // and an update above the census height is not read
  const early = deriveCensus(longer, { contract: { ...at, censusHeight: tipHeight - 1 }, resolve, bond: BOND, verifyUpdate: () => true });
  assert.equal(early.entries.find((x) => whoIs(x.pubkey) === 'honest').updatedBy, undefined);
});
