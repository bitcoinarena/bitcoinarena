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
import { netStakeMsat } from '../../protocol/src/payout.js';

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
    // THERE IS NO BUDGET FIELD HERE, and there was: `budget:
    // url.searchParams.get('budget')`, carried "for display only" and read by
    // nothing. NIP-47's URI carries `relay`, `secret` and optionally `lud16` -
    // no wallet attaches a budget to it, so that field was blank for every
    // wallet in the world and would have rendered a working-looking screen
    // showing nothing. The budget is wallet-side policy, exactly as §24A.1
    // says, and the only honest way to it is to ASK: `walletBudget` below.
  };
}

/**
 * THE CONNECTION THIS TAB IS USING, HELD WHERE THE PLAYER KEY IS HELD.
 *
 * `sessionStorage`, for the reason `tabSeed` uses it and one more. Per tab,
 * so two tabs are two players and neither borrows the other's wallet; gone when
 * the tab closes; and NOT `localStorage`, which every tab of a browser shares -
 * that would make one paste spend from every round open in the browser.
 *
 * IT IS A SPENDING CREDENTIAL AND NOT AN IDENTITY. The player key already in
 * this storage cannot move a satoshi; this can, up to whatever budget the
 * wallet attached. It survives a reload on purpose: §24A.1 exists to remove
 * approval friction, and a budget the player must re-authorise every refresh is
 * a budget that buys nothing. The trust boundary is where §24 puts it - the
 * budget ceiling and the wallet's own confirmation screen - not this storage.
 *
 * STORED ONLY IF IT PARSES. A string that is not a connection is not kept: a
 * page that remembered rubbish would offer to pay with it on every reload.
 */
export function tabWallet({ storage, key = 'blwp.wallet' } = {}) {
  const read = () => {
    const held = storage && storage.getItem(key);
    if (!held) return { ok: false, why: 'this tab has no wallet connected' };
    const parsed = parseConnection(held);
    if (!parsed.ok) return parsed;
    return parsed;
  };
  return {
    /** The connection this tab holds, or why it holds none. */
    current: read,
    get connected() { return read().ok; },
    /** Keep a pasted connection, if it is one. */
    connect(uri) {
      const parsed = parseConnection(uri);
      if (!parsed.ok) return parsed;
      if (storage) storage.setItem(key, String(uri).trim());
      return parsed;
    },
    /** Forget it. A player closing a wallet should not have to close the tab. */
    forget() { if (storage) storage.removeItem(key); return { ok: true }; },
  };
}

/**
 * WHAT THIS TAB HAS SPENT, AND ON WHAT.
 *
 * §24A.1 is a requirement and not advice: "a client MUST show the running total
 * and what it was spent on". So the total is kept HERE, next to the thing that
 * spends, and the page renders it - a page that added up its own numbers would
 * be showing the player a figure nobody checked.
 *
 * ONE ENTRY PER PAYMENT, and the payment hash is in it: "what it was spent on"
 * means a round and a seat, not a running number. A spend log is a display and
 * the authority for what was paid is the chain of invoices, not this.
 *
 * KEPT IN THE TAB WHEN HANDED ITS STORAGE (M3.2 6e). Measured before, on the
 * daily page: after a reload the panel said "nothing paid this session" beside
 * "1334 msat paid" while 97334 msat had left the wallet - the log was page
 * memory. Without `storage` it is page memory, as before. Each entry says what
 * it paid for (`kind`: a stake, or a donation share), and a payment hash is
 * counted once however often it is recorded.
 */
export const SPEND_LOG_KEY = 'blwp.spend.log';
/** The hold end states in which a stake comes back to the payer. */
const RETURNED = ['CANCELLED', 'EXPIRED'];

