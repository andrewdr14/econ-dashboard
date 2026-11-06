"""UK migration statistics. Neither the Home Office nor ONS offers an API for
these, so each fetcher finds the latest published file via the GOV.UK Content
API (or ONS's /data JSON) and parses it. Big files are cached by URL so they
are only downloaded again when a new edition is published."""
from __future__ import annotations

import html
import json
import re
from datetime import date, datetime
from pathlib import Path

from .http import get, get_json, get_text
from .spreadsheets import ods_sheet, table_from_header, xlsx_rows

Obs = list[tuple[str, float]]
CACHE = Path(__file__).resolve().parent.parent / "data_cache" / "sources.json"
GOVUK = "https://www.gov.uk/api/content"
SMALL_BOATS = "/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats"
DATA_TABLES = "/government/statistical-data-sets/immigration-system-statistics-data-tables"
ONS_LTIM = ("https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/internationalmigration/"
            "datasets/longterminternationalimmigrationemigrationandnetmigrationflowsprovisional")


# ---------------------------------------------------------------- cache by source URL
def _cached(key: str, url: str, compute) -> Obs:
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    hit = cache.get(key)
    if hit and hit.get("url") == url:
        return [tuple(o) for o in hit["obs"]]
    obs = compute()
    cache[key] = {"url": url, "fetched": datetime.utcnow().strftime("%Y-%m-%d"), "obs": obs}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=0, sort_keys=True), encoding="utf-8")
    return obs


def _attachment(path: str, title_test, content_type: str | None = None) -> str:
    page = get_json(GOVUK + path)
    for a in page.get("details", {}).get("attachments", []):
        if title_test(a.get("title", "")) and (content_type is None or a.get("content_type") == content_type):
            return a["url"]
    raise RuntimeError(f"No matching attachment on gov.uk{path}")


def _quarter_date(label: str) -> str:
    m = re.match(r"(\d{4})\s*Q([1-4])", label.strip())
    if not m:
        raise ValueError(label)
    return f"{m.group(1)}-{(int(m.group(2)) - 1) * 3 + 1:02d}-01"


# ---------------------------------------------------------------- small boats (daily -> monthly)
def _small_boats_daily() -> dict[str, float]:
    url = _attachment(SMALL_BOATS, lambda t: "time series" in t.lower(), "application/vnd.oasis.opendocument.spreadsheet")
    daily: dict[str, float] = {}
    rows = ods_sheet(get(url), "SB_01")
    for r in rows[1:]:
        if len(r) > 1 and re.match(r"\d{4}-\d{2}-\d{2}", r[0] or "") and re.match(r"^-?\d+(\.\d+)?$", r[1] or ""):
            daily[r[0][:10]] = float(r[1])
    # The weekly ODS lags; the "last 7 days" HTML page tops it up.
    try:
        page = get_json(GOVUK + SMALL_BOATS + "/migrants-detected-crossing-the-english-channel-in-small-boats-last-7-days")
        body = page.get("details", {}).get("body", "")
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body, flags=re.S):
            cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.S)]
            if len(cells) >= 2 and re.match(r"^\d+$", cells[1].replace(",", "")):
                try:
                    d = datetime.strptime(cells[0], "%d %B %Y").date().isoformat()
                except ValueError:
                    continue
                daily[d] = float(cells[1].replace(",", ""))
    except Exception:
        pass  # top-up is optional
    return daily


def small_boats(ind: dict) -> tuple[Obs, str]:
    daily = _small_boats_daily()
    last = max(daily)
    monthly: dict[str, float] = {}
    for d, v in daily.items():
        k = d[:7] + "-01"
        monthly[k] = monthly.get(k, 0.0) + v
    # Drop the current, incomplete month unless the data runs to its last day.
    last_d = date.fromisoformat(last)
    nxt = date(last_d.year + (last_d.month == 12), last_d.month % 12 + 1, 1)
    if (nxt - last_d).days > 1:
        monthly.pop(last[:7] + "-01", None)
    return sorted(monthly.items()), "https://www.gov.uk" + SMALL_BOATS


# ---------------------------------------------------------------- quarterly detailed datasets
def asylum_claims(ind: dict) -> tuple[Obs, str]:
    url = _attachment(DATA_TABLES, lambda t: t.lower().startswith("asylum claims and initial decisions detailed"))

    def compute():
        q: dict[str, float] = {}
        for r in table_from_header(xlsx_rows(get(url, timeout=180), "Data_Asy_D01"), "Year"):
            v = (r.get("Claims") or "").strip()
            if r.get("Quarter") and re.match(r"^\d+(\.\d+)?$", v):
                k = _quarter_date(r["Quarter"])
                q[k] = q.get(k, 0.0) + float(v)
        return sorted(q.items())

    return _cached("uk_asylum_claims", url, compute), "https://www.gov.uk" + DATA_TABLES


def visas_granted(ind: dict) -> tuple[Obs, str]:
    """Entry clearance visas issued, filtered to the configured visa type groups."""
    groups = set(ind.get("visa_groups") or [])
    url = _attachment(DATA_TABLES, lambda t: t.lower().startswith("entry clearance visa applications and outcomes detailed"))

    def compute():
        # One pass, keep every group so other indicators can reuse the cache.
        out: dict[str, dict[str, float]] = {}
        for r in table_from_header(xlsx_rows(get(url, timeout=300), "Data_Vis_D02"), "Year"):
            if (r.get("Case outcome") or "").strip() != "Issued":
                continue
            v = (r.get("Decisions") or "").strip()
            if not (r.get("Quarter") and re.match(r"^\d+(\.\d+)?$", v)):
                continue
            g = (r.get("Visa type group") or "").strip()
            k = _quarter_date(r["Quarter"])
            out.setdefault(g, {})
            out[g][k] = out[g].get(k, 0.0) + float(v)
        return [[g, sorted(d.items())] for g, d in sorted(out.items())]

    by_group = _cached("uk_visas_issued_by_group", url, compute)
    total: dict[str, float] = {}
    for g, obs in by_group:
        if not groups or g in groups:
            for d, v in obs:
                total[d] = total.get(d, 0.0) + v
    if not total:
        raise RuntimeError(f"No visa data for groups {groups}; available: {[g for g, _ in by_group]}")
    return sorted(total.items()), "https://www.gov.uk" + DATA_TABLES


# ---------------------------------------------------------------- ONS net migration (rolling 12m)
_MON = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


def net_migration(ind: dict) -> tuple[Obs, str]:
    flow = ind.get("flow", "Net migration")
    latest = get_json(ONS_LTIM + "/data")["datasets"][0]["uri"]
    meta = get_json("https://www.ons.gov.uk" + latest + "/data")
    fname = meta["downloads"][0]["file"]
    url = f"https://www.ons.gov.uk/file?uri={latest}/{fname}"

    def compute():
        obs = {}
        for r in xlsx_rows(get(url), "1"):
            a, b, c = (r.get("A") or "").strip(), (r.get("B") or "").strip(), (r.get("C") or "").strip()
            m = re.match(r"YE\s+([A-Za-z]{3})\s+(\d{2})", b)
            if a == flow and m and re.match(r"^-?\d+(\.\d+)?$", c):
                # Rolling year ending in that month: date it at the month's start.
                obs[f"20{m.group(2)}-{_MON[m.group(1).upper()]:02d}-01"] = float(c)
        return sorted(obs.items())

    return _cached(f"uk_ltim_{flow}", url, compute), ONS_LTIM
