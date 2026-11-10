"""Fetch every configured indicator and the release calendar, then write the
JSON files the static site reads (site/data/).

    python -m pipeline.build              # everything
    python -m pipeline.build --only uk_cpi_yoy us_cpi_yoy
    python -m pipeline.build --skip-calendar
    python -m pipeline.build --only-elections
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path = ROOT / ".env") -> None:
    """Load KEY=VALUE lines from a local, gitignored .env (CI uses repo secrets instead)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

from . import calendar, elections, transforms  # noqa: E402
from .sources import FETCHERS  # noqa: E402

CONFIG = ROOT / "config"
OUT = ROOT / "site" / "data"
SPARK_POINTS = {"daily": 260, "weekly": 104, "monthly": 36, "quarterly": 20, "annual": 15}


def _load(name: str) -> dict:
    return json.loads((CONFIG / name).read_text(encoding="utf-8"))


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def _spark(obs, freq):
    pts = obs[-SPARK_POINTS.get(freq, 36):]
    if freq == "daily":  # keep the sparkline light: weekly sampling of the last year
        pts = pts[::5] + ([pts[-1]] if (len(pts) - 1) % 5 else [])
    return [[d, round(v, 4)] for d, v in pts]


def build_indicator(ind: dict) -> dict:
    meta = {k: ind.get(k) for k in ("id", "country", "category", "concept", "name", "unit", "decimals", "source", "series", "chart", "note", "hidden")}
    try:
        raw, url = FETCHERS[ind["source"]](ind)
        obs = transforms.apply(raw, ind.get("transform", "level"), ind.get("scale", 1.0), ind.get("window", 12))
        if not obs:
            raise RuntimeError("no observations")
        freq = ind.get("freq") or transforms.frequency(obs)
        _write(OUT / "series" / f"{ind['id']}.json",
               {"id": ind["id"], "frequency": freq, "observations": [[d, round(v, 4)] for d, v in obs]})
        last_d, last_v = obs[-1]
        prev = obs[-2] if len(obs) > 1 else None
        if ind.get("compare") == "yoy":  # seasonal, non-adjusted series: compare with a year earlier
            year_ago = transforms._year_earlier(last_d)
            prev = next(((d, v) for d, v in obs if d == year_ago), None)
        meta.update({
            "status": "ok", "url": url, "frequency": freq,
            "latest": {"date": last_d, "value": round(last_v, 4), "period": transforms.period_label(last_d, freq)},
            "previous": {"date": prev[0], "value": round(prev[1], 4),
                         "period": transforms.period_label(prev[0], freq)} if prev else None,
            "spark": _spark(obs, freq),
        })
    except Exception as exc:
        meta.update({"status": "error", "error": str(exc)})
        # Keep the last good file so one failed fetch doesn't blank the dashboard.
        old = OUT / "summary.json"
        if old.exists():
            for o in json.loads(old.read_text(encoding="utf-8")).get("indicators", []):
                if o["id"] == ind["id"] and o.get("status") in ("ok", "stale"):
                    meta.update({k: o[k] for k in o if k not in meta or k in ("latest", "previous", "spark", "url", "frequency")})
                    meta["status"] = "stale"
    return meta


def build_elections() -> None:
    try:
        items, sources, warnings = elections.build()
    except Exception as exc:  # keep the previous file if Wikipedia is unreachable
        print(f"  elections: FAILED ({exc}); keeping previous data")
        return
    if not items:
        print("  elections: no entries parsed; keeping previous data")
        return
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write(OUT / "elections.json", {"generated_at": now, "sources": sources, "warnings": warnings, "elections": items})
    print(f"  elections: {len(items)} entries")
    for w in warnings:
        print(f"  elections warning: {w}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="indicator ids to refresh")
    ap.add_argument("--skip-calendar", action="store_true")
    ap.add_argument("--skip-elections", action="store_true")
    ap.add_argument("--only-elections", action="store_true", help="just refresh the election calendar")
    args = ap.parse_args(argv)

    if not args.skip_elections:
        build_elections()
    if args.only_elections:
        return 0

    cfg = _load("series.json")
    indicators = cfg["indicators"]
    todo = [i for i in indicators if not args.only or i["id"] in args.only]

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = {r["id"]: r for r in pool.map(build_indicator, todo)}

    # Merge with existing summary when refreshing a subset.
    existing = {}
    if (OUT / "summary.json").exists():
        existing = {o["id"]: o for o in json.loads((OUT / "summary.json").read_text(encoding="utf-8")).get("indicators", [])}
    merged = [results.get(i["id"]) or existing.get(i["id"]) or {"id": i["id"], "status": "missing"} for i in indicators]

    explainers = _load("explainers.json")
    for m in merged:
        m["about"] = explainers["indicators"].get(m["id"])
        m["hidden"] = next((bool(i.get("hidden")) for i in indicators if i["id"] == m["id"]), False)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write(OUT / "summary.json", {
        "generated_at": now, "countries": cfg["countries"], "categories": cfg["categories"],
        "concepts": cfg["concepts"], "indicators": merged, "release_about": explainers["releases"],
    })

    failed = [r for r in results.values() if r["status"] != "ok"]
    for r in results.values():
        mark = "ok " if r["status"] == "ok" else r["status"].upper()
        latest = r.get("latest") or {}
        print(f"  [{mark}] {r['id']:<22} {latest.get('period', ''):<16} {latest.get('value', '')}  {r.get('error', '')}")

    if not args.skip_calendar:
        events, warnings = calendar.build(_load("calendar.json"), _load("central_bank_meetings.json"))
        _write(OUT / "calendar.json", {"generated_at": now, "events": events, "warnings": warnings})
        print(f"  calendar: {len(events)} events")
        for w in warnings:
            print(f"  calendar warning: {w}")

    # Fail the run only if everything broke (e.g. network down), not for one bad series.
    return 1 if todo and len(failed) == len(todo) else 0


if __name__ == "__main__":
    sys.exit(main())
