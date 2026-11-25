# #3540: a core's load could depend on the seat's architecture - the ruling and the cap

Ruling (owner, 2026-11-25): **option 2** - cap nesting at a fixed depth for the built-in functions that recurse, so every seat
refuses the same cores whatever its architecture. Implemented in `packages/arena-node/src/core-nest.js` (run by the lockdown in
`core-host.js`), on the count of `core-depth.js`.

## The problem (unchanged analysis)

- The core's thread gets `stackSizeMb: CORE_STACK_MB` (32) on every seat. The limit is the same number of MB everywhere, but how
  many frames fit in it depends on frame sizes: V8 build, arm64 / x86_64, OS.
- The core's own functions are counted (`core-depth.js`, `DEPTH_MAX` 10000), the same depth on every seat.
- V8's overflow could still be reached inside a builtin that recurses on its own. The overflow is sticky (the core is refused and
  cannot read where it happened), but stickiness only decides what happens once an overflow has happened, not whether one happens:

| core (top level, no catch) | x86_64, node 24.22, 32 MB | arm64 laptop, node 24 (from #1489 r5) |
|---|---|---|
| `String(nest(100000)).length` | loads (4.98 s) | overflows, refused |
| `String(nest(200000)).length` | refused, overflowed (5.5 s) | refused |

So x86_64 and arm64 seats could disagree on accepting the same core, and the core's author could choose a depth between two
machines' limits. The node version matters too: node 26's `JSON.stringify` of a 300000-deep array answers (it no longer recurses),
node 24's overflows at ~150000.

## Which built-ins recurse natively (measured)

Probe: one fresh worker per depth, `resourceLimits.stackSizeMb: 32` (as `CORE_STACK_MB`), the operation at the worker's top level
(no core function on the stack), binary search for the smallest depth that throws `RangeError: Maximum call stack size exceeded`.
x86_64, node 24.22.3 and node 26.12.0. "levels" = the depth of the data (nested arrays / objects / chain links).

| built-in / path | node 24 overflows at | node 26 overflows at | recurses natively? | capped? |
|---|---|---|---|---|
| `Array.prototype.join` (via `String()`, template literals, `+ ''`, `toString` -> `join`) | ~105k | ~155k | yes | **yes** |
| `Array.prototype.toLocaleString` | ~120k | ~120k | yes | **yes** |
| `Error.prototype.toString` (`{ name: next, toString: Error.prototype.toString }` chain) | ~27k | ~27k | yes | **yes** |
| `RegExp.prototype.toString` (`{ source: next, toString: RegExp.prototype.toString }` chain) | ~27k | ~33k | yes | **yes** |
| `JSON.stringify` (arrays or objects, no replacer) | ~150k | none at 300k (iterative in V8 14) | node 24 yes | **yes** |
| `JSON.parse` with a reviver | ~77k | ~75k | yes (internalize walk) | **yes** |
| `JSON.parse` without a reviver | none at 1M | none at 1M | no (iterative parser) | not needed |
| `Array.prototype.flat(depth)` | ~301k | ~301k | yes | **yes** |
| `Array.prototype.flatMap` | none at 1M | none at 1M | no (depth 1 only) | not needed |
| `new RegExp` of nested groups `(?:(?:...))` | none at 1M | none at 1M | no | not needed |
| `new RegExp` of nested captures | SyntaxError "Too many captures" (a fixed V8 limit) | same | no | not needed |
| bound-function chains (call and `new`, 1M binds) | none | none | no (tail calls) | not needed |
| `Function.prototype.toString` of a bound chain | none | none | no | not needed |
| `Error` `cause` / `AggregateError` chains, `String(e)` | none | none | no (`toString` does not read them) | not needed |
| Promise chains | - | - | no (each job is a fresh microtask) | not needed |
| `Array.prototype.sort` with a comparator | - | - | no (the comparator does not nest) | not needed |
| `structuredClone` | - | - | not in a core's realm (only the language's globals stay) | - |
| **Proxy chains** (`new Proxy(new Proxy(...), {})`, and objects whose prototype is a proxy of the next) | ~110k | ~96k | yes | **no - see below** |
| **built-in -> built-in call chains through data** (e.g. `Reflect.apply` + `Array.prototype.forEach`, the next callee read from an array) | ~247k | ~247k | yes | **no - see below** |
| a loop of built-ins on ONE object (`o.toString = Object.prototype.toLocaleString`) | always | always | endless | not needed: it has no data depth and overflows on every machine; the #3540 tests use it as their probe |

