"""Worldwide national election calendar.

Source: English Wikipedia's "<year> national electoral calendar" pages (national
elections and referendums in sovereign states and dependent territories), read
through the MediaWiki API. Where a page only gives a month or "unknown date",
the election's Wikidata item is checked for an exact date (P585, point in time).
"""
from __future__ import annotations

import json
import re
import urllib.parse
from datetime import date, timedelta
from pathlib import Path

from .http import get_json

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
CONFIG = Path(__file__).resolve().parent.parent / "config"
COUNTRIES = CONFIG / "countries.json"
EXTRA = CONFIG / "elections_extra.json"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
_MON = {m: i for i, m in enumerate(MONTHS, 1)}
_MONTH_RE = "|".join(MONTHS)
_LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]")


def _wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.strip().replace(" ", "_"), safe="():,'_-")


def _clean(wikitext: str) -> str:
    t = re.sub(r"<!--.*?-->", "", wikitext, flags=re.S)
    t = re.sub(r"<ref[^>]*/>", "", t)
    t = re.sub(r"<ref[^>]*>.*?</ref>", "", t, flags=re.S)
    return t


def _fetch_page(year: int) -> tuple[str, str] | None:
    title = f"{year} national electoral calendar"
    q = urllib.parse.urlencode({"action": "parse", "page": title, "prop": "wikitext", "format": "json",
                                "formatversion": 2, "redirects": 1})
    data = get_json(f"{WIKI_API}?{q}")
    if "error" in data:
        return None
    return data["parse"]["wikitext"], _wiki_url(title)


# ---------------------------------------------------------------- parsing
def _dates(text: str, year: int) -> list[tuple[str, str | None]]:
    """Every '12 March' / '22–23 March' in `text` -> [(start, end_or_None)]."""
    out = []
    for d1, d2, mon in re.findall(rf"(\d{{1,2}})(?:\s*[–\-]\s*(\d{{1,2}}))?\s+({_MONTH_RE})", text):
        m = _MON[mon]
        start = date(year, m, int(d1)).isoformat()
        end = date(year, m, int(d2)).isoformat() if d2 else None
        out.append((start, end))
    return out


def _entry(text: str) -> dict | None:
    """'[[Elections in France|France]], [[2027 French presidential election|President]]' -> parts."""
    territory = "''" in text  # the calendar italicises territories and unrecognised states
    links = _LINK.findall(text)
    if len(links) < 2:
        return None
    target, label = links[0]
    country_title = re.sub(r"^(Elections in|Politics of)\s+", "", target.strip())
    country_label = (label or target).strip().strip(",").strip()
    offices = [{"label": (lab or tgt).strip(), "url": _wiki_url(tgt)} for tgt, lab in links[1:]]
    return {"country_title": country_title, "country": country_label, "offices": offices, "territory_hint": territory}


def parse_calendar(wikitext: str, year: int) -> list[dict]:
    rows: list[dict] = []
    section_month: int | None = None
    indirect = False
    pending: dict | None = None  # date line whose entries follow as '**' lines

    def add(entry_text: str, date_text: str):
        e = _entry(entry_text)
        if not e:
            return
        found = _dates(date_text, year)
        month_only = re.search(rf"\b({_MONTH_RE})\b", date_text)
        if found:
            for start, end in found:
                rows.append({**e, "date": start, "end": end, "precision": "day", "year": year,
                             "month": int(start[5:7]), "indirect": indirect})
        else:
            m = _MON[month_only.group(1)] if month_only else section_month
            rows.append({**e, "date": None, "end": None, "precision": "month" if m else "year",
                         "year": year, "month": m, "indirect": indirect})

    for line in _clean(wikitext).splitlines():
        line = line.rstrip()
        h = re.match(r"^==\s*([^=]+?)\s*==\s*$", line)
        if h:
            name = h.group(1)
            pending = None
            if name in _MON:
                section_month, indirect = _MON[name], False
            elif name.lower().startswith("indirect"):
                section_month, indirect = None, True
            elif name.lower().startswith("unknown"):
                section_month, indirect = None, False
            elif name.lower() in ("see also", "references", "notes", "external links"):
                break
            continue
        if line.startswith("**") and pending is not None:
            add(line.lstrip("*").strip(), pending["date_text"])
            continue
        if line.startswith("*") and not line.startswith("**"):
            body = line[1:].strip()
            # Date text is everything before the first link/italic marker.
            cut = min([i for i in (body.find("[["), body.find("''")) if i >= 0] or [len(body)])
            date_text, rest = body[:cut].strip().rstrip(":").strip(), body[cut:].strip()
            if rest:
                add(rest, date_text)
                pending = None
            else:
                pending = {"date_text": date_text}
    return rows


