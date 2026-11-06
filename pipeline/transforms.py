"""Turn raw levels into the figure people actually quote (y/y %, m/m %, change)."""
from __future__ import annotations

from datetime import date
from statistics import median

Obs = list[tuple[str, float]]


def frequency(obs: Obs) -> str:
    if len(obs) < 3:
        return "unknown"
    ds = [date.fromisoformat(d) for d, _ in obs[-60:]]
    gap = median((b - a).days for a, b in zip(ds, ds[1:]))
    if gap <= 3:
        return "daily"
    if gap <= 8:
        return "weekly"
    if gap <= 35:
        return "monthly"
    if gap <= 100:
        return "quarterly"
    return "annual"


def _year_earlier(d: str) -> str:
    x = date.fromisoformat(d)
    try:
        return x.replace(year=x.year - 1).isoformat()
    except ValueError:  # 29 Feb
        return x.replace(year=x.year - 1, day=28).isoformat()


def _rolling(obs: Obs, window: int, mean: bool) -> Obs:
    """Rolling sum/mean over `window` consecutive periods; skips windows with gaps."""
    out = []
    freq = frequency(obs)
    max_gap = {"monthly": 35, "quarterly": 100, "weekly": 8, "daily": 5}.get(freq, 400)
    for i in range(window - 1, len(obs)):
        win = obs[i - window + 1: i + 1]
        ds = [date.fromisoformat(d) for d, _ in win]
        if any((b - a).days > max_gap for a, b in zip(ds, ds[1:])):
            continue
        s = sum(v for _, v in win)
        out.append((obs[i][0], s / window if mean else s))
    return out


def apply(obs: Obs, transform: str, scale: float = 1.0, window: int = 12) -> Obs:
    if transform == "level":
        out = obs
    elif transform == "rolling_sum":
        out = _rolling(obs, window, mean=False)
    elif transform == "rolling_mean":
        out = _rolling(obs, window, mean=True)
    elif transform == "yoy":
        lookup = dict(obs)
        out = []
        for d, v in obs:
            prev = lookup.get(_year_earlier(d))
            if prev:
                out.append((d, (v / prev - 1) * 100))
    elif transform == "yoy_diff":
        lookup = dict(obs)
        out = [(d, v - lookup[_year_earlier(d)]) for d, v in obs if _year_earlier(d) in lookup]
    elif transform == "mom":
        out = [(d, (v / pv - 1) * 100) for (_, pv), (d, v) in zip(obs, obs[1:]) if pv]
    elif transform == "diff":
        out = [(d, v - pv) for (_, pv), (d, v) in zip(obs, obs[1:])]
    else:
        raise ValueError(f"Unknown transform {transform!r}")
    if scale != 1.0:
        out = [(d, v * scale) for d, v in out]
    return out


def period_label(d: str, freq: str) -> str:
    x = date.fromisoformat(d)
    if freq == "monthly":
        return x.strftime("%b %Y")
    if freq == "quarterly":
        return f"Q{(x.month - 1) // 3 + 1} {x.year}"
    if freq == "annual":
        return str(x.year)
    if freq == "weekly":
        return f"w/e {x.day} {x.strftime('%b %Y')}"
    return f"{x.day} {x.strftime('%b %Y')}"
