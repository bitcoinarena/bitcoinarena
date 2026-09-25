// A SIGNER NODE OPENS ONLY A ROUND ON A CORE AND CONFIG IT RUNS, AND A RESULT NAMES THE CORE THAT REPLAYED
// (M3 R1 step B; the owner 2026-09-15 08:07: "each round names its sim_wasm_hash and its game_config/
// config_hash. Signer nodes replay what that round names").
//
// Before step B every round was replayed by the one truck core whatever it named, and a result
// took the contract's simCoreHash as its own - a signer node could sign "core X" over a replay of core Y.
// Now the signer node's registry (cores.js installedCores: the truck always, and every core its operator
// installs) resolves the round's (simCoreHash, configHash); a pair it does not hold is refused at
// the door (27A.7.5: not selectable - it serves nothing there, and is not slashed); and resultFrom
// refuses a replay that ran another core than the round names.
// A FREE ROUND (RULED the owner 2026-09-25): nothing this file asserts depends on the stake, and a paying round opens only
// on a signer node that reaches a federation now.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFrom } from '../src/verdict.js';
import { TRUCK, TRUCK_CORE_HASH, TRUCK_CONFIG_HASH, coreForRound, installedCores } from '../src/cores.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

test('the signer node door opens a round on the truck\'s own core and config, and refuses an unknown core or a config it does not run - by name, nothing stored', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const nodes = [d.round.pubkey, b32(0x33)];
    const post = async (c) => {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      return { status: r.status, why: (await r.text()).trim(), held: (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(c))}`)).status };
    };
    const truck = { ...contractFor(nodes, 3000n, ['wss://r.example']), simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_CONFIG_HASH, stakeMsat: 0n };
    const unknownCore = await post({ ...truck, simCoreHash: b32(1) });
    const otherConfig = await post({ ...truck, configHash: b32(0x43) });
    const opened = await post(truck);
    console.log('  FACTS:', JSON.stringify({ unknownCore: { ...unknownCore, why: unknownCore.why.slice(0, 110) },
      otherConfig: { ...otherConfig, why: otherConfig.why.slice(0, 110) }, truck: { status: opened.status, held: opened.held } }));
    assert.equal(unknownCore.status, 409);
    assert.match(unknownCore.why, /this signer node holds no core 0101010101010101: it is not selectable for that round \(27A\.7\.5\)/);
    assert.equal(unknownCore.held, 404, 'a round on an unknown core exists on the signer node');
    assert.equal(otherConfig.status, 409);
    assert.match(otherConfig.why, /runs btc-logistics truck but not the config 4343434343434343/);
    assert.equal(otherConfig.held, 404);
    assert.equal(opened.status, 201, opened.why);
    assert.equal(opened.held, 200);
  } finally { await d.close(); }
});

test('the registry resolves a round by both hashes, holds the truck always, and takes an operator\'s cores beside it', () => {
  const round = { simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_CONFIG_HASH };
  const got = coreForRound(round);
  assert.equal(got.ok, true, got.why);
  assert.equal(got.core, TRUCK);
  const other = { name: 'a second title', hash: 'ab'.repeat(32), url: 'file:///nowhere', adapter: TRUCK.adapter, configs: new Map([['cd'.repeat(32), {}]]) };
  const both = installedCores([other]);
  assert.deepEqual([...both.keys()].sort(), [TRUCK.hash, other.hash].sort());
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: Uint8Array.from(Buffer.from('cd'.repeat(32), 'hex')) }, both).core, other);
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: TRUCK_CONFIG_HASH }, both).ok, false,
    'a core was run under a config it does not carry');
  assert.equal(coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(other.hash, 'hex')), configHash: TRUCK_CONFIG_HASH }).ok, false,
    'a signer node that installed no second core ran one');
});

test('a result names the core that replayed the run, and one whose replay ran another core than the round names is refused', () => {
  const contract = { ...contractFor([b32(4), b32(5)], 3000n), simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_CONFIG_HASH };
  const rid = roundId(contract);
  const entry = { roundId: rid, playerPubkey: b32(7) };
  const transcript = { roundId: rid, entryId: b32(9), hash: b32(0x11) };
  const answer = { ok: true, outcome: 'DELIVERED', score: 5, coreHash: TRUCK.hash };
  const good = resultFrom({ answer, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(good.ok, true, good.why);
  assert.equal(toHex(good.result.simCoreHash), TRUCK.hash);
  const other = resultFrom({ answer: { ...answer, coreHash: 'ab'.repeat(32) }, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(other.ok, false);
  assert.match(other.why, /that run was replayed under core abababababababab, not the core/);
  const unnamed = resultFrom({ answer: { ...answer, coreHash: undefined }, contract, entry, transcript, entryId: b32(9), nodePubkey: b32(8) });
  assert.equal(unnamed.ok, false, 'a replay that names no core was signed');
});
