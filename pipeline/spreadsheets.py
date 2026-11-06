"""Minimal stdlib readers for ODS and (large) XLSX files."""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Iterator

_T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_X = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_O = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"


def ods_sheet(data: bytes, name: str) -> list[list[str]]:
    """Rows of one ODS sheet as strings (dates as ISO, numbers as raw values)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ET.parse(z.open("content.xml")).getroot()
    for table in root.iter(_T + "table"):
        if table.get(_T + "name") != name:
            continue
        rows = []
        for r in table.iter(_T + "table-row"):
            repeat = int(r.get(_T + "number-rows-repeated", "1"))
            cells = []
            for c in r:
                if c.tag not in (_T + "table-cell", _T + "covered-table-cell"):
                    continue
                n = int(c.get(_T + "number-columns-repeated", "1"))
                v = c.get(_O + "value") or c.get(_O + "date-value")
                if v is None:
                    v = "\n".join("".join(p.itertext()) for p in c.iter(_X + "p"))
                cells.extend([v] * min(n, 64))
            while cells and cells[-1] == "":
                cells.pop()
            if cells:
                rows.extend([cells] * min(repeat, 5))
        return rows
    raise KeyError(f"ODS sheet {name!r} not found")


_N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def xlsx_rows(data: bytes, name: str) -> Iterator[dict[str, str]]:
    """Stream rows of one XLSX sheet as {column_letter: value}; low memory."""
    z = zipfile.ZipFile(io.BytesIO(data))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    targets = {s.get("name"): rels[s.get(_RID)] for s in wb.iter(_N + "sheet")}
    if name not in targets:
        raise KeyError(f"XLSX sheet {name!r} not found (have {list(targets)})")
    target = targets[name].lstrip("/")
    target = target if target.startswith("xl/") else "xl/" + target
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(_N + "si"):
            shared.append("".join(t.text or "" for t in si.iter(_N + "t")))
    for _, el in ET.iterparse(z.open(target)):
        if el.tag != _N + "row":
            continue
        out = {}
        for c in el.iter(_N + "c"):
            col = re.match(r"[A-Z]+", c.get("r")).group()
            t, v = c.get("t"), c.find(_N + "v")
            if t == "s":
                out[col] = shared[int(v.text)]
            elif t == "inlineStr":
                out[col] = "".join(x.text or "" for x in c.iter(_N + "t"))
            else:
                out[col] = v.text if v is not None else ""
        el.clear()
        yield out


def table_from_header(rows: Iterator[dict[str, str]], first_header: str) -> Iterator[dict[str, str]]:
    """Find the header row whose column A equals `first_header`, then yield
    dicts keyed by header names for the rows below it."""
    header = None
    for r in rows:
        if header is None:
            if (r.get("A") or "").strip() == first_header:
                header = {col: (name or "").strip() for col, name in r.items()}
            continue
        yield {header[c]: v for c, v in r.items() if c in header}
