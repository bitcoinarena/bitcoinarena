#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CHAIN BRIDGE (Electrum mode): answers the node's bitcoind calls on 127.0.0.1:<port> from the Electrum server the
// wizard saved (state.json chain) and Esplora, every block checked against its header. Started by the arena-chain-bridge user unit.
//
//     chain-bridge <port> <node home>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/chain-bridge.js';
import { TESTNET4_ELECTRUM } from '../src/chain-test.js';

const [port, home] = [Number(process.argv[2]), process.argv[3]];
// its log level: ARENA_LOG_LEVEL, else arena.conf log_level, read at its start (kanban #693; log-level.js)
const { serviceLog } = await import('../../arena-node/src/log-level.js');
serviceLog({ home });
const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
// NOTHING TO BRIDGE IS NO FAILURE (kanban #719, the owner's node after an update 2026-10-26: "arena-chain-bridge--2.service: Scheduled restart
// job, restart counter is at 840" - a node on its own Bitcoin Core whose bridge unit the update had not removed, exiting 2 under
// Restart=on-failure every 10 s): said once, exit 0, and the unit stays down
if (!state.chain || state.chain.kind !== 'electrum') { console.log('this node reads its own Bitcoin Core (state.json chain.kind): nothing to bridge, the chain bridge stays off'); process.exit(0); }
const bridge = createBridge({ electrum: state.chain, fallbacks: TESTNET4_ELECTRUM, home, log: (l) => console.log(l) });   // the others when it fails (kanban #639)
const at = await bridge.listen(port);
console.log(`[bridge] testnet4 through ${state.chain.host}:${state.chain.port} and Esplora, on 127.0.0.1:${at}; cookie ${bridge.cookiePath}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bridge.close(); process.exit(0); });
