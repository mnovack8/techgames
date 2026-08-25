"""Static local server with the project's canonical blog URL behavior."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import argparse


ROOT = Path(__file__).resolve().parent
BLOG_REDIRECTS = {
    "/blog/be-the-bridge-stem-thinker": "/blog/be-the-bridge",
    "/blog/be-the-bridge-stem-thinker.html": "/blog/be-the-bridge",
    "/blog/stem-humanities-bridge": "/blog/people-process-tools-board-game-example",
    "/blog/stem-humanities-bridge.html": "/blog/people-process-tools-board-game-example",
}
BLOG_ALIASES = {
    "/blog/be-the-bridge": "/blog/be-the-bridge-stem-thinker.html",
}


class LocalHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _blog_path(self):
        return urlsplit(self.path).path

    def _canonical_blog_url(self):
        pathname = self._blog_path()
        if not pathname.startswith("/blog/"):
            return None

        if pathname.endswith(".html"):
            candidate = ROOT / pathname.lstrip("/")
            if candidate.is_file():
                return pathname[:-5]
            return None

        if Path(pathname).suffix:
            return None

        candidate = ROOT / f"{pathname.lstrip('/')}.html"
        if candidate.is_file():
            return pathname
        return None

    def do_GET(self):
        pathname = self._blog_path()
        if pathname in BLOG_REDIRECTS:
            query = urlsplit(self.path).query
            location = BLOG_REDIRECTS[pathname] + (f"?{query}" if query else "")
            self.send_response(301)
            self.send_header("Location", location)
            self.end_headers()
            return

        if pathname in BLOG_ALIASES:
            self.path = BLOG_ALIASES[pathname]
            super().do_GET()
            return

        canonical_url = self._canonical_blog_url()

        if canonical_url and pathname.endswith(".html"):
            query = urlsplit(self.path).query
            location = canonical_url + (f"?{query}" if query else "")
            self.send_response(301)
            self.send_header("Location", location)
            self.end_headers()
            return

        if canonical_url and not pathname.endswith(".html"):
            self.path = pathname + ".html"

        super().do_GET()

    def do_HEAD(self):
        self.do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serve TechCoLab locally with clean blog URLs")
    parser.add_argument("port", nargs="?", type=int, default=8090)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("", args.port), LocalHandler)
    print(f"TechCoLab local server running at http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local server")
    finally:
        server.server_close()
