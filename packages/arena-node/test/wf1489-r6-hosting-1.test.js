// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (hosting): A RELAYING SEAT CHOOSES THE CONFIGS AN INSTALLED GAME RUNS (bypass of #1541).
// #1541 stopped a relaying seat from renaming a genuine signed package: name and title are no longer taken from it. But each
// core's `configs` list in a package is just as unsigned, and registrationFromPackage installs the core with exactly the
// configs the package lists. autoUpdate takes a signed next version from any network seat, unattended. One seat that hands
// the honest developer's next version with `configs: []` makes every seat that takes it host that version with no config:
// every round of it is then refused ("runs ... but not the config that round names"), the package is kept on disk that way,
// and the next start loads it the same - autoUpdate never takes it again (it is hosted). A config the manifest does not
// list instead throws out of adoptPackage (hostedPlugins) after the package was written.
// Safe behaviour: an installed core runs the configs its signed manifest lists for it, whatever the package says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageOf, verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins, coreOfGame } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);

test('#1489 r6 hosting-1: a package whose relaying seat emptied a core\'s configs still installs the configs its manifest signs', async () => {
  const honest = packageOf(ROCK_PAPER_SCISSORS);
  const listed = ROCK_PAPER_SCISSORS.manifest.cores[0].configs.map(toHex);
  assert.ok(listed.length >= 1, 'the signed manifest lists a config');
  const relayed = { ...honest, cores: honest.cores.map((c) => ({ ...c, configs: [] })) };
  const v = verifyPackage(relayed, { verify: verifyEd25519, want: RPS_ID });
  assert.equal(v.ok, true, 'every check passes: configs are signed by nobody');
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r6-h1-'));
  const at = installPackage(dir, relayed, RPS_ID);
  const reg = await registrationFromPackage(at, relayed);
  const hosted = hostedPlugins([reg]).get(RPS_ID);
  const [core] = [...hosted.cores.values()];
  // a round on the game's own (signed) config
  const contract = { simCoreHash: fromHex(core.hash), configHash: fromHex(listed[0]) };
  const r = coreOfGame(contract, hosted);
  assert.deepEqual([...core.configs.keys()].sort(), [...listed].sort(), `the installed core runs ${JSON.stringify([...core.configs.keys()])}, the manifest signs ${JSON.stringify(listed)}`);
  assert.equal(r.ok, true, r.why);
});

test('#1489 r6 hosting-1: a config the relaying seat added is not a reason to fail the install after the package was written', async () => {
  const honest = packageOf(ROCK_PAPER_SCISSORS);
  const relayed = { ...honest, cores: honest.cores.map((c) => ({ ...c, configs: [...c.configs, 'ee'.repeat(32)] })) };
  assert.equal(verifyPackage(relayed, { verify: verifyEd25519, want: RPS_ID }).ok, true);
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r6-h1b-'));
  const at = installPackage(dir, relayed, RPS_ID);
  const reg = await registrationFromPackage(at, relayed);
  let hosted = null, err = null;
  try { hosted = hostedPlugins([reg], { log: () => {} }).get(RPS_ID); } catch (e) { err = e.message; }
  assert.equal(err, null, `adoptPackage would throw here (autoUpdate's sweep ends): ${err}`);
  assert.ok(hosted);
});
