"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGenerateHandler, kstDate, withRetry } = require("../handler");

// ---- minimal in-memory Firestore fake (only what handler.js uses) ----------
function fakeDb() {
  const store = new Map();
  let autoId = 0;
  const resolve = (v, prev) => {
    // FieldValue.increment / serverTimestamp sentinels
    if (v && typeof v === "object" && v.constructor && v.constructor.name === "NumericIncrementTransform") {
      return (prev || 0) + v.operand;
    }
    if (v && typeof v === "object" && v.constructor && v.constructor.name === "ServerTimestampTransform") return new Date();
    return v;
  };
  const docRef = (path) => ({
    id: path.split("/").pop(),
    path,
    collection: (name) => collRef(`${path}/${name}`),
    async set(data) { store.set(path, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, resolve(v)]))); },
  });
  const collRef = (path) => ({
    doc: (id) => docRef(`${path}/${id || `auto${++autoId}`}`),
  });
  const snap = (path) => ({ exists: store.has(path), data: () => ({ ...store.get(path) }) });
  return {
    store,
    collection: (name) => collRef(name),
    async runTransaction(fn) {
      const tx = {
        get: async (ref) => snap(ref.path),
        set: (ref, data) => store.set(ref.path, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, resolve(v)]))),
        update: (ref, data) => {
          const prev = store.get(ref.path) || {};
          for (const [k, v] of Object.entries(data)) prev[k] = resolve(v, prev[k]);
          store.set(ref.path, prev);
        },
      };
      return fn(tx);
    },
  };
}

const okResponse = {
  candidates: [{
    finishReason: "STOP",
    content: { parts: [{ text: "## 채용공고 분석\n분석\n\n## 자기소개서\n본문 입니다\n\n## 보완 질문\n없음\n\n## 추천 소재\n- x" }] },
    groundingMetadata: {
      searchEntryPoint: { renderedContent: "<div>s</div>" },
      groundingChunks: [{ web: { uri: "https://x.example", title: "X" } }],
    },
  }],
};

const silentLogger = { error() {}, warn() {}, info() {} };
const user = { uid: "u1", token: { firebase: { sign_in_provider: "password" } } };
const data = { role: "백엔드", company: "토스", name: "김지훈" };

function setup(overrides = {}) {
  const db = fakeDb();
  const calls = [];
  const handler = createGenerateHandler({
    getDb: () => db,
    generate: async (req) => { calls.push(req); return overrides.response || okResponse; },
    model: () => "test-model",
    dailyLimit: () => overrides.limit ?? 3,
    now: () => new Date("2026-11-24T15:30:00Z"), // KST 2026-11-25 00:30
    logger: silentLogger,
    retry: { sleep: async () => {} },
    ...overrides.deps,
  });
  return { db, calls, handler };
}

test("kstDate rolls over at KST midnight", () => {
  assert.equal(kstDate(new Date("2026-11-24T14:59:59Z")), "2026-11-24");
  assert.equal(kstDate(new Date("2026-11-24T15:00:00Z")), "2026-11-25");
});

test("rejects unauthenticated and anonymous users", async () => {
  const { handler, calls } = setup();
  await assert.rejects(handler({ data }), { code: "unauthenticated" });
  await assert.rejects(handler({ data, auth: { uid: "a", token: { firebase: { sign_in_provider: "anonymous" } } } }), { code: "permission-denied" });
  assert.equal(calls.length, 0);
});

test("invalid input -> invalid-argument, no quota used", async () => {
  const { handler, db } = setup();
  await assert.rejects(handler({ data: { role: "x" }, auth: user }), { code: "invalid-argument" });
  assert.equal(db.store.has("usage/u1"), false);
});

test("success: saves full document, returns parsed result", async () => {
  const { handler, db, calls } = setup();
  const res = await handler({ data: { ...data, skills: "Java", charLimit: 500 }, auth: user });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "test-model");
  assert.equal(calls[0].useSearch, true);
  assert.equal(res.essay, "본문 입니다");
  assert.deepEqual(res.essayChars, { withSpaces: 6, withoutSpaces: 5 });
  assert.equal(res.grounded, true);
  assert.equal(res.remainingToday, 2);
  const doc = db.store.get(`users/u1/resumes/${res.id}`);
  assert.ok(doc, "document saved");
  // previously name/achievements/motivation were not saved -> loading lost them
  for (const k of ["name", "achievements", "motivation", "skills", "jobDescription", "question", "charLimit"]) {
    assert.ok(k in doc, k);
  }
  assert.equal(doc.name, "김지훈");
  assert.ok(doc.expireAt, "grounded result has TTL");
  assert.equal(db.store.get("usage/u1").count, 1);
  assert.equal(db.store.get("usage/u1").date, "2026-11-25");
});

test("daily limit enforced", async () => {
  const { handler } = setup({ limit: 2 });
  await handler({ data, auth: user });
  await handler({ data, auth: user });
  await assert.rejects(handler({ data, auth: user }), { code: "resource-exhausted" });
});

test("Gemini failure refunds quota; 429 maps to unavailable; retries transient errors", async () => {
  let n = 0;
  const { handler, db } = setup({
    deps: { generate: async () => { n++; const e = new Error("rate"); e.status = 429; throw e; } },
  });
  await assert.rejects(handler({ data, auth: user }), { code: "unavailable" });
  assert.equal(n, 3, "retried 3 times");
  assert.equal(db.store.get("usage/u1").count, 0, "refunded");
});

test("non-retryable error is not retried", async () => {
  let n = 0;
  const { handler } = setup({
    deps: { generate: async () => { n++; const e = new Error("bad"); e.status = 400; throw e; } },
  });
  await assert.rejects(handler({ data, auth: user }), { code: "internal" });
  assert.equal(n, 1);
});

test("empty response refunds quota", async () => {
  const { handler, db } = setup({ response: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] } });
  await assert.rejects(handler({ data, auth: user }), { code: "failed-precondition" });
  assert.equal(db.store.get("usage/u1").count, 0);
});

test("no-search response has no TTL and grounded=false", async () => {
  const resp = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "## 자기소개서\n본문" }] } }] };
  const { handler, db, calls } = setup({ response: resp });
  const res = await handler({ data: { ...data, useSearch: false }, auth: user });
  assert.equal(calls[0].useSearch, false);
  assert.equal(res.grounded, false);
  assert.equal(db.store.get(`users/u1/resumes/${res.id}`).expireAt, undefined);
});

test("withRetry gives up after attempts", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; const e = new Error(); e.status = 503; throw e; }, { attempts: 2, sleep: async () => {} }));
  assert.equal(n, 2);
});
