// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MACHINE A NODE RUNS ON (kanban #597, the owner 2026-10-23: the health page's "section machines where each machine is listed with all its
// nodes ... load 1, 5, 15 m"): an id every node on the same host shares - a hash, so the host's name never leaves it - the operator's own
// name for it (ARENA_MACHINE_NAME), its load averages and its cores. Testnet4 only: a mainnet node answers null.
import { hostname, loadavg, cpus } from 'node:os';
import { createHash } from 'node:crypto';

export function machineIdOf(host) {
  return createHash('sha256').update(`arena/machine/v1|${host}`).digest('hex').slice(0, 16);
}

/** { id, name, load: [1, 5, 15 min], cores } of this host, or null on mainnet (chain: the seat's, 'bitcoin-testnet4' or 'testnet4'). */
export function machineOf({ chain = null, env = process.env } = {}) {
  if (['mainnet', 'main', 'bitcoin'].includes(String(chain || '').replace(/^bitcoin-/, ''))) return null;
  return { id: machineIdOf(hostname()), name: env.ARENA_MACHINE_NAME || null, load: loadavg().map((x) => Math.round(x * 100) / 100), cores: cpus().length };
}
