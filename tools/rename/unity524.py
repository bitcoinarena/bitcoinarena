#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
# Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
# KANBAN #524: THE UNITY-FACING "blwp" NAMES, RENAMED TOGETHER WITH THE NEXT UNITY BUILD. One pass, re-runnable (a second run
# changes nothing), run from the repository root:  python3 tools/rename/unity524.py [--check]
#   C# (unity-proto/Assets):  namespace Blwp -> Arena; Blwp<Name> identifiers (BlwpCore, BlwpNet, the 61 jslib entry points) ->
#                             Arena<Name>; "[blwp]" log lines -> "[arena]"; the files and folder named so, their .meta moved with
#                             them (Unity keeps a script's GUID in its .meta, so no scene or prefab reference changes)
#   the jslib:                the same identifiers; window.BLWP_<X> -> window.ARENA_<X> (the page answers both names, index.html);
#                             Module.blwp<X> -> Module.arena<X>; file blwp.jslib -> arena.jslib
#   tests and tools that name the jslib or its entry points by text: the same renames
# NOT here, each with its own reason: the core global BLWP and the blwp-core*.js / blwp_lock_client files (a new core = a new game
# version, kanban #523); the PlayerPrefs keys blwp.sound / blwp.debug and the storage prefixes blwp.session.key. / blwp.cargo.
# (moved by code that reads the new name and falls back to the old - GameSettings.cs and the jslib - so players keep them);
# the page ids blwp-players / blwp-clean (the page's own ids, kanban #522).
import os, re, sys

CHECK = '--check' in sys.argv
ROOT = os.getcwd()
changed = []

def sub_ident(s):
    s = re.sub(r'\bnamespace Blwp\b', 'namespace Arena', s)
    s = re.sub(r'\busing Blwp;', 'using Arena;', s)
    s = re.sub(r'\bBlwp\.(?=[A-Z])', 'Arena.', s)                       # Blwp.ArenaCore-style qualified names
    s = re.sub(r'\bBlwp(?=[A-Z][A-Za-z0-9_]*)', 'Arena', s)             # BlwpCore, BlwpNet, BlwpInit ... (not BLWP, not blwp)
    s = s.replace('[blwp]', '[arena]')
    s = s.replace('Plugins/WebGL/blwp.jslib', 'Plugins/WebGL/arena.jslib')
    s = s.replace('Scripts/Blwp/', 'Scripts/Arena/')
    return s

def sub_jslib(s):
    s = sub_ident(s)
    s = re.sub(r'\bwindow\.BLWP_([A-Z_]+)', r'window.ARENA_\1', s)
    s = re.sub(r'\bModule\.blwp\b', 'Module.arenaCore', s)              # the core's state holder
    s = re.sub(r'\bModule\.blwp([A-Z][A-Za-z0-9_]*)', r'Module.arena\1', s)
    s = re.sub(r'\bBLWP_(?!CURVE\b)([A-Z][A-Z_]*)\b', r'ARENA_\1', s)      # the page's names read bare (BLWP_ROUND ...); BLWP_CURVE is the engine's
    s = re.sub(r'(?<![A-Za-z0-9_.])(\$?)blwp(?=[A-Z])', r'\1arena', s)     # the jslib's own helpers: $blwpWorldSeed, blwpWithItems ...
    s = s.replace('__blwpAudio', '__arenaAudio').replace('blwp.jslib', 'arena.jslib')
    for a, b in (('blwp-next', 'arena-next'), ('blwp-players', 'arena-players'), ('blwp-clean', 'arena-clean')): s = s.replace(a, b)
    return s

def rewrite(path, fn):
    with open(path, encoding='utf-8') as f: s = f.read()
    t = fn(s)
    if t != s:
        changed.append(os.path.relpath(path, ROOT))
        if not CHECK:
            with open(path, 'w', encoding='utf-8') as f: f.write(t)

A = os.path.join(ROOT, 'unity-proto/Assets')
for d, _, fs in os.walk(A):
    for n in fs:
        p = os.path.join(d, n)
        # C# tests quote jslib lines (window.BLWP_*, Module.blwp*) verbatim; a line quoting the PAGE (`, page)`) keeps the page's own names
        if n.endswith('.cs'): rewrite(p, lambda s: '\n'.join(l if ', page)' in l else sub_jslib(l) for l in s.split('\n')))
        elif n.endswith('.jslib'): rewrite(p, sub_jslib)

# tests and tools that read the jslib or name its entry points
for base in ['packages/arena-client/test', 'packages/arena-node/test', 'packages/nextblock/test', 'packages/nextblock/tools', 'tools']:
    for d, _, fs in os.walk(os.path.join(ROOT, base)):
        if 'node_modules' in d or d.endswith('tools/rename'): continue
        for n in fs:
            if not n.endswith(('.js', '.mjs')): continue
            p = os.path.join(d, n)
            with open(p, encoding='utf-8') as f: s = f.read()
            if 'blwp.jslib' in s or re.search(r'\bBlwp[A-Z]', s) or 'Scripts/Blwp/' in s:
                def fn(s):
                    s = s.replace('blwp.jslib', 'arena.jslib').replace('Scripts/Blwp/', 'Scripts/Arena/')
                    return re.sub(r'\bBlwp(?=[A-Z][A-Za-z0-9_]*)', 'Arena', s)
                rewrite(p, fn)

# the files and the folder, each with its .meta
moves = [('unity-proto/Assets/Scripts/Blwp/BlwpCore.cs', 'unity-proto/Assets/Scripts/Blwp/ArenaCore.cs'),
         ('unity-proto/Assets/Scripts/Blwp/BlwpNet.cs', 'unity-proto/Assets/Scripts/Blwp/ArenaNet.cs'),
         ('unity-proto/Assets/Scripts/Blwp/BlwpLayout.cs', 'unity-proto/Assets/Scripts/Blwp/ArenaLayout.cs'),
         ('unity-proto/Assets/Tests/BlwpBridgeTests.cs', 'unity-proto/Assets/Tests/ArenaBridgeTests.cs'),
         ('unity-proto/Assets/Plugins/WebGL/blwp.jslib', 'unity-proto/Assets/Plugins/WebGL/arena.jslib'),
         ('unity-proto/Assets/Scripts/Blwp', 'unity-proto/Assets/Scripts/Arena')]
for a, b in moves:
    pa, pb = os.path.join(ROOT, a), os.path.join(ROOT, b)
    for x, y in [(pa, pb), (pa + '.meta', pb + '.meta')]:
        if os.path.exists(x) and not os.path.exists(y):
            changed.append(f'{os.path.relpath(x, ROOT)} -> {os.path.relpath(y, ROOT)}')
            if not CHECK: os.rename(x, y)

print(f"{'would change' if CHECK else 'changed'}: {len(changed)}")
for c in changed[:200]: print('  ', c)
sys.exit(1 if CHECK and changed else 0)
