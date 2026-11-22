// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086 (skeptic 2): the page's own lookThePending over a fake vault, with the seats' fetch per node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('    async function lookThePending() {');
const b = html.indexOf('    // THE CHAIN\'S TIP FOR THE LINE ABOVE', a);
assert.ok(a > 0 && b > a, 'lookThePending is in the page');
const lift = pageFunction(PAGE, ['ARENACLIENT', 'vault', 'collectSeed', 'collectNote', 'window', 'fetch', 'document', 'paintMoney', 'pendingTip'],
  html.slice(a, b), '; return lookThePending;');

// fetch(url) -> answer(nodeUrl, entryIdHex) gives the body, null (not ok) or a promise
export function pageWith(V, S, answer, { tabSeed } = {}) {
  const said = [];
  const AC = { savedCollects: PL.savedCollects, saveCollect: PL.saveCollect, fromHex, toHex, decodeRoundContract,
    pendingWindowLine: () => '', savedLockExpiration: () => null };
  const win = { sessionStorage: S, ARENA_STAKE_BACK: new Map(), ArenaText: { say() {} } };
  const fetch = (u) => { const url = new URL(u); const e = url.searchParams.get('entry'); const node = url.origin;
    return Promise.resolve(answer(node, e)).then((body) => ({ ok: !!body, json: async () => body })); };
  const look = lift(AC, () => V, () => tabSeed, (k, t) => said.push(k + ': ' + t), win, fetch, { getElementById: () => null }, () => {}, () => ({}));
  return { look, said, win };
}
export const within = (p, ms) => Promise.race([Promise.resolve(p).catch((e) => 'threw: ' + e.message), new Promise((r) => setTimeout(() => r('timeout'), ms))]);
