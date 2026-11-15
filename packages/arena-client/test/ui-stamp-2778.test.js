// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2778 (feedback #076): the "UI n" stamp beside the wallet and in the footers says what it is - a tooltip naming it the page
// version to give in a bug report - and the stamp next to the wallet takes the pointer for it while its bar stays click-through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const TIP = 'title="Page version (UI build). Please name it when you report a bug."';

test('#2778 every UI stamp of the page carries the explanation, and "UI n" itself stays (#753)', () => {
  assert.match(PAGE, new RegExp(`<div id="arena-build"><span class="ui-stamp" ${TIP.replace(/[().]/g, '\\$&')}>UI \\{\\{\\{ UI_VERSION \\}\\}\\}</span></div>`));
  assert.match(PAGE, new RegExp(`<div class="build-line" id="boot-build" ${TIP.replace(/[().]/g, '\\$&')}>UI \\{\\{\\{ UI_VERSION \\}\\}\\}</div>`));
  assert.match(PAGE, new RegExp(`<span class="build-line" ${TIP.replace(/[().]/g, '\\$&')}>UI \\{\\{\\{ UI_VERSION \\}\\}\\}<`));
  assert.match(PAGE, /#arena-build \.ui-stamp \{ pointer-events: auto; cursor: help; \}/);
  assert.doesNotMatch(PAGE, /<div id="arena-build" aria-hidden="true">/);
});
