#!/usr/bin/env python3
"""Serve the replay viewer: python3 viewer/serve.py [port=8080]. Serves viewer/ at /, out/ at /runs/, and list.json
(runs that have both a .json log and a .mp4). Open http://127.0.0.1:8080/?run=<name>."""
import json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), "out")


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        p = path.split("?")[0]
        if p.startswith("/runs/"):
            return os.path.join(OUT, p[len("/runs/"):])
        return super().translate_path(path)

    def do_GET(self):
        if self.path.split("?")[0] == "/list.json":
            names = sorted(f[:-5] for f in os.listdir(OUT) if f.endswith(".json") and os.path.exists(os.path.join(OUT, f[:-5] + ".mp4"))) if os.path.isdir(OUT) else []
            body = json.dumps(names).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"viewer on http://127.0.0.1:{port}/  (runs from {OUT})")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
