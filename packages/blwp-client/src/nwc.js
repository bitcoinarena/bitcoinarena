// THE PLAYER'S WALLET, REACHED OVER NOSTR WALLET CONNECT (NIP-47).
//
// M3.2 item 6. The client could already ask what a seat owes and refuse a quote
// its own entry did not sign; it could not pay. This is the one thing in the
// whole client that moves a satoshi.
//
// THE WALLET STAYS OUTSIDE, which is §24's first rule: "the wallet seed never
// enters the game; the wallet stays external". What the player pastes is a
// CONNECTION secret - a key their wallet issued for this connection and can
// revoke - and it is all this file ever holds. No seed, no mnemonic, no channel.
//
// AND THE BINDING IS NOT THE PERMISSION. §24 again, and §24A.1 repeats it
// because it is the thing that will be got wrong: "an NWC budget is wallet-side
// policy and encodes nothing about the round... The protocol binds the stake to
// the Entry Contract via `payment_hash`, not via wallet permissions." So a
// budget bounds the loss if this client is compromised and proves nothing about
// what was paid for. The proof is that `Client.payStake` pays the invoice its
// OWN entry's quote produced, and this file is handed one bolt11 and one only.
//
// NIP-04 AND NOT NIP-44, NAMED SO IT DOES NOT LOOK DECIDED FOREVER. NIP-47 was
// specified over NIP-04 and it is what wallets in the field still accept; NIP-44
// is the newer scheme and some now prefer it. This implements NIP-04 - AES-256-
// CBC over the ECDH x-coordinate - through WebCrypto, the same door `seal.js`
// already opens for AES-GCM, so it adds no dependency. When enough wallets have
// moved, this is the file that changes.
//
// THE CURVE IS INJECTED, like everywhere else in this package: `@blwp/client`
// carries no crypto, and `page-curve.js` is what the page loads beside it.
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

// `webcrypto` AND NOT `subtle`, which `seal.js` already declares at its own top
// level. The bundle is a concatenation - `tools/bundle.js` refuses two private
// names that collide, and it refused this one - so a helper here has to be
// named for a file that will sit beside every other.
const webcrypto = () => {
  // BARE `crypto`, NOT `globalThis.crypto`. `discovery.test.js` refuses any
  // `globalThis.` in this package - a client that reads anything off the page
  // is a client that can be told where to send things - and the neighbours
  // here already use bare `fetch` and bare `WebSocket` for the same reason.
  const c = typeof crypto !== 'undefined' && crypto.subtle;
  if (!c) throw new Error('this page has no WebCrypto, so it can talk to no wallet');
  return c;
};
const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);
const b64 = (b) => btoa(String.fromCharCode(...b));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** NIP-47's two kinds: a request to the wallet and its answer. */
export const NWC_REQUEST = 23194;
export const NWC_RESPONSE = 23195;

/**
 * WHAT THE PLAYER PASTED, TAKEN APART.
 *
 * `nostr+walletconnect://<wallet pubkey>?relay=<url>&secret=<hex>`. Every part
 * is required and a missing one is refused BY NAME rather than defaulted: a
 * connection with no relay is not a connection to a wallet that happens to be
 * offline, it is a string that cannot reach anything, and telling the player
 * which half is wrong is the difference between fixing it and giving up.
 */
