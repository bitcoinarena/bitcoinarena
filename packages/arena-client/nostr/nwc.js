// NOSTR WALLET CONNECT FOR DEPOSITS (2026-10-09: "Wallet connect if they already have one"; 2026-10-10:
// "Also nwc for deposits is part of the scope"). The player's own wallet (Alby Hub, Coinos, Primal, Mutiny...) pays the
// deposit invoice the page made: one tap, no copying, no QR. NIP-47: the wallet's connection link
// nostr+walletconnect://<wallet pubkey>?relay=<wss>&secret=<hex> gives a key this page signs requests with; a request is a
// kind 23194 event to the wallet, encrypted to it; its answer a kind 23195 event tagged with the request's id. Encryption is
// NIP-44 when the wallet's info event (kind 13194) says "nip44_v2", else NIP-04 (the older wallets).
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';

const unhex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));

/** The connection link, read: { walletPubkey, relays, secret (32 bytes), lud16 } - or why not. */
export function parseNwc(uri) {
  const s = String(uri || '').trim();
  const m = /^(?:nostr\+walletconnect|nostrwalletconnect):\/\/([0-9a-f]{64})\?(.*)$/i.exec(s);
  if (!m) throw new Error('that is not a Nostr Wallet Connect link (nostr+walletconnect://...) - copy it from your wallet\'s "connect an app" page');
  const q = new URLSearchParams(m[2]);
  const relays = q.getAll('relay').filter((r) => /^wss?:\/\//.test(r));
  const secret = q.get('secret') || '';
  if (!relays.length) throw new Error('that wallet link names no relay');
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('that wallet link has no secret');
  return { walletPubkey: m[1].toLowerCase(), relays, secret: unhex(secret.toLowerCase()), lud16: q.get('lud16') || null };
}

/** The wallet's info event (kind 13194): the methods it allows and the encryptions it speaks. */
export async function nwcInfo(uri, { pool = new SimplePool(), maxWait = 4000 } = {}) {
  const c = parseNwc(uri);
  const ev = (await pool.querySync(c.relays, { kinds: [13194], authors: [c.walletPubkey] }, { maxWait })).sort((a, b) => b.created_at - a.created_at)[0];
  if (!ev) return { methods: null, encryption: ['nip04'] };
  const enc = (ev.tags.find((t) => t[0] === 'encryption') || [])[1];
  return { methods: String(ev.content || '').split(/\s+/).filter(Boolean), encryption: enc ? enc.split(/\s+/) : ['nip04'] };
}

/** One NIP-47 request: { method, params } -> the wallet's `result`, or its error as an Error (code and message). */
export async function nwcRequest(uri, method, params = {}, { pool = new SimplePool(), timeoutMs = 60000, info = null } = {}) {
  const c = parseNwc(uri);
  const i = info || await nwcInfo(uri, { pool });
  const use44 = i.encryption.includes('nip44_v2');
  const plain = JSON.stringify({ method, params });
  const content = use44 ? nip44.encrypt(plain, nip44.getConversationKey(c.secret, c.walletPubkey)) : await nip04.encrypt(c.secret, c.walletPubkey, plain);
  const req = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), content,
    tags: [['p', c.walletPubkey], ...(use44 ? [['encryption', 'nip44_v2']] : [])] }, c.secret);
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sub.close(); reject(new Error(`your wallet did not answer in ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    const sub = pool.subscribeMany(c.relays, { kinds: [23195], authors: [c.walletPubkey], '#e': [req.id] }, {
      onevent: async (ev) => {
        let body;
        try {
          const text = use44 ? nip44.decrypt(ev.content, nip44.getConversationKey(c.secret, c.walletPubkey)) : await nip04.decrypt(c.secret, c.walletPubkey, ev.content);
          body = JSON.parse(text);
        } catch (e) { clearTimeout(timer); sub.close(); reject(new Error(`your wallet's answer did not read: ${e.message}`)); return; }
        clearTimeout(timer); sub.close();
        if (body.error) { const e = new Error(`your wallet said: ${body.error.message || body.error.code}`); e.code = body.error.code; reject(e); }
        else resolve(body.result || {});
      },
    });
  });
  const took = (await Promise.allSettled(pool.publish(c.relays, req))).filter((r) => r.status === 'fulfilled').length;
  if (!took) throw new Error('your wallet\'s relay did not take the request');
  return answer;
}

/** PAY THE DEPOSIT: the invoice paid by the player's wallet; answers { preimage }. */
export async function nwcPay(uri, invoice, opts = {}) {
  if (!/^ln[a-z0-9]+$/i.test(String(invoice || ''))) throw new Error('that is not a Lightning invoice');
  const r = await nwcRequest(uri, 'pay_invoice', { invoice: String(invoice) }, opts);
  if (!r.preimage) throw new Error('your wallet answered without a payment proof');
  return { preimage: r.preimage, feesPaidMsat: r.fees_paid ?? null };
}
/** The wallet's balance in msat (when it allows get_balance). */
export const nwcBalance = async (uri, opts = {}) => (await nwcRequest(uri, 'get_balance', {}, opts)).balance;
/** The wallet's own name and network (get_info): checked when the link is connected. */
export const nwcGetInfo = (uri, opts = {}) => nwcRequest(uri, 'get_info', {}, opts);
/** The page's public key for this link (what the wallet shows as the connected app). */
export const nwcAppKey = (uri) => getPublicKey(parseNwc(uri).secret);
