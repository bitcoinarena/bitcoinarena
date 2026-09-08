// THE BYTES C# READS, DRIVEN HERE.
//
// `blwp.jslib` is the file `node --test` cannot load, and that is not a small
// thing: the session's state word lived in it, was wrong on the socket-up VOID
// path, and survived an audit that was looking straight at it. The word has
// moved into the client where the other tests read it - and what is left here
// is the boundary itself, the three exports the game calls.
//
// So they are evaluated. The file is one `mergeInto(LibraryManager.library,
// {...})` call, which is an object literal: given a `mergeInto` that keeps
// what it is handed, every export becomes an ordinary function this file can
// call with a real `Client` behind it. Nothing is mocked that matters - the
// client is a real one against a real node, and what is stubbed is Emscripten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { Client } from '../src/client.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const JSLIB = new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url);

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FUNDED = { funded: () => true };

/** The exports, and the fake heap they write into. */
function bridge() {
  const Module = { HEAPU8: new Uint8Array(4096) };
  let library = null;
  const load = new Function(
    'mergeInto', 'LibraryManager', 'Module', 'UTF8ToString', 'window',
    readFileSync(JSLIB, 'utf8'));
  load((_target, obj) => { library = obj; }, { library: {} }, Module,
       () => '', { location: { search: '' } });
  const read = (fn, cap = 512) => {
    const n = fn(0, cap);
    return { n, text: Buffer.from(Module.HEAPU8.subarray(0, n)).toString('utf8') };
  };
  return { Module, library, read };
}

async function playing() {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  const client = new Client({ base: `http://127.0.0.1:${node.port}`, core, sign, verify });
  const rid = await client.openRound({
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
    custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0), censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
    minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
  });
  const eid = await client.join({
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e),
  });
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: 600 });
  return { node, client };
}

test('the bridge answers nothing at all before a session exists', () => {
  const { library, read } = bridge();
  assert.equal(library.BlwpNetEnded(), 0);
  assert.equal(read(library.BlwpNetEnding).n, 0, 'a run that never started has no ending');
  assert.equal(read(library.BlwpNetStatus).text, 'off');
});

test('a live run tells the game nothing has ended', async () => {
  const { node, client } = await playing();
  const { Module, library, read } = bridge();
  try {
    Module.blwpNet = { seen: 120, client, error: '' };
    assert.equal(library.BlwpNetEnded(), 0, 'a live run was reported as over');
    const e = read(library.BlwpNetEnding);
    assert.equal(e.n, 0);
    assert.equal(Module.HEAPU8[0], 0, 'and it must leave a terminated empty string');
    assert.match(read(library.BlwpNetStatus).text, /^ready /);
  } finally { client.close(); await node.close(); }
});

/**
 * THE SIGNAL THE GAME ACTS ON, on the path the fault actually takes.
 *
 * The hold fills with the socket still up, `endRun` says VOID, and the close
 * listener returns at its first line because the run is over rather than
 * dropped. Before this, nothing downstream heard: the page kept its own word
 * and only learned `ended` when a reconnect gave up, so a player went on
 * steering a round that could not be settled.
 */
test('a socket-up VOID reaches the bytes C# reads', async () => {
  const { node, client } = await playing();
  const { Module, library, read } = bridge();
  try {
    Module.blwpNet = { seen: 601, client, error: '' };
    for (let i = 0; i < 1200; i++) client.record([45875, 0, 0, 0, 0]);
    assert.equal(client.ended, true, 'the hold should have filled');

    assert.equal(library.BlwpNetEnded(), 1, 'the game was never told the run had ended');

    const e = read(library.BlwpNetEnding);
    assert.match(e.text, /^VOID a tick was dropped at \d+/, 'the word and the reason, both');
    assert.equal(Module.HEAPU8[e.n], 0, 'and it is a terminated string');
    assert.equal(e.text.includes('DELIVERED') || e.text.includes('FAILED'), false,
      'the bridge must repeat the client\'s word, not choose one');

    const line = read(library.BlwpNetStatus).text;
    assert.equal(line.split(' ')[0], 'ended', `the panel still said: ${line}`);
    assert.equal(/(^| )ready( |$)/.test(line), false, `ready printed beside a VOID: ${line}`);
    assert.match(line, /VOID a tick was dropped/);
  } finally { client.close(); await node.close(); }
});

test('the page prints its own word only while there is no client to have one', () => {
  const { Module, library, read } = bridge();
  Module.blwpNet = { seen: 0, client: null, state: 'error', error: 'the node refused the round' };
  const line = read(library.BlwpNetStatus).text;
  assert.equal(line.split(' ')[0], 'error');
  assert.match(line, /\(the node refused the round\)/);
  assert.equal(library.BlwpNetEnded(), 0, 'a session that never opened has not ended');
});
