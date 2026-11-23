// Audit hosting r3-1: a Next Block version taken from the App Store / another seat (GET /plugin -> adoptPackage: verifyPackage,
// installPackage, registrationFromPackage, hostedPlugins) is hosted with every config as {}: the package carries config hashes only,
// so the config's worldShared flag (truck-cores.js CURRENT_CONFIG) is lost and the seat replays a shared-world round with each
// player's own seed - not the world the player's page (known-games sharedWorld) played.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest } from '../../arena-protocol/src/manifest.js';
import { worldSeedWord } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { hostedPlugins } from '../src/plugins.js';
import { packageOf, verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { GAME as NEXTBLOCK_V8 } from '../../nextblock/plugin/nextblock-v8.js';

const CHAIN = [];
for (const f of ['nextblock', 'nextblock-v2', 'nextblock-v3', 'nextblock-v4', 'nextblock-v5', 'nextblock-v6', 'nextblock-v7']) CHAIN.push((await import(`../../nextblock/plugin/${f}.js`)).GAME);

test('audit hosting r3-1: Next Block v8 taken as a package keeps the shared world its built-in registration plays', async () => {
  const builtIn = hostedPlugins([...CHAIN, NEXTBLOCK_V8], { log: () => {} }).get(toHex(NEXTBLOCK_V8.gameId));
  const SHARED = '2170f25079f5652ba0633f4b44032c1c9b4dac094e6df99dd001e74b5586293d';
  assert.deepEqual([...builtIn.sharedWorld], [SHARED], 'the built-in registration plays config 2170f250 as one world');
  assert.deepEqual(sharedWorldOf(NEXTBLOCK_V8.gameId), [SHARED], 'the player page plays it as one world too');

  // what GET /plugin serves, and what adoptPackage (owner install, or the unattended autoUpdate sweep) does with it
  const game = toHex(NEXTBLOCK_V8.gameId);
  let pkg = packageOf(builtIn, { ancestors: CHAIN.map((g) => g.manifest) });
  assert.ok(pkg, 'the built-in v8 packages');
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: game });
  assert.equal(v.ok, true, v.why);
  const signedCores = decodeManifest(fromHex(String(pkg.manifest))).cores;
  pkg = { ...pkg, cores: pkg.cores.map((c) => { const m = signedCores.find((s) => toHex(s.hash) === c.hash); return { ...c, configs: m ? m.configs.map(toHex) : [] }; }) };
  const dir = mkdtempSync(join(tmpdir(), 'audit-hosting-r3-1-'));
  const at = installPackage(dir, pkg, game, { title: 'Next Block' });
  const reg = await registrationFromPackage(at, pkg, { title: 'Next Block' });
  const adopted = hostedPlugins([reg]).get(game);
  console.log('  MEASURED r3-1:', JSON.stringify({ builtIn: builtIn.sharedWorld, adopted: adopted.sharedWorld,
    configs: [...adopted.cores.values()].map((c) => Object.fromEntries([...c.configs].map(([h, cfg]) => [h.slice(0, 8), cfg]))) }));

  // the consequence in the seat's replay seed (replay.js seedWordOf -> seed.js worldSeedWord): two players of one round
  const contract = { configHash: fromHex(SHARED), censusRoot: new Uint8Array(32).fill(3) };
  const roundId = new Uint8Array(32).fill(7), roundRandomness = new Uint8Array(32).fill(9);
  const entryA = { roundId, joinTick: 0, entryId: new Uint8Array(32).fill(1), playerPubkey: new Uint8Array(32).fill(1), worldSecret: new Uint8Array(32).fill(0x11), worldCommit: new Uint8Array(32).fill(0x21) };
  const seedOf = (sw, e) => { try { return worldSeedWord({ entry: e, roundRandomness, contract, roundId, sharedWorld: [...sw] }); } catch (err) { return `throws: ${err.message}`; } };
  console.log('  MEASURED r3-1 seed of one entry:', JSON.stringify({ builtIn: seedOf(builtIn.sharedWorld, entryA), adopted: seedOf(adopted.sharedWorld, entryA) }));

  assert.deepEqual([...adopted.sharedWorld], [...builtIn.sharedWorld],
    'a seat hosting the same signed version from a package must replay its rounds in the same world as a seat hosting it built in');
});
