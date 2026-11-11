import { renderChart, sparkline, fmtNum, fmtDate, toDate } from "./charts.js?v=dev";

const $ = (s, r = document) => r.querySelector(s);
const tooltip = $("#tooltip");
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  summary: null,
  calendar: { events: [], warnings: [] },
  byId: {},
  seriesCache: {},
  country: store.get("country", "US"),
  calCountry: store.get("calCountry", "ALL"),
  calImportance: store.get("calImportance", "high+"),
  detail: null,
  elections: null,
  elRegion: store.get("elRegion", "ALL"),
  elScope: store.get("elScope", "all"),
  elType: store.get("elType", "all"),
};

const SOURCE_NAMES = {
  fred: "FRED", ons: "ONS", boe: "Bank of England", eurostat: "Eurostat", ecb: "ECB", cbp: "US CBP",
  small_boats: "Home Office", uk_asylum: "Home Office", uk_visas: "Home Office", ons_ltim: "ONS",
};
const RANGES = { "1Y": 1, "5Y": 5, "10Y": 10, "Max": null };

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
function countryColor(code) {
  const idx = Object.keys(state.summary.countries).indexOf(code);
  return `var(--series-${(idx % 8) + 1})`;
}
// Country tag (flag emoji don't render on Windows, so use a coloured code pill).
const flag = (c) => `<span class="cc" style="--c:${countryColor(c)}">${c}</span>`;
const isPct = (unit) => unit && unit.includes("%");
function chartKind(ind) {
  if (ind.chart) return ind.chart;
  if (ind.concept === "policy_rate") return "step";
  if (/m\/m|q\/q/.test(ind.unit)) return "bar";
  return "line";
}
function valueHtml(ind, v) {
  const unit = ind.unit === "%" || ind.unit?.startsWith("% ") ? "%" : "";
  return `${fmtNum(v, ind.decimals)}${unit ? `<small>${unit}</small>` : ""}`;
}
function deltaText(ind) {
  if (!ind.latest) return "";
  // Policy rates change rarely: say when they last moved rather than "±0 vs yesterday".
  if (ind.concept === "policy_rate" && ind.spark?.length) {
    const cur = ind.latest.value;
    const pts = ind.spark;
    let i = pts.length - 1;
    while (i >= 0 && Math.abs(pts[i][1] - cur) < 1e-9) i--;
    if (i < 0) return `<span class="delta">Unchanged for over a year</span>`;
    const when = fmtDate(toDate(pts[i + 1][0]), "monthly");
    const dir = cur > pts[i][1] ? "Raised" : "Cut";
    return `<span class="delta"><span class="arrow" aria-hidden="true">${cur > pts[i][1] ? "▲" : "▼"}</span> ${dir} from ${fmtNum(pts[i][1], ind.decimals)}% in ${when}</span>`;
  }
  if (!ind.previous) return "";
  const d = ind.latest.value - ind.previous.value;
  const dec = ind.decimals;
  const rounded = +d.toFixed(dec);
  const suffix = isPct(ind.unit) ? "pp" : "";
  const arrow = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "▬";
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `<span class="delta"><span class="arrow" aria-hidden="true">${arrow}</span> ${sign}${fmtNum(Math.abs(rounded), dec)}${suffix} vs ${ind.previous.period}</span>`;
}
function filterRange(points, years) {
  if (!years || !points.length) return points;
  const last = toDate(points[points.length - 1][0]);
  const cut = new Date(Date.UTC(last.getUTCFullYear() - years, last.getUTCMonth(), last.getUTCDate()));
  const iso = cut.toISOString().slice(0, 10);
  return points.filter((p) => p[0] >= iso);
}
async function loadSeries(id) {
  if (!state.seriesCache[id]) {
    state.seriesCache[id] = fetch(`data/series/${id}.json`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
      return r.json();
    });
  }
  return state.seriesCache[id];
}
function segmented(container, options, current, onPick) {
  container.innerHTML = options.map(([val, label]) =>
    `<button role="radio" aria-checked="${val === current}" data-val="${val}">${label}</button>`).join("");
  container.onclick = (e) => {
    const b = e.target.closest("button[data-val]");
    if (!b) return;
    container.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
    onPick(b.dataset.val);
  };
}
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayKey = (d) => d.toLocaleDateString("en-CA");
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const fmtShortDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
function relDays(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const n = Math.round((x - today) / 864e5);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`;
}
function upcoming() {
  const now = Date.now() - 2 * 3600e3; // keep events for 2h after release
  return state.calendar.events.filter((e) => new Date(e.datetime_utc).getTime() >= now);
}
function nextReleaseFor(id) {
  return upcoming().find((e) => e.indicators.includes(id));
}

// ---------------------------------------------------------------- dashboard
const CAT_DESC = {
  "Inflation": "How fast consumer prices are rising: the figure central banks target.",
  "Growth & activity": "How much the economy is producing and how much households and businesses are spending.",
  "Labour market": "Jobs, unemployment and pay, which drive household incomes and services inflation.",
  "Rates & markets": "The central bank's policy rate, government borrowing costs and the currency.",
  "Public finances": "How much the government is borrowing and how large its debt is relative to the economy.",
  "Migration": "Arrivals, asylum claims, visas and net migration, which shape population and labour supply.",
};
const SHORT_NAME = { US: "US", UK: "UK", EA: "euro area" };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const unitSuffix = (ind) => (ind.unit === "%" || ind.unit?.startsWith("% ") ? "%" : "");

// The four headline figures for an economy.
function glancePicks(country) {
  const inds = state.summary.indicators.filter((i) => i.country === country && i.latest && !i.hidden);
  const byConcept = (k) => inds.find((i) => i.concept === k);
  return [
    ["Inflation", byConcept("cpi_yoy")],
    ["GDP growth", inds.find((i) => i.category === "Growth & activity")],
    ["Unemployment", byConcept("unemployment")],
    ["Policy rate", byConcept("policy_rate")],
  ].filter(([, i]) => i);
}

function overviewLede(country) {
  const picks = Object.fromEntries(glancePicks(country).map(([k, i]) => [k, i]));
  const v = (i) => i ? `<strong>${fmtNum(i.latest.value, i.decimals)}${unitSuffix(i)}</strong>` : "";
  const parts = [];
  if (picks.Inflation && picks.Unemployment) parts.push(`Inflation is ${v(picks.Inflation)} and unemployment ${v(picks.Unemployment)}.`);
  if (picks["Policy rate"]) parts.push(`The ${esc(picks["Policy rate"].name.replace(/ \(.*\)$/, ""))} stands at ${v(picks["Policy rate"])}.`);
  const next = upcoming().find((e) => e.country === country && e.importance === "high");
  if (next) parts.push(`The next major release is <strong>${esc(next.title)}</strong>, ${relDays(new Date(next.datetime_utc))} (${fmtDay(new Date(next.datetime_utc))}).`);
  return parts.join(" ");
}

function renderDashboard() {
  const { summary } = state;
  const c = state.country;
  const cname = summary.countries[c]?.name || c;
  $("#dash-kicker").innerHTML = `${flag(c)} Overview · ${esc(cname)}`;
  $("#dash-title").textContent = `The ${SHORT_NAME[c] || cname} economy at a glance`;
  $("#dash-lede").innerHTML = overviewLede(c);

  $("#glance").innerHTML = glancePicks(c).map(([label, ind]) => `
    <button class="glance-item" data-id="${ind.id}" aria-label="${esc(label)}: ${fmtNum(ind.latest.value, ind.decimals)} ${esc(ind.unit)}. Open chart">
      <span class="g-label">${esc(label)}</span>
      <span class="g-value">${fmtNum(ind.latest.value, ind.decimals)}${unitSuffix(ind) ? "<small>%</small>" : ""}</span>
      <span class="g-sub">${esc(ind.name)} · ${ind.latest.period}</span>
      <span class="g-delta">${deltaText(ind)}</span>
    </button>`).join("");

  const inds = summary.indicators.filter((i) => i.country === c && !i.hidden);
  const cats = summary.categories.filter((cat) => inds.some((i) => i.category === cat));
  $("#dashboard").innerHTML = cats.map((cat) => {
    const cards = inds.filter((i) => i.category === cat);
    return `<section class="cat" id="sec-${slug(cat)}" aria-labelledby="h-${slug(cat)}">
      <div class="cat-head"><div><h2 id="h-${slug(cat)}">${esc(cat)}</h2>${CAT_DESC[cat] ? `<p class="cat-desc">${CAT_DESC[cat]}</p>` : ""}</div>
        <span class="cat-count">${cards.length} ${cards.length === 1 ? "indicator" : "indicators"}</span></div>
      <div class="grid">${cards.map(cardHtml).join("")}</div></section>`;
  }).join("") || `<div class="empty">No indicators configured for this economy yet.</div>`;
  $("#toc-sections").innerHTML = cats.map((cat) => `<li><a href="#sec-${slug(cat)}" data-sec="sec-${slug(cat)}">${esc(cat)}</a></li>`).join("");
  watchSections();
  renderSidebar();
}

// Highlight the section currently in view in the contents list.
let sectionObserver;
function watchSections() {
  sectionObserver?.disconnect();
  const links = [...document.querySelectorAll("#toc-sections a")];
  const mark = (id) => links.forEach((a) => a.classList.toggle("active", a.dataset.sec === id));
  if (links[0]) mark(links[0].dataset.sec);
  sectionObserver = new IntersectionObserver((entries) => {
    const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (vis) mark(vis.target.id);
  }, { rootMargin: "-20% 0px -65% 0px" });
  document.querySelectorAll("#dashboard .cat").forEach((s) => sectionObserver.observe(s));
}

function renderSidebar() {
  const next = upcoming().filter((e) => e.country === state.country && e.importance !== "low").slice(0, 24);
  $("#side-title").textContent = `Upcoming in the ${SHORT_NAME[state.country] || state.country}`;
  const days = new Map();
  for (const e of next) {
    const k = dayKey(new Date(e.datetime_utc));
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  $("#next-up").innerHTML = [...days.values()].map((evs) => {
    const d = new Date(evs[0].datetime_utc);
    const rel = relDays(d);
    const soon = rel === "today" || rel === "tomorrow";
    const label = `${soon ? rel[0].toUpperCase() + rel.slice(1) + " · " : ""}${fmtShortDay(d)}`;
    // On narrow screens the list becomes a row of cards and day headings are hidden,
    // so each item also carries its own date (shown only there).
    return `<div class="side-day"><div class="side-day-head${soon ? " soon" : ""}">${label}</div>${evs.map((e) => {
      const t = new Date(e.datetime_utc);
      return `<button class="side-item" data-release="${e.id}" aria-label="${esc(e.title)}, ${fmtDay(t)}. Open details">
        <span class="side-time"><span class="side-date">${fmtShortDay(t)} · </span>${e.time_known ? fmtTime(t) : "TBC"}</span>
        <span class="side-what">${esc(e.title)}</span>
        ${e.importance === "high" ? `<span class="side-imp">High</span>` : ""}
      </button>`;
    }).join("")}</div>`;
  }).join("") || `<p class="note">No releases scheduled in the next 90 days.</p>`;
}

// ---------------------------------------------------------------- release pop-up
const eventById = (id) => state.calendar.events.find((e) => e.id === id);
function aboutHtml(about) {
  if (!about) return "";
  return `<dl class="about-dl"><dt>What it measures</dt><dd>${esc(about.what)}</dd>${about.why ? `<dt>Why it matters</dt><dd>${esc(about.why)}</dd>` : ""}</dl>`;
}
function openRelease(id) {
  const e = eventById(id);
  if (!e) return;
  const d = new Date(e.datetime_utc);
  const country = state.summary.countries[e.country]?.name || e.country;
  $("#rel-eyebrow").innerHTML = `${flag(e.country)} ${esc(country)} · ${e.importance} importance`;
  $("#rel-title").textContent = e.title;
  const when = `${fmtDay(d)}${e.time_known ? `, ${fmtTime(d)}` : ""} · ${relDays(d)}`;
  $("#rel-when").innerHTML = `${when}${e.provisional ? " · provisional date" : ""}<br><span class="note">${esc(e.detail)} · ${esc(e.source)}</span>`;
  const inds = e.indicators.map((x) => state.byId[x]).filter(Boolean);
  const relAbout = state.summary.release_about?.[`${e.country}|${e.title}`];
  const blocks = inds.map((ind) => {
    const after = upcoming().filter((x) => x.indicators.includes(ind.id) && x.id !== e.id)[0];
    const latest = ind.latest ? `
      <div class="rel-stat">
        <div><div class="rel-k">Latest · ${ind.latest.period}</div><div class="card-value">${valueHtml(ind, ind.latest.value)}</div><div class="card-unit">${esc(ind.unit)}</div></div>
        <div class="rel-delta">${deltaText(ind)}${ind.previous ? `<div class="note">Previous: ${fmtNum(ind.previous.value, ind.decimals)} (${ind.previous.period})</div>` : ""}</div>
      </div>
      <div style="--series-c:${countryColor(ind.country)}">${sparkline(ind.spark)}</div>` : `<p class="note">No data yet.</p>`;
    return `<section class="rel-ind">
      <div class="rel-ind-head"><h3>${esc(ind.name)}</h3><button class="btn ghost" data-open-chart="${ind.id}">Open chart</button></div>
      ${latest}
      ${aboutHtml(ind.about)}
      ${ind.note ? `<p class="note">${esc(ind.note)}</p>` : ""}
      ${after ? `<p class="note">The release after this: ${fmtDay(new Date(after.datetime_utc))}.</p>` : ""}
    </section>`;
  }).join("");
  const body = (relAbout ? `<section class="rel-ind">${aboutHtml(relAbout)}</section>` : "")
    + (blocks || (relAbout ? "" : `<p class="note">This release isn't tracked on the dashboard yet.</p>`));
  $("#rel-body").innerHTML = body + `<div class="rel-foot">
      ${e.url ? `<a class="btn ghost" href="${esc(e.url)}" target="_blank" rel="noopener">Release page</a>` : ""}
      <button class="btn ghost" data-ics-one="${e.id}">Add to calendar</button>
      <a class="btn ghost" href="#calendar" data-close data-goto-cal>Full calendar</a>
    </div>`;
  const dlg = $("#release");
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}

