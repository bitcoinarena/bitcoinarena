// THE LOBBY'S BUILD STAMP IS REWRITTEN IN UNITY'S BROTLI .data.unityweb AT EACH DEPLOY (kanban #148, plan comment 222).
// tools/stamp-data.mjs runs as deploys run it, on a file built here the way Unity's brotli writes one: the stream's window
// bits, a metadata block carrying "UnityWeb Compressed Content (brotli)" where the loader looks, then the compressed data
// byte-aligned behind it. The data holds Unity's build TextAsset (8-byte "0.0.NNNN"). The stamped file must still carry the
// marker in the same bytes, decompress to the same data with only the 8 version bytes changed, and stamp from the .orig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const TOOL = new URL('../tools/stamp-data.mjs', import.meta.url).pathname;
const MARK = 'UnityWeb Compressed Content (brotli)';
const ASSET = (v) => Buffer.from(`\u0005\u0000\u0000\u0000build\u0000\u0000\u0000\u0008\u0000\u0000\u0000${v}`, 'latin1');
const run = (...args) => new Promise((done) => execFile(process.execPath, [TOOL, ...args], { timeout: 60000 },
  (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr })));

function payload(version) {
  const filler = Buffer.alloc(200000);
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 2654435761 >>> 13) & 0x3f;
  return Buffer.concat([filler.subarray(0, 120000), ASSET(version), Buffer.from('\u0000\u0000\u0000\u0000', 'latin1'), filler.subarray(120000)]);
}
// Unity's layout, written bit by bit (LSB first): window bits, ISLAST 0, MNIBBLES "11", reserved 0, MSKIPBYTES 1,
// MSKIPLEN-1, pad to a byte, the marker; then the compressed meta-blocks with their window bits dropped.
function unityBrotli(data, lgwin) {
  const body = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin } });
  const t = (body[0] & 1) ? ((body[0] & 14) ? 4 : 7) : 1;
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(body[0], t); put(0, 1); put(3, 2); put(0, 1); put(1, 2); put(MARK.length - 1, 8);
  while (bits.length % 8) bits.push(0);
  const head = Buffer.alloc(bits.length / 8);
  bits.forEach((b, i) => { head[i >> 3] |= b << (i & 7); });
  const rest = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) rest[i] = ((body[i] >> t) | ((i + 1 < body.length ? body[i + 1] : 0) << (8 - t))) & 0xff;
  return { file: Buffer.concat([head, Buffer.from(MARK, 'latin1'), rest]), markAt: head.length, t };
}
const markerAt = (buf, at) => buf.subarray(at, at + MARK.length).toString('latin1') === MARK;

for (const lgwin of [22, 16, 10]) {
  test(`a Unity brotli file (lgwin ${lgwin}) is stamped: the marker stays where the loader reads it, only the 8 version bytes change`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    const data = payload('0.0.2433');
    const { file, markAt, t } = unityBrotli(data, lgwin);
    assert.ok(zlib.brotliDecompressSync(file).equals(data), 'the fixture is a valid brotli stream');
    const path = join(dir, 'game.data.unityweb');
    writeFileSync(path, file);
    const r = await run(path, '0.0.2751');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stamp 0\.0\.2433 at \d+ -> 0\.0\.2751/);
    assert.ok(readFileSync(path + '.orig').equals(file), '.orig keeps Unity\'s bytes');
    const out = readFileSync(path);
    assert.ok(markerAt(out, markAt), 'the marker is where the loader looks');
    assert.equal(out[0] & ((1 << t) - 1), file[0] & ((1 << t) - 1), 'the window bits are Unity\'s');
    const back = zlib.brotliDecompressSync(out);
    assert.ok(back.equals(payload('0.0.2751')), 'only the version bytes changed');
    // a second deploy stamps from the .orig, not from the stamped file
    const again = await run(path, '0.0.2752');
    assert.match(again.stdout, /stamp 0\.0\.2433 at/);
    assert.ok(zlib.brotliDecompressSync(readFileSync(path)).equals(payload('0.0.2752')));
    assert.ok(readFileSync(path + '.orig').equals(file));
  });
}

test('the deploy form stamps from the kept Unity original it names, and leaves no .orig in Build/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const unity = join(dir, 'unity-data-0.0.2734.unityweb');
  const kept = unityBrotli(payload('0.0.2734'), 22).file;
  writeFileSync(unity, kept);
  const path = join(dir, 'webgl-fork.data.unityweb');
  writeFileSync(path, unityBrotli(payload('0.0.2433'), 22).file); // an older build's data, already stamped once
  const r = await run(path, '0.0.2751', unity);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /stamp 0\.0\.2734 at \d+ -> 0\.0\.2751/);
  assert.ok(zlib.brotliDecompressSync(readFileSync(path)).equals(payload('0.0.2751')), 'the data is the named build, stamped');
  assert.equal(existsSync(path + '.orig'), false, 'no .orig beside the deployed file');
  assert.ok(readFileSync(unity).equals(kept), 'the kept original is untouched');
});

