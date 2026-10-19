// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE WITHOUT ITS OWN BITCOIN CORE (ruling 4: the Electrum option, since testnet4 Electrum servers exist). The seat
// reads its chain through bitcoind's JSON-RPC (arena-node/src/chain-rpc.js) and needs whole blocks - a census is read from the bonds
// and adverts in them - which an Electrum server does not serve. This bridge answers the seat's calls on 127.0.0.1:
//
//   headers  from the Electrum server: each linked to its parent and its proof of work checked against its own bits
//   blocks   from Esplora (mempool.space's testnet4 API): kept only when the 80 bytes hash to the header's block, the
//            transactions hash to its merkle root and their witnesses to the coinbase's witness commitment (BIP141) - Esplora
//            cannot hand over a byte the header does not commit to (measured: a flipped witness byte passed the merkle root alone)
//   txs      from the Electrum server, kept only when they hash to the txid asked for
//
// The calls answered: getblockchaininfo, getblockcount, getblockhash, getblockheader (verbose and not), getblock (raw), getrawtransaction
// (raw, with a block hash). A wallet call is refused by name: a seat that funds rounds or posts bonds needs a Bitcoin Core of its own.
// Blocks are kept on disk (a census window of 2,016 testnet4 blocks measured 2026-10-18: ~25 MB) so a restart reads none again.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { electrumSession, TESTNET4_GENESIS } from './chain-test.js';

export const ESPLORA_TESTNET4 = 'https://mempool.space/testnet4/api';
export const BLOCK_CACHE_BYTES = 200 * 1048576;

const sha256d = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const display = (b) => Buffer.from(b).reverse().toString('hex');

/** The proof of work of an 80-byte header: its hash, as a number, at or below the target its bits name. */
export function powOk(header) {
  const bits = header.readUInt32LE(72);
  const exp = bits >>> 24, mant = BigInt(bits & 0x007fffff);
  const target = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
  return BigInt('0x' + display(sha256d(header))) <= target;
}

/** A transaction's txid (witness stripped), its wtxid (all of it), whether it has witnesses, its coinbase witness, and its end. */
export function readTx(buf, at) {
  const start = at;
  const varint = () => { const f = buf[at]; if (f < 0xfd) { at += 1; return f; } if (f === 0xfd) { const v = buf.readUInt16LE(at + 1); at += 3; return v; }
    if (f === 0xfe) { const v = buf.readUInt32LE(at + 1); at += 5; return v; } const v = Number(buf.readBigUInt64LE(at + 1)); at += 9; return v; };
  at += 4;
  const segwit = buf[at] === 0 && buf[at + 1] === 1;
  if (segwit) at += 2;
  const insStart = at;
  const nIn = varint();
  for (let i = 0; i < nIn; i++) { at += 36; const l = varint(); at += l + 4; }
  const nOut = varint();
  for (let i = 0; i < nOut; i++) { at += 8; const l = varint(); at += l; }
  const ioEnd = at;
  const outs = [];
  { let o = insStart; const vi = () => { const f = buf[o]; if (f < 0xfd) { o += 1; return f; } if (f === 0xfd) { const v = buf.readUInt16LE(o + 1); o += 3; return v; } const v = buf.readUInt32LE(o + 1); o += 5; return v; };
    const ni = vi(); for (let i = 0; i < ni; i++) { o += 36; const l = vi(); o += l + 4; }
    const no = vi(); for (let i = 0; i < no; i++) { o += 8; const l = vi(); outs.push(buf.subarray(o, o + l)); o += l; } }
  const firstWitness = [];
  if (segwit) for (let i = 0; i < nIn; i++) { const n = varint(); for (let k = 0; k < n; k++) { const l = varint(); if (i === 0) firstWitness.push(buf.subarray(at, at + l)); at += l; } }
  at += 4;
  const stripped = segwit ? Buffer.concat([buf.subarray(start, start + 4), buf.subarray(insStart, ioEnd), buf.subarray(at - 4, at)]) : buf.subarray(start, at);
  return { txid: sha256d(stripped), wtxid: sha256d(buf.subarray(start, at)), segwit, outs, firstWitness, end: at };
}

