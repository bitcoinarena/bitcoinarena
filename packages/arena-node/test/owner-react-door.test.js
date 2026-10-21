// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S REACT SCREENS, SERVED BY THE SEAT (kanban #564): /owner/react.js the bundle that mounts them, /owner/react.css its
// stylesheet - read from packages/arena-web/dist, which the release carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';

test('/owner/react.js and /owner/react.css: the React bundle and its stylesheet', async () => {
  const seat = await serve(openStore(':memory:'), { port: 0 });
  try {
    const js = await fetch(`http://127.0.0.1:${seat.port}/owner/react.js`);
    assert.deepEqual([js.status, js.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
    assert.match(await js.text(), /ArenaOwner/, 'it mounts window.ArenaOwner');
    const css = await fetch(`http://127.0.0.1:${seat.port}/owner/react.css`);
    assert.deepEqual([css.status, css.headers.get('content-type')], [200, 'text/css; charset=utf-8']);
    assert.match(await css.text(), /\.tile\{/);
  } finally { await seat.close(); }
});
