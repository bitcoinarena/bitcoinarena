// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 (Daniel 2026-11-08): the node bounty's checklist, read from the seats' public doors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeBountyCheck } from '../src/node-bounty-check.js';

const NODE = 'aa'.repeat(32), ME = 'bb'.repeat(32), OTHER = 'cc'.repeat(32);
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
// two seats; the node served one round a day on `servedDays` of the last 7, signing each, and claims `owner`
const fake = ({ servedDays, owner }) => async (url) => {
  if (url.endsWith('/owner')) return url.startsWith('https://node.example') ? { node: NODE, claimed: true, owner } : { node: 'dd'.repeat(32), claimed: true, owner: OTHER };
  const from = Number(new URL(url).searchParams.get('from')), dayAgo = Math.round((Math.floor(NOW / DAY) * DAY - from) / DAY);
  const held = servedDays.includes(dayAgo) ? [{ roundId: `r${dayAgo}`, committee: [NODE, OTHER], finals: [NODE] }] : [];
  return { held };
};
const seats = ['https://seat1.example', 'https://node.example'];

test('#1342 the node checklist: served all 7 days and owned by the reporter passes; one day short, another owner or a team node does not', async () => {
  const all = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: ME }), nowMs: NOW });
  const short = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6], owner: ME }), nowMs: NOW });
  const theirs = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: OTHER }), nowMs: NOW });
  const team = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: ME }), nowMs: NOW, excluded: new Set([NODE]) });
  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);
  console.log('  MEASURED #1342 node checklist:', JSON.stringify({ all: [all.passes, all.checks.find((c) => c.key === 'committees').says], short: failed(short), theirs: failed(theirs), team: failed(team) }));
  assert.equal(all.passes, true);
  assert.deepEqual(failed(short), ['online']);
  assert.deepEqual(failed(theirs), ['owner']);
  assert.deepEqual(failed(team), ['outside']);
  assert.equal((await nodeBountyCheck({ node: 'x', npub: ME, seats, fetchJson: fake({ servedDays: [], owner: ME }) })).ok, false);
  const byHost = await nodeBountyCheck({ node: NODE, npub: ME, seats, fetchJson: fake({ servedDays: [1, 2, 3, 4, 5, 6, 7], owner: ME }), nowMs: NOW, teamHosts: ['node.example'] });
  assert.deepEqual(failed(byHost), ['outside'], 'a node answering at a team host is a team node');
});
