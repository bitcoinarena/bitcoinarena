// A PAYING ROUND ON A CORE THIS CLIENT DOES NOT KNOW GETS NO STAKE AND NO SIGNER NODE
// (§5, v4.6; F2's second clause). Measured before this: `stakeFor` and
// `entryFor` never looked at `simCoreHash`, and every launcher wrote b32(1) -
// a core that does not exist - so a creator could publish a round on any core
// and the page would deal a stake into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { stakeFor, entryFor, playerFor } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { fromHex } from '../../protocol/src/hash.js';
import { coreHashHex } from '../../core/tools/hash-core.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const CORE = fromHex(coreHashHex());
const UNKNOWN = b32(1);            // what every launcher used to write
const seed = b32(0x5e);
const paying = (simCoreHash) => ({ id: b32(0x21), stakeMsat: 100000n, settlementSlots: 7, simCoreHash });
const signerNodes = () => Array.from({ length: 7 }, () => schnorr.getPublicKey(rand(32)));
const keyFor = (round) => playerFor(round, { seed, curve: feldmanGroup }).pubkey;

test('stakeFor deals no stake into a paying round on an unknown core', async () => {
  const round = paying(UNKNOWN);
  await assert.rejects(() => stakeFor(round, { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) }),
    /not on this client's known-good list/);
  await assert.rejects(() => stakeFor({ ...round, simCoreHash: undefined },
    { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) }), /names no 32-byte core hash/);
});

test('entryFor joins nobody at a paying round on an unknown core', () => {
  assert.throws(() => entryFor(paying(UNKNOWN), { seed, curve: feldmanGroup, random: rand }),
    /not on this client's known-good list/);
});

test('the listed core signer nodes, stake and all', async () => {
  const round = paying(CORE);
  const stake = await stakeFor(round, { signerNodes: signerNodes(), curve: feldmanGroup, random: rand, playerPubkey: keyFor(round) });
  const signerNode = entryFor(round, { seed, curve: feldmanGroup, random: rand, stake });
  assert.deepEqual(signerNode.stakeCommitment, stake.stakeCommitment);
  assert.deepEqual(signerNode.playerPubkey, keyFor(round));
});

test('a free round risks nothing and is joined whatever core it names', () => {
  const free = { id: b32(0x22), stakeMsat: 0n, simCoreHash: UNKNOWN };
  assert.equal(entryFor(free, { seed, curve: feldmanGroup, random: rand }).stakeMsat, 0n);
});
