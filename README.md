# Macro Monitor

A static economic data dashboard for the US, UK and euro area (inflation, growth, labour, rates, public finances and migration), with a calendar of upcoming data releases and a worldwide election calendar.
Data is fetched by a small Python pipeline, saved as JSON, and served by a plain HTML/JS site.
A scheduled GitHub Actions job refreshes the data and redeploys to GitHub Pages.

- **Dashboard**: latest value, change on the previous period, sparkline and next release date for each indicator. Click a card for the full history (1Y / 5Y / 10Y / Max, hover tooltips, table view) and a plain-English explainer.
  A **Next up** sidebar lists the country's upcoming releases; click one for a pop-up with what the statistic measures, why it matters, the latest and previous values, and when it comes out.
- **Compare**: a graph builder. Add a chart by picking a statistic (GDP growth, CPI, core CPI, unemployment, wages, policy rates, yields, FX,
  industrial production, debt/GDP, irregular arrivals, any single indicator, or a custom mix measured in the same units), the areas to compare,
  a frequency (as published, monthly, quarterly or annual averages / end-of-period / totals) and a time range. Charts are saved in your browser.
- **Calendar**: upcoming releases for the next 90 days in your local time, filterable by country and importance, with an **Add to calendar** (.ics) export.
- **Elections**: national elections and referendums worldwide, grouped by month and filterable by region, G20/EU and type
  (executive, legislative, referendum), with a "next G20 / EU" strip, recent elections (last 60 days, linked to results) and .ics export.

## Data sources

| Country | Source | Used for | Key needed |
|---|---|---|---|
| US | [FRED](https://fred.stlouisfed.org/) | Macro, rates, deficit/debt, foreign-born labour force; release calendar | Optional for data, **required for the full US calendar** |
| US | [CBP](https://www.cbp.gov/newsroom/stats/nationwide-encounters) | Border encounters (newest CSV discovered on the stats page each run) | No |
| US | [BEA](https://www.bea.gov/news/schedule) iCal | Fallback calendar when there's no FRED key | No |
| UK | [ONS](https://www.ons.gov.uk/) | CPI, GDP, labour market, retail, public finances, net migration; release calendar | No |
| UK | [Bank of England](https://www.bankofengland.co.uk/boeapps/database/) | Bank Rate, gilt yields, GBP/USD | No |
| UK | [Home Office](https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables) via the GOV.UK Content API | Small boat arrivals, asylum claims, visas; release dates via GOV.UK search | No |
| EA | [Eurostat](https://ec.europa.eu/eurostat/web/main/data/web-services) | HICP, GDP, unemployment, industry, retail, sentiment, debt/deficit; release calendar (iCal) | No |
| EA | [ECB Data Portal](https://data.ecb.europa.eu/) | Deposit rate, AAA yield curve, EUR/USD | No |
| World | [Wikipedia national electoral calendars](https://en.wikipedia.org/wiki/2027_national_electoral_calendar) via the MediaWiki API, plus [Wikidata](https://www.wikidata.org/) for exact dates | Election calendar (this year and the next two, where pages exist) | No |
| All | `config/central_bank_meetings.json` | FOMC, MPC and ECB decision dates (update yearly by hand) | — |

Notes:
- There's no Home Office API: the pipeline finds the latest ODS/XLSX attachment through the GOV.UK Content API
  and parses it with the standard library. Big files (the visas dataset is ~33 MB) are cached in
  `data_cache/sources.json` by file URL, so they're only re-downloaded when a new edition is published.
- DBnomics was tested but its Eurostat mirror lagged by months, so Eurostat and the ECB are queried directly.
- Elections: the Wikipedia calendars are edited by volunteers, so snap elections appear once someone adds them. When a page gives only
  a month, the election's Wikidata item supplies the day if it has one. `config/countries.json` maps country names to ISO codes and
  regions (generated from Wikidata); `config/elections_extra.json` lists a few major elections in years with no calendar page yet
  (e.g. US 2028, UK by Aug 2029) and is ignored once Wikipedia covers that year.
- Eurostat's euro area aggregate changed to EA21 in 2026 (Bulgaria joined); HICP moved to `prc_hicp_minr` (ECOICOP v2).

## Running locally

```bash
pip install -r requirements.txt
python -m pipeline.build            # fetch everything -> site/data/
python -m http.server 8765 -d site  # open http://localhost:8765
```

Put `FRED_API_KEY=...` in a local `.env` file (gitignored) or the environment (free from <https://fred.stlouisfed.org/docs/api/api_key.html>) to use the official
FRED API and get the full US release calendar (CPI, payrolls, retail sales, etc.). Without it, US data comes
from FRED's CSV download and the US calendar only has BEA releases and FOMC meetings.

Useful options:

```bash
python -m pipeline.build --only uk_cpi_yoy us_cpi_yoy   # refresh a subset
python -m pipeline.build --skip-calendar
python -m pipeline.build --only-elections               # just the election calendar
```

## Adding an indicator or a country

Everything is driven by `config/`:

- `series.json`: one entry per indicator: `source` (`fred`, `ons`, `boe`, `eurostat`, `ecb`, `cbp`, `small_boats`,
  `uk_asylum`, `uk_visas`, `ons_ltim`), the series code or filters, a `transform` (`level`, `yoy`, `mom`, `diff`,
  `yoy_diff`, `rolling_sum`, `rolling_mean`), unit and decimals. Give comparable indicators the same
  `concept` so they appear together on the Compare tab.
- `calendar.json`: which releases appear on the calendar, their importance, and the dashboard indicators they update.
- `central_bank_meetings.json`: policy decision dates.
- `explainers.json`: the "what it measures / why it matters" text for each indicator and for releases with no dashboard indicator.
  Indicators with `"hidden": true` (e.g. non-annualised US GDP) are used on the Compare page but not shown as dashboard cards.
- `countries.json` / `elections_extra.json`: country lookup and hand-listed future elections for the Elections tab.

To add a country, add it under `countries` in `series.json`, add its indicators, and if needed a new
connector in `pipeline/sources.py` (a function returning `[(iso_date, value), ...]`). For other EU
countries, the Eurostat and ECB connectors already work: change `geo` / the series key.

## Deployment (GitHub Pages)

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: `FRED_API_KEY`.
3. The `Update data & deploy` workflow runs on weekdays at 07:30, 15:15 and 22:00 UTC, on every push to
   `main`, and on demand (Actions tab → Run workflow).

## Layout

```
config/        indicator, calendar, meeting and country definitions
pipeline/      Python fetchers (standard library + tzdata)
  sources.py   FRED / ONS / BoE / Eurostat / ECB / CBP connectors
  migration_uk.py  Home Office and ONS migration spreadsheets
  spreadsheets.py  stdlib ODS/XLSX readers
  calendar.py  ONS, FRED, BEA and central bank release calendars
  elections.py Wikipedia/Wikidata election calendar
  build.py     entry point; writes site/data/*.json
site/          static frontend (no build step)
  data/        generated JSON (committed by the workflow)
data_cache/    parsed copies of large source files, keyed by URL
```
