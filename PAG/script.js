// API Key는 환경에서 자동으로 주입되므로 빈 문자열로 둡니다.
const apiKey = "";
const MODEL_NAME = "gemini-2.5-flash-preview-09-2025"; // 최신 지침 모델 사용
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

// DOM 요소 참조
const output = document.getElementById("output");
const generateButton = document.getElementById("generateButton");
const messageBox = document.getElementById("messageBox");

/**
 * alert() 대신 메시지 박스에 오류 또는 안내 메시지를 표시합니다.
 * @param {string} message 표시할 메시지
 * @param {string} type 메시지 유형 ('error' 또는 'info')
 */
function displayMessage(message, type = "error") {
  messageBox.textContent = message;
  messageBox.classList.remove("hidden");

  // 메시지 유형에 따른 스타일 변경
  if (type === "error") {
    messageBox.className =
      "mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg";
  } else {
    messageBox.className =
      "mt-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded-lg";
  }
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

  /* ======================================================================
    🌟 프롬프트 개선: 면접관에게 깊은 인상을 주는 전략적 프롬프트 🌟
    ======================================================================
    */

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

  try {
    const payload = {
      // 시스템 명령어(System Instruction)를 통해 AI의 역할과 제약 조건을 명확하게 전달
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      // 사용자 프롬프트(User Prompt)를 통해 구체적인 작성 가이드 전달
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      `🚨 오류 발생: Gemini API 호출에 실패했습니다. (세부: ${err.message})`,
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
