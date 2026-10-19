// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY'S "build 0.0.xxxx" IS UNITY'S Resources/build.txt, baked into the brotli .data.unityweb at the last Unity build
// (0.0.2433). The page moves on without a Unity build, so the stamp is rewritten here at each deploy: decompress, replace the
// 8-byte stamp with the page's version (same length), recompress with the original window, and keep Unity's marker
// metadata block in front (the loader's hasUnityMarker) - the compressed meta-blocks shifted onto its byte boundary.
// Where Unity's build keeps the stamp inside an LZ4 block of data.unity3d (0.0.2822), that block is stored plain with the
// new stamp and the bundle's tables are rewritten around it (stampInBundle, below).
//   node stamp-data.mjs <data.unityweb> <version e.g. 0.0.2486>   (keeps <file>.orig once; always stamps from the .orig)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import zlib from 'node:zlib';

const [file, version, origArg] = process.argv.slice(2);
if (!file || !/^0\.0\.\d{4}$/.test(version || '')) { console.error('usage: stamp-data.mjs <data.unityweb> 0.0.NNNN'); process.exit(2); }
const origPath = origArg || file + '.orig';
if (!existsSync(origPath)) copyFileSync(file, origPath);
const orig = readFileSync(origPath);
const MARK = 'UnityWeb Compressed Content (brotli)';
// the header as the loader reads it: t WBITS bits, then the metadata block; the comment ends byte-aligned
const t = (orig[0] & 1) ? ((orig[0] & 14) ? 4 : 7) : 1;
const o = 1 + ((Math.log(MARK.length - 1) / Math.log(2)) >> 3);
const commentOffset = (1 + t + 2 + 1 + 2 + (o << 3) + 7) >> 3;
if (orig.subarray(commentOffset, commentOffset + MARK.length).toString('latin1') !== MARK) throw new Error('no Unity brotli marker where the loader looks');
const prefix = orig.subarray(0, commentOffset + MARK.length);

const STAMP = /\u0005\u0000\u0000\u0000build\u0000\u0000\u0000\u0008\u0000\u0000\u0000(0\.0\.\d{4})/;
let data = zlib.brotliDecompressSync(orig);
const old = STAMP.exec(data.toString('latin1'));
if (old) {
  const at = old.index + old[0].length - 8;
  console.log(`stamp ${old[1]} at ${at} -> ${version}`);
  Buffer.from(version, 'latin1').copy(data, at);
} else {
  data = stampInBundle(data, version);
}

