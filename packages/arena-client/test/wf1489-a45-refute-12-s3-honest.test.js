// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 3: honest-path controls for the s3 harness (expected to pass on ee09fa9b7)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { door, honest, evil, mine, theirs } from './wf1489-a45-refute-12-s3-common.js';
const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const host = (u) => new URL(u).hostname.replace(/\.$/, '').toLowerCase();
const undrawn = { players: [] };
const shown = async (answers, nodes) => { const { result, alerts } = door(PAGE, answers, nodes, host); const g = await result('aa'.repeat(32)); return { me: g && g.entries.find((e) => e.entry === mine), alerts, g }; };
test('honest: two seats agree, both with slashes and case', async () => { const { me } = await shown({ h1: honest, h2: honest }, ['http://H1/', 'http://h2']); assert.equal(me.outcome, 'DELIVERED'); assert.equal(me.signedBy, 2); });
test('honest: seven seats, five drawn, one evil, honest last', async () => { const { me, alerts } = await shown({ evil, a: undrawn, b: undrawn, h1: honest, h2: honest, h3: honest, h4: honest }, ['http://evil', 'http://a', 'http://b', 'http://h1', 'http://h2', 'http://h3', 'http://h4']); assert.equal(me.outcome, 'DELIVERED'); assert.ok(me.signedBy > 0); assert.deepEqual(alerts, []); });
test('honest: seats answer with match and players reversed, undefined outcome on an undecided one', async () => {
  const m = { identities: ['aa', 'bb'], score: [1, 0], played: 1, players: { [mine]: 'aa', [theirs]: 'bb' }, names: ['x', 'y'], seat: 's', signature: 'z' };
  const r1 = { players: [...honest.players].reverse(), match: { ...m, seat: 's1', signature: 'q1' } }, r2 = { ...honest, match: { ...m, players: { [theirs]: 'bb', [mine]: 'aa' } } };
  const { me, g } = await shown({ h1: r1, h2: r2 }, ['http://h1', 'http://h2']); assert.equal(me.outcome, 'DELIVERED'); assert.equal(me.signedBy, 2); assert.ok(g.match, 'match shown'); });
test('honest: a round of one seat stands on it alone', async () => { const { me } = await shown({ h1: honest }, ['http://h1']); assert.equal(me.signedBy, 2); });
