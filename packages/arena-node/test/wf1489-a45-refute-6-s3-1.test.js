// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 3) of #1814 / #2240 / #2307 - SECOND COPY: the owner page checks a package in the browser with
// its own copy of plugin-check.js, the bundle pages/owner-client.js (owner.html shortCheck -> C.checkPackage, used by the
// Apps panel's Install/Update: NetworkAppsPanel.check). #2240 and #2307 changed src/plugin-check.js only; the bundle was
// not rebuilt. So the page reports "all N checks passed in this browser" for a package that carries one signed core twice
// and drops another, and throws (the card stuck at "checking in this browser...", its button disabled) on `clients: [null]`.
// Safe behaviour: the page's copy answers what the seat's answers - refused, not passed, and never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageOf } from '../src/plugin-package.js';
import { checkPackage as seatCheck } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testGame } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'a45r6s3p-'));
const src = (tag) => `export const DECIDE = { name: 'duo ${tag}', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n`;
function duoGame() {
  const cores = new Map();
  for (const [tag, cfg] of [['a', '22'.repeat(32)], ['b', '33'.repeat(32)]]) {
    const s = src(tag), file = join(srcDir, `decide-${tag}.mjs`); writeFileSync(file, s);
    const hash = sha(Buffer.from(s));
    cores.set(hash, { name: `duo ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) });
  }
  return { ...testGame({ name: 'duo', cores, runTicksMax: 10, dev: 'duo dev', donationSet: testDonationSet('duo') }), clientUrls: [] };
}

test('#1489 a45 refute #1814 s3-1: the owner page\'s package check answers what the seat\'s answers', async () => {
  const page = await import('../pages/owner-client.js');
  const g = duoGame(), id = toHex(g.gameId), honest = packageOf(g);
  const opts = { verify: verifyEd25519, want: id };
  assert.equal(page.checkPackage(honest, opts).ok, true, 'the page passes the honest package');
  for (const [what, relayed] of [['one core twice, the other dropped', { ...honest, cores: [honest.cores[0], honest.cores[0]] }],
    ['a null client entry', { ...honest, clients: [null] }], ['a null core entry', { ...honest, cores: [null, honest.cores[1]] }]]) {
    const seat = seatCheck(relayed, opts);
    assert.equal(seat.ok, false, `the seat refuses ${what}`);
    let r = null, err = null;
    try { r = page.checkPackage(relayed, opts); } catch (e) { err = e.message; }
    assert.equal(err, null, `the owner page's check throws on ${what} (the card stays "checking", its button disabled): ${err}`);
    assert.equal(r.ok, false, `the owner page reports "all checks passed in this browser" for ${what}; the seat refuses it: ${seat.why}`);
  }
});
