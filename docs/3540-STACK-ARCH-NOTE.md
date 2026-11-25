# #3540: a core's load can depend on the seat's architecture (needs a ruling)

Status: analysis only. Nothing in `core-sandbox.js`, `core-host.js`, `core-depth.js` or `core-supervisor.js` was changed.

## What the sandbox does today

- The core's thread gets `stackSizeMb: CORE_STACK_MB` (32) on every seat (`core-supervisor.js`). The limit is the same number
  of MB everywhere, but how many frames fit in it depends on frame sizes: V8 build, arm64 / x86_64, OS.
- The core's own functions are counted (`core-depth.js`, `DEPTH_MAX` 10000). That depth is the same on every seat, so V8's own
  overflow is never reached through core code.
- V8's overflow can still be reached inside a builtin that recurses on its own: `Array.prototype.join` / `String()` of nested
  arrays, `JSON.stringify`, `Array.prototype.flat`. When that happens the overflow is sticky (catch clauses, finally, the LEAVE of
  every core function, every promise rejection handler). The core is refused with "the core overflowed the stack" and cannot
  read where the overflow happened. The #3540 tests pin that down, and it works on x86_64.
- `LOAD_MS` (10 s) is a wall-clock deadline. A load that misses it is refused but not cached (#1586), so the seat retries it.

## The split

Stickiness only decides what happens once an overflow has happened. It does nothing about whether one happens. A core whose
top level (or any call) runs a builtin recursion near the stack's end overflows on one machine and fits on another:

| core (top level, no catch) | x86_64, node 24.22, 32 MB | arm64 laptop, node 24 (from #1489 r5) |
|---|---|---|
| `String(nest(100000)).length` | loads (4.98 s) | overflows, refused |
| `String(nest(200000)).length` | refused, overflowed (5.5 s) | refused |

So an honest-looking core can be accepted by x86_64 seats and refused by arm64 seats. The same goes for any call (decide, step):
the call fails on one architecture and answers on the other. The core cannot read the boundary, which is what the sticky rule
is for. But the yes/no split is itself a consensus split, and the core's author can choose its depth to land between two
machines' limits.

There is a second, machine-speed split that does not depend on architecture. Join and stringify of nested arrays are quadratic
in V8 (cycle check): join 100000 deep takes about 5 s and JSON.stringify 200000 deep about 12 s here. A load like that fits
`LOAD_MS` on a fast seat and misses it on a slow or busy one.

Shipped cores nest their data a few levels deep, so this has no effect on them today. It matters only for a core written to sit
on the boundary.

## Options (each changes which cores a seat accepts, so each needs a ruling)

1. **Accept it as a known limit.** No code change: document that a core whose builtins recurse near the stack's end has no
   defined load result. That is a publishing / review rule for core authors, not a sandbox rule.
2. **A deterministic nesting bound on the recursive builtins.** The lockdown would wrap `join` / `toString` / `toLocaleString`,
   `JSON.stringify`, `flat` / `flatMap` (and any others that recurse) with an iterative pre-walk that throws the sticky overflow
   past a fixed nesting depth N, well below what 32 MB holds on any arch (e.g. N = 10000, like `DEPTH_MAX`). Then the same cores
   are refused on every seat. The cost: it refuses cores that nest deeper than N but load today, and the list of recursive
   builtins has to be complete (it is easy to miss one), so this is whack-a-mole without an audit of V8's recursive builtins.
3. **A much larger stack** (e.g. 256 MB). This moves the boundary out of reach of anything that loads within `LOAD_MS`, given
   the quadratic cost above. It changes acceptance only for cores that overflow today, and costs memory per core thread. It
   leaves the speed split (2nd point above) in place.
4. For the speed split only: a deterministic work budget for loads, in place of or alongside wall time. That is a large change,
   out of scope here.

No option is a pure hardening that leaves accepted cores unchanged. Any rule that makes an x86_64 seat refuse what it accepts
today, or an arm64 seat accept what it refuses, changes the accepted set.
