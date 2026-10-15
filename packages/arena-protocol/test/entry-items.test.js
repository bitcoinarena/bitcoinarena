// THE ITEMS AN ENTRY PLAYS WITH (protocol 10, kanban #365): each item by id with the purchase that made it the player's, last of all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract, entryId, ITEMS_ENTRY_MARKER, ENTRY_ITEMS_MAX } from '../src/contracts.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const site = (n) => { const k = new Uint8Array(33).fill(n); k[0] = 2; return k; };
const ENTRY = {
  roundId: b32(1), playerPubkey: b32(2), sessionPubkey: b32(3), stakeCommitment: b32(4), stakeMsat: 2000000n, feeMsat: 100000n, donationMsat: 100000n,
  joinTick: 0, worldSecret: b32(5), vssSharesRef: b32(6), stakePoint: new Uint8Array(33).fill(7), feePreimage: b32(8),
  stakeLockOutpoint: { txid: b32(9), outIdx: 0n }, feeLockOutpoint: { txid: b32(9), outIdx: 1n }, claimKeyAttestationRef: b32(10),
};
const ITEMS = [{ itemId: 'large-truck', purchaseId: b32(0xda) }, { itemId: 'turbo', purchaseId: b32(0xdb) }];

test('an entry names its items last, read back whole, in its id; every entry without them keeps its bytes', () => {
  const plain = encodeEntryContract(ENTRY);
  const withItems = encodeEntryContract({ ...ENTRY, items: ITEMS });
  assert.equal(toHex(withItems.subarray(0, plain.length)), toHex(plain), 'the items only append');
  assert.equal(withItems[plain.length], ITEMS_ENTRY_MARKER);
  assert.deepEqual(decodeEntryContract(withItems).items, ITEMS);
  assert.notEqual(toHex(entryId({ ...ENTRY, items: ITEMS })), toHex(entryId(ENTRY)));
  assert.equal(decodeEntryContract(plain).items, undefined);
  // after every other tail field: the federation, the operator, the website's key, then the items
  const full = { ...ENTRY, federationId: b32(0xfe), operatorId: b32(0x0f), frontendPk: site(3), items: ITEMS };
  assert.deepEqual(decodeEntryContract(encodeEntryContract(full)), { ...full });
  const onlySite = { ...ENTRY, frontendPk: site(4) };
  assert.deepEqual(decodeEntryContract(encodeEntryContract(onlySite)), onlySite, 'the website without items reads as before');
});

test('items that are not a list of ids with purchases, sorted and each once, are refused by name', () => {
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: [] }), /1 to 8 items/);
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: Array.from({ length: ENTRY_ITEMS_MAX + 1 }, (_, i) => ({ itemId: `i${i}`, purchaseId: b32(i) })) }), /1 to 8 items/);
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: [ITEMS[1], ITEMS[0]] }), /sorted by id, each once/);
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: [ITEMS[0], ITEMS[0]] }), /sorted by id, each once/);
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: [{ itemId: 'Big', purchaseId: b32(1) }] }), /by its id and the 32-byte id/);
  assert.throws(() => encodeEntryContract({ ...ENTRY, items: [{ itemId: 'big', purchaseId: new Uint8Array(31) }] }), /by its id and the 32-byte id/);
  const bytes = encodeEntryContract(ENTRY);
  // an unknown byte after the website's key is no item list
  const afterSite = new Uint8Array([...encodeEntryContract({ ...ENTRY, frontendPk: site(5) }), 0x99]);
  assert.throws(() => decodeEntryContract(afterSite), /neither its federation, its operator, its website nor its items/);
  const empty = new Uint8Array([...bytes, ITEMS_ENTRY_MARKER, 0, 0]);
  assert.throws(() => decodeEntryContract(empty), /empty list of items is not written/);
});
