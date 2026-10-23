// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FORUM'S MARKDOWN TABLES (kanban #590, the owner 2026-10-23: "not sure how tables work ... make sure it works" - "| a | b |"
// under a heading rendered as text): rows with a separator line are a table with a header and the separator's alignment; rows
// alone are a table of body rows; a "|" inside a sentence stays text; nothing typed reaches the page as HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../src/arena-ui/proposals/forum.js', import.meta.url), 'utf8');
const md = new Function(src.slice(src.indexOf('  function esc(x)'), src.indexOf('  window.ARENA_FORUM_MD = markdown;')) + '\nreturn markdown;')();

test('a table with its header and alignment; rows alone a table too; a bar in a sentence stays text; HTML escaped', () => {
  assert.equal(md('| What | Sats |\n| --- | --: |\n| **Server** | 50,000 |'),
    '<div class="tbl"><table><thead><tr><th>What</th><th class="al-right">Sats</th></tr></thead><tbody><tr><td><b>Server</b></td><td class="al-right">50,000</td></tr></tbody></table></div>');
  assert.equal(md('# This is my test\n\nThis is my deal\n| a | b |\n'),
    '<h3>This is my test</h3>\n<p>This is my deal</p>\n<div class="tbl"><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table></div>');
  assert.equal(md('| :-: | x |\n| --- | --- |\n| 1 | 2 |').includes('<th>:-:</th>'), true);
  assert.equal(md('| a | :-: |\n| :-: | --- |\n| 1 | 2 |').includes('<td class="al-center">1</td>'), true);
  assert.equal(md('text | not a table'), '<p>text | not a table</p>');
  assert.equal(md('| <script>x</script> |'), '<div class="tbl"><table><tbody><tr><td>&lt;script&gt;x&lt;/script&gt;</td></tr></tbody></table></div>');
});
