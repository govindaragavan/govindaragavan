#!/usr/bin/env node
/**
 * Streak card generator (zero dependencies, Node 18+).
 *
 *   1. Fetches your REAL contribution calendar from the GitHub GraphQL API
 *      (one request per year, since the API caps a query at one year).
 *   2. Computes total contributions, current streak and longest streak.
 *   3. Injects the numbers and a lit-up grid of the last 53 weeks into
 *      templates/profile-streak.template.svg and writes profile-streak.svg.
 *
 * It only reads data. Your GitHub contributions are never modified.
 *
 * Usage:
 *   GH_TOKEN=... GITHUB_USERNAME=you node scripts/generate-streak.mjs
 *   node scripts/generate-streak.mjs --demo        # random data -> preview/ (design testing only)
 *   node scripts/generate-streak.mjs --out some/other.svg
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;

/* ------------------------- configuration ------------------------- */
const CONFIG = {
  template: "templates/profile-streak.template.svg",
  output: "profile-streak.svg",
  // Must match the grid origin/size in the template (53 * 14 - 3 = 739px wide).
  grid: { weeks: 53, cell: 11, gap: 3 },
  // Minimum contributions for level 1..4 of NON-streak active days.
  thresholds: [1, 3, 6, 10],
  // Streak squares are coloured along this gradient, oldest -> newest.
  neon: { from: "#00f0ff", to: "#ff2bd6" },
};