/**
 * WHAT THE SEATS SAID HAPPENED TO THIS SEAT'S STAKE, WRITTEN INTO THE LOG (M3.2 6e).
 * Measured before, on the bundle the daily page runs: a winner read "98 sat over 1
 * stake in 1 round" beside "Returned: ... cancelled back to the wallet", and a
 * refunded player the same beside "Expired: ... came back to the wallet". A hold
 * that ends CANCELLED or EXPIRED is money that came back; one that SETTLED left and
 * stays spent. `settlement` is `settlementBy`'s answer; `paymentHash` the stake's.
 */
export function noteSettlement(log, settlement, paymentHash) {
  if (!log || typeof log.markReturned !== 'function' || !settlement) return false;
  if (!RETURNED.includes(settlement.hold)) return false;
  return log.markReturned({ paymentHash, state: settlement.hold });
}

export function spendLog({ storage = null, key = SPEND_LOG_KEY } = {}) {
  const paid = [];
  const kindOf = (k) => (k === 'donation' ? 'donation' : 'stake');
  if (storage) {
    let kept = [];
    try { kept = JSON.parse(storage.getItem(key) || '[]'); } catch { kept = []; }
    for (const p of Array.isArray(kept) ? kept : []) {
      try {
        paid.push({ amountMsat: BigInt(p.amountMsat), paymentHash: p.paymentHash ? fromHex(p.paymentHash) : undefined,
          roundId: p.roundId ? fromHex(p.roundId) : undefined, at: p.at, kind: kindOf(p.kind),
          ...(RETURNED.includes(p.returned) ? { returned: p.returned } : {}) });
      } catch { /* an entry this page cannot read is not counted */ }
    }
  }
  const save = () => {
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(paid.map((p) => ({ amountMsat: String(p.amountMsat),
        paymentHash: p.paymentHash instanceof Uint8Array ? toHex(p.paymentHash) : null,
        roundId: p.roundId instanceof Uint8Array ? toHex(p.roundId) : null, at: p.at, kind: p.kind,
        ...(p.returned ? { returned: p.returned } : {}) }))));
    } catch { /* a tab that keeps nothing forgets on a reload, as before */ }
  };
  const kept = () => paid.filter((p) => !p.returned);
  return {
    /** Every payment this page has made, oldest first - a returned stake carries `returned`. */
    entries: () => paid.slice(),
    get count() { return paid.length; },
    /** Millisatoshi that left the wallet and stayed gone: a stake that came back is not in it. */
    get totalMsat() { return kept().reduce((t, p) => t + p.amountMsat, 0n); },
    /** Millisatoshi of stakes that came back (their hold CANCELLED or EXPIRED). */
    get returnedMsat() { return paid.filter((p) => p.returned).reduce((t, p) => t + p.amountMsat, 0n); },
    /**
     * A STAKE THAT CAME BACK (M3.2 6e): its hold ended CANCELLED - a winner's, handed
     * back - or EXPIRED - nobody acted, the HTLC timed out to the payer. Answers
     * whether a stake with that payment hash was marked.
     */
    markReturned({ paymentHash, state }) {
      if (!(paymentHash instanceof Uint8Array) || !RETURNED.includes(state)) return false;
      const p = paid.find((x) => x.kind === 'stake' && x.paymentHash instanceof Uint8Array && toHex(x.paymentHash) === toHex(paymentHash));
      if (!p) return false;
      if (p.returned !== state) { p.returned = state; save(); }
      return true;
    },
    record({ amountMsat, paymentHash, roundId, at, kind = 'stake' }) {
      if (paymentHash instanceof Uint8Array
        && paid.some((p) => p.paymentHash instanceof Uint8Array && toHex(p.paymentHash) === toHex(paymentHash)))
        return paid.length;
      paid.push({
        amountMsat: BigInt(amountMsat), paymentHash, roundId,
        at: at === undefined ? Date.now() : at, kind: kindOf(kind),
      });
      save();
      return paid.length;
    },
  };
}

/**
 * THE RUNNING TOTAL AS ONE LINE, so the page renders and does not compute.
 *
 * Sats rather than millisats, because that is what a player was quoted and what
 * their wallet showed them. Millisatoshi are the protocol's unit and the whole
 * of the reason this is one function rather than a template in the page: 1000
 * of them are one satoshi and the conversion is exactly the kind of thing a
 * screen gets wrong quietly.
 */
