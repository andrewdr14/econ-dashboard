// Small dependency-free SVG charts: sparklines and an interactive line/bar/step chart.
const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtNum(v, decimals = 1) {
  if (v == null || Number.isNaN(v)) return "–";
  return v.toLocaleString("en-GB", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtDate(d, freq) {
  if (freq === "monthly") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (freq === "quarterly") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (freq === "annual") return `${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const toDate = (s) => new Date(s + "T00:00:00Z");

// ---------------------------------------------------------------- sparkline
export function sparkline(points, { width = 240, height = 40 } = {}) {
  if (!points || points.length < 2) return "";
  const xs = points.map((p) => toDate(p[0]).getTime());
  const ys = points.map((p) => p[1]);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = 4;
  const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - pad * 2);
  const sy = (y) => pad + (1 - (y - y0) / (y1 - y0)) * (height - pad * 2);
  const d = xs.map((x, i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join("");
  const area = `${d}L${sx(x1).toFixed(1)},${height}L${sx(x0).toFixed(1)},${height}Z`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${area}"/><path class="line" d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------- scales
function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks, step };
}

function timeTicks(t0, t1, maxTicks) {
  const years = (t1 - t0) / (365.25 * 864e5);
  const out = [];
  const start = new Date(t0);
  if (years > 2.5) {
    const every = [1, 2, 5, 10].find((e) => years / e <= maxTicks) || 20;
    let y = Math.ceil(start.getUTCFullYear() / every) * every;
    for (; ; y += every) {
      const t = Date.UTC(y, 0, 1);
      if (t > t1) break;
      if (t >= t0) out.push({ t, label: String(y) });
    }
  } else {
    const months = years * 12;
    const every = [1, 2, 3, 6].find((e) => months / e <= maxTicks) || 12;
    let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1;
    m = Math.ceil(m / every) * every;
    for (; ; m += every) {
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      const d = new Date(t);
      if (t >= t0) out.push({ t, label: d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` });
    }
  }
  return out;
}

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

// nearest index with time <= t (binary search); falls back to 0
function bisect(times, t) {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return t - times[lo] < times[hi] - t ? lo : hi;
}

// ---------------------------------------------------------------- main chart
/**
 * series: [{ label, color, freq, points: [[isoDate, value], ...] }]
 * opts:   { kind: "line" | "bar" | "step", decimals, unit, tooltip: HTMLElement, endLabels }
 */
export function renderChart(container, series, opts = {}) {
  const draw = () => drawChart(container, series, opts);
  draw();
  if (container._ro) container._ro.disconnect();
  let w = container.clientWidth;
  container._ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - w) > 2) { w = container.clientWidth; draw(); }
  });
  container._ro.observe(container);
}

