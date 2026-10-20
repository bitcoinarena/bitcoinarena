// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HISTORY NAMES A MOVE AS A MOVE, AND SHOWS EVERY FEDERATION (the owner 2026-10-20 18:4xZ: "it doesn't show the complete history. Not sure what the
// -1000 even is" - his 1,000 sat moved out of the CRITICAL b18947f0 into 337ae01a showed "Stake · round undefine · not entered -1,000 sat", and
// only the chip's federation was listed). The page's own row rule, run on rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = HTML.indexOf('        const plus = r.kind === ');
const src = HTML.slice(at, HTML.indexOf("          : String(r.kind || 'entry');", at) + "          : String(r.kind || 'entry');".length);
const doc = { createElement: () => ({ className: '', appendChild() {}, append() {} }) };
const row = (r) => new Function('r', 'sat', 'document', src + '; return { plus, what };')(r, (m) => `${Number(BigInt(m || 0) / 1000n)} sat`, doc);

test('moves and swaps are named, with their sign; a stake stays a stake; nothing unknown becomes a stake', () => {
  assert.deepEqual(row({ kind: 'moved-in', msat: '1000000', from: 'b18947f085d4' }), { plus: true, what: 'Moved in from federation b18947f0' });
  assert.deepEqual(row({ kind: 'moved-out', msat: '1000000', to: '337ae01ad1e9' }), { plus: false, what: 'Moved to federation 337ae01a' });
  assert.deepEqual(row({ kind: 'swapped-in', msat: '100000', from: '4dc88be70830' }), { plus: true, what: 'Swapped in from federation 4dc88be7' });
  assert.equal(row({ kind: 'swapped-out', msat: '100000', feeMsat: '2000', to: '337ae01a' }).what, 'Swapped to federation 337ae01a (fee 2 sat)');
  assert.equal(row({ kind: 'stake', round: 'abcdef0123', entry: null }).what, 'Stake · round abcdef01 · not entered');
  assert.equal(row({ kind: 'something-new' }).what, 'something-new');
});

test('every federation\'s rows are listed, each tagged with its federation when there is more than one', () => {
  assert.match(HTML, /const feds = \[\.\.\.new Set\(\[fed, \.\.\.\(ARENACLIENT\.ledgerFederations \? ARENACLIENT\.ledgerFederations\(st\) : \[\]\)\]\)\];/);
  assert.match(HTML, /what \+ \(feds\.length > 1 \? ' \\u00b7 ' \+ String\(r\.fed\)\.slice\(0, 8\) : ''\)/);
});
