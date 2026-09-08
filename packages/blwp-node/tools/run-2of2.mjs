#!/usr/bin/env node
/**
 * Two blwp-nodes on one machine, 2-of-2. One bitcoind/LND. Separate stores.
 *
 *   node tools/run-2of2.mjs
 *
 * A: http://127.0.0.1:8080   B: http://127.0.0.1:8081
 * GET /identity on each for the two committee keys. Two bonds still come from
 * the same wallet; each node has its own sqlite identity.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { toHex } from '../../protocol/src/hash.js';

const dir = process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2';
mkdirSync(dir, { recursive: true, mode: 0o700 });

const funded = () => true;
const a = await serve(openStore(join(dir, 'a.db')), { port: 8080, funded });
const b = await serve(openStore(join(dir, 'b.db')), { port: 8081, funded });

const idA = await (await fetch('http://127.0.0.1:8080/identity')).arrayBuffer();
const idB = await (await fetch('http://127.0.0.1:8081/identity')).arrayBuffer();

console.log(JSON.stringify({
  a: { url: 'http://127.0.0.1:8080', pubkey: toHex(new Uint8Array(idA)) },
  b: { url: 'http://127.0.0.1:8081', pubkey: toHex(new Uint8Array(idB)) },
  slots: 2,
  threshold: 2,
  chain: 'bitcoin-testnet4',
  lnd: 'shared',
}, null, 2));
