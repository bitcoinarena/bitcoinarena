// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3358: writes src/core-intrinsics.js - the own property names of the core realm's globals as THIS Node's fresh vm context holds them.
// Run it with the release's pinned Node only (tools/release/build-release.sh NODE_VER): node tools/core-intrinsics-gen.mjs > src/core-intrinsics.js
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/core-host.js', import.meta.url), 'utf8');
const GLOBALS = JSON.parse(src.match(/const GLOBALS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const d = JSON.parse(vm.runInContext(`(() => {
  const name = (k) => (typeof k === 'symbol' ? '@@' + String(k.description) : k);
  const keys = (o) => Reflect.ownKeys(o).map(name).sort();
  const res = {};
  for (const g of ${JSON.stringify(GLOBALS)}) {
    if (g === 'globalThis') continue;
    const v = globalThis[g];
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null) continue;
    res[g] = keys(v);
    if (typeof v === 'function' && v.prototype && typeof v.prototype === 'object') res[g + '.prototype'] = keys(v.prototype);
  }
  const TA = Object.getPrototypeOf(Uint8Array);
  res['%TypedArray%'] = keys(TA); res['%TypedArray%.prototype'] = keys(TA.prototype);
  return JSON.stringify(res);
})()`, vm.createContext({})));
const head = readFileSync(new URL('../src/core-intrinsics.js', import.meta.url), 'utf8').split('\nexport const')[0];
process.stdout.write(`${head}\nexport const CORE_INTRINSICS = Object.freeze({\n${Object.entries(d).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n});\n`);
process.stderr.write(`node ${process.version}: ${Object.keys(d).length} objects\n`);