/** Do a raw block's 80 bytes hash to `hash` and its transactions to the header's merkle root? */
export function blockMatches(raw, hash) {
  if (raw.length < 81 || display(sha256d(raw.subarray(0, 80))) !== hash) return false;
  let at = 80;
  const f = raw[at];
  let n; if (f < 0xfd) { n = f; at += 1; } else if (f === 0xfd) { n = raw.readUInt16LE(at + 1); at += 3; } else { n = raw.readUInt32LE(at + 1); at += 5; }
  const txs = [];
  for (let i = 0; i < n; i++) { const t = readTx(raw, at); txs.push(t); at = t.end; }
  if (at !== raw.length || !txs.length) return false;
  if (Buffer.compare(merkleRoot(txs.map((t) => t.txid)), raw.subarray(36, 68)) !== 0) return false;
  // THE WITNESSES (BIP141): with any in the block, the coinbase's last aa21a9ed output names sha256d(witness root || reserved value)
  if (!txs.some((t) => t.segwit)) return true;
  const commit = [...txs[0].outs].reverse().find((o) => o.length >= 38 && o[0] === 0x6a && o[1] === 0x24 && o.readUInt32BE(2) === 0xaa21a9ed);
  if (!commit || txs[0].firstWitness.length !== 1 || txs[0].firstWitness[0].length !== 32) return false;
  const root = merkleRoot([Buffer.alloc(32), ...txs.slice(1).map((t) => t.wtxid)]);
  return Buffer.compare(sha256d(Buffer.concat([root, txs[0].firstWitness[0]])), commit.subarray(6, 38)) === 0;
}
const merkleRoot = (hashes) => {
  let level = hashes;
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i], level[i + 1]])));
    level = next;
  }
  return level[0];
};

/**
 * The bridge. `electrum`: { host, port, tls }. `home`: where the cookie and the block cache live. Injectables for the tests:
 * `session` (an Electrum session factory), `fetcher` (Esplora). Answers { listen(port), close(), call(method, params) }.
 */
