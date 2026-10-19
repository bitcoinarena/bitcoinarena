// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEPOSIT INVOICE AS A QR CODE (2026-09-30: the deposit needs a QR code).
// A phone's Lightning wallet scans it instead of the player copying the invoice. Encoded here, in the pinned bundle, with
// qrcode-generator (MIT, no dependencies): a QR picture is what a player pays, so it is built by the same audited script
// that made the invoice, not by a loose one beside the page. BOLT11 is case-insensitive and its upper case fits the
// QR alphanumeric mode, as wallets write it; the `lightning:` scheme is the one wallets open.
import { qrcode } from './vendor-qrcode.js';

/** An SVG tag of `lightning:<INVOICE>` as a QR code, error correction L. */
export function invoiceQrSvg(invoice, { cellSize = 4, margin = 4 } = {}) {
  const text = String(invoice || '').trim();
  if (!/^ln[a-z0-9]+$/i.test(text)) throw new Error('that is not a Lightning invoice, so no QR code is drawn');
  const qr = qrcode(0, 'L');   // L: fewest modules - a screen, not a printed label, so no damage to recover from
  qr.addData(`LIGHTNING:${text.toUpperCase()}`, 'Alphanumeric');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}
