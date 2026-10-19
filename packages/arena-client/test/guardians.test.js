// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE COUNTS THE FEDERATION'S BONDED GUARDIANS ON ITS OWN EVIDENCE (§23.6;
// 2026-09-15 07:33): the keys off its lock client's config, the bonds
// proven into a mined chain, each advertisement signed by the node it names.
// Whoever named the candidates can omit and cannot forge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { advertId } from '../../arena-protocol/src/advert.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { hash256, parseTransaction } from '../../arena-protocol/src/tx.js';
import { blockHashOf, BITCOIN_MAINNET_GENESIS_HEADER } from '../../arena-protocol/src/chain.js';
import { bondTransaction, blockOf, advertUpdateTransaction } from '../../arena-protocol/tools/bond.js';
import { guardiansOf, bondedGuardians } from '../src/guardians.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (n) => Uint8Array.from([0x02, ...b32(n)]);
const FED = b32(0xfe);
const ROUND = { federationId: FED, bondMinSats: 50000n, censusConfirmations: 6 };
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

// THE LOCK CLIENT'S ANSWER, in the shape `guardians()` writes it (lock-client/src/lib.rs).
const ANSWER = JSON.stringify({
  federation_id: toHex(FED), guardians: 4, threshold: 3,
  keys: [1, 2, 3, 4].map((n, peer) => ({ peer: String(peer), key: toHex(key(n)) })),
});

const node = (n) => {
  const secret = b32(0x30 + n);
  return { secret, pubkey: schnorr.getPublicKey(secret) };
};
const advertFor = (pubkey, guardianOf) => ({
  nodePubkey: pubkey, operatorId: 'guardian', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['settlement'],
  endpoint: 'wss://guardian.example:443', region: 'eu', capacityClass: 1, softwareHash: b32(3),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(4), guardianOf, timestamp: 1788700000000n,
});
/** Node n bonds `value` sats and advertises guardian key g of FED, signed by `signer`. */
const bondOf = (n, g, { value = 100000, signer = node(n).secret, fed = FED } = {}) => {
  const a = advertFor(node(n).pubkey, [{ federationId: fed, guardianKey: key(g) }]);
  return bondTransaction(a, { value, signature: schnorr.sign(advertId(a), signer), previousTxid: b32(0xa0 + n) });
};

/**
 * Genesis, one block per bond, `after` empty blocks on top, then one block per
 * `late` bond at the tip: the offers, in that order, prove into it.
 */
function chainOf(transactions, after = 6, late = []) {
  const chain = [BITCOIN_MAINNET_GENESIS_HEADER];
  const offers = [];
  const mine = (transaction) => {
    const sibling = b32(0x99);
    const { header } = blockOf(hash256, [parseTransaction(transaction).txid, sibling], { previous: blockHashOf(chain.at(-1)) });
    chain.push(header);
    offers.push({ transaction, branch: [sibling], position: 0 });
  };
  transactions.forEach(mine);
  for (let i = 0; i < after; i++) chain.push(blockOf(hash256, [b32(0xe0 + i)], { previous: blockHashOf(chain.at(-1)) }).header);
  late.forEach(mine);
  return { chain, offers };
}

const count = (over) => bondedGuardians({ guardians: guardiansOf(ANSWER), round: ROUND, verify, ...over });

test('three of four guardians proven bonded meets the federation\'s threshold of three', async () => {
  const { chain, offers } = chainOf([bondOf(1, 1), bondOf(2, 2), bondOf(3, 3)]);
  const got = await count({ chain, offers });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.bonded, 3);
  assert.equal(got.threshold, 3, 'the threshold is the federation\'s, off its config');
  assert.deepEqual(got.refused, []);
});

