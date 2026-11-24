// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087 (skeptic 3, second copies): the #3087 fix exists twice more, as hand ports - origin/main (d2db0c1bd +
// e851bc3e8) and the 2.0 branch worktree-health-199 (bdffdd82c + fe9313aa2). Neither carries the corrections this chain needed
// (#3095 one row for a claimed lost deposit, #3098 the reissue row written when committed, #3111 the page bundle rebuilt). So on
// both, the page bundle's recordReceived still drops 'returned' (no row: the #368 report unchanged), and the page source still has
// the second plus row in scanLostDeposits' onClaimed and the poll-only reissue row. This checks every copy of the page this
// repository ships; OTHER_TREES (':'-separated tree roots) names them, by default the sibling worktrees of this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const trees = [here, ...(process.env.OTHER_TREES ? process.env.OTHER_TREES.split(':')
  : [here + '-main', here + '-20'])];

// a default sibling (<this tree>-main, <this tree>-20: the author's checkouts of origin/main and the 2.0 branch) that this machine does
// not have is skipped - a ticket worktree has neither; a tree OTHER_TREES names must be there
const named = !!process.env.OTHER_TREES;
for (const tree of trees) {
  const absent = tree !== here && !named && !existsSync(tree + '/src/arena-ui/index.html');
  test(`#3087 in every copy of the page: ${tree.split('/').pop()}`, { skip: absent && `no sibling tree ${tree} here (OTHER_TREES names the copies to check)` }, () => {
    assert.ok(existsSync(tree + '/src/arena-ui/index.html'), `the tree ${tree} is there`);
    const page = readFileSync(tree + '/src/arena-ui/index.html', 'utf8');
    const bundle = readFileSync(tree + '/src/arena-ui/arena-client.js', 'utf8');
    const off = [];
    // #3111: the bundle the page loads keeps a 'returned' row
    const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL, Uint8Array, BigInt, Promise, atob, btoa, queueMicrotask, structuredClone, performance });
    ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
    vm.runInContext(bundle + '\n;globalThis.ARENACLIENT = ARENACLIENT;', ctx);
    const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    const fed = 'ab'.repeat(32);
    ctx.ARENACLIENT.recordReceived(st, fed, { kind: 'returned', msat: '589000', outpoint: 'reissue:' + 'cc'.repeat(32) });
    if (ctx.ARENACLIENT.ledgerRows(st, fed).length !== 1) off.push('the page bundle writes no returned row (#3111)');
    // #3095: a claimed lost deposit already has its deposit row; the page writes no second plus row for it
    const lost = page.slice(page.indexOf('ARENACLIENT.scanLostDeposits('), page.indexOf('ARENACLIENT.scanLostDeposits(') + 1500);
    if (/onClaimed[\s\S]*kind: 'returned'[\s\S]*\.then\(/.test(lost.slice(0, lost.indexOf('.then(') + 6))) off.push('a claimed lost deposit gets a second plus row (#3095)');
    // #3098: the reissue row is written when the reissue is committed, with a stable id, not only inside the 90 s poll
    const start = page.indexOf('if (Number(got.reissuingMsat) > 0) {');
    const block = page.slice(start, page.indexOf('ARENA_NOTE_ARRIVING(f,', start));
    if (!/recordReceived\([^;]*kind: 'returned'[^;]*'reissue:'/.test(block)) off.push('the reissue row is written only from the poll, without its id (#3098)');
    assert.deepEqual(off, []);
  });
}
