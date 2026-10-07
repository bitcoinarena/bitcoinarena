// THE PAGE FOR THE PAID-PICK RUN (kanban #206), on the test host: the built page (round-2of2's servePage, as every live-page run
// serves it) behind one more door - /harness-invoice?msat=N, an invoice for exactly N msat made by alice's lnd, the player's
// own wallet here, which the page's Withdraw is handed as its invoice maker (BLWP_WITHDRAW takes a function).
//   BUILD=<page dir> LNCLI=<lncli> ALICE_DIR=<lnddir> ALICE_RPC=<host:port> PORT=29600 node page-server.mjs
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { servePage } from '../../blwp-node/tools/round-2of2.mjs';
const env = process.env;
const inner = await servePage(env.BUILD, { host: '127.0.0.1', port: 0 });
const invoice = (msat) => new Promise((ok) => execFile(env.LNCLI, [`--lnddir=${env.ALICE_DIR}`, `--rpcserver=${env.ALICE_RPC}`, '--network=regtest',
  'addinvoice', `--amt_msat=${msat}`, '--memo=blwp #206 withdraw'], { timeout: 60000 }, (e, so) => ok(e ? { error: e.message } : JSON.parse(so))));
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://h');
  if (u.pathname === '/harness-invoice') {
    const msat = u.searchParams.get('msat');
    const made = /^\d+$/.test(msat || '') ? await invoice(msat) : { error: 'msat' };
    console.log(JSON.stringify({ at: new Date().toISOString(), invoiceFor: msat, made: made.payment_request ? 'ok' : made.error }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ payment_request: made.payment_request || null, msat, error: made.error || null }));
  }
  const p = request({ host: '127.0.0.1', port: inner.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(p);
}).listen(Number(env.PORT || 29600), '127.0.0.1', () => console.log(JSON.stringify({ page: `http://127.0.0.1:${env.PORT || 29600}`, inner: inner.port })));
