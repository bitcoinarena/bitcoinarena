#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HUB'S RETURN-CHANNEL WATCHER (hub-return.js): every minute, a channel back to each new gateway that opened one to this LND.
//
//     hub-return-watch --rest https://127.0.0.1:8182 --lnddir /mnt/bitcoin/lnd-testnet4-c --state <file.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lndChannels, lndFunds, lndOpenTo } from '../src/lnd.js';
import { hubReturnTick } from '../src/hub-return.js';
const a = process.argv.slice(2); const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const lnddir = opt('--lnddir'), file = opt('--state');
const cfg = { restUrl: opt('--rest'), tlsCert: join(lnddir, 'tls.cert'), macaroon: join(lnddir, 'data/chain/bitcoin/testnet4/admin.macaroon') };
const log = (l) => console.log(`${new Date().toISOString()} ${l}`);
let last = '';
const run = async () => {
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let r; try { r = await hubReturnTick({ channels: () => lndChannels(cfg), funds: () => lndFunds(cfg), openTo: (o) => lndOpenTo(cfg, o), state, log }); } catch (e) { r = { why: e.message }; }
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  if (r.why !== last) { log(r.why); last = r.why; }
};
await run();
setInterval(run, 60000);
