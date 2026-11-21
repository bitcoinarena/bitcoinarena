// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3111 (refute of #3087/#3098, kanban #1489): recordReceived and ledgerRows out of the BUILT page bundle the page loads
// (src/arena-ui/arena-client.js, or BUNDLE=<path>), evaluated as a classic script as bundle-shim-1447 does. #3087 changed
// src/page-lock.js and the bundle was not rebuilt, so the page wrote no 'returned' row while every test of the module passed;
// the page-side tests of #3087 import from here so a stale bundle fails them. Rows are copied into this realm.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(process.env.BUNDLE || new URL('../../../src/arena-ui/arena-client.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL, Uint8Array, BigInt, Promise, atob, btoa, queueMicrotask, structuredClone, performance });
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.runInContext(src + '\n;globalThis.ARENACLIENT = ARENACLIENT;', ctx);
export const ARENACLIENT = ctx.ARENACLIENT;
export const recordReceived = (...a) => ctx.ARENACLIENT.recordReceived(...a);
export const ledgerRows = (...a) => JSON.parse(JSON.stringify(ctx.ARENACLIENT.ledgerRows(...a)));