test('a bad version, a file without the marker, or data without the build asset is refused and the file is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const good = join(dir, 'a.data.unityweb');
  writeFileSync(good, unityBrotli(payload('0.0.2433'), 22).file);
  for (const v of ['0.0.275', '1.0.2751', '']) {
    const r = await run(good, v);
    assert.equal(r.code, 2, `version "${v}"`);
    assert.match(r.stderr, /usage: stamp-data\.mjs/);
  }
  assert.equal(existsSync(good + '.orig'), false, 'a refused usage writes no .orig');
  const plain = join(dir, 'b.data.unityweb');
  const plainBytes = zlib.brotliCompressSync(payload('0.0.2433'));
  writeFileSync(plain, plainBytes);
  const r1 = await run(plain, '0.0.2751');
  assert.notEqual(r1.code, 0);
  assert.match(r1.stderr, /no Unity brotli marker where the loader looks/);
  assert.ok(readFileSync(plain).equals(plainBytes));
  const noAsset = join(dir, 'c.data.unityweb');
  const noAssetBytes = unityBrotli(Buffer.alloc(5000, 7), 22).file;
  writeFileSync(noAsset, noAssetBytes);
  const r2 = await run(noAsset, '0.0.2751');
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /the build TextAsset \(8 bytes\) was not found/);
  assert.ok(readFileSync(noAsset).equals(noAssetBytes));
});

// THE STAMP INSIDE AN LZ4 BLOCK (kanban #200: the 0.0.2822 build keeps `build` in a compressed block of data.unity3d, and
// the tool refused it). The fixture is Unity's layout: UnityWebData1.0 with three files, the middle one a UnityFS bundle
// (format 8, block table LZ4HC behind a 16-byte aligned header, blocks LZ4HC) - one block holding the stamp, one holding a
// back-reference so the decoder's matches run.
const lz4Literal = (b) => {   // one LZ4 sequence of literals and nothing else, as the format allows
  const n = b.length; const head = [n >= 15 ? 0xf0 : n << 4];
  if (n >= 15) { let r = n - 15; while (r >= 255) { head.push(255); r -= 255; } head.push(r); }
  return Buffer.concat([Buffer.from(head), b]);
};
// "abcd" then a match of 12 four back, then the literal tail "xyz": "abcdabcdabcdabcdxyz"
const MATCHED = Buffer.from([0x48, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x30, 0x78, 0x79, 0x7a]);
const MATCHED_OUT = Buffer.from('abcdabcdabcdabcdxyz');
// the stamp's four digits as a match on the same digits 20,012 bytes back, as Unity's LZ4 left 0.0.2822: never in the clear
const len15 = (n) => { const o = []; if (n >= 15) { let r = n - 15; while (r >= 255) { o.push(255); r -= 255; } o.push(r); } return o; };
function lz4Stamped(b, digitsAt, from) {
  const lit = b.subarray(0, digitsAt);
  const seq = Buffer.from([(lit.length >= 15 ? 15 : lit.length) << 4, ...len15(lit.length)]);
  const off = Buffer.from([(digitsAt - from) & 0xff, (digitsAt - from) >> 8]);
  return Buffer.concat([seq, lit, off, lz4Literal(b.subarray(digitsAt + 4))]);
}
function unityWeb(stamp) {
  const stream = payload(stamp);
  const vAt = stream.indexOf(Buffer.from(stamp, 'latin1'));
  stream.write(stamp.slice(4), 100000, 'latin1');
  const parts = [stream.subarray(0, 131072), stream.subarray(131072)];
  const blocks = [{ u: parts[0].length, c: lz4Stamped(parts[0], vAt + 4, 100000) }, { u: parts[1].length, c: lz4Literal(parts[1]) },
    { u: MATCHED_OUT.length, c: MATCHED }];
  const nodeName = Buffer.from('CAB-fixture\u0000', 'latin1');
  const total = blocks.reduce((s, b) => s + b.u, 0);
  const info = Buffer.alloc(20 + blocks.length * 10 + 4 + 20 + nodeName.length);
  info.writeUInt32BE(blocks.length, 16);
  blocks.forEach((b, i) => { info.writeUInt32BE(b.u, 20 + i * 10); info.writeUInt32BE(b.c.length, 24 + i * 10); info.writeUInt16BE(3, 28 + i * 10); });
  let q = 20 + blocks.length * 10;
  info.writeUInt32BE(1, q); info.writeBigUInt64BE(0n, q + 4); info.writeBigUInt64BE(BigInt(total), q + 12); info.writeUInt32BE(4, q + 20); nodeName.copy(info, q + 24);
  const infoC = lz4Literal(info);
  const head = Buffer.concat([Buffer.from('UnityFS\u0000', 'latin1'), Buffer.from([0, 0, 0, 8]), Buffer.from('5.x.x\u00006000.0.82f1\u0000', 'latin1'), Buffer.alloc(8 + 12)]);
  const hEnd = head.length;
  head.writeUInt32BE(infoC.length, hEnd - 12); head.writeUInt32BE(info.length, hEnd - 8); head.writeUInt32BE(0x243, hEnd - 4);
  const pad = (b) => Buffer.concat([b, Buffer.alloc(((b.length + 15) & ~15) - b.length)]);
  const bundle = Buffer.concat([pad(Buffer.concat([pad(head), infoC])), ...blocks.map((b) => b.c)]);
  bundle.writeBigUInt64BE(BigInt(bundle.length), hEnd - 20);
  const files = [['pre.json', Buffer.from('{"pre":1}')], ['data.unity3d', bundle], ['post.bin', Buffer.alloc(3000, 9)]];
  const table = files.map(([n]) => 12 + Buffer.byteLength(n));
  const headSize = 20 + table.reduce((a, b) => a + b, 0);
  const web = Buffer.alloc(headSize);
  web.write('UnityWebData1.0\u0000', 0, 'latin1'); web.writeUInt32LE(headSize, 16);
  let p = 20, off = headSize;
  for (const [n, b] of files) { web.writeUInt32LE(off, p); web.writeUInt32LE(b.length, p + 4); web.writeUInt32LE(Buffer.byteLength(n), p + 8); web.write(n, p + 12); p += 12 + Buffer.byteLength(n); off += b.length; }
  return { web: Buffer.concat([web, ...files.map(([, b]) => b)]), stream: Buffer.concat([stream, MATCHED_OUT]), blocks: blocks.map((b) => b.c), vAt };
}
/** The web data read back: its files, and data.unity3d's blocks as the tool must leave them readable. */
function readWeb(w) {
  const files = {};
  for (let p = 20; p < w.readUInt32LE(16);) { const off = w.readUInt32LE(p), sz = w.readUInt32LE(p + 4), nl = w.readUInt32LE(p + 8); files[w.subarray(p + 12, p + 12 + nl).toString()] = w.subarray(off, off + sz); p += 12 + nl; }
  const f = files['data.unity3d'];
  let q = 12; q = f.indexOf(0, q) + 1; q = f.indexOf(0, q) + 1;
  const size = Number(f.readBigUInt64BE(q)); const cbi = f.readUInt32BE(q + 8), ubi = f.readUInt32BE(q + 12), flags = f.readUInt32BE(q + 16);
  assert.equal(flags & 0x3f, 0, 'the block table is written uncompressed');
  const at0 = (q + 20 + 15) & ~15; const info = f.subarray(at0, at0 + cbi); assert.equal(cbi, ubi);
  let at = (at0 + cbi + 15) & ~15; const out = []; const kinds = [];
  for (let i = 0; i < info.readUInt32BE(16); i++) {
    const u = info.readUInt32BE(20 + i * 10), c = info.readUInt32BE(24 + i * 10), k = info.readUInt16BE(28 + i * 10) & 0x3f;
    kinds.push(k); out.push(f.subarray(at, at + c)); at += c;
  }
  return { files, size, length: f.length, end: at, kinds, raw: out };
}

