#!/usr/bin/env python3
"""
Local test server for the static (GitHub Pages) build.

Python's built-in `python3 -m http.server` does NOT support HTTP range
requests, and this app's in-browser database relies on them — so with the
built-in server the database never loads and pages like a person or a search
fail. This server adds range support, so it behaves like GitHub Pages.

    cd stuart-pages
    python3 serve-local.py            # http://localhost:8000
    python3 serve-local.py 8123       # a different port

GitHub Pages supports range requests natively, so once deployed you don't need
this — it's only for local testing.
"""
import os, re, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler + HTTP Range (206 Partial Content)."""

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().do_GET()

        m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().do_GET()

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "":                       # suffix range: bytes=-N
            length = int(end_s); start = max(0, size - length); end = size - 1
        else:
            start = int(start_s); end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        length = end - start + 1

        ctype = self.guess_type(path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404); return
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        f.seek(start)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
            except BrokenPipeError:
                break
            remaining -= len(chunk)
        f.close()

    def log_message(self, *a):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    srv = ThreadingHTTPServer(("127.0.0.1", port), RangeHandler)
    print(f"Serving the static build with range support at http://localhost:{port}")
    print("(This mimics GitHub Pages. Plain `python3 -m http.server` will NOT work here.)")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
