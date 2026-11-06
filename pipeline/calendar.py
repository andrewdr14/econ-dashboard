"""Upcoming economic release calendar for each country."""
from __future__ import annotations

import os
import re
import urllib.parse
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .http import get_json, get_text


def _event(**kw) -> dict:
    kw.setdefault("indicators", [])
    kw.setdefault("time_known", True)
    kw.setdefault("provisional", False)
    kw.setdefault("note", None)
    kw["id"] = f"{kw['country']}-{kw['datetime_utc'][:10]}-{re.sub(r'[^a-z0-9]+', '-', kw['title'].lower())}"
    return kw


def _match(title: str, rules: list[dict], prefix: bool = False) -> dict | None:
    """Case-insensitive match; prefix=True requires the title to start with the rule."""
    t = title.lower().strip()
    for rule in rules:
        m = rule["match"].lower()
        if (t.startswith(m) if prefix else m in t):
            return rule
    return None


def _local_to_utc(d: date, hhmm: str, tz: str) -> str:
    h, m = map(int, hhmm.split(":"))
    local = datetime.combine(d, time(h, m), tzinfo=ZoneInfo(tz))
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- UK: ONS release calendar
def ons_events(rules: list[dict], start: date, end: date) -> list[dict]:
    events, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "release-type": "type-upcoming", "limit": 100, "offset": offset,
            "sort": "release_date_asc", "fromDate": start.isoformat(), "toDate": end.isoformat(),
        })
        page = get_json(f"https://api.beta.ons.gov.uk/v1/search/releases?{q}")
        releases = page.get("releases") or []
        for r in releases:
            desc = r["description"]
            title = desc["title"]
            # Skip the companion "time series" / regional publications - same release.
            if any(x in title.lower() for x in ("time series", "timeseries", "in the regions")):
                continue
            if desc.get("cancelled"):
                continue
            rule = _match(title, rules, prefix=True)
            if not rule:
                continue
            events.append(_event(
                country="UK", title=rule["label"], detail=title,
                importance=rule["importance"], indicators=rule.get("indicators", []),
                datetime_utc=desc["release_date"].replace(".000Z", "Z"),
                provisional=not desc.get("finalised", True),
                source="ONS", url=f"https://www.ons.gov.uk{r['uri']}",
            ))
        offset += len(releases)
        if not releases or offset >= 1000:
            break
    return events


# ---------------------------------------------------------------- US: FRED release dates (needs API key)
def fred_events(rules: list[dict], start: date, end: date, key: str) -> list[dict]:
    q = urllib.parse.urlencode({
        "api_key": key, "file_type": "json", "realtime_start": start.isoformat(),
        "realtime_end": end.isoformat(), "include_release_dates_with_no_data": "true",
        "sort_order": "asc", "limit": 1000,
    })
    data = get_json(f"https://api.stlouisfed.org/fred/releases/dates?{q}")
    events, seen = [], set()
    for r in data.get("release_dates", []):
        rule = _match(r["release_name"], rules)
        if not rule:
            continue
        d = date.fromisoformat(r["date"])
        if not (start <= d <= end) or (rule["label"], d) in seen:
            continue
        seen.add((rule["label"], d))
        events.append(_event(
            country="US", title=rule["label"], detail=r["release_name"],
            importance=rule["importance"], indicators=rule.get("indicators", []),
            datetime_utc=_local_to_utc(d, rule["time"], rule["tz"]),
            source="FRED", url=f"https://fred.stlouisfed.org/release?rid={r['release_id']}",
        ))
    return events


# ---------------------------------------------------------------- US fallback: BEA iCal feed (no key)
def _ics_unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.splitlines():
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def bea_events(rules: list[dict], start: date, end: date) -> list[dict]:
    text = get_text("https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics")
    events, cur = [], None
    for line in _ics_unfold(text):
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT" and cur is not None:
            summary = cur.get("SUMMARY", "").replace("\\,", ",")
            dt = cur.get("DTSTART", "")
            rule = _match(summary, rules, prefix=True)
            if rule and dt:
                when = datetime.strptime(dt[:15], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
                if start <= when.date() <= end:
                    events.append(_event(
                        country="US", title=rule["label"], detail=summary,
                        importance=rule["importance"], indicators=rule.get("indicators", []),
                        datetime_utc=when.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        source="BEA", url="https://www.bea.gov/news/schedule",
                    ))
            cur = None
        elif cur is not None and ":" in line:
            k, v = line.split(":", 1)
            cur[k.split(";")[0]] = v
    return events


# ---------------------------------------------------------------- Central bank meetings (config)
def meeting_events(meetings: dict, start: date, end: date) -> list[dict]:
    events = []
    for country, m in meetings.items():
        if country.startswith("_"):
            continue
        for item in m["dates"]:
            d = date.fromisoformat(item["date"])
            if start <= d <= end:
                events.append(_event(
                    country=country, title=m["label"], detail=m["label"],
                    importance="high", indicators=m.get("indicators", []),
                    datetime_utc=_local_to_utc(d, m["time"], m["tz"]),
                    note=item.get("note"), source="Central bank schedule", url=None,
                ))
    return events


def build(cal_cfg: dict, meetings: dict, today: date | None = None) -> tuple[list[dict], list[str]]:
    today = today or datetime.now(timezone.utc).date()
    start, end = today, today + timedelta(days=cal_cfg.get("horizon_days", 90))
    events: list[dict] = []
    warnings: list[str] = []

    def run(name, fn, *args):
        try:
            events.extend(fn(*args))
        except Exception as exc:  # one source failing shouldn't sink the calendar
            warnings.append(f"{name}: {exc}")

    run("ONS calendar", ons_events, cal_cfg["UK"]["ons_releases"], start, end)
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        run("FRED calendar", fred_events, cal_cfg["US"]["fred_releases"], start, end, key)
    else:
        warnings.append("FRED_API_KEY not set: US calendar limited to BEA releases and FOMC meetings")
        run("BEA calendar", bea_events, cal_cfg["US"]["bea_fallback"], start, end)
    run("Central bank meetings", meeting_events, meetings, start, end)

    # De-duplicate (same country, title, day) and sort.
    uniq = {e["id"]: e for e in events}
    out = sorted(uniq.values(), key=lambda e: (e["datetime_utc"], e["country"], e["title"]))
    return out, warnings
