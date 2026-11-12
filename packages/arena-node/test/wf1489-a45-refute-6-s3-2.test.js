// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2359 (refute of #1814 / #2307, #1489 audit45 item 6): the owner page's shortCheck turns a check that throws into a
// refusal, so the Apps card (NetworkAppsPanel.check) never stays at "checking in this browser..." with its button disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const body = html.slice(html.indexOf('function shortCheck('), html.indexOf('function storePanel('));
const shortCheckWith = (C) => new Function('C', `${body}; return shortCheck;`)(C);

test('#2359: a package check that throws is reported as refused, not thrown', () => {
  const shortCheck = shortCheckWith({ checkPackage: () => { throw new TypeError("Cannot read properties of null (reading 'body')"); } });
  let r = null, err = null;
  try { r = shortCheck({ clients: [null] }, {}); } catch (e) { err = e.message; }
  assert.equal(err, null, 'shortCheck throws');
  assert.equal(r.ok, false);
  assert.match(r.why, /cannot be read/);
});

// 2.0 (kanban #1489 port): 2.0's owner page hands the report to NetworkAppsPanel whole (1.9's one-line summary is not in 2.0), so the
// honest path is the report as checkPackage gave it
test('#2359: the honest path is unchanged - a passed package is the report checkPackage gave', () => {
  const shortCheck = shortCheckWith({ checkPackage: () => ({ ok: true, checks: [{ check: 'a', ok: true }, { check: 'b', ok: true }] }) });
  const r = shortCheck({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 2);
});
