const apiKey = " "; // ⭐ 여기에 실제 API Key를 입력하세요! ⭐
const MODEL_NAME = "gemini-2.5-flash-preview-09-2025";
const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

// DOM 요소 참조
const output = document.getElementById("output");
const generateButton = document.getElementById("generateButton");
const messageBox = document.getElementById("messageBox");
const resumeForm = document.getElementById("resumeForm"); // 폼 요소 참조

/**
 * alert() 대신 메시지 박스에 오류 또는 안내 메시지를 표시합니다.
 * @param {string} message 표시할 메시지
 * @param {string} type 메시지 유형 ('error' 또는 'info')
 */
function displayMessage(message, type = "error") {
  messageBox.textContent = message;
  messageBox.classList.remove("hidden");

  // 메시지 유형에 따른 스타일 변경 (Tailwind classes)
  if (type === "error") {
    messageBox.className =
      "mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg";
  } else {
    messageBox.className =
      "mt-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded-lg";
  }
}

/**
 * 지수 백오프를 사용하여 API 호출을 재시도합니다.
 * API Key를 URL 대신 Authorization 헤더를 통해 전달하도록 수정됨.
 * @param {string} url 호출할 API URL
 * @param {object} options fetch 옵션
 * @param {number} maxRetries 최대 재시도 횟수
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // API Key가 설정되어 있다면, Authorization 헤더를 추가합니다.
      const headers = {
        ...options.headers,
        "Content-Type": "application/json",
      };
      if (apiKey && apiKey !== "<YOUR_ACTUAL_API_KEY_HERE>") {
        // 키가 'Bearer' 토큰이 아니라면, 쿼리 파라미터 방식으로 다시 시도합니다.
        // 대부분의 SDK/환경에서 요구하는 표준 API Key 방식입니다.
        const finalUrl = `${url}?key=${apiKey}`;

        const response = await fetch(finalUrl, { ...options, headers });

        if (response.ok) {
          return response;
        }
      } else if (!apiKey || apiKey === "<YOUR_ACTUAL_API_KEY_HERE>") {
        // API 키가 설정되지 않았거나 기본값일 경우 즉시 오류를 발생시킵니다.
        throw new Error(
          "API Key가 설정되지 않았습니다. '<YOUR_ACTUAL_API_KEY_HERE>'를 실제 키로 교체해 주세요."
        );
      }

      // HTTP 오류 응답 (4xx, 5xx) 처리
      const response = await fetch(url, { ...options, headers });

      if (response.ok) {
        return response;
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          errorData.error?.message ||
          `HTTP Error: ${response.status} ${response.statusText}`;

        if (attempt === maxRetries) {
          throw new Error(
            `API 호출 실패 후 최대 재시도 횟수 도달: ${errorMessage}`
          );
        }

        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      // 네트워크 오류 및 사용자 정의 오류 처리
      if (attempt === maxRetries) {
        throw new Error(
          `네트워크 오류 후 최대 재시도 횟수 도달: ${error.message}`
        );
      }
      if (error.message.includes("API Key가 설정되지 않았습니다")) {
        throw error; // 즉시 API Key 설정 오류를 상위로 전달
      }
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("알 수 없는 이유로 API 호출에 실패했습니다.");
}

/**
 * 자소서를 생성하고 결과를 출력합니다.
 */
