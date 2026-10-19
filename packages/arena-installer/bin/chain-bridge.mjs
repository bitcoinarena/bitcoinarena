#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CHAIN BRIDGE (kanban #471, Electrum mode): answers the node's bitcoind calls on 127.0.0.1:<port> from the Electrum server the
// wizard saved (state.json chain) and Esplora, every block checked against its header. Started by the arena-chain-bridge user unit.
//
//     chain-bridge <port> <node home>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../src/chain-bridge.js';

const [port, home] = [Number(process.argv[2]), process.argv[3]];
const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
if (!state.chain || state.chain.kind !== 'electrum') { console.error('this node is not in Electrum mode (state.json chain.kind)'); process.exit(2); }
const bridge = createBridge({ electrum: state.chain, home, log: (l) => console.log(l) });
const at = await bridge.listen(port);
console.log(`[bridge] testnet4 through ${state.chain.host}:${state.chain.port} and Esplora, on 127.0.0.1:${at}; cookie ${bridge.cookiePath}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bridge.close(); process.exit(0); });
