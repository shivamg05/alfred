/**
 * Visualize Alfred's memory graph.
 *
 * Static:
 *   pnpm memory:viz
 *   pnpm memory:viz -- --open
 *
 * Live:
 *   pnpm memory:viz -- --serve
 *   pnpm memory:viz -- --serve --open
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { writeFileSync } from "fs";
import { createServer } from "http";
import { spawn } from "child_process";
import Database from "better-sqlite3";
import { config } from "../src/config.js";

interface FactRow {
  id: number;
  text: string;
  abstraction_level: number;
  descendant_count: number;
  is_static: number;
  is_latest: number;
  is_forgotten: number;
  document_date: string;
  event_date: string | null;
  forget_after: string | null;
  created_at: string;
}

interface EdgeRow {
  fact_id_a: number;
  fact_id_b: number;
  relation_type: string;
  created_at: string;
}

interface GraphData {
  generatedAt: string;
  facts: FactRow[];
  edges: EdgeRow[];
  activeFactIds: number[];
  stats: {
    totalFacts: number;
    latestFacts: number;
    countsByLevel: number[];
    edgeCounts: Record<string, number>;
    topDescendants: FactRow[];
    expiredLevel0Count: number;
    nextConsolidationISO: string;
    nextConsolidationIn: string;
    nextPromotionISO: string;
    nextPromotionIn: string;
  };
}

const args = process.argv.slice(2);
const shouldOpen = args.includes("--open");
const shouldServe = args.includes("--serve");
const outIdx = args.indexOf("--out");
const portIdx = args.indexOf("--port");
const outputPath = outIdx >= 0 && args[outIdx + 1]
  ? resolve(args[outIdx + 1])
  : "/tmp/alfred-memory-graph.html";
const port = portIdx >= 0 && args[portIdx + 1]
  ? Number(args[portIdx + 1])
  : Number(process.env.PORT ?? 3838);

function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function nextEverySixHoursAtMinute(now: Date, minute: number): Date {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  const nextHour = Math.ceil((next.getHours() + (next <= now ? 1 : 0)) / 6) * 6;
  if (nextHour >= 24) {
    next.setDate(next.getDate() + 1);
    next.setHours(0);
  } else {
    next.setHours(nextHour);
  }
  if (next <= now) next.setHours(next.getHours() + 6);
  return next;
}

function nextSunday0330(now: Date): Date {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(3, 30, 0, 0);
  const daysUntilSunday = (7 - next.getDay()) % 7;
  next.setDate(next.getDate() + daysUntilSunday);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

function readGraphData(): GraphData {
  const cfg = config();
  const sqlite = new Database(cfg.DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const factColumns = new Set(
      (sqlite.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const levelExpr = factColumns.has("abstraction_level") ? "COALESCE(abstraction_level, 1)" : "1";
    const descendantsExpr = factColumns.has("descendant_count") ? "COALESCE(descendant_count, 0)" : "0";

    const facts = sqlite
      .prepare(
        `SELECT id, text,
                ${levelExpr} AS abstraction_level,
                ${descendantsExpr} AS descendant_count,
                is_static, is_latest, is_forgotten,
                document_date, event_date, forget_after, created_at
         FROM memory_facts
         WHERE user_id = ? AND is_forgotten = 0
         ORDER BY id ASC`,
      )
      .all(cfg.USER_ID) as FactRow[];

    const edges = facts.length === 0
      ? []
      : sqlite
          .prepare(
            `SELECT fact_id_a, fact_id_b, relation_type, created_at
             FROM fact_relations
             WHERE fact_id_a IN (${facts.map(() => "?").join(",")})
                OR fact_id_b IN (${facts.map(() => "?").join(",")})
             ORDER BY created_at ASC`,
          )
          .all(...facts.map((f) => f.id), ...facts.map((f) => f.id)) as EdgeRow[];

    const now = new Date();
    const activeFactIds = facts.filter((f) => f.is_latest === 1).map((f) => f.id);
    const countsByLevel = [0, 0, 0];
    for (const f of facts) {
      if (f.is_latest === 1 && f.abstraction_level >= 0 && f.abstraction_level <= 2) {
        countsByLevel[f.abstraction_level]++;
      }
    }
    const edgeCounts = edges.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.relation_type] = (acc[edge.relation_type] ?? 0) + 1;
      return acc;
    }, {});
    const topDescendants = facts
      .filter((f) => f.is_latest === 1)
      .sort((a, b) => b.descendant_count - a.descendant_count)
      .slice(0, 3);
    const expiredLevel0Count = facts.filter((f) =>
      f.is_latest === 1 &&
      f.abstraction_level === 0 &&
      f.forget_after &&
      new Date(f.forget_after) < now
    ).length;
    const nextConsolidation = nextEverySixHoursAtMinute(now, 17);
    const nextPromotion = nextSunday0330(now);

    return {
      generatedAt: now.toISOString(),
      facts,
      edges,
      activeFactIds,
      stats: {
        totalFacts: facts.length,
        latestFacts: activeFactIds.length,
        countsByLevel,
        edgeCounts,
        topDescendants,
        expiredLevel0Count,
        nextConsolidationISO: nextConsolidation.toISOString(),
        nextConsolidationIn: humanDuration(nextConsolidation.getTime() - now.getTime()),
        nextPromotionISO: nextPromotion.toISOString(),
        nextPromotionIn: humanDuration(nextPromotion.getTime() - now.getTime()),
      },
    };
  } finally {
    sqlite.close();
  }
}

function makeHtml(initialData: GraphData | null, live: boolean): string {
  const initial = JSON.stringify(initialData);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred Memory Graph</title>
  <style>
    :root {
      --bg: #f7f8fa; --panel: #fff; --text: #151922; --muted: #667085; --border: #d9dee8;
      --l0: #3b82f6; --l1: #16a34a; --l2: #dc2626;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); overflow: hidden; }
    .app { display: grid; grid-template-columns: 350px 1fr; height: 100vh; }
    aside { background: var(--panel); border-right: 1px solid var(--border); padding: 18px; overflow: auto; }
    main { position: relative; min-width: 0; }
    canvas { width: 100%; height: 100%; display: block; }
    h1 { margin: 0 0 4px; font-size: 18px; }
    h2 { margin: 18px 0 8px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .sub, .muted { color: var(--muted); font-size: 12px; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
    .stat, .card { border: 1px solid var(--border); border-radius: 8px; background: #fbfcfe; padding: 10px; }
    .value { font-size: 21px; font-weight: 750; line-height: 1.1; }
    .label { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .legend { display: grid; gap: 7px; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .swatch { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; }
    .line { width: 24px; height: 3px; border-radius: 999px; flex: 0 0 auto; }
    .cards { display: grid; gap: 8px; }
    .card { font-size: 12px; line-height: 1.35; }
    .card b { display: block; margin-bottom: 4px; }
    .controls { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; align-items: center; background: rgba(255,255,255,.94); border: 1px solid var(--border); border-radius: 8px; padding: 8px; box-shadow: 0 8px 20px rgba(15, 23, 42, .08); }
    input, select, button { height: 32px; border: 1px solid var(--border); border-radius: 6px; background: white; padding: 0 9px; font: inherit; font-size: 12px; }
    input { width: 240px; }
    button { cursor: pointer; }
    .tooltip { position: absolute; pointer-events: none; max-width: 380px; background: rgba(17,24,39,.96); color: white; border-radius: 8px; padding: 9px 10px; font-size: 12px; line-height: 1.35; display: none; z-index: 10; }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>Alfred Memory Graph</h1>
      <div class="sub"><span id="mode"></span> · updated <span id="updatedAt"></span></div>
      <div class="stat-grid">
        <div class="stat"><div class="value" id="totalFacts">0</div><div class="label">facts</div></div>
        <div class="stat"><div class="value" id="latestFacts">0</div><div class="label">latest</div></div>
        <div class="stat"><div class="value" id="expiredFacts">0</div><div class="label">expired L0</div></div>
        <div class="stat"><div class="value" id="edgeTotal">0</div><div class="label">edges</div></div>
      </div>
      <h2>Consolidation</h2>
      <div class="cards">
        <div class="card"><b>level 0 cleanup</b><span id="nextConsolidation"></span></div>
        <div class="card"><b>level 1 promotion</b><span id="nextPromotion"></span></div>
      </div>
      <h2>Levels</h2>
      <div class="legend">
        <div class="row"><span class="swatch" style="background:var(--l0)"></span><span>Level 0: event/state/plan</span></div>
        <div class="row"><span class="swatch" style="background:var(--l1)"></span><span>Level 1: behavior/pattern</span></div>
        <div class="row"><span class="swatch" style="background:var(--l2)"></span><span>Level 2: identity/value</span></div>
      </div>
      <h2>Edges</h2>
      <div class="legend" id="edgeLegend"></div>
      <h2>Top descendants</h2>
      <div class="cards" id="topFacts"></div>
      <h2>Tips</h2>
      <div class="muted">Drag nodes to pin them. Scroll to zoom. Search filters visible nodes. In live mode, data refreshes every 2 seconds and on page refresh.</div>
    </aside>
    <main>
      <div class="controls">
        <input id="search" placeholder="search facts" />
        <select id="level"><option value="all">all levels</option><option value="0">level 0</option><option value="1">level 1</option><option value="2">level 2</option></select>
        <button id="reset">reset view</button>
        <button id="refresh">refresh data</button>
      </div>
      <canvas id="graph"></canvas>
      <div class="tooltip" id="tooltip"></div>
    </main>
  </div>
  <script>
    const LIVE = ${JSON.stringify(live)};
    let DATA = ${initial};
    const levelColors = ["#3b82f6", "#16a34a", "#dc2626"];
    const edgeColors = { relates_to: "#94a3b8", instance_of: "#7c3aed", updates: "#ef4444", extends: "#f59e0b", derives: "#0891b2", consolidated_from: "#0f766e" };
    const canvas = document.getElementById("graph");
    const ctx = canvas.getContext("2d");
    const tooltip = document.getElementById("tooltip");
    const search = document.getElementById("search");
    const level = document.getElementById("level");
    let nodes = [], edges = [], nodeById = new Map(), activeIds = new Set();
    let scale = 1, ox = 0, oy = 0, dragging = null, panning = false, last = null;

    function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
    function buildGraph(data, keepPositions = true) {
      const old = new Map(nodes.map(n => [n.id, n]));
      activeIds = new Set(data.activeFactIds);
      nodes = data.facts.map((f, i) => {
        const prev = old.get(f.id);
        return { ...f, x: keepPositions && prev ? prev.x : 220 + (i % 13) * 76, y: keepPositions && prev ? prev.y : 120 + Math.floor(i / 13) * 58, vx: 0, vy: 0, pinned: !!prev?.pinned, visible: true };
      });
      nodeById = new Map(nodes.map(n => [n.id, n]));
      edges = data.edges.map(e => ({ ...e, a: nodeById.get(e.fact_id_a), b: nodeById.get(e.fact_id_b) })).filter(e => e.a && e.b);
      applyFilters();
      updateStats();
    }
    function updateStats() {
      mode.textContent = LIVE ? "live" : "static";
      updatedAt.textContent = DATA ? new Date(DATA.generatedAt).toLocaleTimeString() : "never";
      totalFacts.textContent = DATA.stats.totalFacts;
      latestFacts.textContent = DATA.stats.latestFacts;
      expiredFacts.textContent = DATA.stats.expiredLevel0Count;
      edgeTotal.textContent = DATA.edges.length;
      nextConsolidation.textContent = DATA.stats.nextConsolidationIn + " (" + new Date(DATA.stats.nextConsolidationISO).toLocaleString() + ")";
      nextPromotion.textContent = DATA.stats.nextPromotionIn + " (" + new Date(DATA.stats.nextPromotionISO).toLocaleString() + ")";
      edgeLegend.innerHTML = Object.keys(edgeColors).map(k => '<div class="row"><span class="line" style="background:' + edgeColors[k] + '"></span><span>' + k + ': ' + (DATA.stats.edgeCounts[k] || 0) + '</span></div>').join("");
      topFacts.innerHTML = DATA.stats.topDescendants.map(f => '<div class="card"><b>[' + f.id + '] ' + f.descendant_count + ' descendants</b>' + escapeHtml(f.text) + '</div>').join("") || '<div class="muted">none yet</div>';
    }
    async function refreshData() {
      if (!LIVE) return;
      const res = await fetch("/data", { cache: "no-store" });
      DATA = await res.json();
      buildGraph(DATA, true);
    }
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function applyFilters() {
      const q = search.value.toLowerCase().trim();
      const lv = level.value;
      for (const n of nodes) n.visible = (!q || n.text.toLowerCase().includes(q) || String(n.id) === q) && (lv === "all" || String(n.abstraction_level) === lv);
    }
    function nodeRadius(n) { return 8 + Math.min(12, Math.sqrt(Math.max(0, n.descendant_count)) * 3) + n.abstraction_level * 2; }
    function tick() {
      const visible = nodes.filter(n => n.visible);
      for (const e of edges) {
        if (!e.a.visible || !e.b.visible) continue;
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dist = Math.max(1, Math.hypot(dx, dy));
        const target = e.relation_type === "instance_of" ? 150 : 110;
        const force = (dist - target) * .002;
        const fx = dx / dist * force, fy = dy / dist * force;
        if (!e.a.pinned) { e.a.vx += fx; e.a.vy += fy; }
        if (!e.b.pinned) { e.b.vx -= fx; e.b.vy -= fy; }
      }
      for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i], b = visible[j], dx = b.x - a.x, dy = b.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
        const force = Math.min(1.8, 900 / (dist * dist)), fx = dx / dist * force, fy = dy / dist * force;
        if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
        if (!b.pinned) { b.vx += fx; b.vy += fy; }
      }
      for (const n of visible) if (!n.pinned) { n.vx *= .86; n.vy *= .86; n.x += n.vx; n.y += n.vy; }
    }
    function toWorld(x, y) { return { x: (x - ox) / scale, y: (y - oy) / scale }; }
    function drawArrow(a, b, color, directed) {
      const ra = nodeRadius(a), rb = nodeRadius(b), dx = b.x - a.x, dy = b.y - a.y, dist = Math.max(1, Math.hypot(dx, dy));
      const x1 = a.x + dx / dist * ra, y1 = a.y + dy / dist * ra, x2 = b.x - dx / dist * rb, y2 = b.y - dy / dist * rb;
      ctx.strokeStyle = color; ctx.globalAlpha = .72; ctx.lineWidth = 1.5 / scale;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (directed) {
        const angle = Math.atan2(y2 - y1, x2 - x1), size = 8 / scale;
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - Math.cos(angle - .45) * size, y2 - Math.sin(angle - .45) * size);
        ctx.lineTo(x2 - Math.cos(angle + .45) * size, y2 - Math.sin(angle + .45) * size);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function draw() {
      tick();
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale);
      for (const e of edges) if (e.a.visible && e.b.visible) drawArrow(e.a, e.b, edgeColors[e.relation_type] || "#64748b", e.relation_type !== "relates_to");
      for (const n of nodes) {
        if (!n.visible) continue;
        const r = nodeRadius(n);
        ctx.fillStyle = levelColors[n.abstraction_level] || "#64748b"; ctx.globalAlpha = activeIds.has(n.id) ? 1 : .32;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = n.pinned ? "#111827" : "white"; ctx.lineWidth = 2 / scale; ctx.stroke();
        if (scale > .72) { ctx.fillStyle = "#111827"; ctx.font = (10 / scale) + "px sans-serif"; ctx.fillText(String(n.id), n.x + r + 3 / scale, n.y + 3 / scale); }
      }
      ctx.restore(); requestAnimationFrame(draw);
    }
    function hitTest(sx, sy) {
      const p = toWorld(sx, sy);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]; if (!n.visible) continue;
        if (Math.hypot(n.x - p.x, n.y - p.y) <= nodeRadius(n) + 4 / scale) return n;
      }
      return null;
    }
    canvas.addEventListener("mousedown", e => { const n = hitTest(e.offsetX, e.offsetY); last = { x: e.offsetX, y: e.offsetY }; if (n) { dragging = n; n.pinned = true; } else panning = true; });
    window.addEventListener("mousemove", e => {
      const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, n = hitTest(x, y);
      if (dragging) { const p = toWorld(x, y); dragging.x = p.x; dragging.y = p.y; }
      else if (panning && last) { ox += x - last.x; oy += y - last.y; }
      else if (n) {
        tooltip.style.display = "block"; tooltip.style.left = (e.clientX + 14) + "px"; tooltip.style.top = (e.clientY + 14) + "px";
        tooltip.innerHTML = "<b>[" + n.id + "] L" + n.abstraction_level + "</b><br>" + escapeHtml(n.text) + "<br><span style='color:#cbd5e1'>" + n.descendant_count + " descendants · " + (n.is_static ? "static" : "dynamic") + (n.forget_after ? " · expires " + new Date(n.forget_after).toLocaleString() : "") + "</span>";
      } else tooltip.style.display = "none";
      last = { x, y };
    });
    window.addEventListener("mouseup", () => { dragging = null; panning = false; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const before = toWorld(e.offsetX, e.offsetY);
      scale = Math.max(.2, Math.min(3.5, scale * (e.deltaY < 0 ? 1.08 : .92)));
      const after = toWorld(e.offsetX, e.offsetY);
      ox += (after.x - before.x) * scale; oy += (after.y - before.y) * scale;
    }, { passive: false });
    search.addEventListener("input", applyFilters); level.addEventListener("change", applyFilters);
    reset.addEventListener("click", () => { scale = 1; ox = 0; oy = 0; for (const n of nodes) n.pinned = false; });
    refresh.addEventListener("click", refreshData);
    resize(); window.addEventListener("resize", resize);
    if (DATA) buildGraph(DATA, false);
    if (LIVE) { refreshData().catch(console.error); setInterval(() => refreshData().catch(console.error), 2000); }
    draw();
  </script>
</body>
</html>`;
}

if (shouldServe) {
  const server = createServer((req, res) => {
    try {
      if (req.url?.startsWith("/data")) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(readGraphData()));
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(makeHtml(null, true));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`[memory-viz] live at ${url}`);
    console.log("[memory-viz] data refreshes on page load and every 2s");
    if (shouldOpen) spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  });
} else {
  const data = readGraphData();
  writeFileSync(outputPath, makeHtml(data, false), "utf8");
  console.log(`[memory-viz] wrote ${outputPath}`);
  console.log(`[memory-viz] facts=${data.facts.length} latest=${data.activeFactIds.length} edges=${data.edges.length}`);
  console.log(`[memory-viz] next L0 consolidation in ${data.stats.nextConsolidationIn}`);
  if (shouldOpen) spawn("open", [outputPath], { detached: true, stdio: "ignore" }).unref();
}
