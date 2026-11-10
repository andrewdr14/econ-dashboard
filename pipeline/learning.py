"""Learning Centre: publish one explainer and one country spotlight per day.

Articles are Markdown files in content/learning/{explainers,spotlights}/ (format in
content/learning/STYLE.md). Issue n (n = days since start_date) uses the n-th file of
each series, wrapping round when a series runs out. A new issue appears at
publish_hour UK time. Spotlights get a live World Bank data panel and the country's
next election from site/data/elections.json.

Writes site/data/learning.json (today + archive), one JSON per published article in
site/data/learning/<series>/<slug>.json, and an RSS feed at site/feed.xml.
"""
from __future__ import annotations

import html
import json
import re
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .http import get_json

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content" / "learning"
OUT = ROOT / "site" / "data"
CACHE = ROOT / "data_cache" / "worldbank.json"
SERIES = {"explainers": "The Explainer", "spotlights": "Country Spotlight"}
WPM = 230  # reading speed for "N min read"


# ---------------------------------------------------------------- markdown (the subset in STYLE.md)
def _inline(s: str) -> str:
    s = html.escape(s, quote=False)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", lambda m: f'<a href="{html.escape(m.group(2))}" target="_blank" rel="noopener">{m.group(1)}</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", s)
    return s


def markdown(md: str) -> tuple[str, list[dict]]:
    """Render to HTML; also return the H2 outline [{id, text}]."""
    out, outline = [], []
    lines = md.strip().splitlines()
    i = 0

    def slugify(t):
        return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")[:60]

    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        if line.startswith("### "):
            out.append(f"<h3>{_inline(line[4:].strip())}</h3>")
            i += 1
            continue
        if line.startswith("## "):
            text = line[3:].strip()
            sid = slugify(text)
            outline.append({"id": sid, "text": text})
            out.append(f'<h2 id="{sid}">{_inline(text)}</h2>')
            i += 1
            continue
        if line.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            out.append(f"<blockquote><p>{_inline(' '.join(buf))}</p></blockquote>")
            continue
        if line.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            cells = lambda l: [c.strip() for c in l.strip().strip("|").split("|")]
            head = cells(line)
            i += 2
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(cells(lines[i]))
                i += 1
            out.append('<div class="art-table"><table><thead><tr>' + "".join(f"<th>{_inline(h)}</th>" for h in head)
                       + "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>" for r in rows)
                       + "</tbody></table></div>")
            continue
        if re.match(r"^\s*[-*] ", line) or re.match(r"^\s*\d+[.)] ", line):
            ordered = bool(re.match(r"^\s*\d+[.)] ", line))
            items = []
            while i < len(lines) and (re.match(r"^\s*([-*]|\d+[.)]) ", lines[i]) or (lines[i].startswith("  ") and lines[i].strip() and items)):
                if re.match(r"^\s*([-*]|\d+[.)]) ", lines[i]):
                    items.append(re.sub(r"^\s*([-*]|\d+[.)]) ", "", lines[i]).strip())
                else:
                    items[-1] += " " + lines[i].strip()
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{_inline(x)}</li>" for x in items) + f"</{tag}>")
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{2,3} |>|\s*[-*] |\s*\d+[.)] |\s*\|)", lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append(f"<p>{_inline(' '.join(buf))}</p>")
    return "\n".join(out), outline


def parse_article(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    meta, body = {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, flags=re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.lstrip().startswith("#"):
                k, v = line.split(":", 1)
                meta[k.strip()] = re.sub(r"\s+#.*$", "", v.strip()).strip().strip('"')
        body = m.group(2)
    words = len(re.findall(r"[A-Za-z0-9’'%-]+", body))
    body_html, outline = markdown(body)
    slug = re.sub(r"^\d+-", "", path.stem)
    plain = re.sub(r"<[^>]+>", "", body_html)
    first_para = re.search(r"<p>(.*?)</p>", body_html, flags=re.S)
    return {
        "slug": slug, "file": path.name, "title": meta.get("title", slug), "dek": meta.get("dek", ""),
        "topic": meta.get("topic"), "tags": [t.strip() for t in meta.get("tags", "").split(",") if t.strip()],
        "country": meta.get("country"), "iso2": meta.get("iso2"), "iso3": meta.get("iso3"),
        "leader_note": meta.get("leader_note"),
        "words": words, "minutes": max(1, round(words / WPM)),
        "html": body_html, "outline": outline,
        "intro": re.sub(r"<[^>]+>", "", first_para.group(1)) if first_para else plain[:400],
    }


# ---------------------------------------------------------------- live data for spotlights
def _worldbank(iso3: str, indicators: list[dict], refresh_days: int) -> list[dict]:
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    hit = cache.get(iso3)
    if hit and (date.today() - date.fromisoformat(hit["fetched"])).days < refresh_days:
        return hit["values"]
    values = []
    for ind in indicators:
        try:
            data = get_json(f"https://api.worldbank.org/v2/country/{iso3}/indicator/{ind['code']}?format=json&mrnev=1", retries=2, timeout=30)
            row = (data[1] or [None])[0] if isinstance(data, list) and len(data) > 1 else None
            # Skip figures too old to describe the economy today (some series stop being reported).
            if row and row.get("value") is not None and int(row["date"]) >= date.today().year - 6:
                values.append({"code": ind["code"], "label": ind["label"], "format": ind["format"], "value": row["value"], "year": row["date"]})
        except Exception:
            continue
    if values or not hit:
        cache[iso3] = {"fetched": date.today().isoformat(), "values": values}
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, indent=0, sort_keys=True), encoding="utf-8")
        return values
    return hit["values"]


