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
import { TRUCK_BEFORE_FORK_HASH } from '../src/cores.js';
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
  // THE TRUCK, 2069b4c2 KEPT BESIDE IT (path A, 2026-10-04), THE TRUCK BEFORE THE 82/90 FORK (its old hash: 2069b4c2 held
  // to 10800), and the operator's core.
  assert.deepEqual([...both.keys()].sort(), [TRUCK.hash, '2069b4c2ab39466c79000aac1b091c75b066b814a0952f8037011691538a774e', TRUCK_BEFORE_FORK_HASH, other.hash].sort());
  const old = coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(TRUCK_BEFORE_FORK_HASH, 'hex')), configHash: TRUCK_CONFIG_HASH, blockTicks: 10800 });
  assert.equal(old.ok, true, old.why);
  assert.deepEqual([old.core.hash === TRUCK_BEFORE_FORK_HASH, old.core.fixedRunTicks, old.runTicks], [true, 10800, 10800]);
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

// 2069b4c2 KEPT INSTALLED BESIDE THE TRUCK (the owner 2026-10-04, path A): every round published before C became the bed
// fill and T sank from 20 s names it, and is replayed by it - its frozen source, not the truck that moved on. The pre-fork
// core d15c39bb rides on it too: 2069b4c2 is the core that ran those rounds hash for hash at 10800 ticks.
import { TRUCK_2069, TRUCK_2069_HASH } from '../src/cores.js';
import { CORE as FROZEN_2069 } from '../../core/frozen/2069b4c2/adapter.js';
import { CORE as NOW } from '../../core/src/adapter.js';

test('2069b4c2 rounds are replayed by the frozen 2069b4c2 core, the pre-fork core by it held to 10800, the rest by the truck', () => {
  const at = (hex) => coreForRound({ simCoreHash: Uint8Array.from(Buffer.from(hex, 'hex')), configHash: TRUCK_CONFIG_HASH, blockTicks: 4920 });
  const old = at(TRUCK_2069_HASH);
  assert.equal(old.ok, true, old.why);
  assert.equal(old.core.adapter, FROZEN_2069);
  assert.equal(old.core, TRUCK_2069);
  const pre = at(TRUCK_BEFORE_FORK_HASH);
  assert.equal(pre.core.adapter, FROZEN_2069, 'the pre-fork core is still the truck that moved on');
  assert.equal(pre.core.fixedRunTicks, FROZEN_2069.RUN_TICKS);
  const now = coreForRound({ simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_CONFIG_HASH, blockTicks: 4920 });
  assert.equal(now.core.adapter, NOW);
  assert.notEqual(TRUCK.hash, TRUCK_2069_HASH);
  // and they differ where the rule moved: the same load and drive scores differently under the two
  const drive = (core, loads) => { const st = core.start(0x5eed1234); const ev = core.eventsOf({ loads });
    for (let t = 0; t < 1500; t++) { ev.before(st, t); core.step(st, [65536, 0, 0, 0, 1]); } return core.result(st); };
  const a = drive(FROZEN_2069, [[0, 0, 0]]), b = drive(NOW, [[0, 0, 0, 0]]);
  assert.ok(a.score > 0, `the 2069b4c2 drive scored ${a.score}`);
  assert.equal(b.score, 0, 'an empty bed on the current core scores nothing');
});