export function spentLine(log) {
  if (!log || !log.count) return 'nothing paid this session';
  // A STAKE THAT CAME BACK IS NOT SPENT (M3.2 6e): it is named, and left out of the total.
  const back = log.entries().filter((p) => p.returned);
  const backMsat = back.reduce((t, p) => t + p.amountMsat, 0n);
  const states = [...new Set(back.map((p) => p.returned.toLowerCase()))].join('/');
  const cameBack = back.length ? ` · ${backMsat % 1000n === 0n ? `${backMsat / 1000n} sat` : `${backMsat} msat`} came back `
    + `(${back.length} stake${back.length === 1 ? '' : 's'} ${states})` : '';
  const all = log.entries().filter((p) => !p.returned);
  if (!all.length) return `nothing spent this session${cameBack}`;
  const rounds = new Set(all.map((p) => toHex(p.roundId || new Uint8Array(0)))).size;
  const inRounds = ` in ${rounds} round${rounds === 1 ? '' : 's'}`;
  const donations = all.filter((p) => p.kind === 'donation').length;
  const stakes = all.length - donations;
  if (!donations) {
    const sats = log.totalMsat / 1000n;
    return `${sats} sat over ${stakes} stake${stakes === 1 ? '' : 's'}${inRounds}${cameBack}`;
  }
  // A DONATION SHARE IS NOT A STAKE (M3.2 6e): measured before, a 96 sat stake
  // and a 1334 msat share read "97 sat over 2 stakes". And the total is exact -
  // a share is rarely whole sats, and 96000 + 1334 is 97334 msat, not 97 sat.
  const t = log.totalMsat;
  const amount = t % 1000n === 0n ? `${t / 1000n} sat` : `${t} msat`;
  const parts = [];
  if (stakes) parts.push(`${stakes} stake${stakes === 1 ? '' : 's'}`);
  parts.push(`${donations} donation share${donations === 1 ? '' : 's'}`);
  return `${amount} over ${parts.join(' and ')}${inRounds}${cameBack}`;
}

/**
 * WHAT THIS SEAT COSTS, AS ONE LINE, and it is 22A's Transparency list.
 *
 * "Before wallet approval the client MUST display: total wallet commitment,
 * the node fee and donation coming OUT of it, the resulting net game stake".
 * Every number is off the ENTRY the player signed; the only thing taken from
 * the quote is what the wallet is being asked for and the hold's state, and
 * the quote reaching here has already passed `invoiceMatchesEntry` - so the
 * amount asked IS the net stake, and the line shows both so a player can see
 * that it is.
 *
 * `netStakeMsat` does the subtraction. A page that took 2 from 100 itself
 * would be a second arithmetic for the one number a player parts with money
 * over.
 */
export function owedLine(entry, quote) {
  if (!entry) return 'this seat owes —';
  let net;
  try { net = netStakeMsat(entry); } catch (e) { return `this seat cannot be paid: ${e.message}`; }
  const split = `${sats(entry.stakeMsat)} round: ${sats(entry.feeMsat)} fee and `
    + `${sats(entry.donationMsat)} donation out of it, ${sats(net)} staked`;
  return quote
    ? `${split} · the wallet is asked ${sats(quote.amountMsat)} · ${quote.state}`
    : `${split} · no quote yet`;
}

