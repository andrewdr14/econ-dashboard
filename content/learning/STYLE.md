# Learning Centre article format

Each article is one Markdown file with a front-matter block. Two daily series:
explainers (economics concepts, metrics, theories, schools of thought) and
country spotlights. Published in filename order, one of each per day (UK morning).

## Front matter

```
---
title: How inflation is measured
dek: One sentence standfirst shown under the title (max ~30 words).
topic: Metrics            # explainers: Metrics | Theory | Schools of thought | Policy | Markets | History
tags: inflation, CPI, prices
---
```

Spotlights also have:

```
country: Germany
iso2: DE                  # ISO 3166-1 alpha-2
iso3: DEU                 # World Bank / ISO alpha-3 (drives the live data panel)
leader_note: Chancellor ... (as of mid-2026)
```

## Length and tone

- 1,600-2,100 words: a 10-minute read over a morning coffee.
- Plain, warm, precise British English. Explain jargon the first time. No hype, no investment advice.
- Balanced on contested ideas: state the strongest case for and against.
- Figures: approximate and dated ("about 3% of GDP in 2024"). The page adds a live World Bank data panel to spotlights, so don't lean on exact current figures.
- Politics: describe institutions and leaders as of mid-2026 and say so; avoid claims about events you are not sure of.
- No invented quotes, statistics or URLs. Links only to pages you are certain exist (Wikipedia articles, official statistics homepages). Links are optional.

## Markdown subset (the renderer supports only this)

`## H2`, `### H3`, paragraphs, `**bold**`, `*italic*`, `[text](https://...)`, `- bullets`,
`1. numbered`, `> blockquote` (one-paragraph pull quotes / key ideas), and simple pipe tables:

```
| Export | Share |
|---|---|
| Cars | ~15% |
```

Do not use HTML, images, footnotes, code blocks or H1 (the title comes from front matter).

## Structure

Explainers: hook paragraph -> sections (## ...) building the idea -> a worked example
or real-world episode -> common misconceptions or critiques -> `## Key takeaways` (3-5 bullets).

Spotlights: hook paragraph -> `## At a glance` (short bullet list) -> `## How the economy makes its money`
-> `## Trade: what it sells, buys and who with` (include a small table) -> `## Strengths`
-> `## Vulnerabilities` -> `## Politics and power` -> `## The history that shaped it`
-> `## What to watch` -> `## Key takeaways` (3-5 bullets).
