// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3326 (feedback #385): the bounty texts said "link a verified X (Twitter) account" and "humans only: link and verify your X account",
// which reads as a blue check. The rule (the owner 2026-11-16: "Ein bestaetigtes X-Konto reicht") is an X account linked through the Feedback
// form's link step (its name checked live) - no blue check. Every text a reporter or the owner reads says that now; comments are not text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const FILES = ['packages/arena-node/pages/owner.html', 'packages/arena-node/src/bounty-season.js', 'src/website/www/bounty/index.html',
  'src/website/www/feedback-admin/index.html', 'src/website-stage/stage-2641/bounty-index.html'];
const WORDS = /verified X|verify your X|X linked and verified|verified\)? X \(Twitter\)/i;

test('#3326 no bounty text asks for a "verified" X account: a linked one is the rule', () => {
  const bad = [];
  for (const f of FILES.filter((x) => existsSync(root(x)))) readFileSync(root(f), 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (/^(\/\/|\*|\/\*)/.test(t)) return;   // a comment line
    const code = t.replace(/\/\/ .*$/, '');   // a trailing comment
    if (WORDS.test(code)) bad.push(`${f}:${i + 1}: ${code.slice(0, 120)}`);
  });
  assert.deepEqual(bad, []);
});

test('#3326 the bounty page names the rule: link your X account, no blue check needed', () => {
  // 2.0: its bounty page has no human rule paragraph yet (only the 1.9 page does); where one is, it says so
  for (const f of ['src/website/www/bounty/index.html', 'src/website-stage/stage-2641/bounty-index.html'].filter((x) => existsSync(root(x)))) {
    const s = readFileSync(root(f), 'utf8'); if (!s.includes('human-rule')) continue;
    assert.match(s, /To prove you are human, link your X \(Twitter\) account/, f);
    assert.match(s, /no blue check/i, f);
  }
});