test('the stamp in an LZ4 block of data.unity3d: that block is stored plain with the new stamp, every other byte and file kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const { web, stream, vAt } = unityWeb('0.0.2822');
  const { file } = unityBrotli(web, 22);
  assert.ok(!/0\.0\.2822/.test(zlib.brotliDecompressSync(file).toString('latin1')), 'the fixture holds the stamp only compressed');
  const path = join(dir, 'webgl-fork.data.unityweb');
  writeFileSync(path, file);
  const r = await run(path, '0.0.2830');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`stamp 0\\.0\\.2822 at ${vAt} of data\\.unity3d \\(LZ4 blocks\\) -> 0\\.0\\.2830`));
  const back = readWeb(zlib.brotliDecompressSync(readFileSync(path)));
  assert.equal(back.files['pre.json'].toString(), '{"pre":1}');
  assert.ok(back.files['post.bin'].equals(Buffer.alloc(3000, 9)), 'the file behind the bundle moved, its bytes did not');
  assert.equal(back.size, back.length, 'the bundle names its own new length');
  assert.equal(back.end, back.length, 'its blocks fill it exactly');
  assert.deepEqual(back.kinds, [0, 3, 3], 'the stamped block plain, the others LZ4 as Unity wrote them');
  const want = stream.subarray(0); Buffer.from('0.0.2830', 'latin1').copy(want, vAt);
  assert.ok(back.raw[0].equals(want.subarray(0, 131072)), 'the plain block is the stamped stream');
  const { blocks } = unityWeb('0.0.2822');
  assert.ok(back.raw[1].equals(blocks[1]) && back.raw[2].equals(blocks[2]), 'the other blocks keep Unity\'s compressed bytes (the third, with its match, was decoded to look for the stamp)');
  // stamped once, the stamp is in the clear: the next deploy's stamp of this file takes the plain path
  const again = await run(path, '0.0.2831', path);
  assert.match(again.stdout, /stamp 0\.0\.2830 at \d+ -> 0\.0\.2831/);
});
