// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ZAP-TAKING LIGHTNING ADDRESS IN FRONT OF ONE LND (src/zap-address.js). Invoices are minted and
// looked up with lncli; receipts are signed with the key in ZAP_KEY_FILE (32 bytes hex, made on first start, 0600) and
// sent to the relays each zap request names.
//   ZAP_HOST=<public host> ZAP_NAMES=a,b ZAP_LNCLI=<lncli> ZAP_LND_ARGS="--lnddir=... --rpcserver=... --network=testnet4" \
//   ZAP_PORT=18781 ZAP_KEY_FILE=... ZAP_STATE=... node tools/zap-address.mjs
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses } from '../src/zap-address.js';
import { sendToRelay } from '../src/nostr-results.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const host = env('ZAP_HOST');
const names = env('ZAP_NAMES', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const lncliPath = env('ZAP_LNCLI', 'lncli');
const lndArgs = env('ZAP_LND_ARGS', '').split(/\s+/).filter(Boolean);
const keyFile = env('ZAP_KEY_FILE');
if (!host || !names.length || !keyFile) { console.error('needs ZAP_HOST, ZAP_NAMES and ZAP_KEY_FILE'); process.exit(2); }
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = Uint8Array.from(Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex'));
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const lncli = (...a) => new Promise((res, rej) => execFile(lncliPath, [...lndArgs, ...a], { maxBuffer: 16 << 20 },
  (e, so, se) => (e ? rej(new Error(String(se || e.message).trim())) : res(JSON.parse(so)))));
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);

const served = await serveZapAddresses({
  host: '127.0.0.1', port: Number(env('ZAP_PORT', 18781)), publicHost: host, publicBase: env('ZAP_PUBLIC_BASE', null), names, secret, curve,
  statePath: env('ZAP_STATE', null), log,
  invoice: async ({ amountMsat, descriptionHash, expiryS }) => {
    const inv = await lncli('addinvoice', '--amt_msat', String(amountMsat), '--description_hash', Buffer.from(descriptionHash).toString('hex'), '--expiry', String(expiryS));
    return { request: inv.payment_request, paymentHash: inv.r_hash };
  },
  lookup: async ({ paymentHash }) => {
    const i = await lncli('lookupinvoice', paymentHash);
    return { settled: i.state === 'SETTLED', preimage: /^[0-9a-f]{64}$/.test(String(i.r_preimage)) ? i.r_preimage : null,   // lncli prints bytes as hex
      settledAtS: Number(i.settle_date) || null };
  },
  publish: async (receipt, relays) => {
    for (const r of relays) {
      const a = (await sendToRelay(r, [receipt])).get(receipt.id);
      log(`receipt ${receipt.id.slice(0, 16)} -> ${r}: ${a ? (a.ok ? 'OK' : `refused ${a.why}`) : 'no answer'}`);
    }
  },
});
log(`zap addresses ${names.map((n) => `${n}@${host}`).join(', ')} on 127.0.0.1:${served.port}, receipts by ${served.nostrPubkey}`);
