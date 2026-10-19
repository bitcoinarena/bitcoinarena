// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Hand-written fixed-layout binary encoding.
//
// Not JSON: key order, number formatting, -0 and unicode escaping are
// unspecified enough that JSON.stringify is not a specification. Not canonical
// CBOR: defensible in principle, but every library has its own reading of
// "canonical", and a library upgrade must never change a round_id.
//
// Big-endian throughout, which is a choice and not an accident - it is what
// every wire format and every hash construction already uses, so a reader can
// check the bytes by eye against a hexdump.

import { utf8Encode, utf8Decode } from './utf8.js';

/** Growable output buffer. */
export class Writer {
  constructor() { this.buf = new Uint8Array(256); this.len = 0; }

  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.len + n) size <<= 1;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error('u8 out of range: ' + v);
    this._need(1); this.buf[this.len++] = v; return this;
  }

  u16(v) {
    if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('u16 out of range: ' + v);
    this._need(2);
    this.buf[this.len++] = (v >>> 8) & 255;
    this.buf[this.len++] = v & 255;
    return this;
  }

  u32(v) {
    if (!Number.isInteger(v) || v < 0 || v > 4294967295) throw new Error('u32 out of range: ' + v);
    this._need(4);
    this.buf[this.len++] = (v >>> 24) & 255;
    this.buf[this.len++] = (v >>> 16) & 255;
    this.buf[this.len++] = (v >>> 8) & 255;
    this.buf[this.len++] = v & 255;
    return this;
  }

  /**
   * 64-bit unsigned, BigInt only.
   *
   * Refusing a Number here is the point: amounts, timestamps and heights all
   * exceed 2^53 eventually, and a silent Number path is how a payout table
   * ends up off by a millisatoshi in a way no test with small numbers finds.
   */
  u64(v) {
    if (typeof v !== 'bigint') throw new Error('u64 needs a BigInt, got ' + typeof v);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('u64 out of range: ' + v);
    this._need(8);
    for (let s = 56n; s >= 0n; s -= 8n) this.buf[this.len++] = Number((v >> s) & 0xffn);
    return this;
  }

  i32(v) {
    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647)
      throw new Error('i32 out of range: ' + v);
    return this.u32(v >>> 0);
  }

  /**
   * 64-bit SIGNED, BigInt only, two's complement (kanban #362 feature 8: a scalar market's bounds and an attested value may be
   * below zero - a temperature, a price change). Written as the u64 with the same bits, so a reader that knows the field is
   * signed reads it back exactly; nothing written before uses it.
   */
  i64(v) {
    if (typeof v !== 'bigint') throw new Error('i64 needs a BigInt, got ' + typeof v);
    if (v < -0x8000000000000000n || v > 0x7fffffffffffffffn) throw new Error('i64 out of range: ' + v);
    return this.u64(v < 0n ? v + 0x10000000000000000n : v);
  }

  bytes(b, expected) {
    // SAID BY NAME, not crashed. A missing field used to read `undefined.length`
    // and hand the caller "Cannot read properties of undefined" - which names
    // neither the field nor the length it wanted, and every other refusal in
    // this encoder does both.
    if (!(b instanceof Uint8Array))
      throw new Error(`expected ${expected === undefined ? '' : expected + ' '}bytes, got ${b === undefined ? 'nothing' : typeof b}`);
    if (expected !== undefined && b.length !== expected)
      throw new Error('expected ' + expected + ' bytes, got ' + b.length);
    this._need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  bytes32(b) { return this.bytes(b, 32); }

  /**
   * UTF-8 with a u16 length. Unpaired surrogates are rejected rather than
   * replaced: TextEncoder would quietly write U+FFFD, and two implementations
   * disagreeing about whether that happened is a fork.
   */
  str(s) {
    if (typeof s !== 'string') throw new Error('str needs a string');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = s.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) throw new Error('unpaired high surrogate');
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('unpaired low surrogate');
    }
    const b = utf8Encode(s);
    return this.u16(b.length).bytes(b);
  }

  /**
   * u16 count, then each item.
   *
   * When the protocol says an array is sorted, the encoder ASSERTS it rather
   * than sorting silently - a caller that forgot must not be able to produce a
   * valid-looking artifact, because the sort order is part of what the hash
   * commits to.
   */
  vec(items, write, { sortedBy } = {}) {
    if (items.length > 65535) throw new Error('vec longer than u16');
    if (sortedBy) {
      for (let i = 1; i < items.length; i++)
        if (sortedBy(items[i - 1], items[i]) > 0)
          throw new Error('vec is not sorted at index ' + i);
    }
    this.u16(items.length);
    for (const it of items) write(it, this);
    return this;
  }

  finish() { return this.buf.slice(0, this.len); }
}

/** The mirror of Writer, for anything that has to read what it wrote. */
export class Reader {
  constructor(bytes) { this.b = bytes; this.at = 0; }

  _take(n) {
    if (this.at + n > this.b.length) throw new Error('reader ran off the end');
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }

  u8() { return this._take(1)[0]; }
  u16() { const b = this._take(2); return (b[0] << 8) | b[1]; }
  u32() { const b = this._take(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }
  i32() { return this.u32() | 0; }
  i64() { const v = this.u64(); return v >= 0x8000000000000000n ? v - 0x10000000000000000n : v; }

  u64() {
    const b = this._take(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  bytes(n) { return this._take(n).slice(); }
  bytes32() { return this.bytes(32); }
  str() { return utf8Decode(this._take(this.u16())); }
  vec(read) { const n = this.u16(), out = []; for (let i = 0; i < n; i++) out.push(read(this)); return out; }

  /** Nothing may be left over: trailing bytes are a different message. */
  end() {
    if (this.at !== this.b.length)
      throw new Error('trailing bytes: ' + (this.b.length - this.at));
  }
}
