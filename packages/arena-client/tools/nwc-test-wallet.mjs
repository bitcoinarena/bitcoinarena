#!/usr/bin/env node
// A NOSTR WALLET CONNECT SERVICE IN FRONT OF A REGTEST LND (kanban #277, for measuring NWC deposits end to end): it announces
// itself (kind 13194, NIP-44), takes pay_invoice / get_balance / get_info requests for its one app key over the relay, and
// pays with `lncli payinvoice` - a real Lightning payment, on a private regtest only. Prints its connection link.
//   LNCLI=<lncli> LND_DIR=<alice's dir> LND_RPC=127.0.0.1:<port> RELAY=wss://relay.bitcoin-arena.io node tools/nwc-test-wallet.mjs
import { execFile } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';

const env = process.env;
const RELAY = env.RELAY || 'wss://relay.bitcoin-arena.io';
const lncli = (...a) => new Promise((res, rej) => execFile(env.LNCLI, [`--lnddir=${env.LND_DIR}`, `--rpcserver=${env.LND_RPC}`, '--network=regtest', ...a], { timeout: 60000 },
  (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().slice(0, 200))) : res(String(out)))));
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const pool = new SimplePool();
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const sk = env.WALLET_SK ? unhex(env.WALLET_SK) : generateSecretKey(), pk = getPublicKey(sk), app = env.APP_SK ? unhex(env.APP_SK) : generateSecretKey();
await Promise.allSettled(pool.publish([RELAY], finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now() / 1000), content: 'pay_invoice get_balance get_info', tags: [['encryption', 'nip44_v2 nip04']] }, sk)));
const appPk = getPublicKey(app);
// SUBSCRIBED AGAIN WHENEVER THE RELAY DROPS THE CONNECTION (measured: the service exited silently when it did - nothing else
// kept it alive), and kept alive by a timer
setInterval(() => {}, 1 << 30);
const listen = () => pool.subscribeMany([RELAY], { kinds: [23194], '#p': [pk], since: Math.floor(Date.now() / 1000) - 5 }, { onclose: () => { say({ step: 'relay closed - subscribing again' }); setTimeout(listen, 2000); }, onevent: async (ev) => {
  if (ev.pubkey !== appPk) return;                       // only the app this link was made for
  const use44 = ev.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
  const ck = nip44.getConversationKey(sk, ev.pubkey);
  let req; try { req = JSON.parse(use44 ? nip44.decrypt(ev.content, ck) : await nip04.decrypt(sk, ev.pubkey, ev.content)); } catch { return; }
  let body;
  try {
    if (req.method === 'pay_invoice') {
      const t0 = Date.now();
      const out = JSON.parse(await lncli('payinvoice', '--force', '--json', req.params.invoice));
      const ok = out.status === 'SUCCEEDED';
      say({ step: 'pay_invoice', ok, ms: Date.now() - t0, amountSat: out.value_sat, feeMsat: out.fee_msat, status: out.status });
      body = ok ? { result_type: 'pay_invoice', result: { preimage: out.payment_preimage, fees_paid: Number(out.fee_msat || 0) } }
        : { result_type: 'pay_invoice', error: { code: 'PAYMENT_FAILED', message: out.failure_reason || out.status } };
    } else if (req.method === 'get_balance') {
      const b = JSON.parse(await lncli('channelbalance'));
      body = { result_type: 'get_balance', result: { balance: Number(b.local_balance.msat) } };
      say({ step: 'get_balance', msat: body.result.balance });
    } else if (req.method === 'get_info') body = { result_type: 'get_info', result: { alias: 'regtest alice (NWC test wallet)', network: 'regtest', methods: ['pay_invoice', 'get_balance', 'get_info'] } };
    else body = { result_type: req.method, error: { code: 'NOT_IMPLEMENTED', message: `${req.method} is not offered here` } };
  } catch (e) { body = { result_type: req.method, error: { code: 'INTERNAL', message: e.message } }; }
  const text = JSON.stringify(body);
  const content = use44 ? nip44.encrypt(text, ck) : await nip04.encrypt(sk, ev.pubkey, text);
  await Promise.allSettled(pool.publish([RELAY], finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now() / 1000), content, tags: [['p', ev.pubkey], ['e', ev.id]] }, sk)));
} });
listen();
const hex = (b) => Buffer.from(b).toString('hex');
say({ step: 'up', link: `nostr+walletconnect://${pk}?relay=${encodeURIComponent(RELAY)}&secret=${hex(app)}` });