function drawChart(container, series, opts) {
  const { kind = "line", decimals = 1, unit = "", tooltip, endLabels = series.length > 1 } = opts;
  container.innerHTML = "";
  const data = series
    .filter((s) => s.points && s.points.length)
    .map((s) => ({ ...s, t: s.points.map((p) => toDate(p[0]).getTime()), v: s.points.map((p) => p[1]) }));
  if (!data.length) {
    container.innerHTML = `<div class="chart-empty">No data in this range</div>`;
    return;
  }
  const W = container.clientWidth || 600, H = container.clientHeight || 260;
  const m = { top: 12, right: endLabels ? 56 : 12, bottom: 26, left: 44 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;

  const allT = data.flatMap((d) => [d.t[0], d.t[d.t.length - 1]]);
  let t0 = Math.min(...allT), t1 = Math.max(...allT);
  if (kind === "bar") { // pad half a period so first/last bars are not clipped
    const d0 = data[0];
    const gap = d0.t.length > 1 ? (d0.t[d0.t.length - 1] - d0.t[0]) / (d0.t.length - 1) : 864e5 * 30;
    t0 -= gap / 2; t1 += gap / 2;
  }
  const allV = data.flatMap((d) => d.v);
  let vmin = Math.min(...allV), vmax = Math.max(...allV);
  if (kind === "bar") { vmin = Math.min(0, vmin); vmax = Math.max(0, vmax); }
  const pad = (vmax - vmin) * 0.06 || 1;
  const yt = niceTicks(kind === "bar" ? vmin : vmin - pad, kind === "bar" ? vmax : vmax + pad, Math.max(3, Math.round(ph / 55)));

  const sx = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * pw;
  const sy = (v) => m.top + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * ph;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": series.map((s) => s.label).join(" vs ") + (unit ? ` (${unit})` : "") });
  container.appendChild(svg);

  // grid + y labels
  const yDec = yt.step < 0.1 ? 2 : yt.step < 1 ? 1 : 0;
  for (const v of yt.ticks) {
    const y = sy(v);
    el("line", { x1: m.left, x2: m.left + pw, y1: y, y2: y, class: Math.abs(v) < 1e-9 ? "zero" : "gridline" }, svg);
    const txt = el("text", { x: m.left - 8, y: y + 4, "text-anchor": "end", class: "tick" }, svg);
    txt.textContent = fmtNum(v, yDec);
  }
  // x labels
  for (const tk of timeTicks(t0, t1, Math.max(2, Math.floor(pw / 70)))) {
    const txt = el("text", { x: sx(tk.t), y: H - 6, "text-anchor": "middle", class: "tick" }, svg);
    txt.textContent = tk.label;
  }

  // marks
  const clipId = "c" + Math.random().toString(36).slice(2);
  const defs = el("defs", {}, svg);
  const cp = el("clipPath", { id: clipId }, defs);
  el("rect", { x: m.left, y: m.top - 2, width: pw, height: ph + 4 }, cp);
  const g = el("g", { "clip-path": `url(#${clipId})` }, svg);

  for (const d of data) {
    if (kind === "bar") {
      const n = d.t.length;
      const slot = pw / Math.max(n, 1);
      const bw = Math.max(1, Math.min(18, slot - Math.min(2, slot * 0.25)));
      const y0 = sy(0);
      for (let i = 0; i < n; i++) {
        const x = sx(d.t[i]) - bw / 2, y = sy(d.v[i]);
        const r = Math.min(bw / 2, 3, Math.abs(y - y0) / 2);
        // rounded data-end, square at baseline
        const top = Math.min(y, y0), h = Math.abs(y - y0);
        const up = d.v[i] >= 0;
        const p = up
          ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
          : `M${x},${y0}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + bw - r}Q${x + bw},${top + h} ${x + bw},${top + h - r}V${y0}Z`;
        el("path", { d: p, fill: d.color, class: "bar" }, g);
      }
    } else {
      let p = "";
      for (let i = 0; i < d.t.length; i++) {
        const x = sx(d.t[i]).toFixed(1), y = sy(d.v[i]).toFixed(1);
        if (!i) p += `M${x},${y}`;
        else p += kind === "step" ? `H${x}V${y}` : `L${x},${y}`;
      }
      if (kind === "step") p += `H${(m.left + pw).toFixed(1)}`;
      el("path", { d: p, class: "series", stroke: d.color }, g);
    }
  }

  // direct end labels (multi-series), nudged apart
  if (endLabels) {
    const labs = data.map((d) => ({ d, y: sy(d.v[d.v.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 14) labs[i].y = labs[i - 1].y + 14;
    for (const l of labs) {
      const txt = el("text", { x: m.left + pw + 6, y: l.y + 4, class: "end-label" }, svg);
      txt.textContent = l.d.short || l.d.label;
    }
  }

  // hover layer
  if (!tooltip) return;
  const hover = el("g", { style: "display:none" }, svg);
  const cross = el("line", { y1: m.top, y2: m.top + ph, class: "crosshair" }, hover);
  const dots = data.map((d) => el("circle", { r: 4.5, fill: d.color, class: "hover-dot" }, hover));
  const hit = el("rect", { x: m.left, y: 0, width: pw, height: H, fill: "transparent", style: "cursor:crosshair" }, svg);
  const ref = data.reduce((a, b) => (b.t.length > a.t.length ? b : a));

  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - m.left) / pw) * (t1 - t0);
    const iRef = bisect(ref.t, t);
    const tSnap = ref.t[iRef];
    hover.style.display = "";
    cross.setAttribute("x1", sx(tSnap)); cross.setAttribute("x2", sx(tSnap));
    let rows = "";
    data.forEach((d, k) => {
      const i = bisect(d.t, tSnap);
      const far = Math.abs(d.t[i] - tSnap) > 120 * 864e5; // don't show stale values
      dots[k].style.display = far ? "none" : "";
      dots[k].setAttribute("cx", sx(d.t[i])); dots[k].setAttribute("cy", sy(d.v[i]));
      const lbl = data.length > 1 ? `${d.label}${d.freq !== ref.freq ? ` <span style="opacity:.7">(${fmtDate(new Date(d.t[i]), d.freq)})</span>` : ""}` : "Value";
      rows += `<div class="tt-row"><span class="tt-key"><span class="swatch" style="background:${d.color}"></span>${lbl}</span><span class="tt-val">${far ? "–" : fmtNum(d.v[i], decimals)}${unit && !far ? ` <span style="font-weight:400;color:var(--text-muted)">${unit}</span>` : ""}</span></div>`;
    });
    tooltip.innerHTML = `<div class="tt-date">${fmtDate(new Date(tSnap), ref.freq)}</div>${rows}`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = ev.clientX + 14, top = ev.clientY - th - 10;
    if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
    if (top < 8) top = ev.clientY + 16;
    tooltip.style.left = left + "px"; tooltip.style.top = top + "px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => { hover.style.display = "none"; tooltip.hidden = true; });
}
