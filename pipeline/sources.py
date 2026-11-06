"""Data source connectors. Each returns (observations, source_url) where
observations is a list of (iso_date, float) sorted ascending."""
from __future__ import annotations

import csv
import io
import os
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


FETCHERS = {"fred": fred, "ons": ons, "boe": boe}
