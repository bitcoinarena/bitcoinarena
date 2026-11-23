// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND POSTED ON CHAIN (kanban #3256, the owner 2026-11-21: "When are the rounds posted on the chain?"). Each Orange Pill Run round is
// announced the Arena's way: one testnet4 transaction with one OP_RETURN, "ARN" and a kind byte as every other ARN payload has (ballot "ARNV",
// advert "ARNA", fork "ARNF"), here "ARN" 'O'. 80 bytes at most (the OP_RETURN limit). Big-endian integers. The payload:
//
//   "ARNO" (4) | format 1 (1) | flags (1: bit 0 = test round) | round number (u32) | start ms (u48) | end ms (u48) | entry sats (u32; 0: a free round, #3273)
//   | attempt limit (u8) | pot split (3 x u8, percent) | chart day (u16, days since 1970-01-01) | game version (u8 length + ASCII, at most 15)
//   | level hash (32: sha256 of the level's canonical JSON, levelHashOf)
//
// Funded, signed and sent by a bitcoind wallet of its own (OPR_WALLET, never a seat's signing key), then listed for miner C: testnet4 blocks
// here are mined by miner C, which includes only listed txids (OPR_PENDING_FILE, read by ops/pending-to-minerc.sh), so an unlisted post never confirms.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const POST_MAGIC = Buffer.from('ARNO', 'ascii');
export const POST_FORMAT = 1;
export const POST_MOST = 80;
const DAY_MS = 86400000;

/** The level's hash: sha256 over its canonical JSON - version, seed and the 48 candles - so anyone can rebuild it from the post's inputs (the same
 *  bytes as src/level-check.mjs levelHashOf). */
export function levelHashOf({ gameVersion, seed, candles }) {
  return createHash('sha256').update(JSON.stringify({ v: String(gameVersion), seed: Number(seed) | 0, candles })).digest('hex');
}

const u48 = (n) => { const b = Buffer.alloc(6); b.writeUIntBE(n, 0, 6); return b; };

/** The OP_RETURN payload of a round (Buffer, at most 80 bytes); throws on a field out of range. */
export function encodeRoundPost(r) {
  const v = Buffer.from(String(r.gameVersion), 'ascii');
  if (!v.length || v.length > 15) throw new Error('the game version is 1 to 15 ASCII bytes on chain');
  if (!/^[0-9a-f]{64}$/.test(String(r.levelHash))) throw new Error('the level hash is 32 bytes hex');
  const ints = [[r.number, 0, 0xffffffff], [r.startMs, 0, 2 ** 48 - 1], [r.endMs, 0, 2 ** 48 - 1], [r.entrySats, 0, 0xffffffff], [r.attempts, 1, 255]];
  for (const [x, lo, hi] of ints) if (!Number.isSafeInteger(x) || x < lo || x > hi) throw new Error('a round field is out of range');
  if (!(r.endMs > r.startMs)) throw new Error('a round ends after it starts');
  const split = r.split || [];
  if (split.length !== 3 || !split.every((x) => Number.isInteger(x) && x >= 0 && x <= 100)) throw new Error('the split is three percentages');
  const day = Math.floor(Date.parse(`${r.chartDay}T00:00:00Z`) / DAY_MS);
  if (!Number.isInteger(day) || day < 0 || day > 0xffff) throw new Error('the chart day is a UTC date');
  const head = Buffer.alloc(6); POST_MAGIC.copy(head, 0); head[4] = POST_FORMAT; head[5] = r.test ? 1 : 0;
  const n = Buffer.alloc(4); n.writeUInt32BE(r.number);
  const e = Buffer.alloc(5); e.writeUInt32BE(r.entrySats); e[4] = r.attempts;
  const d = Buffer.alloc(2); d.writeUInt16BE(day);
  const out = Buffer.concat([head, n, u48(r.startMs), u48(r.endMs), e, Buffer.from(split), d, Buffer.from([v.length]), v, Buffer.from(r.levelHash, 'hex')]);
  if (out.length > POST_MOST) throw new Error('the post is over 80 bytes');
  return out;
}

/** The round a payload names, or null when it is not an ARNO post of this format. */
export function decodeRoundPost(buf) {
  const b = Buffer.from(buf);
  if (b.length < 6 || !b.subarray(0, 4).equals(POST_MAGIC) || b[4] !== POST_FORMAT) return null;
  try {
    let i = 6;
    const number = b.readUInt32BE(i); i += 4;
    const startMs = b.readUIntBE(i, 6); i += 6;
    const endMs = b.readUIntBE(i, 6); i += 6;
    const entrySats = b.readUInt32BE(i); i += 4;
    const attempts = b[i++];
    const split = [b[i], b[i + 1], b[i + 2]]; i += 3;
    const chartDay = new Date(b.readUInt16BE(i) * DAY_MS).toISOString().slice(0, 10); i += 2;
    const vl = b[i++]; if (!vl || vl > 15) return null;
    const gameVersion = b.subarray(i, i + vl).toString('ascii'); i += vl;
    if (b.length !== i + 32) return null;
    const levelHash = b.subarray(i, i + 32).toString('hex');
    return { test: (b[5] & 1) === 1, number, startMs, endMs, entrySats, attempts, split, chartDay, gameVersion, levelHash };
  } catch { return null; }
}

/**
 * THE WALLET THAT POSTS (bitcoin-cli of the test host's testnet4 bitcoind, its own wallet): post(payloadHex) -> txid, status(txid) ->
 * { confirmations, height } | null. createrawtransaction with a data output, fundrawtransaction (the wallet's own coins and change, at
 * OPR_FEE_RATE sat/vB), signrawtransactionwithwallet, sendrawtransaction; the txid is appended to the miner C list.
 */
export function bitcoinCliChain({ cli, datadir, wallet, chain = null, pendingFile = null, feeRate = 1, log = () => {} } = {}) {
  if (!cli || !wallet) throw new Error('the chain post needs OPR_BITCOIN_CLI and OPR_WALLET');
  const call = (args, timeoutMs = 30000) => new Promise((resolve, reject) => execFile(cli,
    [...(datadir ? [`-datadir=${datadir}`] : []), ...(chain ? [`-chain=${chain}`] : []), `-rpcwallet=${wallet}`, ...args],
    { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().slice(0, 200))) : resolve(String(out).trim()))));
  return {
    async post(payloadHex) {
      const raw = await call(['createrawtransaction', '[]', JSON.stringify([{ data: payloadHex }])]);
      const funded = JSON.parse(await call(['-named', 'fundrawtransaction', `hexstring=${raw}`, `options=${JSON.stringify({ fee_rate: feeRate, replaceable: true })}`]));
      const signed = JSON.parse(await call(['signrawtransactionwithwallet', funded.hex]));
      if (!signed.complete) throw new Error('the wallet did not sign the post');
      const txid = await call(['sendrawtransaction', signed.hex]);
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('sendrawtransaction gave no txid');
      if (pendingFile) { try { appendFileSync(pendingFile, `${txid}\n`); } catch (e) { log(`the post ${txid} was not listed for miner C: ${e.message}`); } }
      return txid;
    },
    async status(txid) {
      const t = JSON.parse(await call(['gettransaction', txid]));
      return { confirmations: Number(t.confirmations) || 0, height: Number.isInteger(t.blockheight) ? t.blockheight : null };
    },
  };
}