def _next_election(iso2: str | None, today: date) -> dict | None:
    f = OUT / "elections.json"
    if not iso2 or not f.exists():
        return None
    for e in json.loads(f.read_text(encoding="utf-8")).get("elections", []):
        # Skip indirect votes (e.g. a president chosen by parliament): readers want the next popular vote.
        if e.get("iso") == iso2 and not e.get("territory") and not e.get("indirect") and (not e.get("date") or e["date"] >= today.isoformat()):
            return {k: e.get(k) for k in ("date", "precision", "year", "month", "offices", "kinds")}
    return None


# ---------------------------------------------------------------- build
def _series_files(series: str) -> list[Path]:
    return sorted(p for p in (CONTENT / series).glob("*.md"))


def issue_date(now: datetime | None, cfg: dict) -> date:
    tz = ZoneInfo(cfg.get("timezone", "Europe/London"))
    local = (now or datetime.now(timezone.utc)).astimezone(tz)
    d = local.date()
    if local.hour < int(cfg.get("publish_hour", 6)):
        d -= timedelta(days=1)
    return max(d, date.fromisoformat(cfg["start_date"]))


def build(cfg: dict, now: datetime | None = None) -> dict:
    today = issue_date(now, cfg)
    start = date.fromisoformat(cfg["start_date"])
    n_today = (today - start).days
    files = {s: _series_files(s) for s in SERIES}
    if not all(files.values()):
        raise RuntimeError("no articles in content/learning/")
    parsed: dict[str, dict] = {}
    issues = []
    # Archive: every past issue, but each article at most once (its most recent appearance).
    seen = set()
    for n in range(n_today, -1, -1):
        d = start + timedelta(days=n)
        issue = {"date": d.isoformat(), "number": n + 1}
        for s, fl in files.items():
            p = fl[n % len(fl)]
            key = (s, p.name)
            if key not in parsed:
                parsed[key] = parse_article(p)
            a = parsed[key]
            issue[s] = {k: a[k] for k in ("slug", "title", "dek", "topic", "country", "iso2", "minutes")}
            issue[s]["repeat"] = key in seen
            seen.add(key)
        issues.append(issue)

    # Write each published article (with live data for spotlights).
    art_dir = OUT / "learning"
    for (s, _), a in parsed.items():
        first_date = next(i["date"] for i in reversed(issues) if i[s]["slug"] == a["slug"])
        last_date = next(i["date"] for i in issues if i[s]["slug"] == a["slug"])
        doc = {**a, "series": s, "series_name": SERIES[s], "published": last_date, "first_published": first_date}
        if s == "spotlights" and a.get("iso3"):
            doc["data"] = _worldbank(a["iso3"], cfg["worldbank_indicators"], int(cfg.get("worldbank_refresh_days", 7)))
            doc["next_election"] = _next_election(a.get("iso2"), today)
        (art_dir / s).mkdir(parents=True, exist_ok=True)
        (art_dir / s / f"{a['slug']}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    summary = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issue_date": today.isoformat(), "issue_number": n_today + 1,
        "publish_hour": cfg.get("publish_hour", 6), "timezone": cfg.get("timezone"),
        "buttondown_username": cfg.get("buttondown_username") or None,
        "library": {s: len(f) for s, f in files.items()},
        "series": SERIES,
        "issues": issues,
    }
    (OUT / "learning.json").write_text(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    _write_feed(cfg, issues[:30], parsed)
    return summary


def _write_feed(cfg: dict, issues: list[dict], parsed: dict) -> None:
    site = cfg["site_url"].rstrip("/") + "/"
    by_slug = {(s, a["slug"]): a for (s, _), a in parsed.items()}
    items = []
    for iss in issues:
        d = datetime.fromisoformat(iss["date"]).replace(hour=int(cfg.get("publish_hour", 6)), tzinfo=ZoneInfo(cfg.get("timezone", "Europe/London")))
        for s, name in SERIES.items():
            a = by_slug[(s, iss[s]["slug"])]
            link = f"{site}#learn/{s}/{a['slug']}"
            items.append(f"""  <item>
    <title>{html.escape(f"{name}: {a['title']}")}</title>
    <link>{link}</link>
    <guid isPermaLink="false">{s}-{a['slug']}-{iss['date']}</guid>
    <pubDate>{format_datetime(d)}</pubDate>
    <description>{html.escape(a['dek'] or a['intro'])}</description>
  </item>""")
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Macro Monitor: Learning Centre</title>
  <link>{site}#learn</link>
  <description>A daily economics explainer and country spotlight, each a 10-minute read.</description>
  <language>en-gb</language>
{chr(10).join(items)}
</channel>
</rss>
"""
    (ROOT / "site" / "feed.xml").write_text(feed, encoding="utf-8")
