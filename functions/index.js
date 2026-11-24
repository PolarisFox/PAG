// =============================================================================
// Cloud Functions 진입점
//  - Gemini API 키는 Secret Manager(GEMINI_API_KEY)에만 존재하고 브라우저로 나가지 않는다.
//  - 배포: firebase functions:secrets:set GEMINI_API_KEY && firebase deploy
// =============================================================================
"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { defineSecret, defineString, defineInt, defineBoolean } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { GoogleGenAI } = require("@google/genai");
const { createGenerateHandler } = require("./handler");

initializeApp();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-3.8-flash" });
const DAILY_LIMIT = defineInt("DAILY_LIMIT", { default: 20 });
const ENFORCE_APP_CHECK = defineBoolean("ENFORCE_APP_CHECK", { default: false });

setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

let ai = null;
function getAI() {
  if (!ai) {
    const options = { apiKey: GEMINI_API_KEY.value() };
    // 에뮬레이터 테스트용: 가짜 Gemini 서버 주소 (배포 환경에서는 설정하지 않음)
    if (process.env.GEMINI_BASE_URL) options.httpOptions = { baseUrl: process.env.GEMINI_BASE_URL };
    ai = new GoogleGenAI(options);
  }
  return ai;
}

async function generate({ model, systemPrompt, userPrompt, useSearch }) {
  const config = { systemInstruction: systemPrompt };
  if (useSearch) config.tools = [{ googleSearch: {} }];
  return getAI().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config,
  });
}

exports.generateEssay = onCall(
  {
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
    enforceAppCheck: ENFORCE_APP_CHECK,
  },
  createGenerateHandler({
    getDb: () => getFirestore(),
    generate,
    model: () => GEMINI_MODEL.value(),
    dailyLimit: () => DAILY_LIMIT.value(),
    logger,
  }),
);
