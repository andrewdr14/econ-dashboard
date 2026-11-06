"""Data source connectors. Each returns (observations, source_url) where
observations is a list of (iso_date, float) sorted ascending."""
from __future__ import annotations

import csv
import io
import os
import re
import urllib.parse
from datetime import datetime

from .http import get_json, get_text

Obs = list[tuple[str, float]]


# ---------------------------------------------------------------- FRED (US)
def fred(ind: dict) -> tuple[Obs, str]:
    sid = ind["series"]
    start = ind.get("start", "1990-01-01")
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        q = urllib.parse.urlencode({
            "series_id": sid, "api_key": key, "file_type": "json", "observation_start": start,
        })
        data = get_json(f"https://api.stlouisfed.org/fred/series/observations?{q}")
        rows = [(o["date"], o["value"]) for o in data["observations"]]
    else:
        # Keyless CSV download (the same file as FRED's "Download CSV" button).
        text = get_text(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}")
        reader = csv.reader(io.StringIO(text))
        next(reader)
        rows = [(r[0], r[1]) for r in reader if len(r) >= 2]
    obs = [(d, float(v)) for d, v in rows if v not in (".", "", "NA") and d >= start]
    return obs, f"https://fred.stlouisfed.org/series/{sid}"


# ---------------------------------------------------------------- ONS (UK)
_MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


def _ons_uri(cdid: str, dataset: str) -> str:
    """ONS time series live under topic paths, so look the path up via search."""
    q = urllib.parse.urlencode({"q": cdid, "content_type": "timeseries", "limit": 50})
    res = get_json(f"https://api.beta.ons.gov.uk/v1/search?{q}")
    suffix = f"/timeseries/{cdid.lower()}/{dataset.lower()}"
    for item in res.get("items", []):
        if item.get("uri", "").lower().endswith(suffix):
            return item["uri"]
    raise RuntimeError(f"ONS series {cdid}/{dataset} not found via search")


def _ons_date(row: dict, freq: str) -> str:
    y = int(row["year"])
    if freq == "months":
        return f"{y}-{_MONTHS[row['month'].strip().upper()[:3]]:02d}-01"
    if freq == "quarters":
        q = int(row["quarter"].strip().upper().lstrip("Q"))
        return f"{y}-{(q - 1) * 3 + 1:02d}-01"
    return f"{y}-01-01"


def ons(ind: dict) -> tuple[Obs, str]:
    uri = _ons_uri(ind["series"], ind["dataset"])
    data = get_json(f"https://www.ons.gov.uk{uri}/data")
    for freq in ("months", "quarters", "years"):
        rows = data.get(freq) or []
        if rows:
            break
    obs = []
    for r in rows:
        v = (r.get("value") or "").strip()
        if not v:
            continue
        obs.append((_ons_date(r, freq), float(v)))
    start = ind.get("start", "1990-01-01")
    obs = sorted(o for o in obs if o[0] >= start)
    return obs, f"https://www.ons.gov.uk{uri}"


# ---------------------------------------------------------------- Bank of England (UK)
def boe(ind: dict) -> tuple[Obs, str]:
    code = ind["series"]
    start = datetime.strptime(ind.get("start", "2000-01-01"), "%Y-%m-%d").strftime("%d/%b/%Y")
    q = urllib.parse.urlencode({
        "csv.x": "yes", "Datefrom": start, "Dateto": "now", "SeriesCodes": code,
        "CSVF": "TN", "UsingCodes": "Y", "VPD": "Y", "VFD": "N",
    })
    text = get_text(
        f"https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?{q}", browser=True)
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    if len(header) < 2 or header[1].strip() != code:
        raise RuntimeError(f"Unexpected BoE response for {code}: {text[:200]!r}")
    obs = []
    for r in reader:
        if len(r) >= 2 and r[1].strip():
            d = datetime.strptime(r[0].strip(), "%d %b %Y").strftime("%Y-%m-%d")
            obs.append((d, float(r[1])))
    obs.sort()
    page = f"https://www.bankofengland.co.uk/boeapps/database/fromshowcolumns.asp?SeriesCodes={code}&UsingCodes=Y&Datefrom={start}&Dateto=now&html.x=yes"
    return obs, page


def _period_to_date(p: str) -> str:
    """SDMX-style periods: 2026-09-14, 2026-09, 2026-Q3, 2026-S1, 2026."""
    p = p.strip()
    if len(p) == 10:
        return p
    if "-Q" in p:
        y, q = p.split("-Q")
        return f"{y}-{(int(q) - 1) * 3 + 1:02d}-01"
    if "-S" in p:
        y, s = p.split("-S")
        return f"{y}-{(int(s) - 1) * 6 + 1:02d}-01"
    if len(p) == 7:
        return f"{p}-01"
    if len(p) == 4:
        return f"{p}-01-01"
    raise ValueError(f"Unrecognised period {p!r}")


