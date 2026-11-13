#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The game's own Nostr relay (src/nostr-relay.js): node tools/nostr-relay.mjs <port> <db file>
import { startRelay } from '../src/nostr-relay.js';
const [port = '29700', dbPath = 'nostr-relay.db'] = process.argv.slice(2);
// kanban #2146, #2214: ARENA_RELAY_KEEP (comma list of 64-hex node keys, the seats') - a full relay never pushes their events out for another author
const keep = String(process.env.ARENA_RELAY_KEEP || '').split(',').map((k) => k.trim()).filter(Boolean);
const r = await startRelay({ port: Number(port), host: process.env.RELAY_HOST || '127.0.0.1', dbPath, keep });
console.log(JSON.stringify({ at: new Date().toISOString(), step: 'up', port: r.port, db: dbPath }));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await r.close(); process.exit(0); });
