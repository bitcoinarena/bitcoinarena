// UTF-8 in plain JavaScript.
//
// TextEncoder and TextDecoder are Web APIs, not ECMAScript. Node and browsers
// have them; the engine shells do not, and neither does every embedding a node
// operator might use. For a package whose output pins money, depending on a
// host API for the byte-level meaning of a string is the wrong trade - the
// encoding is part of the protocol, so it belongs in the protocol.
//
// Surrogate handling is strict on purpose. TextEncoder silently writes U+FFFD
// for an unpaired surrogate, and two implementations disagreeing about whether
// that substitution happened is a fork.

export function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('unpaired high surrogate');
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error('unpaired low surrogate');
    }

    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
                  0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/**
 * Strict decode: overlong forms, truncated sequences and out-of-range code
 * points are errors rather than replacement characters. A decoder that repairs
 * bad input accepts messages a stricter peer rejects.
 */
export function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i];
    let c, need;

    if (b0 < 0x80) { c = b0; need = 0; }
    else if ((b0 & 0xe0) === 0xc0) { c = b0 & 31; need = 1; }
    else if ((b0 & 0xf0) === 0xe0) { c = b0 & 15; need = 2; }
    else if ((b0 & 0xf8) === 0xf0) { c = b0 & 7; need = 3; }
    else throw new Error('bad UTF-8 lead byte at ' + i);

    if (i + need >= bytes.length + (need === 0 ? 1 : 0) && need > 0
        && i + need > bytes.length - 1) throw new Error('truncated UTF-8 at ' + i);

    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) throw new Error('bad UTF-8 continuation at ' + (i + k));
      c = (c << 6) | (b & 63);
    }

    const min = [0, 0x80, 0x800, 0x10000][need];
    if (need > 0 && c < min) throw new Error('overlong UTF-8 at ' + i);
    if (c > 0x10ffff) throw new Error('code point out of range at ' + i);
    if (c >= 0xd800 && c <= 0xdfff) throw new Error('surrogate encoded in UTF-8 at ' + i);

    if (c < 0x10000) s += String.fromCharCode(c);
    else {
      c -= 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    }
    i += need + 1;
  }
  return s;
}
