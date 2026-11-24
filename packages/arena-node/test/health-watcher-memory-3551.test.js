// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3551: the 2026-11-23 outage (13:30-15:15Z, 4-9 of 14 seats answering). The health watcher restarted seat 3 at 12:51Z with the
// 1-min load at 10.76 - under its gate of 12 - while the swap (12 GB) was full; three minutes later the load was 25.37 and 12:54-15:00 had
// 4-11 of 14 seats. A starting seat reads ~1 GB into its malloc heap and its V8 pages in its first minute; on a host with no swap left that
// is page-cache eviction and swapping for every other seat. So a seat restart is held when the host is short on memory: MemAvailable under
// HW_RESTART_MEM_MIN_MB (2048), or the swap all but full (under 5 % free) and MemAvailable under HW_RESTART_SWAPFULL_MEM_MIN_MB (4096).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, pass, meminfoOf } from '../tools/health-watcher.mjs';

const NOW = Date.UTC(2026, 9, 28, 10, 5, 50);   // :05 of a quarter: a restart minute
const SEATS = [31221, 31231, 31241, 31251, 31261, 31271, 31281].map((p) => `http://127.0.0.1:${p}`);
const K = (i) => String(i).padStart(2, '0').repeat(32);

function world({ mem, down = [SEATS[2]] }) {
  const w = { now: NOW, restarts: [], posts: [] };
  w.io = {
    now: () => w.now,
    loadavg: async () => [3, 3, 3],
    ...(mem !== undefined ? { meminfo: async () => mem } : {}),
    identity: async (base) => (down.includes(base) ? { ok: false, why: 'ECONNREFUSED' } : { ok: true, key: K(SEATS.indexOf(base) + 10) }),
    get: async () => ({ ok: false, why: 'HTTP 404' }),
    units: async (units) => Object.fromEntries(units.map((u) => [u, { active: 'active', sub: 'running', nRestarts: 0 }])),
    restartUnit: async (u) => { w.restarts.push(u); },
    minercCheck: async () => ({ listed: [], missing: [] }),
    minercAdd: async () => {},
    post: async (text) => { w.posts.push(text); },
  };
  return w;
}
const CFG = config({ HW_STATE: '/nonexistent/hw.json', HW_MAC_SEATS: '' }, []);
const twoPasses = async (w) => { let r = await pass(w.io, CFG, {}); w.now += 60000; r = await pass(w.io, CFG, r.state); return r; };
const GB = 1024;

test('#3551: a down seat is not restarted while the host is short on memory - the 11-23 12:51Z case (swap full) is held', async () => {
  // swap all gone, 3.3 GB available (the Beelink on 11-24 01:17Z): held
  let w = world({ mem: { availMb: 3379, swapTotalMb: 12 * GB, swapFreeMb: 0 } });
  let r = await twoPasses(w);
  assert.deepEqual(w.restarts, []);
  let fx = r.fixes.find((x) => x.kind === 'restart-seat');
  assert.equal(fx.allowed, false);
  assert.match(fx.blocked.join(), /memory short: 3379 MB available, swap 0 of 12288 MB free/);
  // little available, swap free: held too
  w = world({ mem: { availMb: 1500, swapTotalMb: 12 * GB, swapFreeMb: 6 * GB } });
  r = await twoPasses(w);
  assert.deepEqual(w.restarts, []);
  assert.match(r.fixes.find((x) => x.kind === 'restart-seat').blocked.join(), /memory short: 1500 MB available/);
});

test('#3551: with memory to spare the seat is restarted as before; no meminfo (a host without /proc) changes nothing', async () => {
  for (const mem of [{ availMb: 6 * GB, swapTotalMb: 12 * GB, swapFreeMb: 0 }, { availMb: 3 * GB, swapTotalMb: 12 * GB, swapFreeMb: 4 * GB }, undefined, null]) {
    const w = world({ mem });
    const r = await twoPasses(w);
    assert.deepEqual(w.restarts, ['blwp-tn4-node@3.service'], JSON.stringify(mem));
    assert.equal(r.fixes.find((x) => x.kind === 'restart-seat').allowed, true);
  }
});

test('#3551: meminfoOf reads /proc/meminfo text (kB) into MB', () => {
  const text = 'MemTotal:       37748736 kB\nMemFree:          200000 kB\nMemAvailable:    3503684 kB\nSwapTotal:      12582904 kB\nSwapFree:            152 kB\n';
  assert.deepEqual(meminfoOf(text), { availMb: 3422, swapTotalMb: 12288, swapFreeMb: 0 });
  assert.equal(meminfoOf('nonsense'), null);
});
