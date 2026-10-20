// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEPOSIT AN EARLIER PAGE LEFT IS FINISHED WHEREVER THE WALLET OPENS (kanban #547). Measured 2026-10-20 01:0xZ on live UI 251: 99 sat
// paid while the page that made the invoice was closed never arrived - only the lobby's own wallet resumed pending deposits, and the
// Up/Down market opened its wallet another way. The page's ARENA_KEEP_WALLET, run on stubs: every kept wallet resumes its federation's
// pending deposits once per page, and a claimed one reads the balance again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = HTML.indexOf('      const RESUMED = new Set();');
const SRC = HTML.slice(at, HTML.indexOf('\n      };\n', at) + 9);

function page() {
  const resumed = [], reads = [];
  const window = { ARENA_WALLETS: new Map(), ARENA_READ_BALANCE: () => reads.push(1) };
  const BLWPCLIENT = { fromHex: (h) => Buffer.from(h, 'hex'),
    resumeDeposits: (o) => { resumed.push(o); return Promise.resolve(); } };
  new Function('window', 'BLWPCLIENT', 'vault', 'paintHistory', SRC)(window, BLWPCLIENT, () => 'store', () => {});
  return { window, resumed, reads };
}

test('a kept wallet resumes its federation\'s pending deposits once per page, whoever opened it', () => {
  const { window, resumed } = page();
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  window.ARENA_KEEP_WALLET(A, { id: 'wallet A' });
  window.ARENA_KEEP_WALLET(A.toUpperCase(), { id: 'wallet A again' });
  window.ARENA_KEEP_WALLET(B, { id: 'wallet B' });
  assert.equal(resumed.length, 2, 'once per federation');
  assert.equal(resumed[0].client.id, 'wallet A');
  assert.equal(resumed[0].storage, 'store');
  assert.equal(Buffer.from(resumed[1].federationId).toString('hex'), B);
  assert.equal(window.ARENA_WALLETS.get(A).id, 'wallet A again', 'the newest client is the kept one');
});

test('a deposit claimed this way reads the balance again', () => {
  const { window, resumed, reads } = page();
  window.ARENA_KEEP_WALLET('cc'.repeat(32), {});
  resumed[0].onClaimed({ amountMsat: 99000n });
  assert.equal(reads.length, 1);
});

test('the lobby\'s wallet is kept through the same door (no second resume of its own)', () => {
  assert.equal((HTML.match(/BLWPCLIENT\.resumeDeposits\(/g) || []).length, 1, 'one place resumes deposits');
  assert.match(HTML, /if \(window\.ARENA_KEEP_WALLET\) window\.ARENA_KEEP_WALLET\(fed, client\);/);
});