# ---------------------------------------------------------------- Eurostat (EU)
def eurostat(ind: dict) -> tuple[Obs, str]:
    """Eurostat dissemination API (JSON-stat 2.0). `filters` must pin every
    dimension except time to a single value."""
    ds = ind["dataset"]
    q = urllib.parse.urlencode({"format": "JSON", "lang": "EN", **ind["filters"]})
    data = get_json(f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{ds}?{q}")
    sizes = dict(zip(data["id"], data["size"]))
    extra = {k: v for k, v in sizes.items() if k != "time" and v != 1}
    if extra:
        raise RuntimeError(f"Eurostat {ds}: filters leave multiple values for {extra}")
    tindex = data["dimension"]["time"]["category"]["index"]
    periods = {v: k for k, v in tindex.items()}
    obs = sorted((_period_to_date(periods[int(i)]), float(v)) for i, v in data["value"].items() if v is not None)
    start = ind.get("start", "1990-01-01")
    return [o for o in obs if o[0] >= start], f"https://ec.europa.eu/eurostat/databrowser/view/{ds}/default/table"


# ---------------------------------------------------------------- ECB Data Portal (euro area)
def ecb(ind: dict) -> tuple[Obs, str]:
    key = ind["series"]  # e.g. FM/D.U2.EUR.4F.KR.DFR.LEV
    start = ind.get("start", "1999-01-01")
    text = get_text(f"https://data-api.ecb.europa.eu/service/data/{key}?format=csvdata&startPeriod={start[:7]}")
    obs = []
    for r in csv.DictReader(io.StringIO(text)):
        v = (r.get("OBS_VALUE") or "").strip()
        if v and v.upper() != "NAN":
            obs.append((_period_to_date(r["TIME_PERIOD"]), float(v)))
    flow, rest = key.split("/", 1)
    return sorted(obs), f"https://data.ecb.europa.eu/data/datasets/{flow}/{flow}.{rest}"


# ---------------------------------------------------------------- US CBP border encounters
_CBP_PAGE = "https://www.cbp.gov/document/stats/nationwide-encounters"
_FY_MONTH = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
_cbp_cache: dict[str, list[dict]] = {}


def _cbp_rows() -> list[dict]:
    """CBP publishes rolling 4-fiscal-year CSVs whose names change monthly, so
    find the newest one on the stats page, plus the oldest for extra history."""
    if "rows" in _cbp_cache:
        return _cbp_cache["rows"]
    page = get_text(_CBP_PAGE, browser=True)
    links = sorted(set(re.findall(r'/sites/default/files/(\d{4}-\d{2})/(nationwide-encounters-fy(\d{2})[^"]*?-aor\.csv)', page)))
    if not links:
        raise RuntimeError("No CBP encounter CSV links found on the stats page")
    newest = max(links, key=lambda x: x[0])
    oldest = min(links, key=lambda x: (x[2], x[0]))
    files = [oldest, newest] if oldest != newest else [newest]
    by_month: dict[tuple, list[dict]] = {}
    for folder, name, _ in files:  # later file overwrites overlapping months
        text = get_text(f"https://www.cbp.gov/sites/default/files/{folder}/{name}", browser=True)
        fresh: dict[tuple, list[dict]] = {}
        for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
            fy, mon = int(r["Fiscal Year"]), r["Month (abbv)"].strip().upper()[:3]
            m = _FY_MONTH[mon]
            year = fy - 1 if m >= 10 else fy
            fresh.setdefault((year, m), []).append(r)
        by_month.update(fresh)
    rows = [dict(r, _date=f"{y}-{m:02d}-01") for (y, m), rs in by_month.items() for r in rs]
    _cbp_cache["rows"] = rows
    return rows


def cbp(ind: dict) -> tuple[Obs, str]:
    filt = ind.get("filters", {})
    totals: dict[str, float] = {}
    for r in _cbp_rows():
        if all(r.get(k, "").strip() == v for k, v in filt.items()):
            totals[r["_date"]] = totals.get(r["_date"], 0.0) + float(r["Encounter Count"] or 0)
    return sorted(totals.items()), "https://www.cbp.gov/newsroom/stats/nationwide-encounters"


from . import migration_uk  # noqa: E402

FETCHERS = {
    "fred": fred, "ons": ons, "boe": boe, "eurostat": eurostat, "ecb": ecb, "cbp": cbp,
    "small_boats": migration_uk.small_boats, "uk_asylum": migration_uk.asylum_claims,
    "uk_visas": migration_uk.visas_granted, "ons_ltim": migration_uk.net_migration,
}
