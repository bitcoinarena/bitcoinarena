// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2367: the page's Players chip takes its name bounds from the bundle (NAMES_PER_SEAT, LOBBY_NAME_CHECKS_PER_READ);
// the bundle must export them, and the chip's fallbacks for an older bundle must equal them, so the two copies cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NAMES_PER_SEAT } from '../src/identity.js';
import { LOBBY_NAME_CHECKS_PER_READ } from '../src/lobby.js';

const HTML = fs.readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const BUNDLE = fs.readFileSync(new URL('../../../src/arena-ui/arena-client.js', import.meta.url), 'utf8');

test('wf1489-a45-refute-24-s3-2: the bundle exports the lobby name bounds and the chip falls back to the same numbers', () => {
  assert.match(BUNDLE, /NAMES_PER_SEAT: NAMES_PER_SEAT, LOBBY_NAME_CHECKS_PER_READ: LOBBY_NAME_CHECKS_PER_READ/);
  assert.ok(HTML.includes(`Number(ARENACLIENT.NAMES_PER_SEAT) || ${NAMES_PER_SEAT};`));
  assert.ok(HTML.includes(`Number(ARENACLIENT.LOBBY_NAME_CHECKS_PER_READ) || ${LOBBY_NAME_CHECKS_PER_READ} }`));
});