function cardHtml(ind) {
  if (!ind.latest) {
    return `<div class="card" aria-disabled="true"><div class="card-top"><div><div class="card-name">${ind.name || ind.id}</div></div>
      <span class="badge error">Unavailable</span></div><div class="card-meta">${ind.error || "No data yet"}</div></div>`;
  }
  const next = nextReleaseFor(ind.id);
  const nextTxt = next ? `Next: ${fmtShortDay(new Date(next.datetime_utc))}` : "";
  const badge = ind.status === "stale" ? `<span class="badge stale" title="${ind.error || ""}">Stale</span>` : "";
  return `<button class="card" data-id="${ind.id}" style="--series-c:${countryColor(ind.country)}" aria-label="${ind.name}: ${fmtNum(ind.latest.value, ind.decimals)} ${ind.unit}, ${ind.latest.period}. Open chart">
    <div class="card-top"><div><div class="card-name">${ind.name}</div><div class="card-unit">${ind.unit}</div></div>${badge}</div>
    <div class="card-value">${valueHtml(ind, ind.latest.value)}</div>
    <div class="card-meta"><span>${ind.latest.period}</span>${deltaText(ind)}</div>
    ${sparkline(ind.spark)}
    <div class="card-foot"><span>${SOURCE_NAMES[ind.source] || ind.source}</span><span>${nextTxt}</span></div>
  </button>`;
}

// ---------------------------------------------------------------- detail dialog
async function openDetail(id) {
  const ind = state.byId[id];
  if (!ind) return;
  const dlg = $("#detail");
  state.detail = { ind, range: ind.frequency === "daily" || ind.frequency === "weekly" || chartKind(ind) === "bar" ? "5Y" : "10Y", table: false };
  $("#detail-eyebrow").innerHTML = `${flag(ind.country)} ${state.summary.countries[ind.country].name} · ${ind.category}`;
  $("#detail-title").textContent = ind.name;
  $("#detail-sub").innerHTML = ind.latest
    ? `<strong>${fmtNum(ind.latest.value, ind.decimals)}</strong> ${ind.unit} · ${ind.latest.period} · ${deltaText(ind)}`
    : "No data";
  $("#detail-about").innerHTML = aboutHtml(ind.about);
  const next = nextReleaseFor(id);
  $("#detail-source").innerHTML = (ind.note ? `<strong>Note:</strong> ${ind.note}<br>` : "") + `<strong>Source:</strong> <a href="${ind.url}" target="_blank" rel="noopener">${SOURCE_NAMES[ind.source] || ind.source}${ind.series ? " · " + ind.series : ""}</a>` +
    (next ? ` · Next release ${fmtDay(new Date(next.datetime_utc))}, ${fmtTime(new Date(next.datetime_utc))}` : "");
  segmented($("#detail-range"), Object.keys(RANGES).map((k) => [k, k]), state.detail.range, (v) => { state.detail.range = v; drawDetail(); });
  const tbtn = $("#detail-table-toggle");
  tbtn.setAttribute("aria-pressed", "false"); tbtn.textContent = "Show table";
  $("#detail-table").hidden = true;
  // A modal dialog sits in the browser's top layer, above everything else on the page,
  // so the hover tooltip has to live inside it while it's open.
  dlg.append(tooltip);
  if (!dlg.open) dlg.showModal();
  $("#detail-chart").innerHTML = `<div class="chart-empty">Loading…</div>`;
  await drawDetail();
}

async function drawDetail() {
  const { ind, range } = state.detail;
  try {
    const s = await loadSeries(ind.id);
    const pts = filterRange(s.observations, RANGES[range]);
    renderChart($("#detail-chart"), [{ label: ind.name, color: countryColor(ind.country), freq: s.frequency, points: pts }],
      { kind: chartKind(ind), decimals: ind.decimals, unit: ind.unit, tooltip, endLabels: false });
    const rows = pts.slice().reverse().slice(0, 500);
    $("#detail-table").innerHTML = `<table><thead><tr><th>Period</th><th class="num">${ind.unit}</th></tr></thead><tbody>${rows.map((p) =>
      `<tr><td>${fmtDate(toDate(p[0]), s.frequency)}</td><td class="num">${fmtNum(p[1], ind.decimals)}</td></tr>`).join("")}</tbody></table>`;
  } catch (err) {
    $("#detail-chart").innerHTML = `<div class="chart-empty">Couldn't load data (${err.message})</div>`;
  }
}

