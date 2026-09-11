// Bundles the page curve into one file the template can load as a script.
//
// The client bundle itself still carries no crypto. This file is the
// injection: the same `@noble/curves` secp256k1 the daemons use, assigned to
// `BLWP_CURVE` so `playerFor` can name a real key.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/page-curve.js');
// BLWP_BUNDLE_OUT builds into another directory, so a test can build this
// source and compare it with what is committed; unset, it writes dist/ as ever.
const out = process.env.BLWP_BUNDLE_OUT ? resolve(process.env.BLWP_BUNDLE_OUT, 'blwp-curve.js') : resolve(here, '../dist/blwp-curve.js');
const bin = resolve(here, '../node_modules/esbuild/bin/esbuild');

const r = spawnSync(bin, [
  src, '--bundle', '--format=iife', '--platform=browser',
  '--global-name=BLWP_CURVE_EXPORTS',
  '--footer:js=globalThis.BLWP_CURVE=BLWP_CURVE_EXPORTS.pageCurve;',
  `--outfile=${out}`,
], { stdio: 'inherit' });
if (r.status) process.exit(r.status || 1);

const kb = (statSync(out).size / 1024).toFixed(1);
console.log(`dist/blwp-curve.js  ${kb} KB`);
