// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishIssues } from '../tools/compat-publish.mjs';

test('triage creates one issue per product and updates it only for a changed failure', async () => {
  const issues = [], updates = [];
  const report = { date: '2026-11-17', works: [], skipped: [], reminders: [], failed: [{ name: 'Wallet', kind: 'NWC wallet', version: '1', failing: { get_info: 'timeout' } }] };
  const api = { list: async () => issues, create: async (row) => issues.push({ ...row, number: 1 }), update: async (n, body) => { updates.push(n); issues[0].body = body; } };
  await publishIssues(report, api);
  await publishIssues(report, api);
  assert.equal(issues.length, 1);
  assert.equal(updates.length, 0);
  report.failed[0].failing.get_info = 'refused';
  await publishIssues(report, api);
  await publishIssues(report, api);
  assert.deepEqual(updates, [1]);
  assert.match(issues[0].body, /report suspected product bugs to the team/);
});
