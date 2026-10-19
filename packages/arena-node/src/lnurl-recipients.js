// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE DONATION SET'S TWO LOCAL TEST RECIPIENTS, ANSWERING (M3.2 item 6e; ruled
 * 2026-09-13).
 *
 * The regtest and testnet4 test sets name two LNURL-pay recipients at a fixed
 * local address, http://127.0.0.1:18777/lnurlp/blwp-test-a and .../blwp-test-b.
 * Measured before this: nothing listened there, so a paid round's page asked
 * both and each share came back "the recipient's endpoint did not answer".
 * This is what a launcher binds there: LUD-06's two answers - the pay request
 * (tag, callback, metadata, the sendable range, commentAllowed 64 so the
 * player's key fits as the comment) and, at the callback, an invoice of exactly
 * the amount asked under SHA-256 of that recipient's metadata, made by the
 * `invoice` it is handed (a Lightning node's). Handed none, it answers the pay
 * request and refuses to invoice, by name - it never makes one up.
 *
 * LOCAL TEST RECIPIENTS ONLY: never a production recipient, never 6d.
 * CORS is open, because the page that pays is served from another origin.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export const TEST_RECIPIENT_NAMES = ['blwp-test-a', 'blwp-test-b'];
export const TEST_RECIPIENT_PORT = 18777;
const OPEN = { 'access-control-allow-origin': '*' };

/** What each recipient's invoices are hashed over (LUD-06: raw JSON, text/plain first). */
export const recipientMetadata = (name) => JSON.stringify([['text/plain', `BLWP local test donation recipient ${name}`]]);

/**
 * Binds the recipients at `host:port` and answers `{ port, base, issued, refused, close }`.
 * `invoice({ amountMsat, descriptionHash })` answers `{ request }`.
 */
export function serveDonationRecipients({ host = '127.0.0.1', port = TEST_RECIPIENT_PORT, names = TEST_RECIPIENT_NAMES,
  invoice = null, minSendable = 1, maxSendable = 100000000000 } = {}) {
  const issued = [];
  const refused = [];
  let base = null;
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...OPEN }); res.end(JSON.stringify(body)); };
      const refuse = (reason) => { refused.push(reason); return json(200, { status: 'ERROR', reason }); };
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...OPEN, 'access-control-allow-methods': 'GET' }); return res.end(); }
      const u = new URL(req.url, 'http://local');
      const m = u.pathname.match(/^\/lnurlp\/([a-z0-9-]+)(\/cb)?$/);
      if (req.method !== 'GET' || !m || !names.includes(m[1])) return json(404, { status: 'ERROR', reason: 'no such recipient here' });
      const name = m[1];
      const metadata = recipientMetadata(name);
      if (!m[2]) return json(200, { tag: 'payRequest', callback: `${base}/lnurlp/${name}/cb`, metadata, minSendable, maxSendable, commentAllowed: 64 });
      const said = u.searchParams.get('amount') || '';
      if (!/^\d{1,15}$/.test(said)) return refuse('the amount is a whole number of millisatoshi');
      const amountMsat = BigInt(said);
      if (amountMsat < BigInt(minSendable) || amountMsat > BigInt(maxSendable))
        return refuse(`${amountMsat} msat is outside ${minSendable}..${maxSendable}`);
      if (typeof invoice !== 'function') return refuse('this local test recipient has no Lightning node to invoice from');
      let made;
      try { made = await invoice({ amountMsat, descriptionHash: new Uint8Array(createHash('sha256').update(metadata).digest()) }); }
      catch (e) { return refuse(`the Lightning node made no invoice: ${String(e.message).slice(0, 160)}`); }
      issued.push({ name, amountMsat, comment: u.searchParams.get('comment'), request: made.request });
      return json(200, { pr: made.request, routes: [] });
    });
    server.on('error', reject);
    server.listen(port, host, () => {
      base = `http://${host}:${server.address().port}`;
      resolve({ port: server.address().port, base, issued, refused, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
