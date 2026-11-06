"""Tiny HTTP helper with retries. Standard library only."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

DEFAULT_UA = "econ-dashboard/0.1 (+https://github.com/andrewdr14/econ-dashboard)"
# Some sites (Bank of England) reject non-browser user agents.
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def get(url: str, *, browser: bool = False, retries: int = 3, timeout: int = 60) -> bytes:
    headers = {"User-Agent": BROWSER_UA if browser else DEFAULT_UA}
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            last = exc
            # 4xx other than 429 won't fix themselves.
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500 and exc.code != 429:
                break
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GET {url.split('api_key=')[0]} failed: {last}")


def get_json(url: str, **kw):
    return json.loads(get(url, **kw))


def get_text(url: str, **kw) -> str:
    return get(url, **kw).decode("utf-8", errors="replace")
