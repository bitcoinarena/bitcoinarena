// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ENTRY INVOICE (kanban #3248): 100 testnet sats per attempt, a Lightning invoice of one testnet4 lnd, called the way the faucet calls its
// lnds (tools/faucet.mjs lncli: --lnddir, --network, --rpcserver; FAUCET_PAYERS=<lnddir>|<rpc host:port>): OPR_LNCLI, OPR_LND=<lnddir>|<rpc host:port>,
// OPR_LN_NETWORK (testnet4). An attempt token is given only after lnd says the invoice is SETTLED for at least the entry.
//   create({ sats, memo, expirySeconds }) -> { hash, invoice }
//   lookup(hash) -> { state: 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED', paidMsat, settleMs }
import { execFile } from 'node:child_process';

export function lncliInvoices({ lncli, lnd, network = 'testnet4' } = {}) {
  if (!lncli || !lnd) throw new Error('entry invoices need OPR_LNCLI and OPR_LND');
  const [dir, rpcserver] = String(lnd).split('|');
  const call = (args) => new Promise((resolve, reject) => execFile(lncli, [`--lnddir=${dir}`, `--network=${network}`, `--rpcserver=${rpcserver}`, ...args],
    { timeout: 20000, maxBuffer: 4 << 20 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().slice(0, 200))) : resolve(JSON.parse(String(out))))));
  return {
    async create({ sats, memo, expirySeconds }) {
      const r = await call(['addinvoice', `--amt=${sats}`, `--memo=${memo}`, `--expiry=${Math.max(60, Math.floor(expirySeconds))}`]);
      if (!/^[0-9a-f]{64}$/.test(String(r.r_hash)) || !/^lntb/.test(String(r.payment_request))) throw new Error('lnd made no testnet invoice');
      return { hash: r.r_hash, invoice: r.payment_request };
    },
    async lookup(hash) {
      if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error('no hash');
      const r = await call(['lookupinvoice', hash]);
      return { state: String(r.state || ''), paidMsat: Number(r.amt_paid_msat || 0), settleMs: Number(r.settle_date || 0) * 1000 || null };
    },
  };
}
