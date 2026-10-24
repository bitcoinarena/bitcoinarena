// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY STEP OF AN ORDER IN THE SEAT'S LOG (kanban #618): one line per request with its arrival time, each step's offset, the status
// and the whole time - said once, when the answer leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stepLog } from '../src/step-log.js';

test('one line: arrival in UTC, each step\'s offset, steps timed elsewhere, the status and the whole time - once', () => {
  let t = Date.UTC(2026, 9, 24, 14, 59, 1, 123); const lines = [];
  const s = stepLog('lock', '-', { log: (l) => lines.push(l), now: () => t });
  s.named('3dd014ad8c1e2f40aa'); t += 1; s.at('entry'); t += 411; s.took({ statusMs: 400 }); s.at('status');
  const res = new EventEmitter(); res.statusCode = 201; s.on(res);
  t += 3; res.emit('finish'); res.emit('finish');
  assert.deepEqual(lines, ['[steps] lock 3dd014ad8c1e2f40 at 2026-10-24T14:59:01.123Z: entry +1, statusMs 400ms, status +412 -> 201 in 415 ms']);
});