export function createBridge({ electrum, home, esplora = ESPLORA_TESTNET4, session = electrumSession, fetcher = fetch, cacheBytes = BLOCK_CACHE_BYTES, log = () => {} }) {
  const blocksDir = join(home, 'bridge-blocks');
  mkdirSync(blocksDir, { recursive: true });
  const headers = new Map();       // height -> { hash, header (Buffer) }
  const heightOf = new Map();      // hash -> height
  let tip = null, s = null, opening = null;
  const conn = async () => {
    if (s) return s;
    if (!opening) opening = session({ ...electrum, timeoutMs: 20000 }).then((x) => { s = x; opening = null; return x; }, (e) => { opening = null; throw e; });
    return opening;
  };
  const ask = async (method, params) => {
    try { return await (await conn()).call(method, params); }
    catch (e) { if (s) { try { s.close(); } catch { /* gone */ } } s = null; throw new Error(`the Electrum server ${electrum.host}:${electrum.port}: ${e.message}`); }
  };
  const putHeader = (height, header) => {
    const hash = display(sha256d(header));
    if (height === 0 && hash !== TESTNET4_GENESIS) throw new Error('the Electrum server is not on testnet4');
    if (height > 0 && !powOk(header)) throw new Error(`header ${height} fails its own proof of work`);
    const parent = headers.get(height - 1);
    if (parent && display(header.subarray(4, 36)) !== parent.hash) { for (const h of [...headers.keys()]) if (h >= height - 1) { heightOf.delete(headers.get(h).hash); headers.delete(h); } }
    headers.set(height, { hash, header }); heightOf.set(hash, height);
    return hash;
  };
  const headerAt = async (height) => {
    const had = headers.get(height);
    if (had && tip !== null && height <= tip - 12) return had;   // deep: kept; near the tip: asked again (a reorg is followed)
    const hex = await ask('blockchain.block.header', [height]);
    putHeader(height, Buffer.from(hex, 'hex'));
    return headers.get(height);
  };
  const tipNow = async () => { const t = await ask('blockchain.headers.subscribe', []); tip = t.height; putHeader(t.height, Buffer.from(t.hex, 'hex')); return t.height; };
  const heightOfHash = async (hash) => {
    if (heightOf.has(hash)) return heightOf.get(hash);
    const r = await fetcher(`${esplora}/block/${hash}/status`, { signal: AbortSignal.timeout(15000) });
    const st = await r.json().catch(() => null);
    if (!st || !st.in_best_chain || !Number.isInteger(st.height)) throw Object.assign(new Error('Block not found'), { code: -5 });
    const h = await headerAt(st.height);
    if (h.hash !== hash) throw Object.assign(new Error('Block not found'), { code: -5 });   // the header source decides, not Esplora
    return st.height;
  };
  const medianTime = async (height) => {
    const times = [];
    for (let h = height; h > height - 11 && h >= 0; h--) times.push((await headerAt(h)).header.readUInt32LE(68));
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  };
  const blockFile = (hash) => join(blocksDir, `${hash}.bin`);
  const trimCache = () => {
    const files = readdirSync(blocksDir).map((f) => { const st = statSync(join(blocksDir, f)); return { f, size: st.size, t: st.mtimeMs }; }).sort((a, b) => a.t - b.t);
    let total = files.reduce((a, x) => a + x.size, 0);
    for (const x of files) { if (total <= cacheBytes) break; rmSync(join(blocksDir, x.f), { force: true }); total -= x.size; }
  };
  let writes = 0;
  const rawBlock = async (hash) => {
    if (existsSync(blockFile(hash))) return readFileSync(blockFile(hash));
    await heightOfHash(hash);                          // the header source knows this block on its best chain
    const r = await fetcher(`${esplora}/block/${hash}/raw`, { signal: AbortSignal.timeout(30000) });
    if (r.status !== 200) throw new Error(`Esplora answered ${r.status} for block ${hash}`);
    const raw = Buffer.from(await r.arrayBuffer());
    if (!blockMatches(raw, hash)) throw new Error(`Esplora's block ${hash} does not match its header`);
    writeFileSync(blockFile(hash), raw);
    if (++writes % 200 === 0) trimCache();
    return raw;
  };

  const METHODS = {
    getblockchaininfo: async () => { const h = await tipNow(); return { chain: 'testnet4', blocks: h, headers: h, bestblockhash: headers.get(h).hash, initialblockdownload: false, pruned: false, bridge: `electrum ${electrum.host}:${electrum.port}` }; },
    getblockcount: async () => tipNow(),
    getblockhash: async ([height]) => {
      if (tip === null) await tipNow();
      if (!Number.isInteger(height) || height < 0 || height > tip) throw Object.assign(new Error('Block height out of range'), { code: -8 });
      return (await headerAt(height)).hash;
    },
    getblockheader: async ([hash, verbose = true]) => {
      const height = await heightOfHash(hash);
      const { header } = await headerAt(height);
      if (verbose === false) return header.toString('hex');
      if (tip === null || height > tip) await tipNow();
      return { hash, height, confirmations: tip - height + 1, version: header.readInt32LE(0), merkleroot: display(header.subarray(36, 68)), time: header.readUInt32LE(68),
        mediantime: await medianTime(height), bits: header.readUInt32LE(72).toString(16).padStart(8, '0'), nonce: header.readUInt32LE(76),
        previousblockhash: height ? display(header.subarray(4, 36)) : undefined };
    },
    getblock: async ([hash, verbosity = 1]) => {
      if (verbosity !== 0) throw Object.assign(new Error('the chain bridge serves raw blocks only (verbosity 0)'), { code: -32601 });
      return (await rawBlock(hash)).toString('hex');
    },
    // THE OWNER'S BOND WITHDRAWAL is sent through the Electrum server, which refuses an invalid one itself
    sendrawtransaction: async ([hex]) => String(await ask('blockchain.transaction.broadcast', [String(hex)])),
    getrawtransaction: async ([txid, verbose = false]) => {
      if (verbose) throw Object.assign(new Error('the chain bridge serves raw transactions only'), { code: -32601 });
      const hex = await ask('blockchain.transaction.get', [txid, false]);
      const raw = Buffer.from(hex, 'hex');
      if (display(readTx(raw, 0).txid) !== txid) throw new Error(`the Electrum server's transaction ${txid} does not hash to it`);
      return hex;
    },
  };

  async function call(method, params = []) {
    const m = METHODS[method];
    if (!m) throw Object.assign(new Error(`${method} is not served in Electrum mode: a seat that funds rounds or posts bonds needs its own Bitcoin Core`), { code: -32601 });
    return m(params);
  }

  // THE COOKIE: what main.js reads (ARENA_BITCOIND_COOKIE), new at every start, the user's only
  const cookiePath = join(home, 'bridge.cookie');
  const cookie = `__cookie__:${randomBytes(24).toString('hex')}`;
  writeFileSync(cookiePath, cookie + '\n', { mode: 0o600 });
  const server = http.createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      if (req.headers.authorization !== `Basic ${Buffer.from(cookie).toString('base64')}`) { res.writeHead(401); return res.end(); }
      let id = null, out;
      try {
        const q = JSON.parse(b); id = q.id;
        out = { result: await call(q.method, q.params || []), error: null, id };
      } catch (e) { out = { result: null, error: { code: e.code || -1, message: e.message }, id }; log(`[bridge] ${e.message}`); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return {
    call, cookiePath,
    listen: (port) => new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server.address().port))),
    close: () => { server.close(); if (s) s.close(); },
  };
}
