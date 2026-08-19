#!/usr/bin/env python3
"""
Static server for the Unity WebGL build.

Python's http.server does not know .wasm or .data, and a WebGL player served
with the wrong Content-Type fails to instantiate - so the mappings are set
explicitly here. Caching is off so a rebuild is picked up on reload rather
than serving a stale wasm against a fresh loader.

    python3 serve-unity.py [port]     # default 8900, binds 0.0.0.0
"""
import http.server
import mimetypes
import os
import socket
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build", "webgl")

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".data")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/x-icon", ".ico")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        # Unity is happier with cross-origin isolation available; harmless if unused
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8900
    if not os.path.isdir(ROOT):
        sys.exit(f"no build at {ROOT} - run the WebGL build first")
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Unity-Prototyp:  http://{lan_ip()}:{port}/")
    print(f"                 http://127.0.0.1:{port}/")
    print(f"Wurzel:          {ROOT}")
    srv.serve_forever()
