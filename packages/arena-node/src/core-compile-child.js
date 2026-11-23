// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3389: the child core-compile-apart.js starts - compiles each core file it reads on stdin ([[rel, text], ...]) as a module in
// an empty context, code generation off, as core-host.js does; never links or evaluates. Prints COMPILED; a compile error of the core
// prints COMPILE-ERROR (the core thread names it); a heap overrun aborts this process alone.
import vm from 'node:vm';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const files = JSON.parse(input);
  input = '';
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  try {
    for (const [rel, text] of files) new vm.SourceTextModule(text, { context, identifier: `core:/${rel}` });
    process.stdout.write('COMPILED\n');
  } catch (e) {
    process.stdout.write(`COMPILE-ERROR ${String(e && e.message).slice(0, 200)}\n`);
  }
});
