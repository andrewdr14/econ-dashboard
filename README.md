# Macro Monitor

A static economic data dashboard for the US and UK, with a calendar of upcoming data releases.
Data is fetched by a small Python pipeline, saved as JSON, and served by a plain HTML/JS site.
A scheduled GitHub Actions job refreshes the data and redeploys to GitHub Pages.

- **Dashboard**: latest value, change on the previous period, sparkline and next release date for each indicator. Click a card for the full history (1Y / 5Y / 10Y / Max, hover tooltips, table view).
- **Compare**: comparable indicators (CPI, core CPI, unemployment, wages, policy rate, yields) for both countries on one chart.
- **Calendar**: upcoming releases for the next 90 days in your local time, filterable by country and importance, with an **Add to calendar** (.ics) export.

## Data sources

| Country | Source | Used for | Key needed |
|---|---|---|---|
| US | [FRED](https://fred.stlouisfed.org/) | All US indicators; release calendar | Optional for data, **required for the full US calendar** |
| US | [BEA](https://www.bea.gov/news/schedule) iCal | Fallback calendar (GDP, PCE, trade) when there's no FRED key | No |
| UK | [ONS](https://www.ons.gov.uk/) | CPI, GDP, labour market, retail sales; release calendar | No |
| UK | [Bank of England database](https://www.bankofengland.co.uk/boeapps/database/) | Bank Rate, gilt yields, GBP/USD | No |
| Both | `config/central_bank_meetings.json` | FOMC and MPC decision dates (update yearly by hand) | — |

## Running locally

```bash
pip install -r requirements.txt
python -m pipeline.build            # fetch everything -> site/data/
python -m http.server 8765 -d site  # open http://localhost:8765
```

Set `FRED_API_KEY` (free from <https://fred.stlouisfed.org/docs/api/api_key.html>) to use the official
FRED API and get the full US release calendar (CPI, payrolls, retail sales, etc.). Without it, US data comes
from FRED's CSV download and the US calendar only has BEA releases and FOMC meetings.

Useful options:

```bash
python -m pipeline.build --only uk_cpi_yoy us_cpi_yoy   # refresh a subset
python -m pipeline.build --skip-calendar
```

## Adding an indicator or a country

Everything is driven by `config/`:

- `series.json`: one entry per indicator: `source` (`fred` | `ons` | `boe`), the series code, a
  `transform` (`level`, `yoy`, `mom`, `diff`), unit and decimals. Give comparable indicators the same
  `concept` so they appear together on the Compare tab.
- `calendar.json`: which releases appear on the calendar, their importance, and the dashboard indicators they update.
- `central_bank_meetings.json`: policy decision dates.

To add a country, add it under `countries` in `series.json`, add its indicators, and if needed a new
connector in `pipeline/sources.py` (a function returning `[(iso_date, value), ...]`). For multi-country
coverage, [DBnomics](https://db.nomics.world/) (one API over Eurostat, ECB, IMF, OECD and many national
statistics offices) is the planned next connector.

## Deployment (GitHub Pages)

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `FRED_API_KEY`.
3. The `Update data & deploy` workflow runs on weekdays at 07:30, 15:15 and 22:00 UTC, on every push to
   `main`, and on demand (Actions tab → Run workflow).

## Layout

```
config/        indicator, calendar and meeting definitions
pipeline/      Python fetchers (standard library + tzdata)
  sources.py   FRED / ONS / BoE connectors
  calendar.py  ONS, FRED, BEA and central bank release calendars
  build.py     entry point; writes site/data/*.json
site/          static frontend (no build step)
  data/        generated JSON (committed by the workflow)
```
