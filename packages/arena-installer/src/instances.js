// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW MANY NODES ON THIS MACHINE (kanban #596, the owner 2026-10-23: "installer command line option und Option in der UI n Instanzen zu
// installieren, Standard 1, und es wird angezeigt dass ab 10 die nodes eigene federation anlegen werden. Alles nur gültig für Testnet4";
// "bei mehr als 5 nodes eine checkbox anzeigen, bzw. in der console automatisch anzeigen: RAM disk für fedimint aktivieren? Default ja").
// The count and the RAM disk choice, checked the same for `arena-install --instances N` and the wizard's intro; each further node is
// one instance (instance.js) - its own home, services and ports - with its own seed, owner key and bond.

export const INSTANCES_MAX = 20;
export const FOUNDING_NODES = 10;     // from ten, the nodes found a federation of their own (§23A.2 cohort, founding-rulings 10-22)
export const RAM_FROM = 6;            // "bei mehr als 5 nodes"
export const PORT_STEP = 100;

/** The count and RAM disk choice, checked: { ok, count, ram } or { ok: false, why }. `ram` undefined: the default (yes from RAM_FROM). */
export function instancesChoice({ count, ram, network = 'testnet4' } = {}) {
  const n = Number(count === undefined || count === '' ? 1 : count);
  if (!Number.isInteger(n) || n < 1 || n > INSTANCES_MAX) return { ok: false, why: `the number of nodes is a whole number from 1 to ${INSTANCES_MAX}` };
  if (n > 1 && network !== 'testnet4') return { ok: false, why: 'more than one node on a machine is for testnet4 only' };
  return { ok: true, count: n, ram: n >= RAM_FROM ? ram !== false : false };
}

/** What the intro says for a count: the bonds it takes, and from ten that they found their own federation. */
export function instancesNote(count, bondSats = 50000) {
  const n = Number(count) || 1;
  if (n <= 1) return '';
  const each = `${n} nodes: each its own seed, owner key and bond (${(n * bondSats).toLocaleString('en-US')} sat in all)`;
  return n >= FOUNDING_NODES ? `${each}. ${FOUNDING_NODES} or more nodes found their own federation.` : `${each}.`;
}

/** The nodes of a count: the first in `home` as before, then b, c, ... each in `<home>-<x>`, its ports PORT_STEP apart. */
export function instancesOf(count, home) {
  return Array.from({ length: Number(count) || 1 }, (_, i) => (i === 0 ? { instance: '', home, portOffset: 0 }
    : { instance: String.fromCharCode(97 + i), home: `${home}-${String.fromCharCode(97 + i)}`, portOffset: i * PORT_STEP }));
}

/** The console's question (more than 5 nodes, neither --ram nor --no-ram): yes unless the answer starts with n. */
export const RAM_QUESTION = 'Enable RAM disk for Fedimint? [Y/n] ';
export const ramAnswer = (line) => !/^\s*n/i.test(String(line || ''));

/** The node after `home` in a count's list (instancesOf from `baseHome`), or null: the last one, or a home not in the list. */
export function nextInstance(count, baseHome, home) {
  const list = instancesOf(count, baseHome), i = list.findIndex((x) => x.home === home);
  return i >= 0 && i + 1 < list.length ? { ...list[i + 1], index: i + 2, count: list.length } : null;
}

/**
 * A FURTHER NODE STARTS WITH THE FIRST ONE'S CHOICES (kanban #596): its Bitcoin source, roles and apps - the steps before the seed - are
 * taken over and marked done, so its wizard opens at its own seed. A Core's login file is copied into its own home. Its seed, owner key,
 * address, Lightning and bond stay its own. A node that has begun its own steps is left as it is.
 */
export function prefillFrom(base, into, nowMs = Date.now()) {
  const b = base.read(), s = into.read();
  if (s.done && Object.keys(s.done).length) return { ok: false, why: 'this node has begun its own steps; nothing was taken over' };
  const done = {};
  for (const k of ['chain', 'roles', 'apps']) if (b.done && b.done[k]) done[k] = nowMs;
  let chain = b.chain || null;
  if (chain && chain.cookiePath && chain.cookiePath === base.path('bitcoind.auth')) {
    const auth = base.readSecret('bitcoind.auth');
    if (auth) { into.writeSecret('bitcoind.auth', `${auth}\n`); chain = { ...chain, cookiePath: into.path('bitcoind.auth') }; }
  }
  into.save({ instances: b.instances || null, chain, chainTest: b.chainTest || null, roles: b.roles || [], apps: b.apps || undefined, done });
  return { ok: true, took: Object.keys(done) };
}
