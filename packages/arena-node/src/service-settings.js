// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH OF THE NODE'S OWN SERVICES START WITH IT (kanban #563, 2026-10-21): the services that run inside the node - its guardian,
// the guardians' P2P tunnel, the address announcements - each started at the node's start unless the owner turned that off on the owner
// page. Kept in the node's store, so a node set up by hand has the same switch as an installed one. A service never set starts.
export const OWN_SERVICES = Object.freeze(['guardian', 'guardian-next', 'p2p-tunnel', 'announcements']);

export function serviceSettings(db) {
  db.exec('CREATE TABLE IF NOT EXISTS service_settings (id TEXT PRIMARY KEY, at_boot INTEGER NOT NULL)');
  return {
    atBoot: (id) => { const r = db.prepare('SELECT at_boot FROM service_settings WHERE id = ?').get(id); return r ? r.at_boot === 1 : true; },
    setAtBoot: (id, on) => {
      if (!OWN_SERVICES.includes(id)) throw new Error(`${id} is not a service the node runs itself`);
      db.prepare('INSERT INTO service_settings (id, at_boot) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at_boot = excluded.at_boot').run(id, on ? 1 : 0);
      return !!on;
    },
  };
}