## The cap

`core-nest.js` runs in the lockdown, before any core code. Each capped built-in counts one level per level of the data it descends
into, **on the same count as the core's own calls** (`core-depth.js`, `DEPTH_MAX` = 10000): the core's calls and the data's levels
together stay under 10000. The level past it throws a RangeError with the fixed text
`nesting deeper than 10000: a built-in function recursed into the core's data past the cap`, **before** the built-in descends - so V8's
stack is never reached through these built-ins, and the refusal depends only on the data, never on the machine or its speed. Like
`DEPTH_SAID` it is catchable (it is the same on every seat, so a core that catches it reads nothing about the machine); a core that
does not catch it is refused ("the core failed while loading: nesting deeper than 10000 ...").

How each is capped:
- `Array.prototype.join`, `Array.prototype.toLocaleString`, `Error.prototype.toString`, `RegExp.prototype.toString` reach the next level
  through a property lookup (the element's / name's / source's `toString`), so each is wrapped: the wrapper counts one level around the
  original. V8's own join cycle check still applies (`[a]` holding itself still joins to `''`). `Array.prototype.toString` needs no
  wrapper: it only calls `this.join`, so its levels are join's.
- `JSON.stringify` recurses inside V8 with nothing a wrapper sees, so V8 runs with a replacer function of the lockdown's that knows each
  value's level (its holder's + 1) and refuses before V8 descends into a value past the cap. The core's replacer function is called from
  it as V8 calls it (same `this`, key, value), with V8's levels lifted onto the count while it runs. A property-list replacer
  (`JSON.stringify(v, ['a', 'b'])`) is turned into views: per object a Proxy whose keys are the list, in its order, and whose `get` reads
  the object - so the reads happen in the same order as V8's; V8 still serializes everything.
- `JSON.parse` with a reviver: the text's nesting (brackets outside strings) is measured first; past the cap the text is refused (a text
  that is no JSON still gets V8's SyntaxError first). V8 parses it once with a reviver of the lockdown's that only records each value's
  `source` (V8's third reviver argument); the internalizing walk then runs in `core-nest.js`, counted, and calls the core's reviver with
  what V8 gives it (`{ source }` only for a primitive still the one parsed at its place). A structure the core's reviver puts into a place
  not walked yet is walked and counted too.
- `Array.prototype.flat` runs in `core-nest.js` as ECMA-262 FlattenIntoArray / ArraySpeciesCreate, counting one level per array it
  descends into.

Why N = 10000 (the existing `DEPTH_MAX`): with the wrappers installed (and no cap), the most stack per level among the capped built-ins is
`Error.prototype.toString`'s: it overflows the 32 MB stack at ~23,600 levels on node 24 (~24,000 for RegExp's; join ~64k-71k, toLocaleString
~75k, the replacer path of stringify ~78k, flat ~145k, the reviver walk ~77k; node 26 alike). So 10000 levels use at most ~42% of the
stack on x86_64: an arm64 frame may be up to ~2.3x the x86_64 one before the cap stops protecting it. One count for calls and data keeps
the budget `core-depth.js` already gives (32 MB for 10000 units, ~3.3 kB each) instead of adding a second 10000 on top of it. arm64 was
not run (no arm64 machine here): the margin is reasoning from the x86_64 measurements and from #1489 r5 (arm64 overflowed at a join
depth x86_64 fits, so its frames are larger, by an unmeasured factor).

What a core cannot do: the originals are taken before any core code runs and kept only in the lockdown's closure. Every intrinsic the
wrappers call (`Reflect.apply`, `WeakMap` / `Map` methods, `Object.defineProperty`, `Array.isArray`, ...) is taken first too, and every
descriptor they pass has a null prototype, so a core that replaces those, or puts a `get` on `Object.prototype`, changes nothing. A core
can replace or delete a wrapped method (the property attributes stay what they were: writable, configurable) but then gets its own
function (counted as core code) or none - never the uncapped original, which no route reaches (`Int8Array.prototype.toString`,
`Object.getOwnPropertyDescriptor`, prototype lookups all give the wrapper). Tested in `core-nest-3540.test.js`.

## What the cap changes

