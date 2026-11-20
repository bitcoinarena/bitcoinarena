// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s3: a signed tree package from a list of [path, text] files (shared by the s3 tests)
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { treeHashHex } from '../src/plugin-check.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';

export const DRAW = "export const DECIDE = { name: 'draw', decide(moves) { const out = {}; for (const x of moves) out[x.key] = 'DRAW'; return out; } };\n";
export function treePackage(word, FILES) {
  const HASH = treeHashHex(FILES.map(([path, t]) => ({ path, bytes: new TextEncoder().encode(t) })));
  const g = testHeadToHeadGame({ name: word, core: { name: word, hash: HASH, configs: new Map([['cc'.repeat(32), {}]]) }, dev: `${word}-dev` });
  const pkg = { format: 'arena-plugin/v1', name: word, manifest: toHex(encodeManifest(g.manifest)), ancestors: [],
    donationSet: testDonationSet(`${word}-dev`).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: HASH, name: word, configs: ['cc'.repeat(32)], entry: 'adapter.js', files: FILES.map(([path, t]) => ({ path, body: Buffer.from(t).toString('base64') })) }], clients: [] };
  return { pkg, gameId: toHex(g.gameId) };
}
