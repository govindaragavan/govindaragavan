#!/usr/bin/env node
/**
 * Custom contribution grid generator.
 *
 * Reads your REAL contribution calendar from the GitHub GraphQL API and renders
 * a GitHub-style SVG grid. A text/ASCII template decides WHICH cells are
 * highlighted; the real contribution count of each cell decides its colour.
 * Nothing here writes to, or fakes, your actual GitHub contributions.
 *
 * Usage:
 *   GH_TOKEN=... GITHUB_USERNAME=you node scripts/generate.mjs
 *   node scripts/generate.mjs --demo --ascii          # local preview, fake data, never commit
 *   node scripts/generate.mjs --template templates/heart.txt
 *   node scripts/generate.mjs --text "HELLO"
 *   node scripts/generate.mjs --config other.config.json --out dist
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Defaults & themes                                                   */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  username: "", // falls back to $GITHUB_USERNAME, then $GITHUB_REPOSITORY_OWNER
  template: "templates/heart.txt",
  text: "", // if set, overrides `template` (uses the built-in 5x7 font)
  layout: {
    fit: "tile", // tile | center | left | right | stretch
    valign: "center", // top | center | bottom   (template shorter/taller than 7 rows)
    rows: "pad", // pad (pad/crop to 7 rows) | scale (resample to 7 rows)
    gap: 3, // blank columns between repeated tiles (fit = tile)
    offset: 0, // shift the pattern by N columns
    anchor: "grid", // grid: pattern fixed on screen | date: pattern scrolls with the calendar (tile only)
    anchorDate: "2024-01-07", // used when anchor = date; week containing this date = template column 0
    invert: false, // swap "in pattern" and "outside pattern"
  },
  thresholds: [1, 3, 6, 10], // minimum contributions for level 1, 2, 3, 4
  outside: "ghost", // how cells OUTSIDE the pattern look: hidden | ghost | dim
  outsideOpacity: 0.28,
  showPatternHint: true, // outline pattern cells that have 0 contributions so the shape stays readable
  weeks: 53, // trailing columns to show (max 53 with one API call)
  theme: "github", // github | ocean | sunset | purple
  colors: {}, // per-variant overrides, e.g. { "light": { "levels": ["#..","#..","#..","#.."] } }
  variants: ["light", "dark"],
  appearance: {
    cellSize: 11,
    cellGap: 3,
    radius: 2,
    padding: 12,
    showMonths: true,
    showDays: true,
    showLegend: true,
    showTotal: true,
    tooltips: false, // <title> per cell (GitHub shows no tooltips for <img> SVGs, adds file size)
    transparentBackground: true,
  },
  output: { dir: "dist", basename: "grid" },
};

