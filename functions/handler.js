// =============================================================================
// handler.js — generateEssay 콜러블의 본체 (의존성 주입으로 테스트 가능)
// =============================================================================
"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const {
  InputError,
  validateInput,
  buildPrompts,
  extractSections,
  countChars,
  extractGrounding,
  extractText,
} = require("./prompt");

// 검색 그라운딩 결과는 약관상 최대 2년까지만 보관 (Firestore TTL 정책으로 자동 삭제)
const GROUNDED_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** KST 기준 날짜 문자열 (일일 사용량 리셋 기준) */
function kstDate(now) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 사용자별 일일 생성 횟수를 트랜잭션으로 1 증가시킨다. 한도 초과면 resource-exhausted.
 * @returns {Promise<{refund: () => Promise<void>, remaining: number}>}
 */
async function reserveQuota(db, uid, now, dailyLimit) {
  const ref = db.collection("usage").doc(uid);
  const date = kstDate(now);
  const count = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const used = data.date === date ? data.count || 0 : 0;
    if (used >= dailyLimit) {
      throw new HttpsError("resource-exhausted", `오늘 생성 가능 횟수(${dailyLimit}회)를 모두 사용했습니다. 내일 다시 시도해 주세요.`);
    }
    tx.set(ref, { date, count: used + 1, updatedAt: FieldValue.serverTimestamp() });
    return used + 1;
  });
  return {
    remaining: dailyLimit - count,
    refund: async () => {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().date === date && snap.data().count > 0) {
          tx.update(ref, { count: FieldValue.increment(-1) });
        }
      });
    },
  };
}

function isRetryable(err) {
  const status = err?.status ?? err?.code;
  return status === 429 || status === 500 || status === 503 || status === 504;
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * @param {object} deps
 * @param {() => FirebaseFirestore.Firestore} deps.getDb
 * @param {(req: {model, systemPrompt, userPrompt, useSearch}) => Promise<any>} deps.generate  Gemini generateContent 호출
 * @param {() => string} deps.model
 * @param {() => number} deps.dailyLimit
 * @param {() => Date} [deps.now]
 * @param {object} [deps.logger]
 * @param {object} [deps.retry]  withRetry 옵션 (테스트용)
 */
function createGenerateHandler(deps) {
  const now = deps.now || (() => new Date());
  const logger = deps.logger || console;

  return async function handleGenerate(request) {
    // 1) 인증: 로그인한 (익명이 아닌) 사용자만
    const auth = request.auth;
    if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    if (auth.token?.firebase?.sign_in_provider === "anonymous") {
      throw new HttpsError("permission-denied", "이메일 또는 Google 계정으로 로그인해 주세요.");
    }

    // 2) 입력 검증
    let input;
    try {
      input = validateInput(request.data);
    } catch (err) {
      if (err instanceof InputError) throw new HttpsError("invalid-argument", err.message);
      throw err;
    }

    // 3) 사용량 한도
    const db = deps.getDb();
    const startedAt = now();
    const quota = await reserveQuota(db, auth.uid, startedAt, deps.dailyLimit());

    // 4) Gemini 호출
    const model = deps.model();
    const { systemPrompt, userPrompt, question } = buildPrompts(input);
    let response;
    try {
      response = await withRetry(
        () => deps.generate({ model, systemPrompt, userPrompt, useSearch: input.useSearch }),
        deps.retry,
      );
    } catch (err) {
      await quota.refund().catch((e) => logger.error("quota refund failed", e));
      logger.error("Gemini call failed", { status: err?.status, message: err?.message });
      if (err?.status === 429) throw new HttpsError("unavailable", "AI 서비스 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
      throw new HttpsError("internal", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }

    const text = extractText(response);
    const finishReason = response?.candidates?.[0]?.finishReason;
    if (!text) {
      await quota.refund().catch((e) => logger.error("quota refund failed", e));
      logger.warn("Empty response", { finishReason, blockReason: response?.promptFeedback?.blockReason });
      throw new HttpsError("failed-precondition", "AI가 응답을 생성하지 못했습니다. 입력 내용을 조금 바꿔 다시 시도해 주세요.");
    }

    const sections = extractSections(text);
    const essayChars = countChars(sections.essay);
    const grounding = extractGrounding(response);

    // 5) 저장 (클라이언트는 이 컬렉션에 쓸 수 없음 — firestore.rules)
    const ref = db.collection("users").doc(auth.uid).collection("resumes").doc();
    const docData = {
      name: input.name,
      role: input.role,
      company: input.company,
      question,
      charLimit: input.charLimit,
      skills: input.skills,
      jobDescription: input.jobDescription,
      achievements: input.achievements,
      motivation: input.motivation,
      useSearch: input.useSearch,
      generatedText: text,
      essay: sections.essay,
      essayChars,
      truncated: finishReason === "MAX_TOKENS",
      grounded: grounding.grounded,
      sources: grounding.sources,
      searchEntryPointHtml: grounding.searchEntryPointHtml,
      model,
      createdAt: FieldValue.serverTimestamp(),
    };
    if (grounding.grounded) {
      docData.expireAt = Timestamp.fromMillis(startedAt.getTime() + GROUNDED_RETENTION_MS);
    }
    await ref.set(docData);

    return {
      id: ref.id,
      generatedText: text,
      essay: sections.essay,
      essayChars,
      charLimit: input.charLimit,
      truncated: docData.truncated,
      grounded: grounding.grounded,
      sources: grounding.sources,
      searchEntryPointHtml: grounding.searchEntryPointHtml,
      remainingToday: quota.remaining,
    };
  };
}

module.exports = { createGenerateHandler, reserveQuota, withRetry, isRetryable, kstDate };
