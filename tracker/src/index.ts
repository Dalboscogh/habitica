import { MongoClient, type ChangeStream, type ResumeToken } from "mongodb";
import { startHttpServer } from "./server";

const MONGO_URL =
  process.env.MONGO_URL ?? "mongodb://mongo:27017/?replicaSet=rs&directConnection=true";
const SRC_DB = process.env.SRC_DB ?? "habitrpg";
const DST_DB = process.env.DST_DB ?? "habitrpg_history";
const WATCH_COLLECTIONS = ["tasks", "users", "userhistories"];

async function main() {
  const mode = process.argv[2];
  if (mode === "watch") return watch();
  if (mode === "snapshot") return snapshot();
  console.error(`unknown mode: ${mode}. use: watch | snapshot`);
  process.exit(2);
}

async function watch() {
  const client = await new MongoClient(MONGO_URL).connect();
  const src = client.db(SRC_DB);
  const dst = client.db(DST_DB);
  const meta = dst.collection<{ _id: string; value: unknown }>("meta");

  await Promise.all(
    WATCH_COLLECTIONS.map((c) =>
      dst
        .collection(`${c}_events`)
        .createIndex({ ts: 1 })
        .catch(() => undefined),
    ),
  );

  for (const col of WATCH_COLLECTIONS) {
    void watchOne(src, dst, meta, col).catch((err) => {
      console.error(`[${col}] fatal:`, err);
      process.exit(1);
    });
  }

  startHttpServer(dst);

  process.stdin.resume();
}

async function watchOne(
  src: ReturnType<MongoClient["db"]>,
  dst: ReturnType<MongoClient["db"]>,
  meta: ReturnType<typeof dst.collection>,
  col: string,
) {
  const events = dst.collection(`${col}_events`);
  const resumeKey = `resumeToken:${col}`;
  const stored = await meta.findOne({ _id: resumeKey });
  const resumeAfter = (stored?.value as ResumeToken | undefined) ?? undefined;

  const stream: ChangeStream = src.collection(col).watch(
    [],
    {
      fullDocument: "updateLookup",
      ...(resumeAfter ? { resumeAfter } : {}),
    },
  );

  console.log(`[${col}] watching${resumeAfter ? " (resumed)" : ""}`);

  for await (const change of stream) {
    const doc = {
      ts: new Date(),
      op: change.operationType,
      ns: col,
      documentKey: (change as { documentKey?: unknown }).documentKey ?? null,
      fullDocument: (change as { fullDocument?: unknown }).fullDocument ?? null,
      updateDescription:
        (change as { updateDescription?: unknown }).updateDescription ?? null,
      clusterTime: (change as { clusterTime?: unknown }).clusterTime ?? null,
    };
    await events.insertOne(doc);
    await meta.updateOne(
      { _id: resumeKey },
      { $set: { value: change._id, updatedAt: new Date() } },
      { upsert: true },
    );
    console.log(`[${col}] ${change.operationType}`);
  }
}

async function snapshot() {
  const client = await new MongoClient(MONGO_URL).connect();
  const src = client.db(SRC_DB);
  const dst = client.db(DST_DB);
  const ts = new Date();
  const date = ts.toISOString().slice(0, 10);

  for (const col of WATCH_COLLECTIONS) {
    const docs = await src.collection(col).find({}).toArray();
    await dst.collection(`${col}_snapshots`).insertOne({
      date,
      ts,
      count: docs.length,
      docs,
    });
    console.log(`[${col}] snapshot ${date}: ${docs.length} docs`);
  }
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
