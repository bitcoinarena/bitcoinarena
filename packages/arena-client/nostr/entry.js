// The page's Nostr bundle (tools/bundle-nostr.js -> window.ARENA_NOSTR): the login, and a QR code of a nostrconnect:// link
// for a phone signer (Amber and similar) to scan.
import qrcode from 'qrcode-generator';
export * from './nostr-login.js';
export function textQrSvg(text, { cellSize = 4, margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}
export * from './nwc.js';
