import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract } from '../src/contracts.js';
import { playerSubSeed, seedWordFromSubSeed, seedWordForEntry } from '../src/seed.js';

const b32 = (n) => new Uint8Array(32).fill(n);

test('the world secret survives the entry wire', () => {
  const e = {
    roundId: b32(1), playerPubkey: b32(2), sessionPubkey: b32(3), stakeCommitment: b32(4),
    stakeMsat: 1n, feeMsat: 0n, donationMsat: 0n, joinTick: 50, worldSecret: b32(0x5e),
  };
  const back = decodeEntryContract(encodeEntryContract(e));
  assert.deepEqual(back.worldSecret, e.worldSecret);
  assert.equal(back.joinTick, 50);
});

test('the same entry and randomness make the same seed word', () => {
  const entry = { playerPubkey: b32(2), worldSecret: b32(0x5e), joinTick: 50 };
  const rnd = b32(9);
  const a = seedWordForEntry(entry, rnd);
  const b = seedWordFromSubSeed(playerSubSeed({
    roundRandomness: rnd, playerPubkey: entry.playerPubkey,
    worldSecret: entry.worldSecret, joinTick: 50,
  }));
  assert.equal(a, b);
  assert.equal(typeof a, 'number');
  assert.notEqual(seedWordForEntry({ ...entry, joinTick: 51 }, rnd), a);
});
