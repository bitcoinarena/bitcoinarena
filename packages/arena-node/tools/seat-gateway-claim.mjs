// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S GATEWAY CLAIM, RENEWED FROM ITS LND (spec §23A.9): what the installer's custody agent does every hour (custody-agent.js step 4),
// for a seat that stands for a gateway outside the installer - its claim file (ARENA_GATEWAY_CLAIM_FILE, served at GET /gateway-claim)
// signed again by the node key from the LND's own figures. Measured 2026-10-19 ~22:00Z: the live seat's claim was signed once by hand
// (10-18 18:47Z) with outsideInboundSats 0, so its gateway stayed "not eligible: inbound liquidity from outside the federation 0" although
// the liquidity providers had opened 143,060 sat of inbound to it since.
//
//   node tools/seat-gateway-claim.mjs --lnd <lnd dir> --rest <host:port> --key <node key file> --federation <hex> --gateway-url <url ending />
//       --out <claim file> [--lightning-addr host:port] [--members <seat url>,...]
//       [--peg-in <sat> | --gateway-cli <path> --gateway-addr <url> --gateway-password <file>]
//
// The peg-in is the gateway's own e-cash in the federation (what it pegged in), read from its gatewayd (`gateway-cli info`) when
// --gateway-cli is named - measured 22:0xZ: gateway A held 248,999 sat in federation A while the hand-signed claim said 0.
//
// Inbound from OUTSIDE the federation counts the public, active channels whose peer is not one of the federation's own gateways' LND
// (the Lightning keys the other guardians' claims name, read at --members): the ring's channels do not take deposits from the wider network.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewayClaim, checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`--${k} is required`); process.exit(2); } return v; };
const lnd = need('lnd'), rest = need('rest'), out = need('out'), federationId = need('federation').toLowerCase(), gatewayUrl = need('gateway-url');
if (!/^https?:\/\/\S+\/$/.test(gatewayUrl)) { console.error('--gateway-url is the gateway\'s public address, ending in /'); process.exit(2); }
const [host, port] = rest.split(':');
const mac = readFileSync(`${lnd}/data/chain/bitcoin/testnet4/admin.macaroon`).toString('hex');
const ca = readFileSync(`${lnd}/tls.cert`);
const get = (path) => new Promise((ok, no) => https.get({ host, port: Number(port), path, ca, headers: { 'Grpc-Metadata-macaroon': mac } }, (r) => {
  let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { no(e); } });
}).on('error', no));

const secret = Uint8Array.from(Buffer.from(readFileSync(need('key'), 'utf8').trim(), 'hex'));
const node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const info = await get('/v1/getinfo');
const channels = ((await get('/v1/channels')).channels || []).filter((c) => !c.private);
// the federation's own gateways: the Lightning keys its other guardians' claims name
const inside = new Set();
for (const base of String(arg('members', '')).split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean)) {
  try {
    const r = await fetch(`${base}/gateway-claim`, { signal: AbortSignal.timeout(10000) });
    if (r.status !== 200) continue;
    const c = await r.json();
    if (c.node !== node && c.federationId === federationId && checkGatewayClaim(c, (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }).ok) inside.add(c.lightningPubkey);
  } catch { /* that member said nothing this time */ }
}
let pegInSats = Number(arg('peg-in', 0));
if (arg('gateway-cli')) {
  const info = JSON.parse(execFileSync(arg('gateway-cli'), ['--address', need('gateway-addr'), '--rpcpassword', readFileSync(need('gateway-password'), 'utf8').trim(), 'info'],
    { encoding: 'utf8', timeout: 30000 }));
  const f = (info.federations || []).find((x) => String(x.federation_id).toLowerCase() === federationId);
  if (!f) { console.error('the gateway does not serve that federation'); process.exit(1); }
  pegInSats = Math.floor(Number(f.balance_msat || 0) / 1000);
}
const sum = (list, k) => list.reduce((a, c) => a + Number(c[k] || 0), 0);
const active = channels.filter((c) => c.active);
const outsideIn = sum(active.filter((c) => !inside.has(c.remote_pubkey)), 'remote_balance');
const claim = signGatewayClaim({ node, federationId, gatewayUrl, lightningPubkey: info.identity_pubkey, capacitySats: sum(channels, 'capacity'),
  pegInSats, atMs: Date.now(), inboundSats: sum(active, 'remote_balance'), outboundSats: sum(active, 'local_balance'),
  lightningAddr: arg('lightning-addr', ''), outsideInboundSats: outsideIn }, (h) => schnorr.sign(h, secret));
const ok = checkGatewayClaim(claim, (s, m, k) => schnorr.verify(s, m, k));
if (!ok.ok) { console.error(`the claim does not check: ${ok.why}`); process.exit(1); }
writeFileSync(`${out}.tmp`, JSON.stringify(claim, null, 2) + '\n');
renameSync(`${out}.tmp`, out);
console.log(`${new Date().toISOString()} gateway claim for ${node.slice(0, 16)}: ${active.length} active public channel(s), inbound ${claim.inboundSats} sat `
  + `(${claim.outsideInboundSats} from outside the federation, ${inside.size} member gateway(s) left out), outbound ${claim.outboundSats} sat, peg-in ${claim.pegInSats} sat`);
