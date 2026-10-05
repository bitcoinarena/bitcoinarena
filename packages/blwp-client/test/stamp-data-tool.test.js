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