// the window: the lgwin whose stream starts with the same t bits as Unity's
const want = orig[0] & ((1 << t) - 1);
let lgwin = null;
for (let w = 10; w <= 24 && lgwin === null; w++) {
  const probe = zlib.brotliCompressSync(Buffer.from('x'), { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: w } });
  const pt = (probe[0] & 1) ? ((probe[0] & 14) ? 4 : 7) : 1;
  if (pt === t && (probe[0] & ((1 << t) - 1)) === want) lgwin = w;
}
if (lgwin === null) throw new Error('no lgwin gives Unity\'s window bits');
const body = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin,
  [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
// drop the t window bits of the new stream (LSB first) and shift the rest onto a byte boundary
const rest = Buffer.alloc(body.length);
for (let i = 0; i < body.length; i++) rest[i] = ((body[i] >> t) | ((i + 1 < body.length ? body[i + 1] : 0) << (8 - t))) & 0xff;
const out = Buffer.concat([prefix, rest]);
const back = zlib.brotliDecompressSync(out);
if (!back.equals(data)) throw new Error('the stamped stream does not decompress to the stamped data');
writeFileSync(file, out);
console.log(`lgwin ${lgwin}, ${orig.length} -> ${out.length} bytes, decompresses to the stamped data`);

// THE STAMP INSIDE AN LZ4 BLOCK (the 0.0.2822 and 0.0.2829 builds keep `build` in a compressed block of
// data.unity3d, so the bytes above never hold it in the clear). The data is UnityWebData1.0: a file table, then the files;
// data.unity3d is a UnityFS bundle whose blocks are LZ4. Its blocks are decompressed to find the stamp; the block(s)
// holding it are stored UNCOMPRESSED with the new stamp (a UnityFS block names its own compression), every other block
// keeps Unity's bytes, the block table is written uncompressed with the new sizes, and the file table moves the files
// behind it. The bundle's directory counts uncompressed offsets, so it does not change.
function stampInBundle(web, version) {
  if (web.subarray(0, 16).toString('latin1') !== 'UnityWebData1.0\u0000') throw new Error('the build TextAsset (8 bytes) was not found in the data');
  const headSize = web.readUInt32LE(16);
  const files = [];
  for (let p = 20; p < headSize;) {
    const off = web.readUInt32LE(p), size = web.readUInt32LE(p + 4), nl = web.readUInt32LE(p + 8);
    files.push({ entry: p, off, size, name: web.subarray(p + 12, p + 12 + nl).toString('utf8') });
    p += 12 + nl;
  }
  const f = files.find((x) => x.name === 'data.unity3d');
  if (!f) throw new Error('the build TextAsset (8 bytes) was not found in the data');
  const fs = web.subarray(f.off, f.off + f.size);
  if (fs.subarray(0, 8).toString('latin1') !== 'UnityFS\u0000') throw new Error('data.unity3d is not a UnityFS bundle');
  let q = 8;
  const fmt = fs.readUInt32BE(q); q += 4;
  q = fs.indexOf(0, q) + 1; q = fs.indexOf(0, q) + 1;            // the engine's version strings
  const sizeAt = q; q += 8;
  const cbi = fs.readUInt32BE(q), ubi = fs.readUInt32BE(q + 4), flags = fs.readUInt32BE(q + 8); q += 12;
  const headEnd = q;
  if (flags & 0x80) throw new Error('a UnityFS block table at the end of the bundle is not handled');
  const align = (n) => (n + 15) & ~15;
  const biAt = fmt >= 7 ? align(headEnd) : headEnd;
  const biRaw = fs.subarray(biAt, biAt + cbi);
  const bi = blockData(biRaw, ubi, flags & 0x3f);
  let dataAt = biAt + cbi;
  if (flags & 0x200) dataAt = align(dataAt);
  const count = bi.readUInt32BE(16);
  const blocks = [];
  let c = dataAt, u = 0;
  for (let i = 0; i < count; i++) {
    const e = 20 + i * 10;
    const b = { usize: bi.readUInt32BE(e), csize: bi.readUInt32BE(e + 4), flags: bi.readUInt16BE(e + 8), at: c, uat: u };
    blocks.push(b); c += b.csize; u += b.usize;
  }
  if (c !== fs.length) throw new Error(`the UnityFS blocks end at ${c}, the bundle at ${fs.length}`);
  for (const b of blocks) b.raw = blockData(fs.subarray(b.at, b.at + b.csize), b.usize, b.flags & 0x3f);
  const all = Buffer.concat(blocks.map((b) => b.raw));
  const old = STAMP.exec(all.toString('latin1'));
  if (!old) throw new Error('the build TextAsset (8 bytes) was not found in the data');
  const at = old.index + old[0].length - 8;
  console.log(`stamp ${old[1]} at ${at} of data.unity3d (LZ4 blocks) -> ${version}`);
  Buffer.from(version, 'latin1').copy(all, at);
  // the block(s) holding the 8 bytes, stored uncompressed; the rest as Unity wrote them
  const parts = []; const table = Buffer.from(bi);
  blocks.forEach((b, i) => {
    const e = 20 + i * 10;
    if (at + 8 > b.uat && at < b.uat + b.usize) {
      parts.push(all.subarray(b.uat, b.uat + b.usize));
      table.writeUInt32BE(b.usize, e + 4); table.writeUInt16BE(b.flags & ~0x3f, e + 8);
    } else parts.push(fs.subarray(b.at, b.at + b.csize));
  });
  const head = Buffer.from(fs.subarray(0, headEnd));
  head.writeUInt32BE(table.length, headEnd - 12); head.writeUInt32BE(table.length, headEnd - 8);
  head.writeUInt32BE(flags & ~0x3f, headEnd - 4);
  const pad = (buf, to) => Buffer.concat([buf, Buffer.alloc(to - buf.length)]);
  let bundle = fmt >= 7 ? pad(head, align(headEnd)) : head;
  bundle = Buffer.concat([bundle, table]);
  if (flags & 0x200) bundle = pad(bundle, align(bundle.length));
  bundle = Buffer.concat([bundle, ...parts]);
  bundle.writeBigUInt64BE(BigInt(bundle.length), sizeAt);
  // the web data's file table: data.unity3d's new size, the files behind it moved by the difference
  const out = Buffer.concat([web.subarray(0, f.off), bundle, web.subarray(f.off + f.size)]);
  const shift = bundle.length - f.size;
  for (const x of files) {
    if (x === f) out.writeUInt32LE(bundle.length, x.entry + 4);
    else if (x.off > f.off) out.writeUInt32LE(x.off + shift, x.entry);
  }
  return out;
}

/** A UnityFS block as stored: 0 none, 2 and 3 LZ4 (HC is the same format to read). */
function blockData(raw, usize, kind) {
  if (kind === 0) return Buffer.from(raw);
  if (kind !== 2 && kind !== 3) throw new Error(`UnityFS compression ${kind} is not handled`);
  return lz4Block(raw, usize);
}

/** The LZ4 block format, decoded. */
function lz4Block(src, usize) {
  const dst = Buffer.alloc(usize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(dst, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    if (!offset || offset > d) throw new Error('a bad LZ4 match offset');
    for (let i = 0; i < len; i++, d++) dst[d] = dst[d - offset];
  }
  if (d !== usize) throw new Error(`an LZ4 block gave ${d} bytes, ${usize} expected`);
  return dst;
}