export function parseConnection(uri) {
  if (typeof uri !== 'string' || !uri.trim())
    return { ok: false, why: 'there is no connection string to a wallet' };
  let url;
  try { url = new URL(uri.trim()); }
  catch { return { ok: false, why: 'that is not a wallet connection string' }; }

  if (url.protocol !== 'nostr+walletconnect:')
    return {
      ok: false,
      why: `that string is ${url.protocol.replace(/:$/, '')} and a wallet connection is `
        + 'nostr+walletconnect',
    };

  // THE WALLET'S KEY IS THE HOST, and browsers lower-case a host - which is
  // harmless for hex and would not be for anything else. `pathname` carries it
  // when the string was written with no slashes, so both shapes are read.
  const walletHex = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletHex))
    return { ok: false, why: 'that connection names no 32-byte wallet key' };

  const relay = url.searchParams.get('relay');
  if (!relay) return { ok: false, why: 'that connection names no relay to reach the wallet through' };
  let relayUrl;
  try { relayUrl = new URL(relay); }
  catch { return { ok: false, why: `that connection's relay is not a URL: ${relay}` }; }
  if (!/^wss?:$/.test(relayUrl.protocol))
    return { ok: false, why: `a relay is ws or wss, and that one is ${relayUrl.protocol.replace(/:$/, '')}` };

  const secretHex = (url.searchParams.get('secret') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secretHex))
    return { ok: false, why: 'that connection carries no 32-byte secret, so it can sign nothing' };

  return {
    ok: true,
    walletPubkey: fromHex(walletHex),
    relay: relayUrl.toString(),
    secret: fromHex(secretHex),
    // The budget a wallet may have attached, carried for DISPLAY only. §24A.1:
    // it is wallet-side policy and encodes nothing about the round.
    budget: url.searchParams.get('budget') || null,
  };
}

/**
 * NIP-04: AES-256-CBC over the ECDH x-coordinate, base64, `?iv=` base64.
 *
 * The shared secret is the x of `theirs * mine`, which is exactly what
 * `page-curve.ecdhShared` already computes for the sealed VSS shares - one
 * agreement, two uses, and no second implementation of it here.
 */