// ---------------------------------------------------------------- compare
// ---------------------------------------------------------------- compare: chart widgets
// Each widget is { id, stat, areas, inds, freq, agg, range, name }, saved in localStorage.
//   stat: "concept:<key>" (one statistic across areas) | "ind:<id>" (one indicator) | "custom" (any indicators)
const WIDGETS_KEY = "compareWidgets.v1";
const FREQ_RANK = { daily: 0, weekly: 1, monthly: 2, quarterly: 3, annual: 4 };
const FREQ_OPTS = [["native", "As published"], ["monthly", "Monthly"], ["quarterly", "Quarterly"], ["annual", "Annual"]];
const AGG_LABEL = { avg: "averages", last: "end-of-period values", sum: "totals" };
const MAX_SERIES = 6;
const uid = () => Math.random().toString(36).slice(2, 9);
const countryOrder = () => Object.keys(state.summary.countries);
const conceptName = (k) => state.summary.concepts[k].replace(/\s*\(.*$/, "").replace(/,.*$/, "");
const unitFamily = (u) => (u || "").trim().split(/[\s,]/)[0];
const isFlowUnit = (u) => /per (month|quarter)|^k m\/m|^£bn$/.test(u || "");

function conceptAreas(k) {
  const have = new Set(state.summary.indicators.filter((i) => i.concept === k && i.latest).map((i) => i.country));
  return countryOrder().filter((c) => have.has(c));
}
function defaultWidgets() {
  return Object.keys(state.summary.concepts).map((k) => ({
    id: uid(), stat: `concept:${k}`, areas: conceptAreas(k), inds: [], freq: "native", agg: "avg", range: "10Y", name: "",
  }));
}
function loadWidgets() {
  try {
    const w = JSON.parse(store.get(WIDGETS_KEY, "null"));
    if (Array.isArray(w)) return w.filter((x) => resolveWidget(x).length);
  } catch {}
  return defaultWidgets();
}
const saveWidgets = () => store.set(WIDGETS_KEY, JSON.stringify(state.widgets));

function resolveWidget(w) {
  const order = countryOrder();
  let inds = [];
  if (w.stat?.startsWith("concept:")) {
    const k = w.stat.slice(8);
    inds = state.summary.indicators.filter((i) => i.concept === k && (w.areas || []).includes(i.country));
    inds.sort((a, b) => order.indexOf(a.country) - order.indexOf(b.country));
  } else if (w.stat?.startsWith("ind:")) {
    inds = [state.byId[w.stat.slice(4)]];
  } else if (w.stat === "custom") {
    inds = (w.inds || []).map((id) => state.byId[id]);
  }
  return inds.filter((i) => i && i.latest);
}
function widgetTitle(w, inds) {
  if (w.name) return w.name;
  if (w.stat.startsWith("concept:")) return state.summary.concepts[w.stat.slice(8)];
  if (inds.length === 1) return `${inds[0].name} · ${state.summary.countries[inds[0].country]?.name || inds[0].country}`;
  return inds.map((i) => `${i.country} ${i.name}`).join(" vs ");
}

// Calendar periods: monthly / quarterly / annual, dated at the period's start like the source data.
function periodStart(iso, f) {
  const y = iso.slice(0, 4), m = +iso.slice(5, 7);
  if (f === "monthly") return `${y}-${iso.slice(5, 7)}-01`;
  if (f === "quarterly") return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  return `${y}-01-01`;
}
function resample(points, target, agg) {
  const groups = new Map();
  for (const [d, v] of points) {
    const k = periodStart(d, target);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const out = [...groups.entries()].map(([k, vs]) => ({
    k, n: vs.length,
    v: agg === "last" ? vs[vs.length - 1] : agg === "sum" ? vs.reduce((a, b) => a + b, 0) : vs.reduce((a, b) => a + b, 0) / vs.length,
  }));
  // Drop part-filled periods at either end (e.g. the current quarter), except for end-of-period values.
  if (agg !== "last" && out.length > 3) {
    const counts = out.slice(1, -1).map((o) => o.n).sort((a, b) => a - b);
    const full = counts[counts.length >> 1];
    if (out[out.length - 1].n < full * 0.8) out.pop();
    if (out[0].n < full * 0.8) out.shift();
  }
  return out.map((o) => [o.k, o.v]);
}

async function widgetData(w) {
  const inds = resolveWidget(w).slice(0, MAX_SERIES);
  const raw = await Promise.all(inds.map((i) => loadSeries(i.id)));
  const order = countryOrder();
  const distinct = new Set(inds.map((i) => i.country)).size === inds.length;
  const colorFor = (ind, k) => (distinct && order.includes(ind.country) ? countryColor(ind.country) : `var(--series-${(k % 8) + 1})`);
  let resampled = false;
  const series = inds.map((ind, k) => {
    const s = raw[k];
    let pts = s.observations, freq = s.frequency;
    if (w.freq !== "native" && FREQ_RANK[w.freq] > FREQ_RANK[s.frequency]) {
      pts = resample(pts, w.freq, w.agg);
      freq = w.freq;
      resampled = true;
    }
    return { ind, label: `${ind.country} ${ind.name}`, short: ind.country, color: colorFor(ind, k), freq, points: pts };
  });
  // Align the window to the latest date across series so ranges match.
  const years = RANGES[w.range];
  const last = series.map((s) => s.points.at(-1)?.[0] || "0000").sort().at(-1);
  const cut = years ? `${+last.slice(0, 4) - years}${last.slice(4)}` : "0000";
  for (const s of series) s.points = s.points.filter((p) => p[0] >= cut);

  const units = [...new Set(inds.map((i) => i.unit))];
  let unit = units.length === 1 ? units[0] : unitFamily(units[0]);
  if (resampled && w.agg === "sum") unit = unit.replace(/per (month|quarter)/, `per ${w.freq === "annual" ? "year" : "quarter"}`).replace(/ m\/m$/, "");
  const decimals = Math.max(...inds.map((i) => i.decimals));
  const kind = inds.every((i) => i.concept === "policy_rate") && !resampled ? "step" : "line";
  const note = resampled ? `${FREQ_OPTS.find((f) => f[0] === w.freq)[1]} ${AGG_LABEL[w.agg]}` : "";
  // Country codes at the line ends work when each line is a different area; otherwise use the legend.
  return { inds, series, unit, decimals, kind, note, endLabels: distinct && inds.length > 1 };
}

function legendHtml(series, decimals) {
  return series.map((s) => {
    const lastPt = s.points.at(-1);
    return `<span><span class="swatch" style="background:${s.color}"></span>${flag(s.ind.country)} ${esc(s.ind.name)} <strong>${lastPt ? fmtNum(lastPt[1], decimals) : "–"}</strong></span>`;
  }).join("");
}

async function drawWidget(w, panel) {
  const host = panel.querySelector("[data-chart]");
  segmented(panel.querySelector("[data-range]"), Object.keys(RANGES).map((k) => [k, k]), w.range,
    (v) => { w.range = v; saveWidgets(); drawWidget(w, panel); });
  try {
    const d = await widgetData(w);
    panel.querySelector("[data-legend]").innerHTML = legendHtml(d.series, d.decimals);
    const srcs = [...new Set(d.inds.map((i) => SOURCE_NAMES[i.source] || i.source))].join(", ");
    panel.querySelector("[data-note]").textContent = [`Units: ${d.unit}`, d.note, `Source: ${srcs}`].filter(Boolean).join(" · ");
    renderChart(host, d.series, { kind: d.kind, decimals: d.decimals, unit: unitFamily(d.unit) === "%" ? "%" : "", tooltip, endLabels: d.endLabels });
  } catch (err) {
    host.innerHTML = `<div class="chart-empty">Couldn't load (${esc(err.message)})</div>`;
  }
}

const ICON_EDIT = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/></svg>`;
const ICON_X = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>`;

function renderWidgets() {
  state.widgets ??= loadWidgets();
  const box = $("#compare");
  if (!state.widgets.length) {
    box.innerHTML = `<div class="empty">No charts yet. <button class="btn primary" data-add-chart>+ Add chart</button></div>`;
    return;
  }
  box.innerHTML = state.widgets.map((w, n) => {
    const title = widgetTitle(w, resolveWidget(w));
    return `<figure class="panel" data-w="${w.id}" style="margin:0">
      <div class="panel-head"><div class="panel-title"><span class="fig-no">Figure ${n + 1}</span>${esc(title)}</div>
        <div class="panel-tools">
          <div class="seg seg-sm" data-range role="radiogroup" aria-label="Time range"></div>
          <button class="icon-btn sm" data-edit title="Edit chart" aria-label="Edit ${esc(title)}">${ICON_EDIT}</button>
          <button class="icon-btn sm" data-remove title="Remove chart" aria-label="Remove ${esc(title)}">${ICON_X}</button>
        </div></div>
      <div class="legend" data-legend></div><div class="chart" data-chart></div><figcaption class="note panel-note" data-note></figcaption>
    </figure>`;
  }).join("");
  for (const w of state.widgets) drawWidget(w, box.querySelector(`[data-w="${w.id}"]`));
}

// ---------------------------------------------------------------- graph builder
const builder = { draft: null, editing: null, timer: 0 };

function statOptions() {
  const { summary } = state;
  const concepts = Object.keys(summary.concepts).map((k) =>
    `<option value="concept:${k}">${esc(conceptName(k))} (${conceptAreas(k).join(", ")})</option>`).join("");
  const byCat = summary.categories.map((cat) => {
    const inds = summary.indicators.filter((i) => i.category === cat && i.latest && !i.hidden);
    if (!inds.length) return "";
    return `<optgroup label="${esc(cat)}: single indicators">${inds.map((i) =>
      `<option value="ind:${i.id}">${esc(i.name)} · ${i.country}</option>`).join("")}</optgroup>`;
  }).join("");
  return `<optgroup label="Compare across areas">${concepts}</optgroup>${byCat}
    <optgroup label="Mix and match"><option value="custom">Custom: pick any indicators…</option></optgroup>`;
}

function builderChecks() {
  const w = builder.draft;
  const areasWrap = $("#b-areas-wrap"), indsWrap = $("#b-inds-wrap");
  if (w.stat === "custom") {
    areasWrap.hidden = true; indsWrap.hidden = false;
    const { summary } = state;
    $("#b-inds").innerHTML = countryOrder().map((c) => {
      const inds = summary.indicators.filter((i) => i.country === c && i.latest);
      return `<div class="check-group"><div class="check-head">${flag(c)} ${esc(summary.countries[c].name)}</div>${inds.map((i) =>
        `<label class="check"><input type="checkbox" name="ind" value="${i.id}" ${w.inds.includes(i.id) ? "checked" : ""}>
          <span>${esc(i.name)} <span class="note">${esc(i.unit)}</span></span></label>`).join("")}</div>`;
    }).join("");
    return;
  }
  areasWrap.hidden = false; indsWrap.hidden = true;
  if (w.stat.startsWith("concept:")) {
    const avail = conceptAreas(w.stat.slice(8));
    $("#b-areas").innerHTML = avail.map((c) => `<label class="check"><input type="checkbox" name="area" value="${c}" ${w.areas.includes(c) ? "checked" : ""}>
      <span>${flag(c)} ${esc(state.summary.countries[c].name)}</span></label>`).join("");
  } else {
    const ind = state.byId[w.stat.slice(4)];
    $("#b-areas").innerHTML = `<label class="check"><input type="checkbox" checked disabled><span>${flag(ind.country)} ${esc(state.summary.countries[ind.country].name)}</span></label>
      <p class="note">Only published for this area. Use a "Compare across areas" statistic or Custom to add others.</p>`;
  }
}

function builderOptions() {
  const w = builder.draft;
  const inds = resolveWidget(w);
  const coarsest = Math.max(-1, ...inds.map((i) => FREQ_RANK[i.frequency] ?? 2));
  const allowed = FREQ_OPTS.filter(([k]) => k === "native" || FREQ_RANK[k] > coarsest);
  if (!allowed.some(([k]) => k === w.freq)) w.freq = "native";
  $("#b-freq").innerHTML = allowed.map(([k, l]) => `<option value="${k}" ${k === w.freq ? "selected" : ""}>${l}</option>`).join("");
  const agg = $("#b-agg");
  const canSum = inds.length && inds.every((i) => isFlowUnit(i.unit));
  agg.querySelector('[value="sum"]').disabled = !canSum;
  if (!canSum && w.agg === "sum") w.agg = "avg";
  agg.value = w.agg;
  agg.disabled = w.freq === "native";
  $("#b-range").value = w.range;
}

function builderProblem() {
  const w = builder.draft;
  const inds = resolveWidget(w);
  if (!inds.length) return w.stat === "custom" ? "Pick at least one indicator." : "Pick at least one area.";
  if (inds.length > MAX_SERIES) return `Pick up to ${MAX_SERIES} indicators so the chart stays readable.`;
  const fams = [...new Set(inds.map((i) => unitFamily(i.unit)))];
  if (fams.length > 1) return `These are measured in different units (${fams.join(", ")}). A chart has one axis, so pick indicators measured the same way, or put them on separate charts.`;
  return "";
}

function builderRefresh(rebuildChecks = false) {
  if (rebuildChecks) builderChecks();
  builderOptions();
  const problem = builderProblem();
  $("#b-msg").textContent = problem;
  $("#b-msg").classList.toggle("warn", !!problem);
  $("#b-save").disabled = !!problem;
  clearTimeout(builder.timer);
  builder.timer = setTimeout(async () => {
    if (problem) { $("#b-chart").innerHTML = `<div class="chart-empty">Nothing to show yet</div>`; $("#b-legend").innerHTML = ""; return; }
    try {
      const d = await widgetData(builder.draft);
      $("#b-legend").innerHTML = legendHtml(d.series, d.decimals);
      renderChart($("#b-chart"), d.series, { kind: d.kind, decimals: d.decimals, unit: unitFamily(d.unit) === "%" ? "%" : "", tooltip, endLabels: d.endLabels });
    } catch (err) {
      $("#b-chart").innerHTML = `<div class="chart-empty">Couldn't load (${esc(err.message)})</div>`;
    }
  }, 120);
}

function openBuilder(w) {
  builder.editing = w ? w.id : null;
  const firstConcept = Object.keys(state.summary.concepts)[0];
  builder.draft = w ? JSON.parse(JSON.stringify(w))
    : { id: uid(), stat: `concept:${firstConcept}`, areas: conceptAreas(firstConcept), inds: [], freq: "native", agg: "avg", range: "10Y", name: "" };
  $("#b-title").textContent = w ? "Edit chart" : "Add a chart";
  $("#b-save").textContent = w ? "Save chart" : "Add chart";
  $("#b-stat").innerHTML = statOptions();
  $("#b-stat").value = builder.draft.stat;
  $("#b-range").innerHTML = Object.keys(RANGES).map((k) => `<option value="${k}">${k === "Max" ? "All" : k === "1Y" ? "1 year" : k.replace("Y", " years")}</option>`).join("");
  $("#b-name").value = builder.draft.name || "";
  const dlg = $("#builder");
  dlg.append(tooltip);
  if (!dlg.open) dlg.showModal();
  builderRefresh(true);
}

function wireBuilder() {
  $("#cmp-add").onclick = () => openBuilder();
  $("#cmp-reset").onclick = () => {
    if (!confirm("Replace your charts with the default set?")) return;
    state.widgets = defaultWidgets(); saveWidgets(); renderWidgets();
  };
  $("#compare").addEventListener("click", (e) => {
    if (e.target.closest("[data-add-chart]")) return openBuilder();
    const panel = e.target.closest("[data-w]");
    if (!panel) return;
    const w = state.widgets.find((x) => x.id === panel.dataset.w);
    if (e.target.closest("[data-edit]")) openBuilder(w);
    if (e.target.closest("[data-remove]")) {
      state.widgets = state.widgets.filter((x) => x !== w); saveWidgets(); renderWidgets();
    }
  });
  const form = $("#builder-form");
  form.addEventListener("change", (e) => {
    const w = builder.draft;
    const t = e.target;
    if (t.id === "b-stat") {
      const prev = { ...w };
      w.stat = t.value;
      if (w.stat.startsWith("concept:")) w.areas = conceptAreas(w.stat.slice(8));
      // Switching to Custom starts from whatever the previous choice showed.
      if (w.stat === "custom" && !w.inds.length) w.inds = resolveWidget(prev).map((i) => i.id);
    }
    if (t.name === "area") w.areas = [...form.querySelectorAll('input[name="area"]:checked')].map((x) => x.value);
    if (t.name === "ind") w.inds = [...form.querySelectorAll('input[name="ind"]:checked')].map((x) => x.value);
    if (t.id === "b-freq") w.freq = t.value;
    if (t.id === "b-agg") w.agg = t.value;
    if (t.id === "b-range") w.range = t.value;
    if (t.id !== "b-name") builderRefresh(t.id === "b-stat");
  });
  $("#b-name").addEventListener("input", (e) => { builder.draft.name = e.target.value.trim(); });
  form.addEventListener("submit", (e) => {
    if (builderProblem()) { e.preventDefault(); return; }
    state.widgets ??= loadWidgets();
    const w = builder.draft;
    const i = state.widgets.findIndex((x) => x.id === builder.editing);
    if (i >= 0) state.widgets[i] = w; else state.widgets.unshift(w);
    saveWidgets();
    if (location.hash !== "#compare") showView("compare");
    compareDrawn = true;
    renderWidgets();
    $("#compare").querySelector(`[data-w="${w.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// ---------------------------------------------------------------- calendar
function filteredEvents() {
  const imp = state.calImportance === "high" ? ["high"] : state.calImportance === "high+" ? ["high", "medium"] : ["high", "medium", "low"];
  return upcoming().filter((e) => (state.calCountry === "ALL" || e.country === state.calCountry) && imp.includes(e.importance));
}

function renderCalendar() {
  const events = filteredEvents();
  const todayKey = dayKey(new Date());
  const groups = new Map();
  for (const e of events) {
    const d = new Date(e.datetime_utc);
    const k = dayKey(d);
    if (!groups.has(k)) groups.set(k, { d, items: [] });
    groups.get(k).items.push(e);
  }
  const impDots = (imp) => {
    const n = { high: 3, medium: 2, low: 1 }[imp];
    return `<span class="imp" role="img" aria-label="${imp} importance" title="${imp} importance">${[1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  };
  const html = [...groups.entries()].map(([k, g]) => `
    <div class="cal-day ${k === todayKey ? "today" : ""}">
      <div class="cal-day-head"><span class="d">${fmtDay(g.d)}</span><span class="rel">${relDays(g.d)}</span></div>
      ${g.items.map((e) => {
        const d = new Date(e.datetime_utc);
        const ind = e.indicators.map((id) => state.byId[id]).find((i) => i?.latest);
        const last = ind ? `<button data-id="${ind.id}" title="Open chart">Last · ${ind.name} ${fmtNum(ind.latest.value, ind.decimals)}${isPct(ind.unit) ? "%" : ""} (${ind.latest.period})</button>` : "";
        const detail = e.url ? `<a href="${e.url}" target="_blank" rel="noopener">${e.detail}</a>` : e.detail;
        return `<div class="cal-row">
          <span class="cal-time">${e.time_known ? fmtTime(d) : "TBC"}</span>
          <span class="cal-flag" title="${state.summary.countries[e.country]?.name || e.country}">${flag(e.country)}</span>
          <div><div class="cal-title"><button class="linkish" data-release="${e.id}">${e.title}</button>${impDots(e.importance)}${e.note ? `<span class="note-inline">${e.note}</span>` : ""}${e.provisional ? `<span class="note-inline">provisional date</span>` : ""}</div>
            <div class="cal-detail">${detail} · ${e.source}</div></div>
          <div class="cal-last">${last}</div>
        </div>`;
      }).join("")}
    </div>`).join("");
  $("#calendar").innerHTML = html || `<div class="empty">No releases match these filters.</div>`;
  $("#cal-warnings").textContent = state.calendar.warnings?.length ? "Note: " + state.calendar.warnings.join(" · ") : "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("#cal-sub").textContent = `Next ${events.length ? Math.max(1, Math.round((new Date(events.at(-1).datetime_utc) - Date.now()) / 864e5)) : 0} days · times in your time zone (${tz})`;
}

function exportIcs(events = filteredEvents()) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const esc = (s) => String(s).replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Macro Monitor//EN", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    const dt = e.datetime_utc.replace(/[-:]/g, "").slice(0, 15) + "Z";
    lines.push("BEGIN:VEVENT", `UID:${e.id}@macro-monitor`, `DTSTAMP:${stamp}`, `DTSTART:${dt}`, "DURATION:PT15M",
      `SUMMARY:${esc(`${e.country} ${e.title}`)}`, `DESCRIPTION:${esc(`${e.detail}${e.url ? "\n" + e.url : ""}`)}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "economic-releases.ics" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- elections
const EL_REGIONS = ["Europe", "Americas", "Asia", "Africa", "Oceania"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const isoDate = (s) => new Date(`${s}T12:00:00Z`);
const localDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayIso = () => new Date().toLocaleDateString("en-CA");

function elTag(e) {
  const code = e.iso === "GB" ? "UK" : e.iso;
  const c = state.summary?.countries?.[code] ? countryColor(code) : "var(--axis)";
  return `<span class="cc" style="--c:${c}">${esc(e.iso || "··")}</span>`;
}
function elFiltered() {
  const els = state.elections?.elections || [];
  return els.filter((e) =>
    (state.elRegion === "ALL" || e.region === state.elRegion) &&
    (state.elScope === "all" || e.g20 || e.eu) &&
    (state.elType === "all" || e.kinds.includes(state.elType)));
}
const elIsPast = (e, today) => e.date && e.precision !== "by" && (e.end || e.date) < today;
function elGroupKey(e) {
  if (e.precision === "day" || e.precision === "by") return e.date.slice(0, 7);
  if (e.precision === "month") return `${e.year}-${String(e.month).padStart(2, "0")}`;
  return `${e.year}-99`;
}
function elGroupLabel(k) {
  const [y, m] = k.split("-");
  return m === "99" ? `${y} · date not yet set` : `${MONTH_NAMES[+m - 1]} ${y}`;
}
function elWhen(e) {
  if (e.precision === "day") {
    const d = localDay(e.date);
    const day = e.end ? `${d.getDate()}–${localDay(e.end).getDate()}` : d.getDate();
    return `<span class="el-day">${day}</span><span class="el-wd">${d.toLocaleDateString(undefined, { weekday: "short" })}</span>`;
  }
  if (e.precision === "by") return `<span class="el-day">${localDay(e.date).getDate()}</span><span class="el-wd">latest</span>`;
  return `<span class="el-day tbc">TBC</span>`;
}
function elRow(e) {
  const offices = e.offices.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)}</a>`).join(", ");
  const badges = [
    e.round && `<span class="badge">${e.round} round</span>`,
    e.indirect && `<span class="badge" title="Chosen by a legislature or electoral college, not a popular vote">Indirect</span>`,
    e.territory && `<span class="badge" title="Dependent territory or partially recognised state">Territory</span>`,
    e.g20 && `<span class="badge strong">G20</span>`, e.eu && `<span class="badge strong">EU</span>`,
    e.precision === "month" && `<span class="badge" title="Only the month is known">Day TBC</span>`,
    e.precision === "by" && `<span class="badge" title="Latest date allowed by law; it can be called earlier">Must be held by</span>`,
  ].filter(Boolean).join("");
  const rel = e.date && e.precision !== "month" ? relDays(localDay(e.date)) : "";
  return `<div class="el-row" id="el-${e.id}">
    <div class="el-when">${elWhen(e)}</div>
    <div class="el-flag">${elTag(e)}</div>
    <div class="el-main"><div class="el-title">${esc(e.country)}<span class="el-badges">${badges}</span></div>
      <div class="el-offices">${offices}</div></div>
    <div class="el-rel">${rel}</div>
  </div>`;
}
function renderElections() {
  const box = $("#elections");
  if (!state.elections) { box.innerHTML = `<div class="empty">Election data not available yet. Run <code>python -m pipeline.build --only-elections</code>.</div>`; return; }
  const today = todayIso();
  const items = elFiltered();
  const upcoming = items.filter((e) => !elIsPast(e, today));
  const recent = items.filter((e) => elIsPast(e, today)).reverse();

  const groups = new Map();
  for (const e of upcoming) {
    const k = elGroupKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const order = (a, b) => (a.precision === "month") - (b.precision === "month")
    || (a.date || "").localeCompare(b.date || "") || a.country.localeCompare(b.country);
  box.innerHTML = [...groups.keys()].sort().map((k) => {
    const g = groups.get(k).sort(order);
    return `<div class="cal-day"><div class="cal-day-head"><span class="d">${elGroupLabel(k)}</span>
      <span class="rel">${g.length} ${g.length === 1 ? "election" : "elections"}</span></div>${g.map(elRow).join("")}</div>`;
  }).join("") || `<div class="empty">No upcoming elections match these filters.</div>`;

  $("#el-recent").innerHTML = recent.map(elRow).join("") || `<p class="note">None in the last 60 days.</p>`;
  $("#el-recent-count").textContent = `${recent.length} in the last 60 days · results are on each linked article`;

  const next = (state.elections.elections || []).filter((e) => (e.g20 || e.eu) && !e.indirect && e.precision === "day" && !elIsPast(e, today)).slice(0, 6);
  $("#el-next").innerHTML = next.length ? `<div class="feature-label">Next votes in G20 and EU countries</div>` + next.map((e) =>
    `<a class="next-item" href="${esc(e.offices[0].url)}" target="_blank" rel="noopener">
      <div class="when">${localDay(e.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · ${relDays(localDay(e.date))}</div>
      <div class="what">${elTag(e)} ${esc(e.country)}</div>
      <div class="when">${esc(e.offices.map((o) => o.label).join(", "))}</div></a>`).join("") : "";

  const dated = upcoming.filter((e) => e.precision === "day").length;
  $("#el-sub").textContent = `${upcoming.length} upcoming national elections and referendums, ${dated} with a confirmed date.`;
  const gen = new Date(state.elections.generated_at);
  const srcLinks = state.elections.sources.map((u) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(decodeURIComponent(u.split("/wiki/")[1]).replace(/_/g, " "))}</a>`).join(" and ");
  $("#el-note").innerHTML = `Source: Wikipedia's ${srcLinks} (CC BY-SA), with exact dates from Wikidata where the calendar only gives a month. `
    + `A few major elections in later years are listed by hand in <code>config/elections_extra.json</code>. `
    + `Fetched ${gen.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Snap elections appear once editors add them.`
    + (state.elections.warnings?.length ? `<br>Note: ${esc(state.elections.warnings.join(" · "))}` : "");
}
function exportElectionsIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const icsEsc = (s) => String(s).replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const ymd = (s) => s.replace(/-/g, "");
  const plusDay = (s) => { const d = isoDate(s); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Macro Monitor//Elections//EN", "CALSCALE:GREGORIAN"];
  const today = todayIso();
  for (const e of elFiltered().filter((x) => x.precision === "day" && !elIsPast(x, today))) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@macro-monitor-elections`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(plusDay(e.end || e.date))}`,
      `SUMMARY:${icsEsc(`${e.country} election: ${e.offices.map((o) => o.label).join(", ")}`)}`,
      `DESCRIPTION:${icsEsc(e.offices.map((o) => o.url).join("\n"))}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "elections.ics" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function initElectionFilters() {
  segmented($("#el-region"), [["ALL", "All regions"], ...EL_REGIONS.map((r) => [r, r])], state.elRegion,
    (v) => { state.elRegion = v; store.set("elRegion", v); renderElections(); });
  segmented($("#el-scope"), [["all", "All countries"], ["major", "G20 + EU"]], state.elScope,
    (v) => { state.elScope = v; store.set("elScope", v); renderElections(); });
  segmented($("#el-type"), [["all", "All types"], ["executive", "Executive"], ["legislative", "Legislative"], ["referendum", "Referendum"]], state.elType,
    (v) => { state.elType = v; store.set("elType", v); renderElections(); });
}

// ---------------------------------------------------------------- search (/ or Ctrl+K)
const ALIASES = {
  US: "us usa united states america american fed federal reserve",
  UK: "uk gb britain british united kingdom england boe bank of england",
  EA: "ea euro area eurozone europe european ecb",
};
const search = { items: [], results: [], sel: 0 };

function buildSearchIndex() {
  const { summary } = state;
  const items = [];
  const pages = [
    ["dashboard", "Overview", "Headline figures for each economy"],
    ["learn", "Learning", "Today's explainer and country spotlight"],
    ["compare", "Compare", "Charts comparing economies; build your own"],
    ["calendar", "Release calendar", "When the next figures come out"],
    ["elections", "Elections", "National elections worldwide"],
    ["about", "About & sources", "How to read the figures, sources, methods"],
  ];
  for (const [view, title, sub] of pages) {
    items.push({ group: "Pages", title, sub, icon: "→", keys: `${title} ${sub} page`, run: () => showView(view) });
  }
  items.push({ group: "Pages", title: "Add a chart", sub: "Open the chart builder", icon: "+", keys: "add chart builder graph new compare plot",
    run: () => { showView("compare"); openBuilder(); } });
  for (const [c, v] of Object.entries(summary.countries)) {
    items.push({ group: "Pages", title: `${v.name} overview`, sub: "Headline figures, all indicators", icon: flag(c),
      keys: `${v.name} ${ALIASES[c] || c} economy overview dashboard`,
      run: () => { state.country = c; store.set("country", c); segmented($("#country-picker"), Object.entries(summary.countries).map(([k, x]) => [k, `${flag(k)} ${esc(x.name)}`]), c, (val) => { state.country = val; store.set("country", val); renderDashboard(); }); renderDashboard(); showView("dashboard"); } });
  }
  for (const ind of summary.indicators) {
    if (ind.hidden || !ind.latest) continue;
    const cname = summary.countries[ind.country]?.name || ind.country;
    items.push({
      group: "Statistics", title: ind.name, sub: `${cname} · ${ind.category} · ${ind.latest.period}`, icon: flag(ind.country),
      val: `${fmtNum(ind.latest.value, ind.decimals)}${unitSuffix(ind)}`,
      keys: `${ind.name} ${cname} ${ALIASES[ind.country] || ""} ${ind.category} ${ind.unit} ${state.summary.concepts[ind.concept] || ""}`,
      more: ind.about ? `${ind.about.what} ${ind.about.why}` : "",
      run: () => openDetail(ind.id),
    });
  }
  for (const e of upcoming().slice(0, 80)) {
    const d = new Date(e.datetime_utc);
    items.push({
      group: "Upcoming releases", title: e.title, sub: `${summary.countries[e.country]?.name || e.country} · ${fmtDay(d)}${e.time_known ? `, ${fmtTime(d)}` : ""}`,
      icon: flag(e.country), keys: `${e.title} ${e.detail} ${ALIASES[e.country] || e.country} release ${fmtDay(d)}`,
      run: () => openRelease(e.id),
    });
  }
  const seenArt = new Set();
  for (const iss of state.learning?.issues || []) {
    for (const sr of ["explainers", "spotlights"]) {
      const a = iss[sr];
      if (seenArt.has(sr + a.slug)) continue;
      seenArt.add(sr + a.slug);
      items.push({
        group: "Learning Centre", title: a.title, sub: `${LEARN_LABEL[sr]} · ${a.country || a.topic || ""} · ${a.minutes} min read`,
        icon: sr === "spotlights" && a.iso2 ? flag(a.iso2) : "Aa", keys: `${a.title} ${a.dek} ${a.topic || ""} ${a.country || ""} article learn read explainer spotlight`,
        run: () => { location.hash = `learn/${sr}/${a.slug}`; },
      });
    }
  }
  const today = todayIso();
  for (const e of state.elections?.elections || []) {
    if (elIsPast(e, today)) continue;
    const when = e.precision === "day" ? localDay(e.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
      : e.precision === "month" ? `${MONTH_NAMES[e.month - 1]} ${e.year}` : `${e.year}, date not set`;
    items.push({
      group: "Elections", title: `${e.country}`, sub: `${e.offices.map((o) => o.label).join(", ")} · ${when}`, icon: elTag(e),
      keys: `${e.country} ${e.iso || ""} election vote ${e.kinds.join(" ")} ${e.offices.map((o) => o.label).join(" ")} ${e.region}`,
      run: () => {
        state.elRegion = "ALL"; state.elScope = "all"; state.elType = "all";
        initElectionFilters(); renderElections(); showView("elections");
        const row = document.getElementById(`el-${e.id}`);
        if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1800); }
      },
    });
  }
  search.items = items.map((it) => ({ ...it, hay: `${it.title} ${it.keys}`.toLowerCase(), titleL: it.title.toLowerCase(), moreL: (it.more || "").toLowerCase() }));
}

function runSearch(q) {
  const query = q.trim().toLowerCase();
  const LIMITS = { Pages: 4, Statistics: 8, "Learning Centre": 4, "Upcoming releases": 5, Elections: 5 };
  let scored;
  if (!query) {
    // Suggestions: this economy's headline figures, the next releases, the pages.
    const head = new Set(glancePicks(state.country).map(([, i]) => i.name));
    const iss0 = state.learning?.issues?.[0];
    const todaysTitles = new Set(iss0 ? [iss0.explainers.title, iss0.spotlights.title] : []);
    scored = search.items.filter((it) =>
      (it.group === "Statistics" && head.has(it.title) && it.icon.includes(`>${state.country}<`)) ||
      it.group === "Upcoming releases" || (it.group === "Pages" && it.icon === "→") ||
      (it.group === "Learning Centre" && todaysTitles.has(it.title))).map((it) => ({ it, score: 1 }));
  } else {
    const tokens = query.split(/\s+/).filter(Boolean);
    scored = [];
    for (const it of search.items) {
      let score = 0, ok = true;
      for (const t of tokens) {
        const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        if (re.test(it.titleL)) score += 10;
        else if (re.test(it.hay)) score += 4;
        else if (t.length > 3 && it.moreL.includes(t)) score += 1;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (it.titleL.startsWith(query)) score += 20;
      if (it.titleL === query) score += 20;
      scored.push({ it, score });
    }
  }
  const order = ["Statistics", "Learning Centre", "Upcoming releases", "Elections", "Pages"];
  const out = [];
  for (const g of order) {
    const inG = scored.filter((x) => x.it.group === g).sort((a, b) => b.score - a.score).slice(0, LIMITS[g]);
    out.push(...inG.map((x) => x.it));
  }
  // If the best match overall is a page or election, lead with that group.
  if (query && scored.length) {
    const best = scored.slice().sort((a, b) => b.score - a.score)[0].it.group;
    out.sort((a, b) => (b.group === best) - (a.group === best));
  }
  search.results = out;
  search.sel = 0;
  drawSearch(query);
}

function drawSearch(query) {
  const box = $("#search-results");
  if (!search.results.length) {
    box.innerHTML = `<div class="search-empty">No matches for “${esc(query)}”. Try a statistic (“inflation”), a country (“UK”) or an election (“France”).</div>`;
    $("#search-input").removeAttribute("aria-activedescendant");
    return;
  }
  let html = "", group = "";
  search.results.forEach((it, i) => {
    if (it.group !== group) { group = it.group; html += `<div class="sr-group" role="presentation">${!query && group === "Statistics" ? "Headline figures" : !query && group === "Learning Centre" ? "Today's reading" : group}</div>`; }
    html += `<button class="sr-item" id="sr-${i}" role="option" data-i="${i}" aria-selected="${i === search.sel}">
      <span class="sr-icon">${it.icon}</span>
      <span style="min-width:0"><div class="sr-title">${esc(it.title)}</div><div class="sr-sub">${esc(it.sub)}</div></span>
      <span class="sr-val">${it.val || ""}</span></button>`;
  });
  box.innerHTML = html;
  $("#search-input").setAttribute("aria-activedescendant", `sr-${search.sel}`);
}

function moveSel(d) {
  if (!search.results.length) return;
  search.sel = (search.sel + d + search.results.length) % search.results.length;
  document.querySelectorAll(".sr-item").forEach((b) => b.setAttribute("aria-selected", +b.dataset.i === search.sel));
  document.getElementById(`sr-${search.sel}`)?.scrollIntoView({ block: "nearest" });
  $("#search-input").setAttribute("aria-activedescendant", `sr-${search.sel}`);
}

function pickResult(i) {
  const it = search.results[i];
  if (!it) return;
  $("#search").close();
  setTimeout(() => it.run(), 0);
}

function openSearch() {
  buildSearchIndex();
  const dlg = $("#search");
  const input = $("#search-input");
  input.value = "";
  if (!dlg.open) dlg.showModal();
  runSearch("");
  input.focus();
}

function wireSearch() {
  $("#search-open").onclick = openSearch;
  const input = $("#search-input");
  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    if (e.key === "Enter") { e.preventDefault(); pickResult(search.sel); }
  });
  $("#search-results").addEventListener("click", (e) => { const b = e.target.closest(".sr-item"); if (b) pickResult(+b.dataset.i); });
  $("#search-results").addEventListener("mousemove", (e) => {
    const b = e.target.closest(".sr-item");
    if (b && +b.dataset.i !== search.sel) { search.sel = +b.dataset.i; document.querySelectorAll(".sr-item").forEach((x) => x.setAttribute("aria-selected", x === b)); }
  });
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing && !document.querySelector("dialog[open]"))) {
      e.preventDefault();
      openSearch();
    }
  });
}

// ---------------------------------------------------------------- learning centre
const LEARN_LABEL = { explainers: "The Explainer", spotlights: "Country Spotlight" };
const articleCache = {};
let archFilter = store.get("archFilter", "all");

const issueDay = (iso) => localDay(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
function fmtWB(v, f) {
  if (v == null) return "–";
  if (f === "usd_bn") { const bn = v / 1e9; return bn >= 1000 ? `$${fmtNum(bn / 1000, 2)} trn` : `$${fmtNum(bn, bn >= 100 ? 0 : 1)} bn`; }
  if (f === "usd") return `$${Math.round(v).toLocaleString("en-GB")}`;
  if (f === "people_m") return v >= 1e9 ? `${fmtNum(v / 1e9, 2)} bn` : `${fmtNum(v / 1e6, 1)} m`;
  if (f === "pct_gdp") return `${fmtNum(v, 1)}% of GDP`;
  return `${fmtNum(v, 1)}%`;
}
const artTag = (s, a) => s === "spotlights" && a.iso2
  ? `${flag(a.iso2 === "GB" ? "UK" : a.iso2)} ${esc(a.country || "")}`
  : esc(a.topic || "Economics");

function learnCard(s, a, big) {
  return `<a class="learn-card ${s}${big ? " big" : ""}" href="#learn/${s}/${a.slug}">
    <span class="lc-series">${LEARN_LABEL[s]}</span>
    <span class="lc-tag">${artTag(s, a)}</span>
    <span class="lc-title">${esc(a.title)}</span>
    ${big ? `<span class="lc-dek">${esc(a.dek)}</span>` : ""}
    <span class="lc-meta">${a.minutes} min read${big ? `<span class="lc-cta">Read now →</span>` : ""}</span>
  </a>`;
}

// Bring forward any scheduled issue whose release time has passed, so the page
// moves to the new issue at 06:00 UK time even if the overnight build hasn't run.
function releaseDueIssues() {
  const L = state.learning;
  if (!L?.upcoming) return;
  while (L.upcoming.length && Date.parse(L.upcoming[0].release) <= Date.now()) L.issues.unshift(L.upcoming.shift());
  L.issue_number = L.issues[0].number;
}

function renderLearnHome() {
  releaseDueIssues();
  const L = state.learning;
  if (!L) { $("#learn-today").innerHTML = `<div class="empty">The Learning Centre isn't available yet.</div>`; return; }
  const today = L.issues[0];
  $("#learn-kicker").textContent = `Learning Centre · Issue ${L.issue_number} · ${issueDay(today.date)}`;
  $("#learn-today").innerHTML = learnCard("explainers", today.explainers, true) + learnCard("spotlights", today.spotlights, true);

  const form = $("#sub-form");
  if (L.buttondown_username) {
    form.hidden = false;
    form.action = `https://buttondown.com/api/emails/embed-subscribe/${encodeURIComponent(L.buttondown_username)}`;
    $("#sub-alt").innerHTML = `Prefer a feed reader? <a href="feed.xml">RSS feed</a>`;
  } else {
    form.hidden = true;
    $("#sub-alt").innerHTML = `Email sign-up is being set up. In the meantime you can follow the <a href="feed.xml">RSS feed</a>.`;
  }

  segmented($("#arch-filter"), [["all", "Both"], ["explainers", "Explainers"], ["spotlights", "Spotlights"]], archFilter,
    (v) => { archFilter = v; store.set("archFilter", v); renderArchive(); });
  renderArchive();
}

function renderArchive() {
  const L = state.learning;
  const past = L.issues.slice(1);
  const show = archFilter === "all" ? ["explainers", "spotlights"] : [archFilter];
  $("#learn-archive").innerHTML = past.length ? past.map((iss) => `
    <div class="arch-row">
      <div class="arch-date"><span class="d">${localDay(iss.date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span><span class="note">Issue ${iss.number}</span></div>
      <div class="arch-items">${show.map((s) => learnCard(s, iss[s], false)).join("")}</div>
    </div>`).join("")
    : `<p class="note">This is the first issue. Earlier editions will appear here from tomorrow.</p>`;
}

async function loadArticle(s, slug) {
  articleCache[`${s}/${slug}`] ??= fetch(`data/learning/${s}/${slug}.json`, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  return articleCache[`${s}/${slug}`];
}

function electionCard(e) {
  if (!e) return "";
  const exact = e.precision === "day" || e.precision === "by";
  const d = exact ? localDay(e.date) : null;
  const tile = exact
    ? `<div class="date-tile"><span class="dt-m">${d.toLocaleDateString(undefined, { month: "short" })}</span><span class="dt-d">${d.getDate()}</span><span class="dt-y">${d.getFullYear()}</span></div>`
    : `<div class="date-tile tbc"><span class="dt-m">${e.precision === "month" ? MONTH_NAMES[e.month - 1].slice(0, 3) : "Date"}</span><span class="dt-d">${e.precision === "month" ? "–" : "TBC"}</span><span class="dt-y">${e.year}</span></div>`;
  const when = e.precision === "by" ? "Must be held by this date" : exact ? relDays(d)[0].toUpperCase() + relDays(d).slice(1) : e.precision === "month" ? "Day not yet set" : "Date not yet set";
  return `<div class="pol-row">${tile}<div><div class="pol-k">Next national election</div>
    <div class="pol-v">${e.offices.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)}</a>`).join(", ")}</div>
    <div class="note">${when}</div></div></div>`;
}

// Spotlight fact file: four headline figures as tiles, the rest as a short list.
function factFile(a) {
  const data = a.data || [];
  if (!data.length) return "";
  const years = data.map((d) => d.year);
  const mainYear = years.sort((x, y) => years.filter((v) => v === y).length - years.filter((v) => v === x).length)[0];
  const yr = (d) => (d.year !== mainYear ? ` <span class="ff-yr">${d.year}</span>` : "");
  const by = Object.fromEntries(data.map((d) => [d.code, d]));
  const tiles = ["NY.GDP.MKTP.CD", "NY.GDP.PCAP.CD", "NY.GDP.MKTP.KD.ZG", "FP.CPI.TOTL.ZG"].map((c) => by[c]).filter(Boolean);
  const rest = data.filter((d) => !tiles.includes(d));
  const short = { "NY.GDP.MKTP.CD": "Economy size", "NY.GDP.PCAP.CD": "Income per person", "NY.GDP.MKTP.KD.ZG": "Real growth", "FP.CPI.TOTL.ZG": "Inflation" };
  const tileVal = (d) => d.format === "usd" ? `$${fmtNum(d.value / 1000, d.value >= 10000 ? 0 : 1)}k` : fmtWB(d.value, d.format).replace(" of GDP", "");
  const restVal = (d) => d.format === "pct_gdp" ? `${fmtNum(d.value, 1)}<small>% GDP</small>` : fmtWB(d.value, d.format);
  return `<section class="rail-card fact-file" aria-label="${esc(a.country)} key figures">
    <header class="rc-head"><span class="rc-title">${flag(a.iso2)} ${esc(a.country)} in numbers</span><span class="rc-sub">World Bank, ${mainYear}</span></header>
    <div class="ff-tiles">${tiles.map((d) => `<div class="ff-tile"><span class="ff-v">${tileVal(d)}${yr(d)}</span><span class="ff-k">${short[d.code]}</span></div>`).join("")}</div>
    ${rest.length ? `<dl class="ff-list">${rest.map((d) => `<div><dt>${esc(d.label)}</dt><dd>${restVal(d)}${yr(d)}</dd></div>`).join("")}</dl>` : ""}
    <p class="rc-foot">Latest annual figures. Refreshed weekly.</p>
  </section>`;
}

async function openArticle(s, slug) {
  $("#learn-home").hidden = true;
  const reader = $("#learn-reader");
  reader.hidden = false;
  $("#art-body").innerHTML = `<p class="note">Loading…</p>`;
  $("#art-aside").innerHTML = "";
  $("#art-foot").innerHTML = "";
  window.scrollTo(0, 0);
  let a;
  try { a = await loadArticle(s, slug); } catch (err) {
    $("#art-title").textContent = "Article not found";
    $("#art-body").innerHTML = `<p>This article isn't available. <a href="#learn">Back to the Learning Centre</a>.</p>`;
    return;
  }
  $("#art-kicker").innerHTML = `<span class="series-pill ${s}">${LEARN_LABEL[s]}</span><span class="kick-tag">${artTag(s, a)}</span>`;
  $("#art-title").textContent = a.title;
  $("#art-dek").textContent = a.dek;
  a.published = state.learning.issues.find((i) => i[s].slug === slug)?.date || a.published;
  $("#art-meta").innerHTML = `<span>${issueDay(a.published)}</span><span>${a.minutes} min read</span><span>${a.words.toLocaleString("en-GB")} words</span>`;
  $("#art-body").innerHTML = a.html;
  document.title = `${a.title} · Macro Monitor`;

  // Turn "At a glance" and "Key takeaways" (an H2 followed by a list) into designed panels.
  for (const [id, cls] of [["at-a-glance", "panel-glance"], ["key-takeaways", "panel-takeaways"]]) {
    const h = document.getElementById(id);
    const list = h?.nextElementSibling;
    if (h && list && /^(UL|OL)$/.test(list.tagName)) {
      const box = document.createElement("section");
      box.className = `art-panel ${cls}`;
      h.replaceWith(box);
      box.append(h, list);
    }
  }
  document.querySelectorAll(".panel-glance li > strong:first-child").forEach((b) => { b.textContent = b.textContent.replace(/:\s*$/, ""); if (b.nextSibling?.nodeType === 3) b.nextSibling.textContent = b.nextSibling.textContent.replace(/^\s*:?\s*/, ""); });
  // Tables: right-align cells that are numeric.
  document.querySelectorAll("#art-body td").forEach((td) => { if (/^[~≈<>]?\s*[-−$£€]?[\d.,]+\s*(%|bn|trn|m)?$/.test(td.textContent.trim())) td.classList.add("num"); });

  $("#art-toc").innerHTML = a.outline.length ? `<div class="toc-label">In this article</div><ol class="toc-sections">${a.outline.map((o) =>
    `<li><a href="#${o.id}" data-art-sec="${o.id}">${esc(o.text)}</a></li>`).join("")}</ol>
    <p class="toc-time">${a.minutes} min read</p>` : "";
  watchArticleSections();

  const other = s === "explainers" ? "spotlights" : "explainers";
  const sameDay = state.learning.issues.find((i) => i[s].slug === slug)?.[other];
  let rail = "";
  if (s === "spotlights") {
    rail += factFile(a);
    if (a.leader_note || a.next_election) {
      const leader = a.leader_note ? a.leader_note.replace(/\s*\(as of [^)]*\)\s*$/i, "") : "";
      rail += `<section class="rail-card politics" aria-label="Politics">
        <header class="rc-head"><span class="rc-title">Politics</span><span class="rc-sub">As of mid-2026</span></header>
        ${leader ? `<div class="pol-row"><div class="pol-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
          <div><div class="pol-k">In power</div><div class="pol-v">${esc(leader)}</div></div></div>` : ""}
        ${electionCard(a.next_election)}
      </section>`;
    }
  } else {
    rail += `<section class="rail-card" aria-label="About this article">
      <header class="rc-head"><span class="rc-title">Topics covered</span><span class="rc-sub">${esc(a.topic || "Economics")}</span></header>
      ${a.tags?.length ? `<div class="tags">${a.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</div>` : ""}
      <p class="rc-foot">Published ${issueDay(a.published)}${state.learning.issues.find((i) => i.explainers.slug === slug) ? ` · Issue ${state.learning.issues.find((i) => i.explainers.slug === slug).number}` : ""}</p>
    </section>`;
  }
  if (sameDay) rail += `<section class="rail-also"><div class="toc-label">Also in today’s issue</div>${learnCard(other, sameDay, false)}</section>`;
  $("#art-aside").innerHTML = rail;

  // Previous / next in the archive (same series).
  const list = state.learning.issues.map((i) => i[s]).filter((x, k, arr) => arr.findIndex((y) => y.slug === x.slug) === k);
  const idx = list.findIndex((x) => x.slug === slug);
  const newer = list[idx - 1], older = list[idx + 1];
  $("#art-foot").innerHTML = `
    <div class="art-nav">
      ${older ? `<a class="btn ghost" href="#learn/${s}/${older.slug}">← ${esc(older.title)}</a>` : "<span></span>"}
      ${newer ? `<a class="btn ghost" href="#learn/${s}/${newer.slug}">${esc(newer.title)} →</a>` : ""}
    </div>
    <div class="art-actions"><button class="btn" id="copy-link">Copy link</button><a class="btn ghost" href="#learn">All articles</a>
      <a class="btn ghost" href="#learn" data-scroll-sub>Get these by email</a></div>`;
  updateReadBar();
}

// Highlight the last section heading scrolled past (works for short and long sections alike).
let artHeads = [], artLinks = [];
function watchArticleSections() {
  artLinks = [...document.querySelectorAll("#art-toc a")];
  artHeads = [...document.querySelectorAll("#art-body h2[id]")];
  markArticleSection();
}
function markArticleSection() {
  if (!artHeads.length || $("#learn-reader").hidden) return;
  const line = innerHeight * 0.3;
  let cur = artHeads[0].id;
  for (const h of artHeads) { if (h.getBoundingClientRect().top <= line) cur = h.id; else break; }
  artLinks.forEach((l) => l.classList.toggle("active", l.dataset.artSec === cur));
}

function updateReadBar() {
  const r = $("#learn-reader");
  if (r.hidden) return;
  const body = $("#art-body").getBoundingClientRect();
  const done = Math.min(1, Math.max(0, (innerHeight * 0.4 - body.top) / Math.max(1, body.height)));
  $("#read-bar").style.width = `${(done * 100).toFixed(1)}%`;
}

function showLearn(rest) {
  releaseDueIssues();
  if (rest.length >= 2 && LEARN_LABEL[rest[0]]) return openArticle(rest[0], rest[1]);
  $("#learn-reader").hidden = true;
  $("#learn-home").hidden = false;
  document.title = "Learning Centre · Macro Monitor";
  renderLearnHome();
}

function wireLearn() {
  addEventListener("scroll", () => { updateReadBar(); markArticleSection(); }, { passive: true });
  document.addEventListener("click", async (e) => {
    const sec = e.target.closest("[data-art-sec]");
    if (sec) { e.preventDefault(); document.getElementById(sec.dataset.artSec)?.scrollIntoView({ behavior: "smooth" }); }
    if (e.target.closest("#copy-link")) {
      try { await navigator.clipboard.writeText(location.href); e.target.textContent = "Link copied"; } catch { prompt("Copy this link:", location.href); }
    }
    if (e.target.closest("[data-scroll-sub]")) setTimeout(() => $("#subscribe").scrollIntoView({ behavior: "smooth" }), 50);
  });
}

// ---------------------------------------------------------------- views & wiring
let compareDrawn = false;
// Hash routes: #view or #learn/<series>/<slug>.
function route() {
  const [view, ...rest] = location.hash.slice(1).split("/");
  showView(view || "dashboard", rest);
}

function showView(view, rest = []) {
  if (!["dashboard", "learn", "compare", "calendar", "elections", "about"].includes(view)) view = "dashboard";
  const changed = document.querySelector(`#view-${view}`)?.hidden;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "compare" && !compareDrawn) { compareDrawn = true; renderWidgets(); }
  if (location.hash.slice(1).split("/")[0] !== view) history.replaceState(null, "", `#${view}`);
  tooltip.hidden = true;
  if (changed) window.scrollTo(0, 0);
  if (view === "learn") showLearn(rest);
  else document.title = "Macro Monitor";
}

function wire() {
  $(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    if (location.hash.slice(1) !== b.dataset.view) location.hash = b.dataset.view; else route();
  });
  window.addEventListener("hashchange", route);
  wireLearn();
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    if (card) openDetail(card.dataset.id);
    const sec = e.target.closest("[data-sec]");
    if (sec) { e.preventDefault(); document.getElementById(sec.dataset.sec)?.scrollIntoView({ behavior: "smooth" }); }
    const rel = e.target.closest("[data-release]");
    if (rel) openRelease(rel.dataset.release);
    const oc = e.target.closest("[data-open-chart]");
    if (oc) { $("#release").close(); openDetail(oc.dataset.openChart); }
    const one = e.target.closest("[data-ics-one]");
    if (one) exportIcs([eventById(one.dataset.icsOne)]);
    const closer = e.target.closest("dialog [data-close]");
    if (closer) closer.closest("dialog").close();
    if (e.target.closest("[data-goto-cal]")) { state.calCountry = state.country; store.set("calCountry", state.country); initCalendarFilters(); renderCalendar(); showView("calendar"); }
  });
  $("#detail-close").onclick = () => $("#detail").close();
  for (const dlg of document.querySelectorAll("dialog")) {
    dlg.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    dlg.addEventListener("close", () => { tooltip.hidden = true; document.body.append(tooltip); });
  }
  wireBuilder();
  wireSearch();
  $("#detail-table-toggle").onclick = (e) => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", on); e.currentTarget.textContent = on ? "Hide table" : "Show table";
    $("#detail-table").hidden = !on;
  };
  $("#ics-export").onclick = () => exportIcs();
  $("#el-ics").onclick = exportElectionsIcs;
  $("#theme-toggle").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  };
}