# ---------------------------------------------------------------- Wikidata exact dates
def _chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def _wikidata_dates(titles: list[str]) -> dict[str, str]:
    """Article title -> ISO date for items whose P585 has day precision."""
    if not titles:
        return {}
    title_to_qid: dict[str, str] = {}
    for chunk in _chunks(sorted(set(titles)), 50):
        q = urllib.parse.urlencode({"action": "query", "prop": "pageprops", "ppprop": "wikibase_item", "redirects": 1,
                                    "titles": "|".join(chunk), "format": "json", "formatversion": 2})
        data = get_json(f"{WIKI_API}?{q}")["query"]
        alias = {t: t for t in chunk}
        for n in data.get("normalized", []):
            alias[n["from"]] = n["to"]
        redirects = {r["from"]: r["to"] for r in data.get("redirects", [])}
        qids = {p["title"]: p.get("pageprops", {}).get("wikibase_item") for p in data.get("pages", [])}
        for t in chunk:
            final = redirects.get(alias.get(t, t), alias.get(t, t))
            if qids.get(final):
                title_to_qid[t] = qids[final]
    qid_date: dict[str, str] = {}
    for chunk in _chunks(sorted(set(title_to_qid.values())), 50):
        q = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(chunk), "props": "claims", "format": "json"})
        for qid, ent in get_json(f"{WIKIDATA_API}?{q}").get("entities", {}).items():
            for claim in ent.get("claims", {}).get("P585", []):
                v = claim.get("mainsnak", {}).get("datavalue", {}).get("value", {})
                if v.get("precision") == 11 and v.get("time", "").startswith("+"):
                    qid_date[qid] = v["time"][1:11]
                    break
    return {t: qid_date[q] for t, q in title_to_qid.items() if q in qid_date}