- Cores whose data nests deeper than 10000 (minus their call depth) for one of these built-ins are refused on every seat, including
  x86_64 seats that load some of them today. Shipped cores nest their data a few levels deep: the shipped-core test set (replay,
  warm ghost, registry, plugin trial, up-or-down, rock-paper-scissors, hostile fixtures; 73 tests) passes, and the sandbox's answers to
  the 2054 inputs both runs shared were byte-identical between `origin/main` and this branch (0 differences).
- A core recursing near `DEPTH_MAX` that then stringifies or joins nested data is refused earlier than before (one count).
- Error stack text of an error thrown through a wrapped built-in shows `arena:lockdown` frames where V8 showed `<anonymous>` built-in
  frames; `Function.prototype.toString` of a wrapped built-in shows the wrapper's source, not `[native code]` (as for the lockdown's
  locale twins). Both are the same on every seat.
- With a property-list replacer, V8's circular-structure TypeError names the constructor of the views (`Object`), not the object's own.
- Speed (node 24, x86_64): the driver's own `JSON.stringify` of an answer (it already has a replacer) +22% (5000 poses: 12.2 -> 15.1 ms);
  a `JSON.stringify` without a replacer ~4x (V8's fast path is off with a replacer); `flat` ~45x and `JSON.parse` with a reviver ~4x
  (they run in JavaScript); `join` unchanged. The shipped cores call none of `JSON.stringify`, `flat` or a reviver themselves.

## Not capped (explicitly)

These recurse natively on data and still overflow at a depth that is the machine's. They cannot be capped safely by wrapping built-ins:

1. **Proxy chains.** A property read on a proxy whose target is a proxy (and so on), or on an object whose prototype is a proxy of the
   next object, recurses in V8 per link (~110k links on node 24, ~96k on node 26). A wrapper on `Proxy` could count the target links it
   creates, but prototype links are also made by syntax a wrapper never sees (`{ __proto__: p }`, `class extends`), so no creation-time
   count bounds the chain a lookup walks. Capping it needs either a rule in `instrumentCore` (refuse or count those syntax forms) or
   taking `Proxy` out of a core's realm - both change far more cores than this ruling.
2. **Built-in -> built-in call chains through data.** A built-in that calls a callable can be handed another built-in that reads its own
   next callee from data, with no core function between them - e.g. `Reflect.apply(Array.prototype.forEach, next, [Reflect.apply])`
   repeated through a linked list of arrays recurses ~247k deep. Every higher-order built-in and every coercion (`valueOf`, `toString`,
   `Symbol.toPrimitive`, getters, iterator `next`, species constructors, proxy traps) is such a call site. Counting them all means wrapping
   every built-in of the realm, which breaks V8's protectors (array iteration, `then`, species), the built-ins' identities and the speed of
   every core. Not done.
3. **A core function with a huge frame** (pre-existing, not a built-in): `DEPTH_MAX` counts frames, not bytes. Measured on x86_64, node 24:
   a recursing function with 200 live locals reaches 9990 calls, one with 400 overflows the 32 MB stack first - where it overflows is the
   machine's frame size again.

For these the sticky overflow still applies (the core is refused and cannot read where it happened), but whether the overflow happens
can still differ between architectures. Closing them needs another ruling (a rule in `instrumentCore`, a frame-size bound, or a much
larger `CORE_STACK_MB` so the boundary sits beyond what loads within `LOAD_MS`).

The machine-speed split (`LOAD_MS` is wall time) is unchanged by this ruling; for the capped built-ins the quadratic cases (join and
stringify of deep arrays) now stop at 10000 levels, well inside the deadline.

## Tests

- `test/core-nest-3540.test.js`: each capped built-in answers at depth N - 1 and refuses at N + 1 with the fixed message; the refusal is the
  same at N + 1 (where V8 would fit) and at 400000 or an endless structure (where V8 would overflow); calls and levels share one count;
  under the cap each answers what V8 answers (values, errors, read order of getters and proxy traps, the reviver's `source`); a hostile
  core cannot restore the uncapped built-in or turn the cap off. Run on node 24.22.3 and 26.12.0.
- The #3540 overflow probes (`wf1489-2712-overflow-catch`, `wf1489-r26-hosting-1`, `wf1489-r5-hosting-4-2731`) used `flat(Infinity)` of
  an array that holds itself, which the cap now refuses with its own message. They now use an endless loop of built-ins on one object
  (`toString` = `Object.prototype.toLocaleString`), which has no data depth and overflows on every machine. Mutation checks: with the
  rejection-handler guard off both r26 tests fail; with `c()`'s overflow check off all 2712 and r5 tests fail.
- arm64 was not run.