function initCalendarFilters() {
  const countries = Object.entries(state.summary.countries);
  segmented($("#cal-country"), [["ALL", "All"], ...countries.map(([c]) => [c, c])], state.calCountry,
    (v) => { state.calCountry = v; store.set("calCountry", v); renderCalendar(); });
  segmented($("#cal-importance"), [["high", "High"], ["high+", "High + medium"], ["all", "All"]], state.calImportance,
    (v) => { state.calImportance = v; store.set("calImportance", v); renderCalendar(); });
}

async function init() {
  wire();
  try {
    const [summary, cal, els, learn] = await Promise.all([
      fetch("data/summary.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/calendar.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { events: [], warnings: ["calendar.json missing"] })),
      fetch("data/elections.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/learning.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    state.summary = summary;
    state.calendar = cal;
    state.elections = els;
    state.learning = learn;
    releaseDueIssues();
  } catch (err) {
    $("#dashboard").innerHTML = `<div class="empty">Couldn't load data. Run <code>python -m pipeline.build</code> first. (${err.message})</div>`;
    return;
  }
  state.byId = Object.fromEntries(state.summary.indicators.map((i) => [i.id, i]));
  if (!state.summary.countries[state.country]) state.country = Object.keys(state.summary.countries)[0];

  const gen = new Date(state.summary.generated_at);
  $("#updated").textContent = `Figures last refreshed ${gen.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;

  segmented($("#country-picker"), Object.entries(state.summary.countries).map(([c, v]) => [c, `${flag(c)} ${esc(v.name)}`]), state.country,
    (v) => { state.country = v; store.set("country", v); renderDashboard(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  initCalendarFilters();

  initElectionFilters();
  renderDashboard();
  renderCalendar();
  renderElections();
  route();
}

init();
