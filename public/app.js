// =============================================================================
// ResumeGPT 클라이언트
// - Firebase 설정은 Firebase Hosting 예약 URL(/__/firebase/init.json)에서 자동으로 받는다.
// - Gemini 호출은 Cloud Function(generateEssay)이 담당한다. API 키는 브라우저에 없다.
// - 모든 사용자/AI 텍스트는 textContent 로만 렌더링한다 (XSS 방지).
// =============================================================================
const SDK = "https://www.gstatic.com/firebasejs/13.4.0";
const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, connectAuthEmulator,
} = await import(`${SDK}/firebase-auth.js`);
const {
    getFirestore, collection, query, orderBy, limit, onSnapshot, doc, deleteDoc, connectFirestoreEmulator,
} = await import(`${SDK}/firebase-firestore.js`);
const { getFunctions, httpsCallable, connectFunctionsEmulator } = await import(`${SDK}/firebase-functions.js`);

const FUNCTIONS_REGION = "asia-northeast3";
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const SECTION_TITLES = ["채용공고 분석", "자기소개서", "보완 질문", "추천 소재"];

let auth = null;
let db = null;
let generateEssayFn = null;
let currentUser = null;
let unsubscribeResumes = null;
let authMode = "login"; // 'login' | 'register'
let currentEssay = "";

const $ = (id) => document.getElementById(id);
const els = {
    loadingScreen: $("loadingScreen"), loginScreen: $("loginScreen"), mainApp: $("mainApp"),
    configErrorScreen: $("configErrorScreen"), configErrorText: $("configErrorText"),
    loginForm: $("loginForm"), loginMessageBox: $("loginMessageBox"), authTitle: $("authTitle"),
    authSubmitButton: $("authSubmitButton"), toggleAuthMode: $("toggleAuthMode"),
    resetPasswordLink: $("resetPasswordLink"), googleLoginButton: $("googleLoginButton"),
    logoutButton: $("logoutButton"), userEmail: $("userEmail"),
    resumeForm: $("resumeForm"), generateButton: $("generateButton"), quotaHint: $("quotaHint"),
    messageBox: $("messageBox"), output: $("output"), essayCount: $("essayCount"),
    copyEssayButton: $("copyEssayButton"), groundingBox: $("groundingBox"),
    searchSuggestions: $("searchSuggestions"), sourcesList: $("sourcesList"),
    resumesList: $("resumesList"), resumeCount: $("resumeCount"),
};
const FORM_FIELDS = ["company", "role", "question", "charLimit", "name", "skills", "jobDescription", "achievements", "motivation"];

// =============================================================================
// UI helpers
// =============================================================================
function showView(id) {
    for (const v of ["loadingScreen", "loginScreen", "mainApp", "configErrorScreen"]) els[v].classList.add("hidden");
    els[id].classList.remove("hidden");
}

function displayMessage(message, type = "error", target = els.messageBox) {
    target.textContent = message;
    target.className = type === "error" ? "msg msg-error" : "msg msg-info";
}
function hideMessage(target = els.messageBox) {
    target.className = "hidden";
}

function setBusy(button, busy, busyLabel, idleLabel) {
    button.disabled = busy;
    if (busy) {
        button.replaceChildren();
        const spin = document.createElement("span");
        spin.className = "loader";
        button.append(spin, ` ${busyLabel}`);
    } else {
        button.textContent = idleLabel;
    }
}

function countChars(s) {
    return { withSpaces: [...s].length, withoutSpaces: [...s.replace(/\s/g, "")].length };
}

