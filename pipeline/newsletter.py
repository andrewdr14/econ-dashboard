"""Send the morning Learning Centre email through Buttondown, once per issue.

    python -m pipeline.newsletter            # send today's issue if not sent yet
    python -m pipeline.newsletter --dry-run  # print the email instead

Needs BUTTONDOWN_API_KEY (a GitHub secret in CI). Does nothing without it, before
the send window (publish_hour to 18:00, UK time), or if today's issue was already sent (data_cache/newsletter.json).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "data_cache" / "newsletter.json"
API = "https://api.buttondown.com/v1/emails"


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def compose(cfg: dict, learning: dict) -> tuple[str, str]:
    site = cfg["site_url"].rstrip("/") + "/"
    iss = learning["issues"][0]
    d = date.fromisoformat(iss["date"])
    arts = {s: _load(ROOT / "site" / "data" / "learning" / s / f"{iss[s]['slug']}.json") for s in ("explainers", "spotlights")}
    ex, sp = arts["explainers"], arts["spotlights"]
    subject = f"Morning reading, {d.strftime('%a')} {d.day} {d.strftime('%b')}: {ex['title']} · {sp['country'] or sp['title']}"

    def block(a, label):
        link = f"{site}#learn/{a['series']}/{a['slug']}"
        return (f"## {label}: {a['title']}\n\n*{a['dek']}* ({a['minutes']} min read)\n\n{a['intro']}\n\n"
                f"**[Read the full article →]({link})**\n")

    body = "\n".join([
        "<!-- buttondown-editor-mode: plaintext -->",
        f"Good morning. Here are today's two reads from the Macro Monitor Learning Centre, issue {learning['issue_number']}.\n",
        block(ex, "The Explainer"),
        "---\n",
        block(sp, "Country Spotlight"),
        "---\n",
        f"Browse earlier editions and live economic data at [Macro Monitor]({site}#learn).",
    ])
    return subject, body


def send(subject: str, body: str, key: str) -> dict:
    req = urllib.request.Request(
        API, method="POST",
        data=json.dumps({"subject": subject, "body": body, "status": "about_to_send"}).encode(),
        headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Buttondown {e.code}: {e.read().decode(errors='replace')[:500]}") from None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    cfg = _load(ROOT / "config" / "learning.json")
    learning = _load(ROOT / "site" / "data" / "learning.json")
    issue = learning["issues"][0]["date"]
    subject, body = compose(cfg, learning)
    if args.dry_run:
        sys.stdout.reconfigure(encoding="utf-8")
        print(subject, "\n", body, sep="")
        return 0
    key = os.environ.get("BUTTONDOWN_API_KEY")
    if not key:
        print("newsletter: BUTTONDOWN_API_KEY not set; skipping")
        return 0
    local = datetime.now(timezone.utc).astimezone(ZoneInfo(cfg.get("timezone", "Europe/London")))
    hour = int(cfg.get("publish_hour", 6))
    # Only send on the issue's own day, before 18:00, so a late evening run doesn't send a stale email.
    if local.date().isoformat() != issue or not (hour <= local.hour < 18):
        print(f"newsletter: outside the morning window for issue {issue} ({local:%Y-%m-%d %H:%M}); skipping")
        return 0
    state = _load(STATE) if STATE.exists() else {}
    if state.get("last_sent") == issue:
        print(f"newsletter: issue {issue} already sent")
        return 0
    res = send(subject, body, key)
    state.update({"last_sent": issue, "last_subject": subject, "last_id": res.get("id"),
                  "sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    print(f"newsletter: sent '{subject}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
