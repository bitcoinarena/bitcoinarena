// Audit census r4-2 finding 1: a stranger flushes a new (unbonded) node's announcement out of every seat's pending bucket
// (kanban #2066, ADDRESS_PENDING_MAX) with 256 announcements under fresh keys, so the owner page's lookup by key
// (GET /address-announcements?node=<key>) finds nothing and the first bond cannot be set up from the link.
// SAFE behaviour asserted: an honest node's held announcement is still answered for its key after a stranger's flood.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, ADDRESS_PENDING_MAX } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const keyOf = (seed) => { const secret = new Uint8Array(32); new DataView(secret.buffer).setUint32(0, seed + 1); secret[31] = 7; return { secret, hex: Buffer.from(schnorr.getPublicKey(secret)).toString('hex') }; };
const T0 = 1_800_000_000_000;

test('a stranger\'s fresh-key announcements do not push a new node\'s held announcement out of the lookup by key', () => {
  const db = new DatabaseSync(':memory:');
  // a census is read and names some other node: neither the new node nor the stranger's keys are in it
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode: (k) => k === 'aa'.repeat(32) });
  const fresh = keyOf(999999);
  const mine = signAddressAnnouncement({ node: fresh.hex, endpoint: 'https://new-node.trycloudflare.com', atMs: T0 }, (d) => schnorr.sign(d, fresh.secret));
  const r = book.take(mine);
  assert.equal(r.status, 409);
  assert.equal(book.list({ node: fresh.hex }).some((a) => a.node === fresh.hex), true, 'held for the lookup before the flood');
  // the stranger: ADDRESS_PENDING_MAX announcements, each under a key generated for it (no bond, no auth, one POST each)
  for (let i = 0; i < ADDRESS_PENDING_MAX; i++) {
    const k = keyOf(i);
    book.take(signAddressAnnouncement({ node: k.hex, endpoint: `https://junk-${i}.example.com`, atMs: T0 }, (d) => schnorr.sign(d, k.secret)));
  }
  assert.equal(book.list({ node: fresh.hex }).some((a) => a.node === fresh.hex), true,
    'the new node\'s announcement is still answered for its key (the owner page finds it)');
});

// kanban #3059: the bucket's rule. A held announcement re-announced within ADDRESS_PENDING_KEEP_MS is never pushed out by a new key;
// a new key finds room only in place of one not re-announced for that long, else it is refused 503 (try again), and nothing goes.
test('#3059: a full bucket of fresh announcements refuses a new key 503; one not re-announced for ADDRESS_PENDING_KEEP_MS makes room', async () => {
  const { ADDRESS_PENDING_KEEP_MS } = await import('../src/address-book.js');
  assert.ok(ADDRESS_PENDING_KEEP_MS >= 2 * 600000, 'longer than the node\'s re-announce interval (10 min), with room for one missed');
  let now = T0;
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => now, isCensusNode: () => false });
  const ann = (k, i) => signAddressAnnouncement({ node: k.hex, endpoint: `https://n-${i}.example.com`, atMs: now }, (d) => schnorr.sign(d, k.secret));
  for (let i = 0; i < ADDRESS_PENDING_MAX; i++) assert.equal(book.take(ann(keyOf(i), i)).status, 409);
  const late = keyOf(500000);
  const r = book.take(ann(late, 'late'));
  assert.equal(r.status, 503, 'a full bucket of fresh announcements: the new key waits');
  assert.equal(book.list({ node: late.hex }).length, 0);
  for (let i = 0; i < ADDRESS_PENDING_MAX; i++) assert.equal(book.list({ node: keyOf(i).hex }).length, 1, `held ${i} stays`);
  // every held one but key 0 re-announces in time; key 0 does not
  now += ADDRESS_PENDING_KEEP_MS - 1000;
  for (let i = 1; i < ADDRESS_PENDING_MAX; i++) assert.equal(book.take(ann(keyOf(i), i)).status, 409, 're-announce of a held key is taken');
  now += 2000;
  assert.equal(book.take(ann(late, 'late')).status, 409, 'room in place of the one not re-announced');
  assert.equal(book.list({ node: late.hex }).length, 1);
  assert.equal(book.list({ node: keyOf(0).hex }).length, 0, 'the one not re-announced went');
  assert.equal(book.list({ node: keyOf(1).hex }).length, 1);
});