/** 모델 출력 렌더링: "## 제목" 줄만 제목으로 표시하고 나머지는 원문 그대로 둔다. */
function renderGeneratedText(text) {
    els.output.replaceChildren();
    const lines = text.split("\n");
    let buffer = [];
    const flush = () => {
        if (!buffer.length) return;
        const p = document.createElement("div");
        p.className = "whitespace-pre-wrap";
        p.textContent = buffer.join("\n").replace(/^\n+|\n+$/g, "");
        if (p.textContent) els.output.append(p);
        buffer = [];
    };
    for (const line of lines) {
        const m = line.match(/^#{1,4}\s*\**\s*(.+?)\s*\**\s*$/);
        if (m && SECTION_TITLES.includes(m[1])) {
            flush();
            const h = document.createElement("h4");
            h.className = "result-heading";
            h.textContent = m[1];
            els.output.append(h);
        } else {
            buffer.push(line);
        }
    }
    flush();
}

function renderEssayCount(essay, essayChars, charLimit) {
    currentEssay = essay || "";
    if (!currentEssay) {
        els.essayCount.textContent = "";
        els.copyEssayButton.classList.add("hidden");
        return;
    }
    const c = essayChars || countChars(currentEssay);
    const over = charLimit && c.withSpaces > charLimit;
    els.essayCount.textContent = `본문 ${c.withSpaces.toLocaleString()}자 (공백 제외 ${c.withoutSpaces.toLocaleString()}자)` +
        (charLimit ? ` / 제한 ${Number(charLimit).toLocaleString()}자${over ? " — 초과" : ""}` : "");
    els.essayCount.className = over ? "text-sm font-semibold text-red-600" : "text-sm text-gray-600";
    els.copyEssayButton.classList.remove("hidden");
}

/**
 * Google 검색 그라운딩 결과 표시.
 * 약관상 Google 검색 추천(renderedContent)은 수정 없이 보여줘야 하므로 Shadow DOM 안에 그대로 넣는다
 * (페이지 CSS와 서로 간섭하지 않게). 이 HTML은 서버(Cloud Function)만 쓸 수 있는 문서에서 온다.
 */
function renderGrounding({ grounded, sources = [], searchEntryPointHtml = "" }) {
    els.sourcesList.replaceChildren();
    els.searchSuggestions.replaceChildren();
    if (!grounded) {
        els.groundingBox.classList.add("hidden");
        return;
    }
    if (searchEntryPointHtml) {
        const host = document.createElement("div");
        host.attachShadow({ mode: "open" }).innerHTML = searchEntryPointHtml;
        els.searchSuggestions.append(host);
    }
    for (const s of sources) {
        let url;
        try { url = new URL(s.uri); } catch { continue; }
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = url.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "text-indigo-600 hover:underline break-all";
        a.textContent = s.title || url.hostname;
        li.append(a);
        els.sourcesList.append(li);
    }
    els.groundingBox.classList.remove("hidden");
}

function showResult(r) {
    renderGeneratedText(r.generatedText || "");
    renderEssayCount(r.essay, r.essayChars, r.charLimit);
    renderGrounding(r);
    if (r.truncated) displayMessage("⚠️ 응답이 길어 중간에 잘렸습니다. 다시 생성해 보세요.", "error");
}

function resetResult() {
    els.output.textContent = "AI 자소서가 여기에 표시됩니다.";
    renderEssayCount("", null, 0);
    renderGrounding({ grounded: false });
}

// =============================================================================
// Auth
// =============================================================================
const AUTH_ERRORS = {
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않습니다.",
    "auth/user-not-found": "이메일 또는 비밀번호가 올바르지 않습니다.",
    "auth/wrong-password": "이메일 또는 비밀번호가 올바르지 않습니다.",
    "auth/invalid-email": "이메일 형식이 올바르지 않습니다.",
    "auth/email-already-in-use": "이미 등록된 이메일입니다. 로그인해 주세요.",
    "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
    "auth/too-many-requests": "시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 연결을 확인해 주세요.",
    "auth/popup-blocked": "팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.",
    "auth/popup-closed-by-user": "Google 로그인 창이 닫혔습니다. 다시 시도해 주세요.",
    "auth/cancelled-popup-request": "",
    "auth/operation-not-allowed": "이 로그인 방식이 아직 활성화되지 않았습니다. (Firebase 콘솔 > Authentication)",
};
function authErrorMessage(err) {
    return AUTH_ERRORS[err?.code] ?? `인증 오류가 발생했습니다. (${err?.code || "unknown"})`;
}

function setAuthMode(mode) {
    authMode = mode;
    const reg = authMode === "register";
    els.authTitle.textContent = reg ? "ResumeGPT 회원가입" : "ResumeGPT 로그인";
    els.authSubmitButton.textContent = reg ? "계정 생성" : "로그인";
    els.toggleAuthMode.textContent = reg ? "이미 계정이 있으신가요? 로그인" : "계정이 없으신가요? 회원가입";
    $("loginPassword").autocomplete = reg ? "new-password" : "current-password";
}

function toggleAuthMode(e) {
    e.preventDefault();
    hideMessage(els.loginMessageBox);
    setAuthMode(authMode === "login" ? "register" : "login");
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    hideMessage(els.loginMessageBox);
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value; // 비밀번호는 trim 하지 않는다
    if (!email || !password) {
        displayMessage("이메일과 비밀번호를 모두 입력해 주세요.", "error", els.loginMessageBox);
        return;
    }
    const idle = els.authSubmitButton.textContent;
    setBusy(els.authSubmitButton, true, "처리 중...", idle);
    try {
        if (authMode === "login") await signInWithEmailAndPassword(auth, email, password);
        else await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
        console.error("Auth error:", err);
        const msg = authErrorMessage(err);
        if (msg) displayMessage(msg, "error", els.loginMessageBox);
    } finally {
        setBusy(els.authSubmitButton, false, "", idle);
    }
}

async function handleGoogleLogin() {
    hideMessage(els.loginMessageBox);
    try {
        await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
        console.error("Google login error:", err);
        const msg = authErrorMessage(err);
        if (msg) displayMessage(msg, "error", els.loginMessageBox);
    }
}

async function handlePasswordReset(e) {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    if (!email) {
        displayMessage("비밀번호를 재설정할 이메일을 위 칸에 입력해 주세요.", "error", els.loginMessageBox);
        return;
    }
    try {
        await sendPasswordResetEmail(auth, email);
    } catch (err) {
        if (err?.code === "auth/invalid-email") {
            displayMessage(authErrorMessage(err), "error", els.loginMessageBox);
            return;
        }
        console.error("Password reset error:", err);
    }
    // 계정 존재 여부를 노출하지 않도록 항상 같은 안내
    displayMessage("가입된 이메일이라면 비밀번호 재설정 메일이 발송됩니다.", "info", els.loginMessageBox);
}

async function handleLogout() {
    try {
        await signOut(auth);
    } catch (err) {
        console.error("Logout error:", err);
        displayMessage("로그아웃 중 오류가 발생했습니다.");
    }
}

// =============================================================================
// Firestore (읽기/삭제만. 저장은 서버가 한다)
// =============================================================================
function resumesCollection(uid) {
    return collection(db, "users", uid, "resumes");
}

function startResumesListener(uid) {
    stopResumesListener();
    const q = query(resumesCollection(uid), orderBy("createdAt", "desc"), limit(50));
    unsubscribeResumes = onSnapshot(q, (snap) => {
        const items = snap.docs.map((d) => {
            const data = d.data({ serverTimestamps: "estimate" });
            return { id: d.id, ...data, createdAtDate: data.createdAt?.toDate?.() || null };
        });
        renderResumes(items);
    }, (err) => {
        console.error("Firestore snapshot error:", err);
        displayMessage("저장된 자소서를 불러오지 못했습니다.");
    });
}

function stopResumesListener() {
    if (unsubscribeResumes) {
        unsubscribeResumes();
        unsubscribeResumes = null;
    }
}

function renderResumes(items) {
    els.resumeCount.textContent = String(items.length);
    els.resumesList.replaceChildren();
    if (!items.length) {
        const p = document.createElement("p");
        p.className = "text-gray-500 text-sm p-4 border rounded-lg bg-gray-50";
        p.textContent = "저장된 자소서가 없습니다. 생성하면 자동으로 저장됩니다.";
        els.resumesList.append(p);
        return;
    }
    for (const r of items) {
        const item = document.createElement("div");
        item.className = "p-3 border rounded-lg shadow-sm bg-white hover:bg-indigo-50 transition duration-150";

        const title = document.createElement("p");
        title.className = "text-sm font-semibold text-indigo-700";
        title.textContent = `${r.company || "-"} · ${r.role || "-"}`;

        const sub = document.createElement("p");
        sub.className = "text-xs text-gray-600 mt-1 truncate";
        sub.textContent = r.question || "";

        const date = document.createElement("p");
        date.className = "text-xs text-gray-500 mt-1";
        date.textContent = r.createdAtDate
            ? r.createdAtDate.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })
            : "저장 중...";

        const buttons = document.createElement("div");
        buttons.className = "flex gap-2 mt-2";
        const loadBtn = document.createElement("button");
        loadBtn.type = "button";
        loadBtn.className = "text-xs bg-indigo-500 hover:bg-indigo-600 text-white px-2 py-1 rounded-md";
        loadBtn.textContent = "불러오기";
        loadBtn.addEventListener("click", () => loadResume(r));
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "text-xs bg-red-500 hover:bg-red-600 text-white px-2 py-1 rounded-md";
        delBtn.textContent = "삭제";
        delBtn.addEventListener("click", () => deleteResume(r));
        buttons.append(loadBtn, delBtn);

        item.append(title, sub, date, buttons);
        els.resumesList.append(item);
    }
}

