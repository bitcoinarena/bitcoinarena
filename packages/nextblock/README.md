# nextblock

The deterministic simulation core. Integer arithmetic only, no floating point
in settled state, no transcendental functions ever called.

## Why this exists

Every node in the federation replays every player's run to check the score.
Replay is only meaningful if the same inputs produce the same bytes in every
engine a player might use. In JavaScript that is achievable but not free:
integer arithmetic is exactly specified, `Math.sin` explicitly is not.

## Acceptance

```
npm run guard      # AST guard: no floats, no banned Math, no outside imports
npm test           # poison tests and seed reproducibility
npm run engines    # identical state hashes from V8, SpiderMonkey, JavaScriptCore
npm run hash       # sim_wasm_hash over the sorted sources
```

`npm run engines` needs the shells once:

```
npx jsvu --os=mac64arm --engines=spidermonkey,v8
```

## The two rules that are easy to break

**Never regenerate `src/tables.js` in a build step.** It is committed on
purpose. Generating it with `Math.sin` at startup would reintroduce exactly
the cross-engine dependence the design exists to avoid, and the divergence
would only appear after minutes of play.

**The order of random draws is protocol.** Two implementations that draw the
same numbers in a different order produce different worlds. New draws go at
the end of a tick, never in the middle, or every transcript ever recorded
stops replaying.
