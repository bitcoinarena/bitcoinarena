// THE BUNDLE IS THE SAME CLIENT, or it is not the client.
//
// The page cannot import ES modules from a .jslib, so the browser runs a
// concatenated build while every test here runs the modules. If those two ever
// differ, the thing that signs a player's commitments in a browser is not the
// thing anybody tested - and the difference would show up as a signature over
// bytes nobody can reproduce, at settlement, months later.
//
// `@blwp/core` has exactly this test for exactly this reason. This one holds
// the client to the same bar: the same ids, the same bytes, the same refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';

import { Client as ModuleClient, markState as moduleMark } from '../src/client.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { checkpointId, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const require = createRequire(import.meta.url);
const bundled = require('../dist/blwp-client.js');
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const key = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, key);

const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});

test('the bundle exports what a page needs to open a round', () => {
  for (const name of ['Client', 'markState', 'GENESIS', 'NO_PREVIOUS',
                      'encodeRoundContract', 'roundId', 'encodeEntryContract',
                      'entryId', 'toHex', 'fromHex']) {
    assert.ok(bundled[name], `the bundle does not export ${name}`);
  }
  assert.equal(typeof bundled.Client, 'function');
});

test('the bundle and the modules name a round and an entry identically', () => {
  const c = contract();
  assert.equal(toHex(bundled.roundId(c)), toHex(roundId(c)));

  const e = {
    roundId: roundId(c), playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(key),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  };
  assert.equal(toHex(bundled.entryId(e)), toHex(entryId(e)));
});

/**
 * The one that matters: the same mark, over the same state, signed the same
 * way, must come out as the same id and the same bytes. A player's commitment
 * is that id; if the two builds disagreed about it, a browser would be signing
 * something no verifier could reproduce.
 */
test('the bundle builds the same signed mark as the modules, byte for byte', async () => {
  const st = core.init(7);
  for (let t = 0; t < 120; t++) core.step(st, 45875, 0, 0, 0);

  const where = {
    roundId: b32(1), entryId: b32(2), tick: 120,
    previousHash: NO_PREVIOUS, inputChainHash: GENESIS,
  };
  const fromModules = await moduleMark(core, st, where, sign);
  const fromBundle = await bundled.markState(core, st, where, sign);

  assert.equal(toHex(fromBundle.id), toHex(fromModules.id), 'the two builds name the mark differently');
  assert.deepEqual(fromBundle.bytes, fromModules.bytes, 'the two builds put different bytes on the wire');
  assert.equal(toHex(fromModules.id), toHex(checkpointId(fromModules.checkpoint)));
});

/**
 * And the refusals travel too. A bundle that dropped a check would be a
 * quietly weaker client in exactly the place a browser runs it.
 */
test('the bundle refuses a receipt the modules would refuse', () => {
  const one = new bundled.Client({ base: 'http://nowhere', core, sign, verify: () => true });
  const other = new ModuleClient({ base: 'http://nowhere', core, sign, verify: () => true });
  one.nodes = [b32(4)];
  other.nodes = [b32(4)];

  const said = (c) => { try { c.readReceipt(new Uint8Array(100), b32(3)); return null; }
                        catch (e) { return e.message; } };
  const a = said(one), b = said(other);
  assert.ok(a, 'the bundle accepted a 100-byte receipt');
  assert.equal(a, b, 'the two builds refuse with different words');
});
