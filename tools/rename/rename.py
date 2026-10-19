#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# NO "blwp" IN THE CODE, ONE SLICE AT A TIME: each mapping file names old -> new tokens (tab separated); every tracked text file has
# them replaced as whole tokens (not inside a longer name), the longest first. Left out, because their bytes are hashed into game ids
# or pinned by name: the game plugins and test plugins, Tick Tock's cores and config, the game clients, built bundles (rebuilt from
# their sources instead) and every file known-good-clients.json pins in the WebGL template. Run again: changes nothing.
#     python3 tools/rename/rename.py tools/rename/<slice>.tsv [--check]
import json, os, re, subprocess, sys

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
EXCLUDE = re.compile(r'(^|/)node_modules/|/dist/|^packages/[^/]+/plugin/|^packages/.*/(plugins?|client)/|^packages/nextblock/(src|frozen|config)/'
                     r'|^tools/rename/')
TEXT = re.compile(r'\.(js|mjs|cjs|jslib|cs|html|css|md|txt|json|sh|py|toml|yml|yaml)$')
pins = json.load(open(os.path.join(ROOT, 'packages/arena-client/known-good-clients.json')))
PINNED = set(pins.get('pinned', {})) | {k for g in pins.get('games', {}).values() for k in g.get('pinned', {})}
pinned = lambda f: '/WebGLTemplates/' in f and f.split('/')[-1] in PINNED

pairs = [l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')]
pairs.sort(key=lambda p: -len(p[0]))
rx = re.compile(r'(?<![A-Za-z0-9_-])(' + '|'.join(re.escape(a) for a, _ in pairs) + r')(?![A-Za-z0-9_-])')
to = dict(pairs)
check = '--check' in sys.argv
changed, left = 0, []
for f in subprocess.run(['git', '-C', ROOT, 'ls-files'], capture_output=True, text=True, check=True).stdout.split('\n'):
    if not f or not TEXT.search(f) or EXCLUDE.search(f) or pinned(f): continue
    p = os.path.join(ROOT, f)
    if os.path.islink(p) or not os.path.isfile(p): continue
    try: s = open(p, encoding='utf-8').read()
    except UnicodeDecodeError: continue
    out = rx.sub(lambda m: to[m.group(1)], s)
    if out == s: continue
    if check: left.append(f); continue
    open(p, 'w', encoding='utf-8', newline='').write(out); changed += 1
if check:
    print(f'{len(left)} file(s) still use an old name'); [print(' ', x) for x in left[:20]]; sys.exit(1 if left else 0)
print(f'renamed in {changed} file(s)')
