// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1159 MEASURE: does a reserve payout's PLANNED get out (the test world of reserve-payout-fixture.js)? Run with the module to
// measure, e.g. the source before the fix:
//   node packages/arena-node/tools/measure-1159.mjs [path/to/reserve-payout.js]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { world, invoiceOf, rand, METADATA, PROPOSAL, GW } from '../test/reserve-payout-fixture.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const mod = await import(pathToFileURL(resolve(process.argv[2] || new URL('../src/reserve-payout.js', import.meta.url).pathname)).href);
const { createReservePayouts } = mod;
const say = (k, v) => console.log(`#1159 ${k.padEnd(58)} ${v}`);
const states = (w) => w.seats.map((s) => (s.api.stateOf(PROPOSAL) || {}).state || '-').join(',');
const pass = async (w, from, to) => { for (let h = from; h <= to; h += 2) for (const s of w.seats) { try { await s.api.round({ height: h }); } catch { /* next pass */ } } await w.deliver(); };
const lost = (w) => { const { settle, status } = w.port; let lose = true;
  w.port.settle = async (a) => { const r = await settle(a); if (a.signature && lose) { lose = false; w.down = true; throw new Error('timed out'); } return r; };
  w.port.status = async (a) => { if (w.down) throw new Error('no answer'); return status(a); }; };
console.log(`#1159 module ${process.argv[2] || 'src/reserve-payout.js'}`);

{ // 1. 4 of 5 committed, then the gateway's fee moved: 40 blocks of passes on all seven seats
  const w = world({ create: createReservePayouts, down: [1, 2, 3] });
  await w.seats[0].api.round({ height: 500 });
  w.port.gateways = async () => ({ gateways: [{ ...GW, sendFeeDefault: { baseMsat: 3000, ppm: 1000 } }], height: w.fed.height });
  for (const s of w.seats) s.down = false;
  await pass(w, 502, 540);
  say('stuck plan, fee moved: payments after 40 blocks', `${w.fed.payments.length} (${states(w)})`);
}
{ // 2. an outsider's valid alternative plan handed to three guardians first
  const ref = world({ create: createReservePayouts }); await ref.seats[0].api.round({ height: 500 });
  const h = toHex(sha256(rand(32)));
  const alt = { ...ref.seats[0].api.stateOf(PROPOSAL).plan, paymentHash: h, invoice: invoiceOf(70000000n, Buffer.from(h, 'hex'), METADATA) };
  const w = world({ create: createReservePayouts });
  const took = [];
  for (const s of w.seats.slice(1, 4)) { await s.api.round({ height: 500 }).catch(() => {}); took.push((await s.api.commit({ plan: alt, kind: 'tx' })).ok); }
  const [r] = await w.seats[0].api.round({ height: 500 });
  say('outsider plan: guardians that took it', `${took.filter(Boolean).length} of 3`);
  say('outsider plan: coordinator\'s pass', r ? r.state || r.why : '-');
}
{ // 3. the federation took the transaction, the answer was lost
  const w = world({ create: createReservePayouts }); lost(w);
  try { await w.seats[0].api.round({ height: 500 }); } catch { /* lost */ }
  const after = w.seats[0].api.stateOf(PROPOSAL).state;
  w.down = false;
  await pass(w, 502, 520);
  say('answer lost after the hand-in: state, then after 20 blocks', `${after} -> ${w.seats[0].api.stateOf(PROPOSAL).state}; payments ${w.fed.payments.length}`);
}
{ // 4. the refund went in, the answer was lost
  const w = world({ create: createReservePayouts, gatewayFails: true });
  await w.seats[0].api.round({ height: 500 });
  w.fed.height = 1000 + 144 + 1; lost(w);
  try { await w.seats[0].api.round({ height: 700 }); } catch { /* lost */ }
  const after = w.seats[0].api.stateOf(PROPOSAL).state;
  w.down = false;
  for (let h = 702; h <= 720; h += 2) { try { await w.seats[0].api.round({ height: h }); } catch { /* next */ } }
  const rec = w.seats[0].api.stateOf(PROPOSAL);
  say('refund answer lost: state, then after 20 blocks', `${after} -> ${rec.state}; refund row kept: ${w.state.kept.some((k) => k.seat === 0 && rec.refundTxid && k.row.outpoint === `${rec.refundTxid}:0`)}`);
}