/** Whole sats where they are whole, and the millisatoshi where they are not. */
const sats = (msat) => (msat % 1000n === 0n ? `${msat / 1000n} sat` : `${msat} msat`);

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
  // A NIP-04 MESSAGE IS TEXT. AES-CBC carries no MAC, so a key the envelope was
  // not sealed to yields garbage, and about 1 in 256 of those passes the
  // padding check - measured, 15 of 4096 strangers "opened" one and were told
  // ok with U+FFFD soup. Bytes that are not UTF-8 are not a NIP-04 message, so
  // the decode is strict and they are refused, not replaced.
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(plain); }
  catch { return { ok: false, why: 'that answer is not text, so it was not sealed to this key' }; }
  return { ok: true, plaintext: text };
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
 * WHAT THIS WALLET WILL STILL LET THIS CONNECTION SPEND.
 *
 * §24A.1 asks a client to show the running total "and what it was spent on";
 * the other half of that screen is what is LEFT, and it does not live in this
 * client. §24 says why: "an NWC budget is wallet-side policy". So it is asked
 * for, over the same relay and the same encryption a payment uses.
 *
 * THREE CALLS, ALL READ-ONLY, AND NONE OF THEM CAN MOVE A SATOSHI. `get_info`
 * first, because its `methods` list is the wallet saying what it implements -
 * `get_budget` is a later addition to NIP-47 and plenty of wallets do not have
 * it, and asking blind would turn "not implemented" into an error a player
 * reads as a fault.
 *
 * A BALANCE IS NOT A BUDGET, which is why this prefers `get_budget` and says
 * which it got. A balance is what the wallet holds; a budget is what THIS
 * connection may spend before the player is asked again. Showing one where the
 * other is meant, on a screen somebody is about to spend from, is the wrong
 * number in the worst place - so the two are never merged.
 *
 * AND A WALLET THAT REPORTS NEITHER SAYS SO IN WORDS. An empty number on a
 * payment screen reads as zero, and zero is a thing a player would act on.
 */
export async function walletBudget(where, options = {}) {
  const info = await nwcCall(where, { method: 'get_info', params: {} }, options);
  if (!info.ok) return { ok: false, why: info.why };
  const methods = (info.result && Array.isArray(info.result.methods)) ? info.result.methods : [];

  if (methods.includes('get_budget')) {
    const said = await nwcCall(where, { method: 'get_budget', params: {} }, options);
    if (!said.ok) return { ok: false, why: said.why };
    const r = said.result || {};
    // A wallet may answer `get_budget` with an empty object, which NIP-47
    // allows and which means "no budget is set on this connection".
    if (r.total_budget === undefined && r.used_budget === undefined)
      return { ok: true, kind: 'none', why: 'this connection has no budget set' };
    const total = BigInt(r.total_budget || 0);
    const used = BigInt(r.used_budget || 0);
    return {
      ok: true, kind: 'budget',
      totalMsat: total, usedMsat: used,
      leftMsat: total > used ? total - used : 0n,
      renewsAt: r.renews_at || null, renewalPeriod: r.renewal_period || null,
    };
  }

  if (methods.includes('get_balance')) {
    const said = await nwcCall(where, { method: 'get_balance', params: {} }, options);
    if (!said.ok) return { ok: false, why: said.why };
    const balance = said.result && said.result.balance;
    if (balance === undefined)
      return { ok: false, why: 'the wallet answered a balance with no balance in it' };
    return { ok: true, kind: 'balance', balanceMsat: BigInt(balance) };
  }

  return {
    ok: true, kind: 'none',
    why: 'this wallet does not report a budget',
    methods,
  };
}

/**
 * THE BUDGET AS ONE LINE, so the page renders and does not compute.
 *
 * Sats rather than millisats, for `spentLine`'s reason: 1000 of them are one
 * satoshi and that conversion is what a screen gets wrong quietly. And the
 * WORD says which number it is - "budget" or "balance" - because a player
 * reading "1000 sat left" has to know whether that is this connection's
 * allowance or everything they own.
 */
export function budgetLine(budget) {
  if (!budget) return 'budget not asked for yet';
  if (!budget.ok) return `budget unknown: ${budget.why}`;
  if (budget.kind === 'budget') {
    const left = budget.leftMsat / 1000n;
    const total = budget.totalMsat / 1000n;
    return `${left} of ${total} sat budget left`;
  }
  if (budget.kind === 'balance') return `wallet balance ${budget.balanceMsat / 1000n} sat`;
  return budget.why || 'this wallet does not report a budget';
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
