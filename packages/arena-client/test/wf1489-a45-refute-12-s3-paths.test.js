// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2364 (audit #1489 a45-refute-12-s3): ONE SERVER, ONE VOTE keeps seats that share one host under paths working (the live layout:
// https://tn4.bitcoin-arena.io/fed2-1 ... /fed2-7). Each path is asked; the host's paths settle among themselves and the host counts once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { door, honest, evil, mine } from './wf1489-a45-refute-12-s3-common.js';
const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const byPath = (u) => u.replace(/\/api\/round-result.*$/, '');   // each path its own seat process
const undrawn = { players: [] };
const shown = async (answers, nodes) => { const { result, alerts } = door(PAGE, answers, nodes, byPath); const g = await result('aa'.repeat(32)); return { me: g && g.entries.find((e) => e.entry === mine), alerts }; };
const L = (k) => `https://tn4.example/fed2-${k}`;

test('#2364: seven seats under paths of one host, two not drawn, the rest agree: the verdict stands, signed', async () => {
  const { me, alerts } = await shown({ [L(1)]: undrawn, [L(2)]: undrawn, [L(3)]: honest, [L(4)]: honest, [L(5)]: honest, [L(6)]: honest, [L(7)]: honest }, [1, 2, 3, 4, 5, 6, 7].map(L));
  assert.equal(me.outcome, 'DELIVERED'); assert.ok(me.signedBy > 0); assert.deepEqual(alerts, []);
});
test('#2364: one lying path among a host\'s honest paths does not carry that host', async () => {
  const { me, alerts } = await shown({ [L(1)]: evil, [L(2)]: honest, [L(3)]: honest }, [1, 2, 3].map(L));
  assert.equal(me.outcome, 'DELIVERED'); assert.ok(me.signedBy > 0); assert.deepEqual(alerts, []);
});
test('#2364: two hosts agreeing stand; a third host listed many times is still one vote', async () => {
  const { me, alerts } = await shown({ 'http://h1': honest, 'http://h2': honest, 'http://evil': evil, 'http://evil/a': evil, 'http://evil/b': evil }, ['http://evil', 'http://evil/a', 'http://evil/b', 'http://h1', 'http://h2']);
  assert.equal(me.outcome, 'DELIVERED'); assert.ok(me.signedBy > 0); assert.deepEqual(alerts, []);
});