export async function nip04Encrypt(plaintext, { secret, theirPubkey, curve, random }) {
  const shared = curve.ecdhShared(secret, theirPubkey);
  const key = await webcrypto().importKey('raw', shared, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = random(16);
  const sealed = new Uint8Array(
    await webcrypto().encrypt({ name: 'AES-CBC', iv }, key, utf8(plaintext)));
  return `${b64(sealed)}?iv=${b64(iv)}`;
}

export async function nip04Decrypt(content, { secret, theirPubkey, curve }) {
  const at = String(content).indexOf('?iv=');
  if (at < 0) return { ok: false, why: 'that answer carries no iv, so it is not NIP-04' };
  let plain;
  try {
    const shared = curve.ecdhShared(secret, theirPubkey);
    const key = await webcrypto().importKey('raw', shared, { name: 'AES-CBC' }, false, ['decrypt']);
    const iv = unb64(content.slice(at + 4));
    plain = new Uint8Array(await webcrypto().decrypt({ name: 'AES-CBC', iv },
      key, unb64(content.slice(0, at))));
  } catch (e) {
    return { ok: false, why: `that answer would not open: ${e.message}` };
  }
  return { ok: true, plaintext: fromUtf8(plain) };
}

/**
 * A SIGNED NOSTR EVENT (NIP-01).
 *
 * The id is the sha256 of a canonical array - `[0, pubkey, created_at, kind,
 * tags, content]` - and the signature is BIP-340 over that id. Both are the
 * protocol's own shapes and neither is negotiable: a relay drops an event whose
 * id is not the hash of its own fields.
 */
export async function signEvent({ kind, tags, content, secret, curve, now }) {
  const pubkey = toHex(curve.pointX(secret));
  const createdAt = Math.floor((now ? now() : Date.now()) / 1000);
  const serialised = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const id = sha256(utf8(serialised));
  const sig = curve.signSchnorr(id, secret);
  return {
    id: toHex(id), pubkey, created_at: createdAt, kind, tags, content, sig: toHex(sig),
  };
}

/**
 * ONE ROUND TRIP TO THE WALLET, AND ONE ONLY.
 *
 * SUBSCRIBE BEFORE PUBLISH, and that ordering is the whole of whether this
 * works: the wallet answers as soon as it sees the request, and a client that
 * published first and listened afterwards would miss an answer that arrived in
 * between - on a fast relay, most of them. The event id is known before it is
 * sent, so the filter can name it.
 */
export function nwcCall(where, request, { curve, random, now, timeoutMs = 30000,
  WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null } = {}) {
  return new Promise((resolve) => {
    let sock;
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (sock) sock.close(); } catch { /* going away anyway */ }
      resolve(answer);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `the wallet did not answer in ${timeoutMs} ms` }), timeoutMs);

    if (!WebSocketImpl)
      return finish({ ok: false, why: 'this page has no WebSocket, so it can reach no relay' });
    try { sock = new WebSocketImpl(where.relay); }
    catch (e) { return finish({ ok: false, why: `that relay would not open: ${e.message}` }); }

    sock.addEventListener('error', () => finish({ ok: false, why: 'that relay would not open' }));
    sock.addEventListener('close', () =>
      finish({ ok: false, why: 'that relay closed before the wallet answered' }));

    sock.addEventListener('open', async () => {
      let event;
      try {
        const content = await nip04Encrypt(JSON.stringify(request), {
          secret: where.secret, theirPubkey: where.walletPubkey, curve, random,
        });
        event = await signEvent({
          kind: NWC_REQUEST, tags: [['p', toHex(where.walletPubkey)]],
          content, secret: where.secret, curve, now,
        });
      } catch (e) {
        return finish({ ok: false, why: `this page could not build the request: ${e.message}` });
      }

      const sub = 'blwp-' + event.id.slice(0, 16);
      sock.send(JSON.stringify(['REQ', sub, {
        kinds: [NWC_RESPONSE], authors: [toHex(where.walletPubkey)], '#e': [event.id],
      }]));
      sock.send(JSON.stringify(['EVENT', event]));
      return undefined;
    });

    sock.addEventListener('message', async (m) => {
      let frame;
      try { frame = JSON.parse(typeof m.data === 'string' ? m.data : fromUtf8(new Uint8Array(m.data))); }
      catch { return; }
      if (!Array.isArray(frame)) return;

      // A RELAY THAT REFUSED THE EVENT IS AN ANSWER TOO. Without this the
      // wallet is blamed for a timeout that the relay caused.
      if (frame[0] === 'OK' && frame[2] === false)
        return finish({ ok: false, why: `the relay refused the request: ${frame[3] || 'no reason given'}` });
      if (frame[0] !== 'EVENT' || !frame[2]) return;

      const opened = await nip04Decrypt(frame[2].content, {
        secret: where.secret, theirPubkey: where.walletPubkey, curve,
      });
      if (!opened.ok) return finish(opened);
      let said;
      try { said = JSON.parse(opened.plaintext); }
      catch (e) { return finish({ ok: false, why: `the wallet answered something that is not JSON: ${e.message}` }); }

      // THE WALLET'S OWN REFUSAL IS REPORTED, NOT TRANSLATED. "insufficient
      // balance" and "quota exceeded" are things a player can act on, and a
      // client that flattened them to "payment failed" would hide the one
      // sentence that says what to do.
      if (said.error)
        return finish({
          ok: false, code: said.error.code,
          why: `the wallet refused: ${said.error.code || 'no code'} ${said.error.message || ''}`.trim(),
        });
      return finish({ ok: true, result: said.result, resultType: said.result_type });
    });
  });
}

/**
 * PAY ONE BOLT11, AND THE INVOICE IS AN ARGUMENT BECAUSE THE CALLER CHECKED IT.
 *
 * This file does not decide what to pay. `Client.payStake` takes an ENTRY, asks
 * its own `invoice()` for the quote - which refuses an amount, a hash or a seat
 * the entry did not sign - and hands the one bolt11 that survived down here.
 * There is no path from a caller's arbitrary invoice to this function that does
 * not go through that check.
 */
export async function payInvoice(where, invoice, options = {}) {
  if (typeof invoice !== 'string' || !invoice.trim())
    return { ok: false, why: 'there is no invoice to pay' };
  const said = await nwcCall(where, {
    method: 'pay_invoice', params: { invoice: invoice.trim() },
  }, options);
  if (!said.ok) return said;
  const preimage = said.result && said.result.preimage;
  if (typeof preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(preimage))
    return { ok: false, why: 'the wallet said it paid and produced no preimage' };
  return { ok: true, preimage, feesPaidMsat: said.result.fees_paid };
}
