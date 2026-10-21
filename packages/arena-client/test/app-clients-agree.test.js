// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT FILES NEXT BLOCK'S MANIFESTS PIN ARE THE APP'S OWN LIST (kanban #569: packages/nextblock/plugin/clients.json, what its signing
// tools and tests read in its own repository); the page's known-good list carries the same for nextblock, or a page would trust what the
// app did not sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Arena\'s known-good list names exactly the client files Next Block pins', () => {
  const arena = JSON.parse(readFileSync(new URL('../known-good-clients.json', import.meta.url), 'utf8')).games.nextblock;
  const { about, ...app } = JSON.parse(readFileSync(new URL('../../nextblock/plugin/clients.json', import.meta.url), 'utf8'));
  void about;
  assert.deepEqual(app, arena);
});
