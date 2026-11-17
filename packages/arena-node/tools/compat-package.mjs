// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { inflateRawSync } from 'node:zlib';

/** The manifest.json of a Chrome Web Store package (CRX3: "Cr24", version, header length, header, then a zip), read through the zip's
 *  central directory, since the store's zips put the sizes after the data. */
export function manifestFromCrx(buf) {
  const b = Buffer.from(buf);
  if (b.toString('latin1', 0, 4) !== 'Cr24') throw new Error('not a Chrome extension package');
  const zip = b.subarray(12 + b.readUInt32LE(8));
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('the package is not a readable zip');
  const count = zip.readUInt16LE(end + 10);
  for (let n = 0, i = zip.readUInt32LE(end + 16); n < count && zip.readUInt32LE(i) === 0x02014b50; n++) {
    const method = zip.readUInt16LE(i + 10), size = zip.readUInt32LE(i + 20), nameLen = zip.readUInt16LE(i + 28);
    const name = zip.toString('utf8', i + 46, i + 46 + nameLen), local = zip.readUInt32LE(i + 42);
    if (name === 'manifest.json') {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), data = zip.subarray(start, start + size);
      return JSON.parse((method === 8 ? inflateRawSync(data) : data).toString('utf8').replace(/^\uFEFF/, ''));
    }
    i += 46 + nameLen + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  throw new Error('no manifest.json in the package');
}

export const crxUrl = (id) => `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=155.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;