// levels = colours for level 1..4 ; empty = level 0 ; hint = outline for 0-count pattern cells
const THEMES = {
  github: {
    light: { background: "#ffffff", text: "#57606a", empty: "#ebedf0", hint: "#40c463", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"] },
    dark: { background: "#0d1117", text: "#8b949e", empty: "#161b22", hint: "#26a641", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"] },
  },
  ocean: {
    light: { background: "#ffffff", text: "#57606a", empty: "#ebedf0", hint: "#60a5fa", levels: ["#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"] },
    dark: { background: "#0d1117", text: "#8b949e", empty: "#161b22", hint: "#3b82f6", levels: ["#1e3a5f", "#1d4ed8", "#3b82f6", "#93c5fd"] },
  },
  sunset: {
    light: { background: "#ffffff", text: "#57606a", empty: "#ebedf0", hint: "#fb923c", levels: ["#fde68a", "#fb923c", "#ef4444", "#9f1239"] },
    dark: { background: "#0d1117", text: "#8b949e", empty: "#161b22", hint: "#f97316", levels: ["#5b2a1b", "#c2410c", "#f97316", "#fde047"] },
  },
  purple: {
    light: { background: "#ffffff", text: "#57606a", empty: "#ebedf0", hint: "#c084fc", levels: ["#e9d5ff", "#c084fc", "#9333ea", "#581c87"] },
    dark: { background: "#0d1117", text: "#8b949e", empty: "#161b22", hint: "#a855f7", levels: ["#3b0764", "#7e22ce", "#a855f7", "#e9d5ff"] },
  },
};

/* ------------------------------------------------------------------ */
/* Built-in 5x7 font for `text` templates (rows separated by "/")       */
/* ------------------------------------------------------------------ */

const FONT = {
  " ": "00/00/00/00/00/00/00",
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01110/10001/10000/10000/10000/10001/01110",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01110/10001/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "01110/00100/00100/00100/00100/00100/01110",
  J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/11011/10001",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  0: "01110/10001/10011/10101/11001/10001/01110",
  1: "00100/01100/00100/00100/00100/00100/01110",
  2: "01110/10001/00001/00010/00100/01000/11111",
  3: "11110/00001/00001/01110/00001/00001/11110",
  4: "00010/00110/01010/10010/11111/00010/00010",
  5: "11111/10000/11110/00001/00001/10001/01110",
  6: "00110/01000/10000/11110/10001/10001/01110",
  7: "11111/00001/00010/00100/01000/01000/01000",
  8: "01110/10001/10001/01110/10001/10001/01110",
  9: "01110/10001/10001/01111/00001/00010/01100",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  ".": "0/0/0/0/0/0/1",
  "!": "1/1/1/1/1/0/1",
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const mod = (n, m) => ((n % m) + m) % m;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--demo" || k === "--ascii") a[k.slice(2)] = true;
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
// Sundays are day 3 (mod 7) counted from the Unix epoch, so this gives consecutive integers per calendar week.
const weekNumber = (dateStr) => {
  const ms = parseDate(dateStr);
  const days = Math.round(ms / DAY_MS) - new Date(ms).getUTCDay();
  return (days - 3) / 7;
};

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

async function loadConfig(args) {
  const file = path.resolve(ROOT, args.config ?? "grid.config.json");
  let user = {};
  try {
    user = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
  }
  const cfg = merge(DEFAULTS, user);
  if (args.template) cfg.template = args.template;
  if (args.text) cfg.text = args.text;
  if (args.out) cfg.output.dir = args.out;

  const t = cfg.thresholds;
  if (!Array.isArray(t) || t.length !== 4 || t.some((n) => typeof n !== "number" || n < 1) || t.some((n, i) => i && n <= t[i - 1])) {
    throw new Error('"thresholds" must be 4 strictly increasing numbers >= 1, e.g. [1, 3, 6, 10]');
  }
  if (!THEMES[cfg.theme]) throw new Error(`Unknown theme "${cfg.theme}". Options: ${Object.keys(THEMES).join(", ")}`);
  if (!["hidden", "ghost", "dim"].includes(cfg.outside)) throw new Error('"outside" must be hidden, ghost or dim');
  if (!["tile", "center", "left", "right", "stretch"].includes(cfg.layout.fit)) throw new Error('"layout.fit" must be tile, center, left, right or stretch');
  cfg.weeks = Math.max(1, Math.min(53, Math.floor(cfg.weeks)));
  return cfg;
}

const levelFor = (count, t) => (count <= 0 ? 0 : t.filter((min) => count >= min).length);

function palette(cfg, variant) {
  const base = THEMES[cfg.theme]?.[variant];
  if (!base) throw new Error(`Variant "${variant}" is not defined. Use "light" or "dark".`);
  return { ...base, ...(cfg.colors?.[variant] ?? {}) };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const ON_CHARS = new Set(["1", "#", "X", "x", "█", "●", "■", "*"]);

/** Parse an ASCII template into rows[r][c] booleans. Lines starting with // or ; are comments. */
function parseTemplate(text) {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|;)/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) throw new Error("Template is empty.");
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => Array.from({ length: width }, (_, i) => ON_CHARS.has(l[i] ?? " ")));
}

/** Render a string with the built-in 5x7 font into rows[r][c]. */
function textToMatrix(str) {
  const cols = [];
  for (const ch of str.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) {
      console.warn(`! No glyph for "${ch}", skipped. Available: A-Z 0-9 space - . !`);
      continue;
    }
    const rows = glyph.split("/");
    for (let x = 0; x < rows[0].length; x++) cols.push(rows.map((r) => r[x] === "1"));
    cols.push(Array(7).fill(false)); // letter spacing
  }
  cols.pop();
  if (!cols.length) throw new Error("Text template produced no columns.");
  return Array.from({ length: 7 }, (_, r) => cols.map((c) => c[r]));
}

async function loadMatrix(cfg) {
  if (cfg.text) return textToMatrix(cfg.text);
  const file = path.resolve(ROOT, cfg.template);
  return parseTemplate(await readFile(file, "utf8"));
}

/** Make the template exactly 7 rows tall (the calendar always has 7 weekday rows). */
function fitRows(m, layout, forceScale) {
  const H = 7;
  if (m.length === H) return m;
  const w = m[0].length;
  if (forceScale || layout.rows === "scale") {
    return Array.from({ length: H }, (_, y) => m[Math.min(m.length - 1, Math.floor(((y + 0.5) * m.length) / H))]);
  }
  const free = H - m.length; // negative => crop
  const top = layout.valign === "top" ? 0 : layout.valign === "bottom" ? free : Math.floor(free / 2);
  return Array.from({ length: H }, (_, y) => m[y - top] ?? Array(w).fill(false));
}

/**
 * Returns match(col, absWeek, weekday) => boolean : "is this calendar cell part of the pattern?"
 * col = 0-based column in the rendered grid, absWeek = calendar week number (for date anchoring).
 */
