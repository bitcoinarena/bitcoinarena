// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE REPORT FROM SEVERAL RUNS OF THE SUITE (kanban #2642): the MacBook's load rule makes the suite run area by area (`run.mjs --only`),
// each run writing its own report.json; this merges them, each flow's newest result winning, into <out>/report.json and REPORT.md.
//   node e2e/tools/merge-reports.mjs <out dir> <report.json> [more report.json ...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const runs = files.map((f) => ({ f, r: JSON.parse(readFileSync(f, 'utf8')) })).sort((a, b) => a.r.started.localeCompare(b.r.started));
const by = new Map();
for (const { f, r } of runs) for (const x of r.results) by.set(x.id, { ...x, run: r.started, from: f });
const results = [...by.values()].sort((a, b) => (b.money - a.money) || (b.reach - a.reach) || a.id.localeCompare(b.id));
const count = (x) => results.filter((r) => r.result === x).length;
const head = { suite: 'bitcoin-arena e2e (kanban #2642)', merged: runs.map(({ f, r }) => ({ file: f, started: r.started, seconds: r.seconds, commit: r.commit })),
  commit: runs.map(({ r }) => r.commit).find(Boolean) || null, pass: count('pass'), fail: count('fail'), notCovered: count('not covered') };
writeFileSync(join(out, 'report.json'), JSON.stringify({ ...head, results }, null, 1) + '\n');
const ev = (r) => (r.result === 'pass' ? JSON.stringify(r.evidence) : r.why || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300);
writeFileSync(join(out, 'REPORT.md'), [
  '# E2E report (kanban #2642)', '',
  `commit ${head.commit || '?'} · ${runs.length} runs merged (${runs[0]?.r.started} .. ${runs[runs.length - 1]?.r.started}) · **${head.pass} pass, ${head.fail} fail, ${head.notCovered} not covered**`, '',
  'Private regtest devnet on the MacBook (devnet.mjs: 5-of-7 federation, seven seats, two gateways on two lnds, a payee lnd); the page built from',
  'this tree (tools/build-arena-page.mjs) served by e2e/lib/page.mjs and driven in headless Chrome. Order: money first, then reach.', '',
  '| flow | area | result | s | evidence / why |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.area} | ${r.result === 'pass' ? 'pass' : r.result === 'fail' ? '**FAIL**' : 'not covered'} | ${r.seconds} | ${ev(r)} |`), ''].join('\n'));
console.log(JSON.stringify({ pass: head.pass, fail: head.fail, notCovered: head.notCovered, flows: results.length }));