# ---------------------------------------------------------------- build
def build(today: date | None = None, past_days: int = 60) -> tuple[list[dict], list[str], list[str]]:
    today = today or date.today()
    cfg = json.loads(COUNTRIES.read_text(encoding="utf-8"))
    lookup = {k.lower(): v for k, v in cfg["countries"].items()}
    eu, g20 = set(cfg["eu"]), set(cfg["g20"])
    warnings, sources, rows = [], [], []

    for year in range(today.year, today.year + 3):
        try:
            page = _fetch_page(year)
        except Exception as exc:
            warnings.append(f"{year} calendar: {exc}")
            continue
        if not page:
            continue  # page for a far-off year may not exist yet
        text, url = page
        sources.append(url)
        for r in parse_calendar(text, year):
            r["source_url"] = url
            rows.append(r)

    # Hand-listed major elections in years no calendar page covers yet.
    covered = {int(u.rsplit("/", 1)[1][:4]) for u in sources}
    if EXTRA.exists():
        for x in json.loads(EXTRA.read_text(encoding="utf-8"))["elections"]:
            y = int(x["date"][:4])
            if y in covered:
                continue
            exact = x["precision"] in ("day", "by")
            rows.append({"country_title": x["country"], "country": x["country"], "offices": x["offices"],
                         "territory_hint": False, "date": x["date"] if exact else None, "end": None,
                         "precision": x["precision"], "year": y, "month": int(x["date"][5:7]) if exact else None,
                         "indirect": False, "date_source": "hand-listed",
                         "source_url": "https://github.com/andrewdr14/econ-dashboard/blob/main/config/elections_extra.json"})

    # Exact dates from Wikidata for month-only entries. (Not for "unknown date" ones:
    # Wikidata often holds the legal deadline there, not a scheduled polling day.)
    vague = [r for r in rows if r["precision"] == "month"]
    try:
        exact = _wikidata_dates([urllib.parse.unquote(o["url"].rsplit("/wiki/", 1)[1]).replace("_", " ")
                                 for r in vague for o in r["offices"][:1]])
    except Exception as exc:
        exact, warnings = {}, warnings + [f"Wikidata dates: {exc}"]
    for r in vague:
        t = urllib.parse.unquote(r["offices"][0]["url"].rsplit("/wiki/", 1)[1]).replace("_", " ")
        d = exact.get(t)
        if d and int(d[:4]) == r["year"] and int(d[5:7]) == r["month"]:
            r.update(date=d, precision="day", month=int(d[5:7]), date_source="Wikidata")

    out, unmatched, seen = [], set(), set()
    cutoff = (today - timedelta(days=past_days)).isoformat()
    for r in rows:
        if r["date"] and (r["end"] or r["date"]) < cutoff:
            continue
        if not r["date"] and r["year"] == today.year and r["month"] and r["month"] < today.month:
            continue  # month-only entry that has already passed
        c = lookup.get(r["country_title"].lower()) or lookup.get(r["country"].lower()) \
            or lookup.get(re.sub(r"^the\s+", "", r["country_title"], flags=re.I).lower())
        if not c:
            unmatched.add(r["country"])
        iso = c["iso"] if c else None
        label = " ".join(o["label"] for o in r["offices"]).lower()
        kinds = []
        if re.search(r"president|presidency|supreme leader|federal council|state affairs", label):
            kinds.append("executive")
        if re.search(r"referend|plebiscite", label):
            kinds.append("referendum")
        if re.search(r"parliament|assembly|house|senate|congress|chamber|duma|sejm|knesset|kurultai|"
                     r"deputies|representatives|national council|council of states|legislat", label) or not kinds:
            kinds.append("legislative")
        rnd = re.search(r"\((1st|2nd|first|second) round\)", label)
        key = (r["country"], r["date"] or f"{r['year']}-{r['month'] or 0}", label)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": re.sub(r"[^a-z0-9]+", "-", f"{iso or r['country']}-{r['date'] or r['year']}-{label}".lower()).strip("-")[:90],
            "date": r["date"], "end": r["end"], "precision": r["precision"], "year": r["year"], "month": r["month"],
            "date_source": r.get("date_source", "Wikipedia"),
            "country": r["country"], "iso": iso, "region": c["region"] if c else "Other",
            "territory": bool(r["territory_hint"] or (c or {}).get("territory")),
            "g20": iso in g20 and not r["territory_hint"], "eu": iso in eu and not r["territory_hint"],
            "offices": r["offices"], "kinds": sorted(set(kinds)), "indirect": r["indirect"],
            "round": {"first": "1st", "second": "2nd"}.get(rnd.group(1), rnd.group(1)) if rnd else None,
            "source_url": r["source_url"],
        })
    if unmatched:
        warnings.append("No region for: " + ", ".join(sorted(unmatched)) + " (add to config/countries.json)")

    def sort_key(e):
        if e["date"]:
            return (0, e["date"], e["country"])
        return (1 if e["month"] else 2, f"{e['year']}-{(e['month'] or 13):02d}", e["country"])
    out.sort(key=sort_key)
    return out, sources, warnings


if __name__ == "__main__":
    evs, srcs, warns = build()
    for e in evs:
        print(e["date"] or f"{e['year']}-{e['month'] or '??'}", e["precision"][:3], e["iso"], e["region"][:6], e["country"], "|",
              ", ".join(o["label"] for o in e["offices"]), e["kinds"], "IND" if e["indirect"] else "", e["round"] or "",
              "G20" if e["g20"] else "", "EU" if e["eu"] else "", "terr" if e["territory"] else "", e["date_source"])
    print(len(evs), srcs, warns)
