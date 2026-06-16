import type { Db } from "mongodb";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.HTTP_PORT ?? 3011);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

type Stats = {
  exp?: number;
  lvl?: number;
  hp?: number;
  mp?: number;
  gp?: number;
  class?: string;
  points?: number;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function serveStatic(path: string): Response {
  const safe = normalize(path).replace(/^(\.\.[\\/])+/, "");
  const file = join(PUBLIC_DIR, safe === "/" || safe === "" ? "index.html" : safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    return new Response("not found", { status: 404 });
  }
  const ext = file.slice(file.lastIndexOf("."));
  const body = readFileSync(file);
  return new Response(body, {
    headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
  });
}

async function getUserStatsSeries(history: Db) {
  const cursor = history.collection("users_events").find(
    { op: { $in: ["insert", "update", "replace"] }, fullDocument: { $ne: null } },
    { projection: { ts: 1, "fullDocument.stats": 1, "fullDocument._id": 1 } },
  ).sort({ ts: 1 });

  const series: Array<{ ts: string; stats: Stats }> = [];
  for await (const ev of cursor) {
    const stats = (ev as { fullDocument?: { stats?: Stats } }).fullDocument?.stats;
    if (!stats) continue;
    series.push({
      ts: (ev as { ts: Date }).ts.toISOString(),
      stats: {
        exp: stats.exp,
        lvl: stats.lvl,
        hp: stats.hp,
        mp: stats.mp,
        gp: stats.gp,
        class: stats.class,
        points: stats.points,
      },
    });
  }

  for await (const snap of history.collection("users_snapshots").find({}, {
    projection: { ts: 1, "docs.stats": 1 },
  }).sort({ ts: 1 })) {
    const doc = (snap as { docs?: Array<{ stats?: Stats }> }).docs?.[0];
    if (!doc?.stats) continue;
    series.push({
      ts: (snap as { ts: Date }).ts.toISOString(),
      stats: {
        exp: doc.stats.exp,
        lvl: doc.stats.lvl,
        hp: doc.stats.hp,
        mp: doc.stats.mp,
        gp: doc.stats.gp,
        class: doc.stats.class,
        points: doc.stats.points,
      },
    });
  }

  series.sort((a, b) => a.ts.localeCompare(b.ts));
  return series;
}

type TaskPoint = {
  ts: string;
  taskId: string;
  counterUp?: number;
  counterDown?: number;
  value?: number;
};

type TaskMeta = {
  _id: string;
  text: string;
  type: string;
  notes?: string;
  value?: number;
  counterUp?: number;
  counterDown?: number;
  streak?: number;
};

async function getTasksSeries(history: Db) {
  const tasksById = new Map<string, TaskMeta>();

  const latestSnap = await history.collection("tasks_snapshots").find({}, {
    projection: { ts: 1, docs: 1 },
  }).sort({ ts: -1 }).limit(1).next();
  const snapDocs = (latestSnap as { docs?: TaskMeta[] } | null)?.docs ?? [];
  for (const t of snapDocs) {
    tasksById.set(t._id, {
      _id: t._id,
      text: t.text,
      type: t.type,
      notes: t.notes,
      value: t.value,
      counterUp: t.counterUp,
      counterDown: t.counterDown,
      streak: t.streak,
    });
  }

  const points: TaskPoint[] = [];
  const cursor = history.collection("tasks_events").find(
    { fullDocument: { $ne: null } },
    {
      projection: {
        ts: 1,
        "fullDocument._id": 1,
        "fullDocument.text": 1,
        "fullDocument.type": 1,
        "fullDocument.notes": 1,
        "fullDocument.value": 1,
        "fullDocument.counterUp": 1,
        "fullDocument.counterDown": 1,
        "fullDocument.streak": 1,
      },
    },
  ).sort({ ts: 1 });

  for await (const ev of cursor) {
    const d = (ev as { fullDocument?: TaskMeta }).fullDocument;
    if (!d?._id) continue;
    if (!tasksById.has(d._id)) {
      tasksById.set(d._id, {
        _id: d._id,
        text: d.text,
        type: d.type,
        notes: d.notes,
        value: d.value,
        counterUp: d.counterUp,
        counterDown: d.counterDown,
        streak: d.streak,
      });
    } else {
      const cur = tasksById.get(d._id)!;
      cur.text = d.text ?? cur.text;
      cur.value = d.value ?? cur.value;
      cur.counterUp = d.counterUp ?? cur.counterUp;
      cur.counterDown = d.counterDown ?? cur.counterDown;
      cur.streak = d.streak ?? cur.streak;
    }
    points.push({
      ts: (ev as { ts: Date }).ts.toISOString(),
      taskId: d._id,
      counterUp: d.counterUp,
      counterDown: d.counterDown,
      value: d.value,
    });
  }

  return {
    tasks: Array.from(tasksById.values()).sort((a, b) => {
      const t = (a.type ?? "").localeCompare(b.type ?? "");
      return t !== 0 ? t : (a.text ?? "").localeCompare(b.text ?? "");
    }),
    points,
  };
}

export function startHttpServer(history: Db) {
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/api/series/user-stats") {
          return json(await getUserStatsSeries(history));
        }
        if (p === "/api/series/tasks") {
          return json(await getTasksSeries(history));
        }
        if (p === "/api/health") {
          return json({ ok: true });
        }
        if (p.startsWith("/api/")) {
          return new Response("not found", { status: 404 });
        }
        return serveStatic(p);
      } catch (err) {
        console.error("[http]", p, err);
        return new Response("internal error", { status: 500 });
      }
    },
  });
  console.log(`[http] listening on :${PORT}`);
}
