#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE COMPATIBILITY CHECK (kanban #926 item 10): the same calls Bitcoin Arena makes of a Lightning wallet over Nostr Wallet Connect (NIP-47) and of a remote signer
 * (NIP-46), asked of one product, one row of the public list (src/website/www/compatibility/results.json). Run it once per product and version:
 *
 *   NAME="Product" VERSION=1.2.3 [TESTED_BY=name] [WRITE=<results.json>] node tools/compat-check.mjs nwc 'nostr+walletconnect://...'
 *   NAME="Product" VERSION=1.2.3 [WRITE=<results.json>] node tools/compat-check.mjs signer 'bunker://...'
 *
 * NWC asks get_info, get_balance and make_invoice; with PAY=<bolt11> it pays that invoice too. A signer is asked connect, get_public_key, sign_event for the two
 * kinds the page signs (27235 HTTP auth, 30078 the wallet's seed event) and a NIP-44 round trip to the user's own key, which is how the seed event is sealed.
 * A browser extension (NIP-07) has no remote door, so it is checked by hand in the page and its row written with `manual`:
 *   NAME=... VERSION=... CHECKS='login=ok,seed=ok,sign=ok' node tools/compat-check.mjs manual nip-07
 * It never prints a connection secret. The link is a password: pass it from your own shell, and revoke it after.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateSecretKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';

const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const timed = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);

/** One row from the checks: ok only when every one passed. */
export function resultRow({ name, version, kind, checks, testedBy = null, date = new Date().toISOString().slice(0, 10) }) {
  return { name: String(name), version: String(version), kind, date, testedBy, checks, result: Object.values(checks).every((c) => c === 'ok') ? 'works' : 'problems' };
}

/** The list with one row put in: a product and kind has one row, the newest. */
export function withRow(list, row) {
  return [...list.filter((r) => !(r.name === row.name && r.kind === row.kind)), row].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function parseNwc(uri) {
  const u = new URL(String(uri).replace(/^nostr\+walletconnect:\/\//, 'http://'));
  const relay = u.searchParams.get('relay'), secret = u.searchParams.get('secret');
  if (!/^[0-9a-f]{64}$/.test(u.hostname) || !relay || !/^[0-9a-f]{64}$/.test(String(secret))) throw new Error('that is not a nostr+walletconnect link');
  return { wallet: u.hostname, relay, secret: unhex(secret) };
}

/** One NIP-47 call, encrypted as the wallet's info event says (NIP-44, else NIP-04). */
export async function nwcAsk({ wallet, relay, secret }, pool, method, params = {}, ms = 20000) {
  const info = await timed(pool.get([relay], { kinds: [13194], authors: [wallet] }), ms, 'the wallet\'s info event');
  const use44 = !!(info && /nip44/.test((info.tags.find((t) => t[0] === 'encryption') || [])[1] || ''));
  const body = JSON.stringify({ method, params });
  const content = use44 ? nip44.encrypt(body, nip44.getConversationKey(secret, wallet)) : await nip04.encrypt(secret, wallet, body);
  const req = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), content, tags: [['p', wallet], ...(use44 ? [['encryption', 'nip44_v2']] : [])] }, secret);
  const answer = new Promise((done) => {
    const sub = pool.subscribeMany([relay], { kinds: [23195], authors: [wallet], '#e': [req.id] }, { onevent: (e) => { sub.close(); done(e); } });
  });
  await new Promise((r) => setTimeout(r, 400));
  await Promise.any(pool.publish([relay], req));
  const e = await timed(answer, ms, method);
  const text = use44 || !e.content.includes('?iv=') ? nip44.decrypt(e.content, nip44.getConversationKey(secret, wallet)) : await nip04.decrypt(secret, wallet, e.content);
  const a = JSON.parse(text);
  if (a.error) throw new Error(`${a.error.code}: ${a.error.message}`);
  return a.result;
}

export async function checkNwc(link, { pay = null } = {}) {
  const c = parseNwc(link), pool = new SimplePool(), checks = {};
  const one = async (name, method, params, ok) => { try { const r = await nwcAsk(c, pool, method, params); checks[name] = ok(r) ? 'ok' : 'odd answer'; } catch (e) { checks[name] = String(e.message).slice(0, 120); } };
  await one('get_info', 'get_info', {}, (r) => !!r);
  await one('get_balance', 'get_balance', {}, (r) => Number.isFinite(Number(r.balance)));
  await one('make_invoice', 'make_invoice', { amount: 1000, description: 'Bitcoin Arena compatibility check' }, (r) => /^ln/.test(String(r.invoice)));
  if (pay) await one('pay_invoice', 'pay_invoice', { invoice: pay }, (r) => /^[0-9a-f]{64}$/.test(String(r.preimage)));
  pool.close([c.relay]);
  return checks;
}

export async function checkSigner(link) {
  const bp = await parseBunkerInput(link);
  if (!bp) throw new Error('that is not a bunker:// link');
  const pool = new SimplePool(), checks = {};
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool });
  const step = async (name, run) => { try { checks[name] = (await timed(run(), 60000, name)) ? 'ok' : 'odd answer'; } catch (e) { checks[name] = String(e.message).slice(0, 120); } };
  let me = null;
  await step('connect', async () => { await signer.connect(); return true; });
  await step('get_public_key', async () => { me = await signer.getPublicKey(); return /^[0-9a-f]{64}$/.test(me); });
  const signs = (kind, tags, content) => async () => verifyEvent(await signer.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content }));
  await step('sign_event 27235', signs(27235, [['u', 'https://bitcoinarena.io/'], ['method', 'GET']], ''));
  await step('sign_event 30078', signs(30078, [['d', 'bitcoin-arena/compat-check']], 'check'));
  await step('nip44 to self', async () => (await signer.nip44Decrypt(me, await signer.nip44Encrypt(me, 'check'))) === 'check');
  await signer.close();
  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, link] = process.argv.slice(2), env = process.env;
  if (!env.NAME || !env.VERSION) { console.error('NAME and VERSION: which product was tested'); process.exit(2); }
  let kind, checks;
  if (mode === 'nwc') { kind = 'NWC wallet'; checks = await checkNwc(link, { pay: env.PAY || null }); }
  else if (mode === 'signer') { kind = 'Remote signer'; checks = await checkSigner(link); }
  else if (mode === 'manual') { kind = 'Browser extension'; checks = Object.fromEntries(String(env.CHECKS || '').split(',').filter(Boolean).map((x) => x.split('='))); }
  else { console.error('nwc, signer or manual'); process.exit(2); }
  const row = resultRow({ name: env.NAME, version: env.VERSION, kind, checks, testedBy: env.TESTED_BY || null });
  console.log(JSON.stringify(row));
  if (env.WRITE) { const list = existsSync(env.WRITE) ? JSON.parse(readFileSync(env.WRITE, 'utf8')) : []; writeFileSync(env.WRITE, `${JSON.stringify(withRow(list, row), null, 1)}\n`); }
  process.exit(row.result === 'works' ? 0 : 1);
}
