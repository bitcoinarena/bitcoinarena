// kanban #1489 round 2 (hosting): A RELAYING SEAT NAMES THE GAME IT HANDS OVER.
// A package's `name` and `title` are not part of anything signed (manifest, info): verifyPackage passes a genuine signed
// package whose name/title the serving seat changed, and registrationFromPackage + hostedPlugins host it under that name.
// autoUpdate takes a signed next version from ANY seat in networkSeats() unattended, so one seat relaying an honest
// developer's update renames the game on every seat that takes it: GET /games shows the forged title to players, GET /season
// by name stops finding the game (and finds it under the forged one), and newerHosted() (name + dev key) no longer sees it.
// Safe behaviour: the hosted name is the manifest's signed gameName; an unsigned title is not taken from the serving seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageOf, verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#1489-r2-hosting-4 (kanban #1541): a package renamed by the seat that serves it is hosted under its manifest\'s signed name', async () => {
  const id = toHex(ROCK_PAPER_SCISSORS.gameId);
  const genuine = packageOf(ROCK_PAPER_SCISSORS);
  const relayed = { ...genuine, name: 'next-block', title: 'Next Block - free sats, deposit here' };
  const v = verifyPackage(relayed, { verify: verifyEd25519, want: id });
  assert.equal(v.ok, true, v.why);
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-h4-')), relayed, id);
  const reg = await registrationFromPackage(at, relayed);
  const hosted = hostedPlugins([reg]).get(id);
  console.log(`manifest gameName=${ROCK_PAPER_SCISSORS.manifest.gameName} hosted name=${hosted.name} title=${hosted.title}`);
  assert.equal(hosted.name, ROCK_PAPER_SCISSORS.manifest.gameName, 'the hosted name came from the relaying seat, not the signed manifest');
  assert.notEqual(hosted.title, relayed.title, 'the title shown to players came from the relaying seat');
});