test('whoever names the candidates can omit: two proven of a threshold of three is a refusal by name', async () => {
  const { chain, offers } = chainOf([bondOf(1, 1), bondOf(2, 2), bondOf(3, 3)]);
  const got = await count({ chain, offers: offers.slice(0, 2) });
  assert.equal(got.ok, false);
  assert.match(got.why, /2 of that federation's 4 guardians are bonded census nodes, and its threshold is 3/);
});

test('and cannot forge: an unproven, a mis-signed, a shallow and an under-bonded offer are set aside by name', async () => {
  const honest = [bondOf(1, 1), bondOf(2, 2)];
  const misSigned = bondOf(3, 3, { signer: node(9).secret });
  const under = bondOf(4, 4, { value: 49999 });
  // one chain: the four deep, six blocks, and guardian 3 again bonded in the tip block
  const { chain, offers } = chainOf([...honest, misSigned, under], 6, [bondOf(6, 3)]);
  const elsewhere = chainOf([bondOf(5, 3)]).offers[0];               // proven into ANOTHER chain

  const got = await count({ chain, offers: [...offers, elsewhere] });
  assert.equal(got.ok, false, 'a forged or unproven guardian was counted');
  assert.equal(got.bonded, 2, 'only the two honest guardians count');
  assert.equal(got.refused.length, 3);
  assert.match(got.refused.join('\n'), /bond 2: the advertisement for .* is not signed by the node it names/);
  assert.match(got.refused.join('\n'), /bond 4: it is 1 block\(s\) deep and this round asks for 6/);
  assert.match(got.refused.join('\n'), /bond 5: the transaction is not in any block of that chain/);
  // the under-bonded one proves and is signed; the count itself leaves it out
  assert.equal(got.counted.length, 3);

  // THE CONTROL: the same guardian 3, honestly signed and deep, lifts it over the threshold
  const fixed = chainOf([...honest, bondOf(3, 3), under]);
  assert.equal((await count({ chain: fixed.chain, offers: fixed.offers })).ok, true);
});

test('guardians read off another federation than the round names count nothing', async () => {
  const { chain, offers } = chainOf([bondOf(1, 1), bondOf(2, 2), bondOf(3, 3)]);
  const other = guardiansOf(JSON.parse(ANSWER.replace(toHex(FED), toHex(b32(0xfd)))));
  const got = await bondedGuardians({ guardians: other, round: ROUND, chain, offers, verify });
  assert.equal(got.ok, false);
  assert.match(got.why, /joined federation fdfdfdfdfdfdfdfd and this round names fefefefefefefefe/);
  // and a bond advertising a guardian key of another federation is not this one's
  const theirs = chainOf([bondOf(1, 1), bondOf(2, 2), bondOf(3, 3, { fed: b32(0xfd) })]);
  assert.equal((await count({ chain: theirs.chain, offers: theirs.offers })).bonded, 2);
});

// THE NEWEST ADVERTISEMENT COUNTS (§5A.2; 2026-09-28, the advertisement-update letter: "the page guardian-bond
// check: same newest-update rule as the census"). Three bonds name keys the federation no longer holds - the refound
// gave every guardian a new one - and each node's signed update names its new key: the page counts the new keys, the
// same bonds. An update signed by anybody else, or mined below its bond, is refused by name and the bond's own
// advertisement stands.
test('updates signed by the bonds\' own nodes replace their guardian keys; a forged or older-than-bond one does not', async () => {
  const stale = [1, 2, 3].map((n) => bondOf(n, 10 + n));             // keys 11, 12, 13: not the federation's
  const bondTxid = (tx) => parseTransaction(tx).txid;
  const updateOf = (n, g, { signer = node(n).secret, bond } = {}) => {
    const a = { ...advertFor(node(n).pubkey, [{ federationId: FED, guardianKey: key(g) }]), timestamp: 1790000000000n };
    return advertUpdateTransaction(a, { bondTxid: bondTxid(bond), signature: schnorr.sign(advertId(a), signer), previousTxid: b32(0xb0 + n) });
  };
  const chainWith = (bonds, updates) => {
    const chain = [BITCOIN_MAINNET_GENESIS_HEADER];
    const put = (transaction) => {
      const sibling = b32(0x98);
      chain.push(blockOf(hash256, [parseTransaction(transaction).txid, sibling], { previous: blockHashOf(chain.at(-1)) }).header);
      return { transaction, branch: [sibling], position: 0 };
    };
    const offers = bonds.map(put);
    const ups = updates.map((u) => (u ? put(u) : null));
    for (let i = 0; i < 6; i++) chain.push(blockOf(hash256, [b32(0xe0 + i)], { previous: blockHashOf(chain.at(-1)) }).header);
    return { chain, offers: offers.map((o, i) => (ups[i] ? { ...o, update: ups[i] } : o)) };
  };

  const before = chainWith(stale, [null, null, null]);
  assert.equal((await count(before)).bonded, 0, 'the bonds as posted name no key of this federation');

  const after = chainWith(stale, stale.map((b, i) => updateOf(i + 1, i + 1, { bond: b })));
  const got = await count(after);
  assert.equal(got.ok, true, got.why);
  assert.equal(got.bonded, 3, 'the same three bonds, counted under their updated keys');
  assert.deepEqual(got.refused, []);

  const forged = chainWith(stale, [updateOf(1, 1, { bond: stale[0] }), updateOf(2, 2, { bond: stale[1], signer: node(9).secret }),
    updateOf(3, 3, { bond: stale[2] })]);
  const f = await count(forged);
  assert.equal(f.bonded, 2);
  assert.match(f.refused.join('\n'), /bond 1: its update is not applied - the update is not signed by the bond's node key/);

  // an update mined BELOW its bond: the update block first, then the bond
  const u1 = updateOf(1, 1, { bond: stale[0] });
  const chain = [BITCOIN_MAINNET_GENESIS_HEADER];
  const put = (transaction) => {
    chain.push(blockOf(hash256, [parseTransaction(transaction).txid, b32(0x97)], { previous: blockHashOf(chain.at(-1)) }).header);
    return { transaction, branch: [b32(0x97)], position: 0 };
  };
  const up = put(u1); const bond = put(stale[0]);
  for (let i = 0; i < 6; i++) chain.push(blockOf(hash256, [b32(0xd0 + i)], { previous: blockHashOf(chain.at(-1)) }).header);
  const early = await count({ chain, offers: [{ ...bond, update: up }] });
  assert.match(early.refused.join('\n'), /bond 0: its update is not applied - the update is older than its bond/);
});