/* ---------------------------- helpers ---------------------------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ts = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const fmt = (s, withYear = true) => {
  const d = new Date(ts(s));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ""}`;
};
const fmtRange = (a, b, empty) => {
  if (!a) return empty;
  if (a === b) return fmt(a);
  return a.slice(0, 4) === b.slice(0, 4) ? `${fmt(a, false)} – ${fmt(b)}` : `${fmt(a)} – ${fmt(b)}`;
};
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [ra, rb] = [hexToRgb(a), hexToRgb(b)];
  return "#" + ra.map((v, i) => Math.round(v + (rb[i] - v) * t).toString(16).padStart(2, "0")).join("");
};
const unit = (n) => (n === 1 ? "day" : "days");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--demo") a.demo = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

/* ----------------------------- data ------------------------------ */
async function gql(query, variables, token) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-streak-card" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    const hint = res.status === 401 ? " (token rejected: check the GH_PAT secret, or remove it to use the built-in token)" : "";
    throw new Error(`GitHub API responded ${res.status}${hint}: ${body}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data;
}

const YEARS_QUERY = `query($login: String!) {
  user(login: $login) { contributionsCollection { contributionYears } }
}`;
const YEAR_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

/** Returns { days: Map<YYYY-MM-DD, count>, firstYear } covering every year with activity. */
async function fetchAllDays(login, token) {
  const meta = await gql(YEARS_QUERY, { login }, token);
  const years = meta.user?.contributionsCollection?.contributionYears;
  if (!years) throw new Error(`No data found for user "${login}".`);
  years.sort((a, b) => a - b);

  const now = new Date();
  const days = new Map();
  for (const y of years) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = y >= now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    const data = await gql(YEAR_QUERY, { login, from, to }, token);
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of w.contributionDays) days.set(d.date, Math.max(days.get(d.date) ?? 0, d.contributionCount));
    }
  }
  return { days, firstYear: years[0] ?? now.getUTCFullYear() };
}

/** Random data for LOCAL DESIGN PREVIEWS ONLY (written to preview/, git-ignored). */
function demoDays() {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const today = ts(iso(Date.now()));
  const days = new Map();
  for (let i = 0; i < 3 * 365; i++) {
    const t = today - i * DAY;
    const weekend = [0, 6].includes(new Date(t).getUTCDay());
    const r = rnd();
    let count = r < (weekend ? 0.55 : 0.25) ? 0 : Math.floor(rnd() ** 2 * 14) + 1;
    if (i < 23) count = Math.max(count, 1); // a live 23-day streak
    if (i === 23) count = 0;
    if (i >= 140 && i < 181) count = Math.max(count, 2); // an older, longer streak
    days.set(iso(t), count);
  }
  return { days, firstYear: new Date(today).getUTCFullYear() - 3 };
}

/* ---------------------------- stats ------------------------------ */
/** Turns the day map into a gap-free, chronological list, ending at the newest day GitHub returned. */
function toSeries(map) {
  const limit = iso(Date.now() + DAY); // ignore anything past "tomorrow" (timezone slack)
  const dates = [...map.keys()].filter((d) => d <= limit).sort();
  if (!dates.length) throw new Error("GitHub returned no contribution days.");
  const series = [];
  for (let t = ts(dates[0]); t <= ts(dates.at(-1)); t += DAY) {
    const date = iso(t);
    series.push({ date, count: map.get(date) ?? 0 });
  }
  return series;
}

function computeStats(series) {
  const runs = [];
  let run = 0;
  let best = 0;
  let bestEnd = -1;
  let total = 0;
  series.forEach((d, i) => {
    total += d.count;
    run = d.count > 0 ? run + 1 : 0;
    runs.push(run);
    if (run >= best && run > 0) [best, bestEnd] = [run, i]; // ties go to the most recent run
  });

  // If today has no contribution yet the streak is still alive, so count up to yesterday.
  let cur = series.length - 1;
  if (cur > 0 && series[cur].count === 0) cur--;
  const curLen = runs[cur] ?? 0;

  const span = (len, end) => ({ length: len, start: len ? series[end - len + 1].date : null, end: len ? series[end].date : null });
  return { total, current: span(curLen, cur), longest: span(best, bestEnd), lastDate: series.at(-1).date };
}

/* ----------------------------- grid ------------------------------ */
function buildGrid(series, stats) {
  const { weeks, cell, gap } = CONFIG.grid;
  const pitch = cell + gap;
  const counts = new Map(series.map((d) => [d.date, d.count]));
  const lastTs = ts(stats.lastDate);
  const startTs = lastTs - new Date(lastTs).getUTCDay() * DAY - (weeks - 1) * 7 * DAY; // Sunday, 52 weeks back

  const streakDates = new Set();
  if (stats.current.length) for (let t = ts(stats.current.start); t <= ts(stats.current.end); t += DAY) streakDates.add(iso(t));

  const cells = [];
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const t = startTs + (col * 7 + row) * DAY;
      if (t > lastTs) continue;
      const date = iso(t);
      cells.push({ col, row, date, count: counts.get(date) ?? 0, hot: streakDates.has(date) });
    }
  }

  const hot = cells.filter((c) => c.hot);
  hot.forEach((c, i) => (c.color = mix(CONFIG.neon.from, CONFIG.neon.to, hot.length > 1 ? i / (hot.length - 1) : 1)));

  const level = (n) => (n <= 0 ? 0 : CONFIG.thresholds.filter((min) => n >= min).length);
  const rect = (c, attrs) => `    <rect x="${c.col * pitch}" y="${c.row * pitch}" width="${cell}" height="${cell}" rx="2.5" ${attrs}/>`;

  const base = cells.filter((c) => !c.hot).map((c) => rect(c, `class="${level(c.count) ? `a${level(c.count)}` : "e"}"`));
  const lit = hot.map((c) => {
    const delay = ((c.col * 0.11) % 3.2).toFixed(2);
    const today = c.date === stats.lastDate ? ' stroke="#ffffff" stroke-opacity=".9"' : "";
    return rect(c, `class="s" fill="${c.color}" style="animation-delay:-${delay}s"${today}`);
  });

  // month labels, dropping any that would collide with the next one
  const labels = [];
  let lastMonth = -1;
  for (let col = 0; col < weeks; col++) {
    const m = new Date(startTs + col * 7 * DAY).getUTCMonth();
    if (m !== lastMonth) labels.push({ col, text: MONTHS[m] });
    lastMonth = m;
  }
  const months = labels
    .filter((l, i) => !labels[i + 1] || labels[i + 1].col - l.col >= 3)
    .map((l) => `    <text class="mon" x="${l.col * pitch}" y="-8">${l.text}</text>`);

  return [...months, ...base, `    <g filter="url(#glow)">`, ...lit, `    </g>`].join("\n");
}

/* --------------------------- templating -------------------------- */
function fillTemplate(template, vars) {
  const RAW = new Set(["GRID"]); // markup, not escaped
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in vars)) throw new Error(`Template placeholder ${m} has no value in the script.`);
    return RAW.has(key) ? vars[key] : esc(vars[key]);
  });
}

/* ------------------------------ main ----------------------------- */
async function main() {
  const args = parseArgs(process.argv);
  let login = args.user || process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
  let data;
  let outFile = args.out ?? CONFIG.output;

  if (args.demo) {
    console.warn("⚠  DEMO MODE: random data. Output goes to ./preview and must never be published.");
    data = demoDays();
    login = login || "demo-user";
    outFile = args.out ?? "preview/profile-streak.svg";
  } else {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Set GH_TOKEN (or GITHUB_TOKEN). See STREAK-SETUP.md.");
    if (!login) throw new Error("Set GITHUB_USERNAME (or pass --user).");
    data = await fetchAllDays(login, token);
  }

  const series = toSeries(data.days);
  const stats = computeStats(series);

  const svg = fillTemplate(await readFile(path.resolve(ROOT, CONFIG.template), "utf8"), {
    USERNAME: login,
    AS_OF: fmt(stats.lastDate),
    TOTAL: stats.total.toLocaleString("en-US"),
    TOTAL_SUB: `${data.firstYear} – Present`,
    CURRENT_STREAK: stats.current.length,
    CURRENT_UNIT: unit(stats.current.length),
    CURRENT_SUB: fmtRange(stats.current.start, stats.current.end, "No active streak"),
    LONGEST_STREAK: stats.longest.length,
    LONGEST_UNIT: unit(stats.longest.length),
    LONGEST_SUB: fmtRange(stats.longest.start, stats.longest.end, "No contributions yet"),
    NEON_FROM: CONFIG.neon.from,
    NEON_TO: CONFIG.neon.to,
    ARIA: `${login}: ${stats.current.length}-day current streak, ${stats.longest.length}-day longest streak, ${stats.total.toLocaleString("en-US")} total contributions`,
    GRID: buildGrid(series, stats),
  });

  const target = path.resolve(ROOT, outFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, svg);
  console.log(`✔ ${path.relative(ROOT, target)}`);
  console.log(`  total ${stats.total} | current ${stats.current.length} (${stats.current.start ?? "-"} → ${stats.current.end ?? "-"}) | longest ${stats.longest.length} (${stats.longest.start ?? "-"} → ${stats.longest.end ?? "-"})`);
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
