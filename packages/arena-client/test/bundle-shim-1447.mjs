// kanban #1447 (2026-11-11): fetchDonationSet out of the BUILT page bundle the page loads (src/arena-ui/arena-client.js, or BUNDLE=<path>), evaluated as a classic script; results copied into this realm
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(process.env.BUNDLE || new URL("../../../src/arena-ui/arena-client.js", import.meta.url), "utf8");
const ctx = vm.createContext({ console, crypto: globalThis.crypto, fetch: (...a) => globalThis.fetch(...a), TextEncoder, TextDecoder, setTimeout, clearTimeout, AbortSignal, AbortController, URL, Uint8Array, BigInt, Promise, atob, btoa, queueMicrotask, structuredClone, performance });
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
ctx.Uint8Array = Uint8Array; ctx.Array = Array;
vm.runInContext(src + '\n;globalThis.ARENACLIENT = ARENACLIENT;', ctx);
const home = (x) => (x instanceof ctx.Uint8Array ? new Uint8Array(x) : Array.isArray(x) || (x && x.constructor === ctx.Array) ? Array.from(x, home) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, home(v)])) : x);
export const fetchDonationSet = async (...a) => home(await ctx.ARENACLIENT.fetchDonationSet(...a));
