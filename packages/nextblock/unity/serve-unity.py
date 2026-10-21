#!/usr/bin/env python3
"""
Static server for the Unity WebGL build, over HTTPS.

TLS is not decoration here. Addressables refuses to load its own catalog on an
origin the browser does not consider trustworthy, and a LAN address over plain
http is not one - the request is never even issued, and every streamed model
then fails with "No Location found". localhost is trustworthy, which is exactly
why this hid during local testing.

The certificate is self-signed, so a browser will warn once per device. That is
the whole cost of keeping the traffic on your own network rather than routing it
through a tunnel.

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
import ssl
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build", "webgl")

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".data")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/x-icon", ".ico")

# Unity names compressed files <name>.<ext>.br / .gz. The browser must be told
# they are encoded, or it hands compressed bytes to the wasm loader as if they
# were the real thing.
ENCODINGS = {".br": "br", ".gz": "gzip"}
BASE_TYPES = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".data": "application/octet-stream",
    ".symbols.json": "application/json",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        """
        A compressed Unity file keeps its real type and gains an encoding.
        webgl.wasm.br is a wasm that happens to be brotli - served as
        application/octet-stream it never reaches the wasm compiler.
        """
        base, ext = os.path.splitext(path)
        if ext in ENCODINGS:
            for suffix, mime in BASE_TYPES.items():
                if base.endswith(suffix):
                    return mime
            return super().guess_type(base)
        return super().guess_type(path)

    def send_head(self):
        # announce the encoding before the body goes out
        _, ext = os.path.splitext(self.translate_path(self.path))
        if ext in ENCODINGS:
            self._encoding = ENCODINGS[ext]
        else:
            self._encoding = None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        # Unity is happier with cross-origin isolation available; harmless if unused
        # NO cross-origin isolation headers.
        #
        # These were set on a guess - "Unity is happier with them" - and this
        # build has no use for them: it does not touch SharedArrayBuffer,
        # because the decompression fallback rules out threads. They are not
        # free, either. Over http on a LAN address the origin is not
        # "trustworthy", so the browser ignores COOP while still applying COEP,
        # and Addressables could not fetch its own catalog - which looked like
        # the models simply not loading. On 127.0.0.1, a trustworthy origin, the
        # same build worked, which is why this hid for so long.
        if getattr(self, "_encoding", None):
            self.send_header("Content-Encoding", self._encoding)
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


CERT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs", "server.crt")
KEY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs", "server.key")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    if not os.path.isdir(ROOT):
        sys.exit(f"no build at {ROOT} - run the WebGL build first")

    srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)

    if os.path.exists(CERT) and os.path.exists(KEY):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    else:
        # Still runs without a certificate, but say so plainly: the streamed
        # models will not load from anything but localhost.
        print("WARNUNG: kein Zertifikat unter certs/ - Modelle laden nur ueber 127.0.0.1")
        scheme = "http"

    print(f"Unity-Prototyp:  {scheme}://{lan_ip()}:{port}/")
    print(f"                 {scheme}://127.0.0.1:{port}/")
    print(f"Wurzel:          {ROOT}")
    srv.serve_forever()