async function generateResume() {
  // 메시지 박스 숨기기
  messageBox.classList.add("hidden");

  const name = document.getElementById("name").value.trim();
  const role = document.getElementById("role").value.trim();
  const company = document.getElementById("company").value.trim();
  const skills = document.getElementById("skills").value.trim();
  const achievements = document.getElementById("achievements").value.trim();
  const motivation = document.getElementById("motivation").value.trim();

  if (!name || !role || !company) {
    displayMessage(
      "🛑 이름, 지원 직무, 회사명은 필수 입력 항목입니다. 입력해 주세요."
    );
    return;
  }

  // 로딩 상태 시작
  generateButton.disabled = true;
  generateButton.innerHTML = '<span class="loader"></span> 자소서 생성 중...';
  output.innerHTML =
    '<p class="text-center text-indigo-600">⏳ AI가 지원자님의 역량을 빛낼 자소서를 작성 중입니다. 잠시만 기다려주세요...</p>';

  // 프롬프트 정의
  const systemPrompt = `
당신은 Google Gemini 기반의 **최고 수준 경력 컨설턴트 및 수석 채용 전문가**입니다.
당신의 임무는 지원자가 제공한 정보를 바탕으로 **ATS(자동 필터링 시스템)를 통과**하고, 면접관에게 깊은 인상을 줄 수 있는 **전략적인 한국어 자기소개서**를 작성하는 것입니다.
결과물은 다음 제약 조건을 반드시 준수해야 합니다.
1.  **구성:** 정확히 3개의 독립된 문단으로 구성되어야 합니다.
2.  **문장력:** 각 문단은 정중하고 프로페셔널한 **문어체**를 사용해야 하며, 문법적 오류가 없어야 합니다.
3.  **핵심:** 지원 직무(${role})와 회사명(${company})에 관련된 **핵심 키워드**를 자연스럽게 통합하여 ATS 적합성을 높여야 합니다.
    `;

  const userPrompt = `
다음 입력 정보를 바탕으로 지원 직무에 가장 최적화된 자기소개서를 작성해 주세요.

[입력 정보]
이름: ${name}
직무: ${role}
회사명: ${company}
기술: ${skills || "입력되지 않음 (직무 기술 매칭 필요)"}
성과/경험: ${achievements || "입력되지 않음 (구체적인 성과 측정치 강조)"}
지원동기: ${motivation || "입력되지 않음 (비전과 연결하여 작성 필요)"}

[3문단 별 작성 목표]

1.  **도입 및 핵심 역량 요약 (Introduction & Core Competency):**
    -   지원자가 가진 **가장 강력한 직무 관련 핵심 역량**을 1~2문장으로 요약하며 시작합니다.
    -   ${company}의 ${role} 직무에 왜 자신이 **'즉시 기여할 수 있는 인재'**인지 명확하게 선언합니다.
    -   문단 전체는 3~4문장으로 마무리합니다.

2.  **성과 중심의 경험 서술 (Achievement-Driven Experience):**
    -   제공된 '성과/경험' 정보를 **Context-Action-Result (CAR) 구조**를 활용하여 서술합니다.
    -   '로그인 서버 처리 속도 30% 개선'과 같은 **측정 가능한 수치(Metric)**를 반드시 사용하여, 경험이 단순 업무가 아닌 **비즈니스 임팩트**를 창출했음을 강조합니다.
    -   보유 기술(${skills})이 어떻게 해당 성과를 달성하는 데 기여했는지 기술적으로 연결합니다.
    -   문단 전체는 4~5문장으로 마무리합니다.

3.  **회사 기여 의지 및 미래 비전 (Motivation & Future Vision):**
    -   ${company}의 기업 문화 또는 비전에 대한 이해를 바탕으로, 지원 동기(${motivation})를 발전시켜 작성합니다.
    -   **입사 후 ${company}에서 달성하고 싶은 구체적인 목표 (Growth Trajectory)**와 기여 방안을 제시합니다.
    -   문단 전체는 3~4문장으로 마무리하여 지원서를 인상적으로 마칩니다.
`;

  // API Key를 URL 쿼리 파라미터로 명시적으로 전달 (헤더 방식이 아닌 표준 방식)
  const fullApiUrl = `${API_BASE_URL}${MODEL_NAME}:generateContent`;

  try {
    const payload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    };

    const response = await fetchWithRetry(fullApiUrl, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // 응답 처리
    const data = await response.json();
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "⚠️ 자소서 생성 실패: 응답이 비정상적이거나 내용이 비어있습니다. 입력 정보를 다시 확인해 주세요.";

    output.textContent = text;
  } catch (err) {
    // 오류 발생 시 메시지 박스에 오류 표시
    displayMessage(
      `🚨 최종 오류 발생: 자소서 생성에 실패했습니다. ${err.message}`,
      "error"
    );
    output.textContent =
      "AI 자소서 생성 중 치명적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    console.error("API Call Error:", err);
  } finally {
    // 로딩 상태 종료
    generateButton.disabled = false;
    generateButton.innerHTML = "AI 자소서 생성하기 🚀";
  }
}

// 폼 제출 이벤트를 프로그램적으로 연결하여 ReferenceError 방지
if (resumeForm) {
  resumeForm.addEventListener("submit", function (event) {
    event.preventDefault(); // 기본 제출 동작 방지
    generateResume();
  });
}
