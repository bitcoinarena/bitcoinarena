// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME'S SIGNED DESCRIPTION AND WEBSITE, WRITTEN BESIDE ITS PLUGIN (kanban #276). Run by the game's developer with the dev
// client's key; writes only public bytes - the two strings and the signature - as <plugin dir>/info.js, which the plugin
// carries as `info`. The game id is the manifest's and does not change. A third string, the developer's Lightning address
// (kanban #362 item 14), is where the page's "Tip the developer" pays; left out, the digest is the one without it.
//   node packages/arena-donor/bin/sign-game-info.mjs <dev dir> <plugin module> "<description>" "<website>" ["<name@host>"]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { gameDevKey } from '../src/manifest-sign.js';
import { signGameInfo } from '../src/game-info-sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const [devDir, pluginPath, description = '', website = '', lightning = ''] = process.argv.slice(2);
if (!devDir || !pluginPath) { console.error('usage: sign-game-info.mjs <dev dir> <plugin module> "<description>" "<website>" ["<name@host>"]'); process.exit(2); }
const mod = await import(resolve(pluginPath));
const game = mod.GAME || mod.default || Object.values(mod).find((v) => v && v.gameId && v.manifest);
if (!game) throw new Error(`${pluginPath} exports no game`);
const dev = gameDevKey(readFileSync(join(devDir, 'game-dev.pkcs8')));
const info = signGameInfo({ gameId: game.gameId, manifest: game.manifest, description, website, lightning }, dev);
const out = join(dirname(resolve(pluginPath)), 'info.js');
writeFileSync(out, `// ${game.title || game.name}'s description and website, signed by its developer key (kanban #276; arena-donor/bin/sign-game-info.mjs).\n`
  + `// Beside the manifest, not in it: game ${toHex(game.gameId).slice(0, 8)} keeps its id.\nexport const INFO = Object.freeze(${JSON.stringify(info, null, 2)});\n`);
console.log(JSON.stringify({ game: toHex(game.gameId).slice(0, 8), out, ...info }));