function loadResume(r) {
    for (const f of FORM_FIELDS) {
        const v = r[f];
        $(f).value = f === "charLimit" ? (v ? String(v) : "") : (v || "");
    }
    $("useSearch").checked = r.useSearch !== false;
    updateHints();
    showResult({
        generatedText: r.generatedText || "",
        essay: r.essay || "",
        essayChars: r.essayChars,
        charLimit: r.charLimit,
        grounded: r.grounded,
        sources: r.sources,
        searchEntryPointHtml: r.searchEntryPointHtml,
    });
    displayMessage(`[${r.company} · ${r.role}] 자소서를 불러왔습니다.`, "info");
    els.output.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteResume(r) {
    if (!currentUser || !window.confirm(`[${r.company} · ${r.role}] 자소서를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
        await deleteDoc(doc(db, "users", currentUser.uid, "resumes", r.id));
        displayMessage("자소서를 삭제했습니다.", "info");
    } catch (err) {
        console.error("Delete error:", err);
        displayMessage("자소서 삭제에 실패했습니다.");
    }
}

// =============================================================================
// 생성
// =============================================================================
const CALLABLE_ERRORS = {
    "functions/unauthenticated": "로그인이 만료되었습니다. 다시 로그인해 주세요.",
    "functions/deadline-exceeded": "응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
};

async function generateResume(e) {
    e.preventDefault();
    hideMessage();
    if (!currentUser) {
        displayMessage("로그인이 필요합니다.");
        return;
    }
    const v = Object.fromEntries(FORM_FIELDS.map((f) => [f, $(f).value]));
    if (!v.company.trim() || !v.role.trim()) {
        displayMessage("회사명과 지원 직무는 필수 입력 항목입니다.");
        return;
    }
    const payload = { ...v, charLimit: v.charLimit ? Number(v.charLimit) : 0, useSearch: $("useSearch").checked };

    const idle = "AI 자소서 생성 및 저장하기 🚀";
    setBusy(els.generateButton, true, "자소서 생성 중... (최대 1분 정도 걸립니다)", idle);
    resetResult();
    els.output.textContent = "⏳ 지원 정보를 분석하고 초안을 작성하고 있습니다...";
    try {
        const { data } = await generateEssayFn(payload);
        showResult(data);
        els.quotaHint.textContent = `오늘 남은 생성 횟수: ${data.remainingToday}회`;
        if (!data.truncated) displayMessage("자소서를 생성해 저장했습니다.", "info");
    } catch (err) {
        console.error("generateEssay error:", err);
        // 서버가 보낸 HttpsError 메시지는 사용자용으로 작성되어 있음
        // SDK가 메시지 끝에 붙이는 HTTP 상태 " [429]"는 사용자에게 보여주지 않는다
        const serverMsg = (err?.message || "").replace(/\s*\[\d{3}\]$/, "");
        const msg = CALLABLE_ERRORS[err?.code] ||
            (err?.code && err.code !== "functions/internal" && serverMsg ? serverMsg : "자소서 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        displayMessage(msg);
        els.output.textContent = "생성에 실패했습니다.";
    } finally {
        setBusy(els.generateButton, false, "", idle);
    }
}

async function copyEssay() {
    if (!currentEssay) return;
    try {
        await navigator.clipboard.writeText(currentEssay);
        els.copyEssayButton.textContent = "복사됨 ✓";
        setTimeout(() => { els.copyEssayButton.textContent = "본문 복사"; }, 1500);
    } catch {
        displayMessage("클립보드 복사에 실패했습니다. 직접 선택해서 복사해 주세요.");
    }
}

function updateHints() {
    for (const [id, hint] of [["jobDescription", "jdCount"], ["achievements", "achCount"]]) {
        const el = $(id);
        $(hint).textContent = el.value ? `${el.value.length.toLocaleString()} / ${Number(el.maxLength).toLocaleString()}` : "";
    }
}

// =============================================================================
// 초기화
// =============================================================================
async function loadFirebaseConfig() {
    const res = await fetch("/__/firebase/init.json");
    if (!res.ok) throw new Error(`init.json ${res.status}`);
    return res.json();
}

async function initAppCheck(app) {
    const siteKey = document.querySelector('meta[name="recaptcha-site-key"]')?.content?.trim();
    if (!siteKey) return;
    const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(`${SDK}/firebase-app-check.js`);
    if (IS_LOCAL) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
}

async function init() {
    let config;
    try {
        config = await loadFirebaseConfig();
    } catch (err) {
        console.error(err);
        els.configErrorText.textContent =
            "Firebase 설정을 불러오지 못했습니다.\n이 앱은 Firebase Hosting(또는 'firebase emulators:start')에서 실행해야 합니다.";
        showView("configErrorScreen");
        return;
    }

    const app = initializeApp(config);
    await initAppCheck(app);
    auth = getAuth(app);
    auth.languageCode = "ko";
    db = getFirestore(app);
    const functions = getFunctions(app, FUNCTIONS_REGION);
    if (IS_LOCAL) {
        connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
        connectFirestoreEmulator(db, "127.0.0.1", 8080);
        connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    }
    generateEssayFn = httpsCallable(functions, "generateEssay", { timeout: 150_000 });

    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        if (user) {
            els.userEmail.textContent = user.email || "";
            hideMessage(els.loginMessageBox);
            startResumesListener(user.uid);
            showView("mainApp");
        } else {
            stopResumesListener();
            els.resumesList.replaceChildren();
            resetResult();
            els.resumeForm.reset(); // 공용 PC에서 다음 사용자에게 입력 내용이 남지 않게
            updateHints();
            hideMessage();
            els.quotaHint.textContent = "";
            setAuthMode("login"); // 로그아웃 후에는 항상 로그인 모드로
            $("loginPassword").value = "";
            showView("loginScreen");
        }
    });
}

els.loginForm.addEventListener("submit", handleAuthSubmit);
els.toggleAuthMode.addEventListener("click", toggleAuthMode);
els.resetPasswordLink.addEventListener("click", handlePasswordReset);
els.googleLoginButton.addEventListener("click", handleGoogleLogin);
els.logoutButton.addEventListener("click", handleLogout);
els.resumeForm.addEventListener("submit", generateResume);
els.copyEssayButton.addEventListener("click", copyEssay);
$("jobDescription").addEventListener("input", updateHints);
$("achievements").addEventListener("input", updateHints);

init();
