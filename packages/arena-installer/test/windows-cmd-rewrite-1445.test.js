// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMAND REWRITTEN WHILE IT RUNS (kanban #1445, audit 8 O8-6): the Windows auto update runs inside <home>\bin\bitcoinarena.cmd (the
// updater's loop CALLs it) and writes that file again for the new release. cmd.exe reads a batch file by its place in the file: after
// node.exe exits 75 it reads on from the old file's length in the NEW one, and ran what was left there ("%*", "arena %*") as a command -
// errorlevel 9009, and the updater's loop ended. Checked on the written text: past the old file's length there is no command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCommand } from '../src/launchers.js';

const PAIRS = [['2026.1.9.26', '2026.1.9.27'], ['2026.1.9.9', '2026.1.9.10'], ['2026.2.0', '2026.2.0.1'], ['2026.2.0', '2026.2.10'], ['2026.1.9.27', '2026.2.0'],
  ['2026.2.0', '2026.2.0-rc.1'], ['2026.2.0', '2026.10.100-rc.12']];
const homeW = 'C:\\Users\\owner\\.bitcoinarena';
const relOf = (v) => `${homeW}\\releases\\bitcoin-arena-node-${v}-windows-x64`;
// the command as 2026.1.9.27 and older wrote it (launchers.js before #1445): the one running when the first fixed update writes it again
const oldFormat = (dir, v) => { const rel = relOf(v); return ['@echo off', 'rem The bitcoinarena command, written by the installer: bitcoinarena status, bitcoinarena restart lnd, bitcoinarena doctor, bitcoinarena help',
  `"${rel}\\runtime\\node.exe" "${join(rel, 'packages', 'arena-installer', 'bin', 'bitcoinarena.mjs')}" --home "${dir}" --name bitcoinarena %*`].join('\r\n') + '\r\n'; };
const write = (dir, v) => { const rel = relOf(v); return writeCommand({ home: dir, release: rel, node: `${rel}\\runtime\\node.exe`, platform: 'win32', env: {}, run: null }).file; };
const readOn = (oldBytes, file) => readFileSync(file).subarray(oldBytes.length).toString('utf8');

test('the line that runs node.exe ends the batch file itself (& exit /b): cmd.exe never reads the rewritten file after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-1445-'));
  try {
    const lines = readFileSync(write(dir, '2026.2.0'), 'utf8').split('\r\n');
    const run = lines.find((l) => /node\.exe"/.test(l));
    assert.match(run, / %\* & exit \/b$/, 'exit /b with no number keeps node.exe\'s exit code (75 for the updater\'s loop)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('from the old command (2026.1.9.27 and older) to a longer release name: past the old file\'s length there is nothing to run', () => {
  for (const [a, b] of PAIRS) {
    const dir = mkdtempSync(join(tmpdir(), 'cmd-1445-'));
    try {
      const file = join(dir, 'bin', 'bitcoinarena.cmd');
      write(dir, a);                                        // the bin folder
      const old = Buffer.from(oldFormat(dir, a));
      writeFileSync(file, old);
      write(dir, b);
      const next = readOn(old, file);
      assert.equal(next.trim(), '', `${a} -> ${b}: cmd.exe would read on ${JSON.stringify(next)}`);
      assert.match(readFileSync(file, 'utf8'), new RegExp(`bitcoin-arena-node-${b.replace(/\./g, '\\.')}-windows-x64\\\\runtime\\\\node\\.exe" .* %\\* & exit /b\\r\\n$`), 'and the command runs the new release');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('from a fixed command to the next: the same holds, and the comment is whole again once there is room', () => {
  for (const [a, b] of PAIRS) {
    const dir = mkdtempSync(join(tmpdir(), 'cmd-1445-'));
    try {
      const file = write(dir, a);
      const old = readFileSync(file);
      assert.ok(old.toString('utf8').includes(' & exit /b'), 'the running file ends at its node line');
      write(dir, b);
      assert.match(readFileSync(file, 'utf8'), /\r\nrem The bitcoinarena command, written by the installer: bitcoinarena status, bitcoinarena restart lnd, bitcoinarena doctor, bitcoinarena help\r\n/,
        `${a} -> ${b}: a running command that ends itself needs no shorter comment`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
