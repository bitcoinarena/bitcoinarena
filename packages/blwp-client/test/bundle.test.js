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
import { schnorr } from '@noble/curves/secp256k1.js';

import { Client as ModuleClient, markState as moduleMark } from '../src/client.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { checkpointId, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { reach as moduleReach } from '../src/directory.js';
import { advertId, encodeAdvert, joinSignedAdvert } from '../../protocol/src/advert.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const require = createRequire(import.meta.url);
const bundled = require('../dist/blwp-client.js');
const core = require('../../core/dist/blwp-core.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const key = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, key);

const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
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
    roundId: roundId(c), playerPubkey: b32(5), sessionPubkey: schnorr.getPublicKey(key),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
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

/**
 * DISCOVERY IN THE BUNDLE, because the bundle is the only copy the browser has.
 *
 * The jslib calls `endpointFor` on this object to decide where to talk. If the
 * bundled copy answered differently from the modules - or, worse, threw and
 * left the page to fall back on an address of its own - the tests above would
 * still pass and the game would still connect, to whoever the page preferred.
 */
test('the bundle proves an endpoint exactly as the modules do', () => {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const secret = ed25519.utils.randomSecretKey();
  const nodePubkey = schnorr.getPublicKey(secret);
  const advert = {
    nodePubkey, operatorId: 'somebody', protocolVersions: [1],
    roles: ['game', 'verify'], endpoint: 'wss://node.example:443', region: 'eu-west',
    capacityClass: 2, softwareHash: b32(3), settlementCapabilities: 0,
    lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
    bondScriptTemplateVersion: 1, payoutPubkey: b32(4), guardianOf: [], timestamp: 1788700000000n,
  };
  const signed = (a) => bondTransaction(a, { signature: schnorr.sign(advertId(a), secret) });
  const transaction = signed(advert);
  const sibling = b32(0x99);
  const first = blockOf(hash256, [b32(0x01)]).header;
  const { header } = blockOf(hash256, [parseTransaction(transaction).txid, sibling],
    { previous: blockHashOf(first) });
  const discovery = {
    chains: [[first, header]], transaction, branch: [sibling], position: 0,
    committee: [nodePubkey],
  };

  assert.equal(bundled.reach(discovery).endpoint, moduleReach(discovery).endpoint);
  assert.equal(bundled.endpointFor(discovery), 'https://node.example:443');

  // the committee is checked in the bundle too, not only in the modules
  assert.throws(() => bundled.endpointFor({ ...discovery, committee: [b32(0x77)] }),
    /which is not on this round's committee/);

  // and the swap is refused in the bundle too, by the same name
  const swapped = { ...advert, endpoint: 'wss://somewhere-else.example:443' };
  const bare = { ...discovery, transaction: bondTransaction(advert, { body: new Uint8Array(0) }) };
  const at = blockOf(hash256, [parseTransaction(bare.transaction).txid, sibling],
    { previous: blockHashOf(first) });
  bare.chains = [[first, at.header]];
  const courier = joinSignedAdvert(encodeAdvert(swapped), schnorr.sign(advertId(swapped), secret));
  assert.throws(() => bundled.endpointFor({ ...bare, signedAdvert: courier }),
    /commits to a different advertisement/);
});
