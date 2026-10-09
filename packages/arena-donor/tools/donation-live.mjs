// LIVE ON TESTNET4 (the owner 2026-10-03): the new wasm's lockWithDonations, then each dev client's redeem, then a withdraw to LND C.
import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { newKey, walletSecretFor, redeemAll, withdrawToLnd, routeWebSockets } from '/tmp/btc-phase0/packages/arena-donor/src/donor.js';
const W = '/mnt/bitcoin/lockclient-build/out-donations';
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 23), ...o }));
const sh = (bin, args) => new Promise((ok, no) => execFile(bin, args, { timeout: 180000 }, (e, out, err) => (e ? no(new Error(String(err || e.message))) : ok(String(out)))));
const LN = '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli';
const lndA = (...a) => sh(LN, ['--lnddir=/mnt/bitcoin/lnd-testnet4', '--rpcserver=127.0.0.1:11009', '--network=testnet4', ...a]);
const lndC = (...a) => sh(LN, ['--lnddir=/mnt/bitcoin/lnd-testnet4-c', '--rpcserver=127.0.0.1:11011', '--network=testnet4', ...a]);
globalThis.window = globalThis;
const esm = join(tmpdir(), `donation-live-${process.pid}.mjs`); copyFileSync(join(W, 'blwp_lock_client.js'), esm);
const m = await import(esm); await m.default({ module_or_path: readFileSync(join(W, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = m;
const daily = await (await fetch('https://btc-logistics-core.pages.dev/daily.json', { cache: 'no-store' })).json();
const routes = { ...(daily.testnet.alt || {}) }; delete routes['127.0.0.1:18777']; routeWebSockets(routes);
const invite = daily.testnet.federation; const fed = String(LockClient.federationIdOf(invite));
const gw = (daily.testnet.gateway || [])[0] || '';
const mem = () => { const h = new Map(); return { entries: () => JSON.stringify([...h]), put: (k, v) => h.set(k, v), remove: (k) => h.delete(k) }; };
const fileStore = (p) => { const fs = { r: () => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } } }; const h = new Map(Object.entries(fs.r()));
  const save = () => import('node:fs').then((f) => f.writeFileSync(p, JSON.stringify(Object.fromEntries(h)))); return { entries: () => JSON.stringify([...h]), put: (k, v) => { h.set(k, v); save(); }, remove: (k) => { h.delete(k); save(); } }; };
const devs = ['a', 'b'].map((x) => ({ x, dir: `/home/arena/blwp-testnet4/donor-${x}`, key: JSON.parse(readFileSync(`/home/arena/blwp-testnet4/donor-${x}/key.json`, 'utf8')) }));
say({ step: 'federation', fed: fed.slice(0, 16), gateway: gw });
// 1. A THROWAWAY PLAYER WALLET, FUNDED 60 sat FROM LND A
const player = await LockClient.join(invite, fed, randomBytes(32).toString('hex'), mem());
const rec = JSON.parse(await player.receive('60000', gw));
const paid = await lndA('payinvoice', '--force', '--json', rec.invoice);
say({ step: 'funded', claimed: await player.awaitReceive(rec.operation), balance: await player.balanceMsat(), pay: (/"status":\s*"(\w+)"/.exec(paid) || [])[1] });
// 2. THE LOCK: a stake to a throwaway point and claim key, our refund key, and two donation outputs
const pt = newKey(), claim = newKey(), refund = newKey();
const t0 = Date.now();
const all = JSON.parse(await player.lockWithDonations(pt.recipientPkHex, '2000', '', '0', claim.recipientPkHex, refund.recipientPkHex, 144,
  JSON.stringify([{ pk: devs[0].key.recipientPkHex, msat: '20000' }, { pk: devs[1].key.recipientPkHex, msat: '10000' }])));
say({ step: 'LOCK WITH DONATIONS', ms: Date.now() - t0, stake: { txid: all.stake.txid.slice(0, 16), out: all.stake.out_idx, ids: all.stake.ids_match }, fee: all.fee,
  donations: all.donations.map((d) => ({ out: d.out_idx, pk: d.recipient_pk.slice(0, 12), msat: d.amount_msat, ids: d.ids_match })), balance: await player.balanceMsat() });
// 3. EACH DEV CLIENT REDEEMS ITS OUTPUT INTO ITS OWN WALLET IN THIS FEDERATION, WITH ITS OWN KEY
for (const [i, d] of devs.entries()) {
  const o = all.donations[i];
  const c = await LockClient.join(invite, fed, walletSecretFor(d.key.secretHex, fed), fileStore(join(d.dir, `wallet-${fed.slice(0, 16)}.json`)));
  const r = await redeemAll({ client: c, donations: [{ outpoint: `${o.txid}:${o.out_idx}`, amountMsat: String(o.amount_msat) }], recipientPkHex: d.key.recipientPkHex, secretHex: d.key.secretHex });
  say({ step: `REDEEM dev ${d.x}`, redeemed: r.redeemed.length, spent: r.spent.length, failed: r.failed.map((f) => f.why), balance: await c.balanceMsat(), withdrawable: await c.withdrawableMsat().catch((e) => e.message) });
  // and the other dev's output is refused to this key
  if (i === 0) {
    const other = all.donations[1];
    const wrong = await redeemAll({ client: c, donations: [{ outpoint: `${other.txid}:${other.out_idx}`, amountMsat: String(other.amount_msat) }], recipientPkHex: d.key.recipientPkHex, secretHex: d.key.secretHex });
    say({ step: 'dev a tries dev b\'s output', redeemed: wrong.redeemed.length, failed: wrong.failed.map((f) => f.why.slice(0, 120)) });
  }
  // 4. DEV A WITHDRAWS TO LND C
  if (i === 0) {
    const lnd = { invoice: async (msat, memo) => JSON.parse(await lndC('addinvoice', '--amt_msat', String(msat), '--memo', memo)).payment_request };
    const w = await withdrawToLnd({ client: c, lnd, minMsat: 1000n, memo: 'blwp donations dev a (live probe)' });
    say({ step: 'WITHDRAW dev a -> LND C', ...w, balance: await c.balanceMsat() });
  }
}
process.exit(0);
