#!/usr/bin/env node
/**
 * Two blwp-nodes on one machine, 2-of-2. One bitcoind/LND. Separate stores.
 *
 *   node tools/run-2of2.mjs
 *
 * Reachable on Tailscale, not LAN (the owner 2026-09-08). Default bind is the
 * tailnet IPv4. A: :8080  B: :8081
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { toHex } from '../../protocol/src/hash.js';

const dir = process.env.BLWP_2OF2_DIR || '/mnt/bitcoin/blwp-2of2';
const host = process.env.BLWP_BIND || '198.51.100.7';
mkdirSync(dir, { recursive: true, mode: 0o700 });

const funded = () => true;
const a = await serve(openStore(join(dir, 'a.db')), { port: 8080, host, funded });
const b = await serve(openStore(join(dir, 'b.db')), { port: 8081, host, funded });

const idA = await (await fetch(`http://${host}:8080/identity`)).arrayBuffer();
const idB = await (await fetch(`http://${host}:8081/identity`)).arrayBuffer();

console.log(JSON.stringify({
  a: { url: `http://${host}:8080`, pubkey: toHex(new Uint8Array(idA)) },
  b: { url: `http://${host}:8081`, pubkey: toHex(new Uint8Array(idB)) },
  slots: 2,
  threshold: 2,
  chain: 'bitcoin-testnet4',
  lnd: 'shared',
}, null, 2));
