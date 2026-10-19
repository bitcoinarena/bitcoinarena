#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The arenanode command (kanban #499): the installer writes a small script that runs this with the node's home, so the user types only
// `arenanode status`, `arenanode restart lnd`, `arenanode doctor` (src/arenanode.js).
const args = process.argv.slice(2);
const at = args.indexOf('--home');
const home = at >= 0 ? args[at + 1] : null;
const name = (() => { const i = args.indexOf('--name'); return i >= 0 ? args[i + 1] : 'arenanode'; })();
const rest = args.filter((_, i) => ![at, at + 1].includes(i) && !(args[i] === '--name' || args[i - 1] === '--name'));
// the home's arena.conf names this node's instance: instance.js reads it from --home before the service names are made
const { main } = await import('../src/arenanode.js');
const { defaultHome } = await import('../src/state.js');
const { latestReleaseReader } = await import('../../arena-node/src/release-latest.js');
const { sumsSigned } = await import('../src/release-verify.js');
const reader = latestReleaseReader({ verify: sumsSigned });
const code = await main(rest, { home: home || defaultHome(), name, deps: { latest: (own) => reader.read(own) } });
// handles still closing close first (arena-install.mjs measured a libuv abort on Windows at an immediate exit)
setTimeout(() => process.exit(code), process.platform === 'win32' ? 1500 : 50);
