#!/usr/bin/env python3
"""
Dev server for Bitcoin Logistics War.

Python's stock http.server sends Last-Modified but no Cache-Control, so a
browser heuristically caches the ES modules. During development that mixes old
and new files — a stale config.js against a fresh roads.js fails at import with
"does not provide an export named ...", the game object is never constructed,
and the boot screen just sits there. So: never cache anything.

    python3 serve.py [port]        default 8899, bound to every interface
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f'serving on http://0.0.0.0:{port}  (no-store, safe for live editing)')
    ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()
