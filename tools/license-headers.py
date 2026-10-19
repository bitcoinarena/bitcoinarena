#!/usr/bin/env python3
# THE LICENSE IN EVERY SOURCE FILE WHERE IT FITS (2026-10-19: "Die Lizenz muss auch in jedes source file, oder nicht?
# Da wo es Sinn macht"): an SPDX line and the copyright at the top of each of our own source files (after a shebang or a BOM), and in the
# files LICENSE section 2 protects a third line saying so. Left out, because their bytes are hashed into ids or pins: the game plugins,
# Tick Tock's core sources and built cores, the Rust lock client (its wasm is pinned), the Nostr bundle's source, built bundles and the
# WebGL template's copies; and vendored code. A file that names a license already is left alone. Run again: changes nothing.
#     python3 tools/license-headers.py [--check]
import os, re, subprocess, sys

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
SPDX = 'SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0'
COPY = 'Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.'
GUARD = 'Protected by LICENSE section 2: no copy or fork may change the network id or the protocol developers\' donation set here.'
INCLUDE = re.compile(r'^(packages/|unity-proto/Assets/(Scripts|Editor|Tests)/|tools/)')
EXCLUDE = re.compile(r'(^|/)node_modules/|/dist/|^packages/[^/]+/plugin/|^packages/nextblock/(src|frozen|config)/'
                     r'|^packages/arena-client/(lock-client|nostr)/|WebGLTemplates/')
KINDS = {'.js': '//', '.mjs': '//', '.cs': '//', '.sh': '#', '.py': '#'}
PROTECTED = {'packages/arena-protocol/src/genesis-ids.js', 'packages/arena-protocol/src/donation-keys.js',
             'packages/arena-protocol/src/testnet4-donation-set.js', 'packages/arena-protocol/src/testnet4-donation-set-keys.js',
             'packages/arena-protocol/src/donation.js'}

def header(path, eol):
    c = KINDS[os.path.splitext(path)[1]]
    lines = [f'{c} {SPDX}', f'{c} {COPY}'] + ([f'{c} {GUARD}'] if path in PROTECTED else [])
    return eol.join(lines) + eol

check = '--check' in sys.argv
files = subprocess.run(['git', '-C', ROOT, 'ls-files'], capture_output=True, text=True, check=True).stdout.split('\n')
changed, missing = 0, []
for f in files:
    if not f or os.path.splitext(f)[1] not in KINDS or not INCLUDE.search(f) or EXCLUDE.search(f): continue
    p = os.path.join(ROOT, f)
    if not os.path.isfile(p) or os.path.islink(p): continue
    raw = open(p, 'rb').read()
    if not raw.strip(): continue
    text = raw.decode('utf-8')
    if 'SPDX-License-Identifier' in text[:600] or re.search(r'\bLicensed under\b|\bMIT License\b', text[:600]): continue
    if check: missing.append(f); continue
    bom = '﻿' if text.startswith('﻿') else ''
    body = text[len(bom):]
    eol = '\r\n' if body.count('\r\n') * 2 > body.count('\n') else '\n'   # the file's own line ending
    if body.startswith('#!'):
        nl = body.find('\n') + 1
        out = bom + body[:nl] + header(f, eol) + body[nl:]
    else:
        out = bom + header(f, eol) + body
    open(p, 'w', encoding='utf-8', newline='').write(out)
    changed += 1
if check:
    print(f'{len(missing)} source file(s) without the license header'); [print(' ', m) for m in missing[:20]]; sys.exit(1 if missing else 0)
print(f'license header added to {changed} file(s)')