function makeMatcher(matrix, layout, cols) {
  const stretch = layout.fit === "stretch";
  const m = fitRows(matrix, layout, stretch);
  const W = m[0].length;
  const originWeek = weekNumber(layout.anchorDate);
  let anchor = layout.anchor;
  if (anchor === "date" && layout.fit !== "tile") {
    console.warn('! layout.anchor "date" only works with fit "tile"; using "grid".');
    anchor = "grid";
  }

  const patternCol = (col, abs) => {
    const x = anchor === "date" ? abs - originWeek : col;
    switch (layout.fit) {
      case "tile": {
        const i = mod(x + layout.offset, W + layout.gap);
        return i < W ? i : -1;
      }
      case "stretch":
        return Math.min(W - 1, Math.floor(((col + 0.5) * W) / cols));
      default: {
        const start = layout.fit === "left" ? 0 : layout.fit === "right" ? cols - W : Math.floor((cols - W) / 2);
        const i = x - (start + layout.offset);
        return i >= 0 && i < W ? i : -1;
      }
    }
  };

  return (col, abs, weekday) => {
    const i = patternCol(col, abs);
    const on = i >= 0 && m[weekday][i];
    return layout.invert ? !on : on;
  };
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
  }
}`;

function normalizeWeeks(rawWeeks) {
  return rawWeeks
    .filter((w) => w.contributionDays.length)
    .map((w) => ({
      abs: weekNumber(w.contributionDays[0].date),
      days: w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount, weekday: d.weekday })),
    }));
}

async function fetchCalendar(login, token) {
  const to = new Date();
  const from = new Date(to.getTime() - 364 * DAY_MS); // API max range is 1 year
  from.setUTCHours(0, 0, 0, 0);
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "custom-contribution-grid" },
    body: JSON.stringify({ query: QUERY, variables: { login, from: from.toISOString(), to: to.toISOString() } }),
  });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    const hint = res.status === 401 ? " (token rejected: check the GH_PAT secret, or remove it to use the built-in token)" : "";
    throw new Error(`GitHub API responded ${res.status}${hint}: ${body}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`No contribution data found for user "${login}".`);
  return normalizeWeeks(cal.weeks);
}

/** Random data for LOCAL DESIGN PREVIEWS ONLY. Written to preview/, which is git-ignored. */
function demoCalendar() {
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const today = Date.UTC(...new Date().toISOString().slice(0, 10).split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  const lastSunday = today - new Date(today).getUTCDay() * DAY_MS;
  const start = lastSunday - 52 * 7 * DAY_MS;
  const weeks = [];
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const t = start + (w * 7 + d) * DAY_MS;
      if (t > today) break;
      const weekend = d === 0 || d === 6;
      const r = rnd();
      const count = r < (weekend ? 0.6 : 0.3) ? 0 : Math.floor(rnd() ** 2 * 14) + 1;
      days.push({ date: new Date(t).toISOString().slice(0, 10), count, weekday: d });
    }
    weeks.push({ abs: weekNumber(days[0].date), days });
  }
  return weeks;
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabels(weeks) {
  const labels = [];
  let last = -1;
  weeks.forEach((w, i) => {
    const month = Number(w.days[0].date.slice(5, 7)) - 1;
    if (month !== last) labels.push({ col: i, text: MONTHS[month] });
    last = month;
  });
  // drop a label that would collide with the next one (need ~3 columns of room)
  return labels.filter((l, i) => !labels[i + 1] || labels[i + 1].col - l.col >= 3);
}

