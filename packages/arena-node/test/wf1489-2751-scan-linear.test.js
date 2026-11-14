// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 7 (hosting): THE PACKAGE SCAN IS QUADRATIC, ON THE SEAT'S OWN THREAD.
// plugin-check.js scanSource runs SCAN_RULES over every core's source before the trial run - synchronously, in the node's
// own thread (adoptPackage -> verifyPackage -> checkPackage), and again in loadInstalled at every start. Its first rule has
// the branch /^\s*import\s[^;]*\bfrom\b/m: at every line that starts with `import `, `[^;]*` runs to the next ';' (or the
// end of the text) and then backtracks one character at a time looking for `from`. A core whose text is many lines of
// `import a` with no ';' and no `from` (a comment block is enough - the scan reads comments) costs O(lines x length).
// The trial's deadline (TRIAL_MS), the core thread and the RSS backstop do not apply: the scan runs before them, in the seat's
// thread. The developer of a hosted game signs a next version whose core carries such a comment; autoUpdate (always on) takes
// it from any network seat unattended and every seat hosting the game holds its event loop - hours for the 32 MB a package
// may be. Safe behaviour: checking a package spends time linear in its size; a few hundred kB of source is checked in well
// under a second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkPackage, scanSource } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
}
const honest = 'export const DECIDE = { name: "x", decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };\n';

test('#1489-r7-hosting-1: a signed package\'s scan takes time linear in its core\'s size, not quadratic, on the seat\'s thread', () => {
  const timed = (lines) => {
    const src = honest + '/*\n' + 'import a\n'.repeat(lines) + '*/\n';
    assert.equal(scanSource(src).length, 0, 'the crafted core passes the scan (no rule matches it)');
    const pkg = pkgOf(src, { name: `scan-${lines}` });
    const t0 = Date.now();
    const r = checkPackage(pkg, { verify: verifyEd25519 });
    const ms = Date.now() - t0;
    console.log(`checkPackage of a ${Math.round(src.length / 1024)} kB core (${lines} lines of "import a"): ok=${r.ok}, ${ms} ms on this thread`);
    assert.equal(r.ok, true, r.why || '');
    return { ms, kb: Math.round(src.length / 1024) };
  };
  const small = timed(5000);
  const big = timed(40000);
  console.log(`8x the lines took ${(big.ms / Math.max(1, small.ms)).toFixed(1)}x the time`);
  assert.ok(big.ms < 1000, `checkPackage held the seat's thread ${big.ms} ms for a ${big.kb} kB core: the scan is quadratic in the source (a 32 MB package holds it for hours)`);
});

// kanban #2751: the linear finder answers what /^\s*import\s[^;]*\bfrom\b/m answered, on small sources where the old pattern is cheap
test('#2751: importFromAt finds what the old import-from pattern found', async () => {
  const { importFromAt } = await import('../src/plugin-check.js');
  const old = /^\s*import\s[^;]*\bfrom\b/m;
  const cases = ["import x from 'y';", "  import {a,\n b} from 'z'", 'import a\nimport b', 'import a; from', '// import a\nconst from = 1', 'imports from x',
    'x = 1;\nimport * as m from "m"', 'import\tq\n\nfrom', 'const s = "import a from b"', 'import a;\nimport b from c', 'import afrom b', ''];
  for (const c of cases) assert.equal(importFromAt(c) >= 0, old.test(c), JSON.stringify(c));
});
