// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S REACT SCREENS, SERVED BY THE SEAT (kanban #564): /owner/react.js the bundle that mounts them, /owner/react.css its
// stylesheet - read from packages/arena-web/dist, which the release carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { readFileSync } from 'node:fs';

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

// NO FALL BACKS (kanban #564, 2026-10-21: "Delete the old html code of those components you have ported, no fall backs"): the
// owner page loads the bundle once, at the top of its script, outside any try, and draws every ported panel with it alone - each screen
// it mounts is one the bundle hands out
test('owner.html: the React bundle loaded once and unconditionally; every screen it mounts is one window.ArenaOwner offers', () => {
  const html = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));
  assert.equal(script.split("import(at('/owner/react.js'))").length - 1, 1, 'imported once');
  assert.match(script, /\nawait import\(at\('\/owner\/react\.js'\)\);\nconst O = window\.ArenaOwner;\n/, 'at the top level, not in a try');
  assert.ok(script.indexOf("import(at('/owner/react.js'))") < script.indexOf('function area()'));
  assert.doesNotMatch(script, /window\.ArenaOwner\s*&&|if \(!window\.ArenaOwner\)|reactInstalled|the page's own (panel|list)/, 'no fallback left');
  const main = readFileSync(new URL('../../arena-web/src/owner/main.jsx', import.meta.url), 'utf8');
  const offered = new Set(/window\.ArenaOwner = \{([^}]*)\}/.exec(main)[1].split(',').map((x) => x.trim()));
  const used = [...script.matchAll(/mount\('[\w-]+', '(\w+)'/g)].map((m) => m[1]);
  // the way in and its one-card messages too (kanban #564: OwnerStart, OwnerMessage)
  assert.deepEqual(new Set(used), new Set(['mountStart', 'mountMessage', 'mountBondAnswer', 'mountPlea', 'mountLeave', 'mountRoles', 'mountKeySwitch', 'mountSetup', 'mountCustody', 'mountLiquidity', 'mountServices', 'mountAddress', 'mountRelease', 'mountBond',
    'mountStanding', 'mountApps', 'mountNetworkApps', 'mountNetwork']));
  for (const u of [...used, 'areaInto']) assert.ok(offered.has(u), `${u} is offered by the bundle`);
  // the area itself is React's (kanban #564, OwnerArea): drawn with the need() list, again on each change
  assert.match(script, /O\.areaInto\(\$\('view'\), \{ \.\.\.areaProps, needs:/);
});