function renderSvg({ weeks, match, cfg, pal, variant, demo }) {
  const a = cfg.appearance;
  const pitch = a.cellSize + a.cellGap;
  const leftGutter = a.showDays ? 30 : 0;
  const monthH = a.showMonths ? 18 : 0;
  const titleH = a.showTotal ? 22 : 0;
  const legendH = a.showLegend ? 26 : 0;
  const gridW = weeks.length * pitch - a.cellGap;
  const gridH = 7 * pitch - a.cellGap;
  const width = a.padding * 2 + leftGutter + gridW;
  const height = a.padding * 2 + titleH + monthH + gridH + legendH;
  const gx = a.padding + leftGutter;
  const gy = a.padding + titleH + monthH;

  const total = weeks.reduce((s, w) => s + w.days.reduce((n, d) => n + d.count, 0), 0);
  const style = [
    `text{font-family:${FONT_STACK};font-size:10px;fill:${pal.text}}`,
    `.t{font-size:12px}`,
    `.l0{fill:${pal.empty}}`,
    ...pal.levels.map((c, i) => `.l${i + 1}{fill:${c}}`),
    `.o{opacity:${cfg.outsideOpacity}}`,
    `.h{stroke:${pal.hint};stroke-width:1}`,
  ].join("");

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Custom contribution grid (${variant})">`);
  if (demo) out.push(`<!-- DEMO DATA: random values for design preview only. Do not publish. -->`);
  out.push(`<style>${style}</style>`);
  if (!a.transparentBackground) out.push(`<rect width="${width}" height="${height}" rx="6" fill="${pal.background}"/>`);

  if (a.showTotal) out.push(`<text class="t" x="${a.padding}" y="${a.padding + 12}">${esc(total.toLocaleString("en-US"))} contributions in the last year</text>`);

  if (a.showMonths) {
    for (const l of monthLabels(weeks)) out.push(`<text x="${gx + l.col * pitch}" y="${gy - 6}">${l.text}</text>`);
  }
  if (a.showDays) {
    for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]]) {
      out.push(`<text x="${a.padding}" y="${gy + row * pitch + a.cellSize - 1}">${name}</text>`);
    }
  }

  let inPattern = 0;
  let active = 0;
  weeks.forEach((w, col) => {
    for (const d of w.days) {
      const lvl = levelFor(d.count, cfg.thresholds);
      const on = match(col, w.abs, d.weekday);
      let cls;
      let x = gx + col * pitch;
      let y = gy + d.weekday * pitch;
      let size = a.cellSize;
      if (on) {
        inPattern++;
        if (lvl) active++;
        cls = `l${lvl}`;
        if (!lvl && cfg.showPatternHint) {
          cls += " h";
          x += 0.5; y += 0.5; size -= 1; // keep the outline inside the cell
        }
      } else if (cfg.outside === "hidden") {
        continue;
      } else if (cfg.outside === "ghost") {
        cls = "l0 o";
      } else {
        cls = `l${lvl} o`;
      }
      const attrs = `class="${cls}" x="${x}" y="${y}" width="${size}" height="${size}" rx="${a.radius}"`;
      out.push(a.tooltips ? `<rect ${attrs}><title>${d.count} contribution${d.count === 1 ? "" : "s"} on ${d.date}</title></rect>` : `<rect ${attrs}/>`);
    }
  });

  if (a.showLegend) {
    const ly = height - a.padding - a.cellSize;
    const moreX = width - a.padding;
    const sqX = moreX - 34 - 5 * pitch + a.cellGap;
    out.push(`<text x="${sqX - 6}" y="${ly + a.cellSize - 1}" text-anchor="end">Less</text>`);
    for (let i = 0; i < 5; i++) out.push(`<rect class="l${i}" x="${sqX + i * pitch}" y="${ly}" width="${a.cellSize}" height="${a.cellSize}" rx="${a.radius}"/>`);
    out.push(`<text x="${moreX}" y="${ly + a.cellSize - 1}" text-anchor="end">More</text>`);
  }
  out.push(`</svg>`);
  return { svg: out.join("\n") + "\n", inPattern, active };
}

/** ASCII preview of the mapping: digit = level inside pattern, "o" = pattern cell with 0 activity, "." = outside. */
function asciiPreview(weeks, match, cfg) {
  const rows = Array.from({ length: 7 }, () => Array(weeks.length).fill(" "));
  weeks.forEach((w, col) => {
    for (const d of w.days) {
      const lvl = levelFor(d.count, cfg.thresholds);
      rows[d.weekday][col] = match(col, w.abs, d.weekday) ? (lvl ? String(lvl) : "o") : "·";
    }
  });
  return rows.map((r) => r.join("")).join("\n");
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv);
  const cfg = await loadConfig(args);

  let weeks;
  if (args.demo) {
    console.warn("⚠  DEMO MODE: using random data. Output goes to ./preview and must never be published.");
    cfg.output.dir = args.out ?? "preview";
    weeks = demoCalendar();
  } else {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const login = cfg.username || process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER;
    if (!token) throw new Error("Set GH_TOKEN (or GITHUB_TOKEN). See SETUP.md.");
    if (!login) throw new Error('Set "username" in grid.config.json or the GITHUB_USERNAME env var.');
    weeks = await fetchCalendar(login, token);
  }
  weeks = weeks.slice(-cfg.weeks);

  const matrix = await loadMatrix(cfg);
  const match = makeMatcher(matrix, cfg.layout, weeks.length);
  if (args.ascii) console.log(asciiPreview(weeks, match, cfg) + "\n");

  const outDir = path.resolve(ROOT, cfg.output.dir);
  await mkdir(outDir, { recursive: true });
  for (const variant of cfg.variants) {
    const { svg, inPattern, active } = renderSvg({ weeks, match, cfg, pal: palette(cfg, variant), variant, demo: !!args.demo });
    const file = path.join(outDir, `${cfg.output.basename}-${variant}.svg`);
    await writeFile(file, svg);
    console.log(`✔ ${path.relative(ROOT, file)}  (${inPattern} pattern cells, ${active} lit by real activity)`);
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
