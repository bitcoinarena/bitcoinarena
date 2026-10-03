// THE LOBBY'S "build 0.0.xxxx" IS UNITY'S Resources/build.txt, baked into the brotli .data.unityweb at the last Unity build
// (0.0.2433). The page moves on without a Unity build, so the stamp is rewritten here at each deploy: decompress, replace the
// 8-byte stamp with the page's version (same length), recompress with the original window, and keep Unity's marker
// metadata block in front (the loader's hasUnityMarker) - the compressed meta-blocks shifted onto its byte boundary.
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

const data = zlib.brotliDecompressSync(orig);
const old = /\u0005\u0000\u0000\u0000build\u0000\u0000\u0000\u0008\u0000\u0000\u0000(0\.0\.\d{4})/.exec(data.toString('latin1'));
if (!old) throw new Error('the build TextAsset (8 bytes) was not found in the data');
const at = old.index + old[0].length - 8;
console.log(`stamp ${old[1]} at ${at} -> ${version}`);
Buffer.from(version, 'latin1').copy(data, at);

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
