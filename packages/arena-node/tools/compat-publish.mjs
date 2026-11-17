#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2950: triage stays in our repository. Stable markers prevent duplicate issues.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { reportMarkdown } from './compat-run.mjs';

export async function publishIssues(report, { list, create, update }) {
  const issues = await list();
  for (const [type, rows] of [['failure', report.failed], ['reminder', report.reminders]]) {
    for (const row of rows) {
      const key = createHash('sha256').update(`${type}:${row.kind}:${row.name}`).digest('hex').slice(0, 20);
      const marker = `<!-- arena-compat:${key} -->`;
      const detail = type === 'failure' ? JSON.stringify(row.failing, null, 2) : row.why;
      const fingerprint = `<!-- detail:${createHash('sha256').update(detail).digest('hex')} -->`;
      const existing = issues.find((i) => i.body?.includes(marker));
      const body = `${marker}\n${fingerprint}\n\n${type === 'failure'
        ? 'Compatibility check failed. The previous public result is retained. Triage here first: fix our bugs under a kanban ticket; report suspected product bugs to the team before filing anything upstream.'
        : 'A new release needs a manual compatibility check.'}\n\n${reportMarkdown({ ...report, works: [], skipped: [], failed: type === 'failure' ? [row] : [], reminders: type === 'reminder' ? [row] : [] })}`;
      if (!existing) await create({ title: `Compatibility ${type}: ${row.name}`, body });
      else if (!existing.body.includes(fingerprint)) {
        // Keep the issue body as the latest snapshot.
        await update(existing.number, body);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', ...(input ? { input: JSON.stringify(input) } : {}) });
  const api = (route, data) => JSON.parse(gh(['api', `repos/${repo}/${route}`, ...(data ? ['--method', 'POST', '--input', '-'] : [])], data));
  await publishIssues(report, {
    list: async () => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`])).flat(),
    create: async (data) => api('issues', data),
    update: async (number, body) => {
      // A repeated changed failure does not add a comment on every nightly run.
      gh(['api', `repos/${repo}/issues/${number}`, '--method', 'PATCH', '--input', '-'], { body });
    },
  });
}
