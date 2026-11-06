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
  compareRange: store.get("compareRange", "10Y"),
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
  if (!ind.latest || !ind.previous) return "";
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
function renderDashboard() {
  const { summary } = state;
  const inds = summary.indicators.filter((i) => i.country === state.country);
  const html = summary.categories.map((cat) => {
    const cards = inds.filter((i) => i.category === cat);
    if (!cards.length) return "";
    return `<section class="cat"><h3>${cat}</h3><div class="grid">${cards.map(cardHtml).join("")}</div></section>`;
  }).join("");
  $("#dashboard").innerHTML = html || `<div class="empty">No indicators configured for this country yet.</div>`;

  const next = upcoming().filter((e) => e.country === state.country && e.importance === "high").slice(0, 8);
  $("#next-up").innerHTML = next.length ? `<span class="next-label">Next up</span>` + next.map((e) => {
    const d = new Date(e.datetime_utc);
    return `<button class="next-item" data-goto-cal>
      <div class="when">${fmtShortDay(d)} · ${fmtTime(d)}</div>
      <div class="what">${e.title}</div></button>`;
  }).join("") : "";
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
  const next = nextReleaseFor(id);
  $("#detail-source").innerHTML = (ind.note ? `${ind.note}<br>` : "") + `Source: <a href="${ind.url}" target="_blank" rel="noopener">${SOURCE_NAMES[ind.source] || ind.source}${ind.series ? " · " + ind.series : ""}</a>` +
    (next ? ` · Next release ${fmtDay(new Date(next.datetime_utc))}, ${fmtTime(new Date(next.datetime_utc))}` : "");
  segmented($("#detail-range"), Object.keys(RANGES).map((k) => [k, k]), state.detail.range, (v) => { state.detail.range = v; drawDetail(); });
  const tbtn = $("#detail-table-toggle");
  tbtn.setAttribute("aria-pressed", "false"); tbtn.textContent = "Show table";
  $("#detail-table").hidden = true;
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
async function renderCompare() {
  const { summary } = state;
  const box = $("#compare");
  const concepts = Object.entries(summary.concepts);
  box.innerHTML = concepts.map(([key, label]) => {
    const inds = summary.indicators.filter((i) => i.concept === key && i.latest);
    const legend = inds.map((i) => `<span><span class="swatch" style="background:${countryColor(i.country)}"></span>${flag(i.country)} ${i.name} <strong>${fmtNum(i.latest.value, i.decimals)}</strong></span>`).join("");
    return `<div class="panel"><div class="panel-head"><div class="panel-title">${label}</div></div>
      <div class="legend">${legend}</div><div class="chart" data-concept="${key}"></div></div>`;
  }).join("");
  const years = RANGES[state.compareRange];
  await Promise.all(concepts.map(async ([key]) => {
    const inds = summary.indicators.filter((i) => i.concept === key && i.latest);
    const host = box.querySelector(`[data-concept="${key}"]`);
    try {
      const all = await Promise.all(inds.map((i) => loadSeries(i.id)));
      // Align the window to the latest common date so ranges match.
      const lastCommon = all.map((s) => s.observations.at(-1)[0]).sort().at(-1);
      const cut = years ? `${+lastCommon.slice(0, 4) - years}${lastCommon.slice(4)}` : "0000";
      const series = inds.map((ind, k) => ({
        label: `${ind.country} ${ind.name}`, short: ind.country, color: countryColor(ind.country),
        freq: all[k].frequency, points: all[k].observations.filter((p) => p[0] >= cut),
      }));
      const ind0 = inds[0];
      renderChart(host, series, { kind: ind0.concept === "policy_rate" ? "step" : "line", decimals: Math.max(...inds.map((i) => i.decimals)), unit: isPct(ind0.unit) ? "%" : ind0.unit, tooltip });
    } catch (err) {
      host.innerHTML = `<div class="chart-empty">Couldn't load (${err.message})</div>`;
    }
  }));
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
          <div><div class="cal-title">${e.title}${impDots(e.importance)}${e.note ? `<span class="note-inline">${e.note}</span>` : ""}${e.provisional ? `<span class="note-inline">provisional date</span>` : ""}</div>
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

function exportIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const esc = (s) => String(s).replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Macro Monitor//EN", "CALSCALE:GREGORIAN"];
  for (const e of filteredEvents()) {
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
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
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
  return `<div class="el-row">
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
  $("#el-next").innerHTML = next.length ? `<span class="next-label">Next G20 / EU</span>` + next.map((e) =>
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

// ---------------------------------------------------------------- views & wiring
let compareDrawn = false;
function showView(view) {
  if (!["dashboard", "compare", "calendar", "elections"].includes(view)) view = "dashboard";
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "compare" && !compareDrawn) { compareDrawn = true; renderCompare(); }
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  tooltip.hidden = true;
}

function wire() {
  $(".tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) showView(b.dataset.view); });
  window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-id]");
    if (card) openDetail(card.dataset.id);
    if (e.target.closest("[data-goto-cal]")) { state.calCountry = state.country; store.set("calCountry", state.country); initCalendarFilters(); renderCalendar(); showView("calendar"); }
  });
  $("#detail-close").onclick = () => $("#detail").close();
  $("#detail").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $("#detail").addEventListener("close", () => (tooltip.hidden = true));
  $("#detail-table-toggle").onclick = (e) => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", on); e.currentTarget.textContent = on ? "Hide table" : "Show table";
    $("#detail-table").hidden = !on;
  };
  $("#ics-export").onclick = exportIcs;
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
    const [summary, cal, els] = await Promise.all([
      fetch("data/summary.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/calendar.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { events: [], warnings: ["calendar.json missing"] })),
      fetch("data/elections.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    state.summary = summary;
    state.calendar = cal;
    state.elections = els;
  } catch (err) {
    $("#dashboard").innerHTML = `<div class="empty">Couldn't load data. Run <code>python -m pipeline.build</code> first. (${err.message})</div>`;
    return;
  }
  state.byId = Object.fromEntries(state.summary.indicators.map((i) => [i.id, i]));
  if (!state.summary.countries[state.country]) state.country = Object.keys(state.summary.countries)[0];

  const gen = new Date(state.summary.generated_at);
  $("#updated").textContent = `Data refreshed ${gen.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;

  segmented($("#country-picker"), Object.entries(state.summary.countries).map(([c, v]) => [c, v.name]), state.country,
    (v) => { state.country = v; store.set("country", v); renderDashboard(); });
  segmented($("#compare-range"), Object.keys(RANGES).map((k) => [k, k]), state.compareRange,
    (v) => { state.compareRange = v; store.set("compareRange", v); renderCompare(); });
  initCalendarFilters();

  initElectionFilters();
  renderDashboard();
  renderCalendar();
  renderElections();
  showView(location.hash.slice(1) || "dashboard");
}

init();
