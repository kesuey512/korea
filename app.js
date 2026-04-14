import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB50lA92DSngs6y98PgK1thovNM4liPycU",
  authDomain: "korea-83b2a.firebaseapp.com",
  projectId: "korea-83b2a",
  storageBucket: "korea-83b2a.firebasestorage.app",
  messagingSenderId: "559427597840",
  appId: "1:559427597840:web:49f2decb6ff3753033fc95",
  measurementId: "G-W2MK1L42X0"
};

const INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60];

const LOCAL_WORDS_CACHE_KEY = "kr_words_cache_v1";
const LOCAL_PROGRESS_CACHE_KEY = "kr_progress_local_cache_v4";
const LOCAL_STUDY_SETTINGS_KEY = "kr_study_settings_v2";

const DEFAULT_PROGRESS = {
  stage: 0,
  nextReview: 0,
  lastResult: "new",
  updatedAt: 0,
  knownStreak: 0,
  mastered: false
};

let words = [];
let wordProgress = {};
let reviewQueue = [];
let currentWord = null;
let currentUser = null;

let app = null;
let auth = null;
let db = null;
let firebaseEnabled = true;

const krEl = document.getElementById("kr");
const cnEl = document.getElementById("cn");
const dueEl = document.getElementById("due-count");
const infoEl = document.getElementById("unit-info");
const syncMsgEl = document.getElementById("sync-msg");
const userStatusEl = document.getElementById("user-status");

const learnCountEl = document.getElementById("learn-count");
const reviewCountEl = document.getElementById("review-count");
const masteredCountEl = document.getElementById("mastered-count");

const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const speakBtn = document.getElementById("speak-btn");
const showBtn = document.getElementById("show-btn");
const knownBtn = document.getElementById("known-btn");
const vagueBtn = document.getElementById("vague-btn");
const unknownBtn = document.getElementById("unknown-btn");

const studyModeEl = document.getElementById("study-mode");
const unitSelectEl = document.getElementById("unit-select");

function nowTs() {
  return Date.now();
}

function daysToMs(days) {
  return days * 24 * 60 * 60 * 1000;
}

function shuffle(arr) {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function setSyncMsg(msg) {
  syncMsgEl.textContent = msg;
}

function setUserStatus(msg) {
  userStatusEl.textContent = msg;
}

function safeString(v) {
  return typeof v === "string" ? v : "";
}

function isValidWord(item) {
  return item &&
    typeof item === "object" &&
    safeString(item.id).trim() &&
    safeString(item.kr).trim() &&
    safeString(item.cn).trim() &&
    safeString(item.unit).trim();
}

function saveLocalProgressCache() {
  localStorage.setItem(LOCAL_PROGRESS_CACHE_KEY, JSON.stringify(wordProgress));
}

function loadLocalProgressCache() {
  try {
    const raw = localStorage.getItem(LOCAL_PROGRESS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalWordsCache(list) {
  localStorage.setItem(LOCAL_WORDS_CACHE_KEY, JSON.stringify(list));
}

function loadLocalWordsCache() {
  try {
    const raw = localStorage.getItem(LOCAL_WORDS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStudySettings() {
  const settings = {
    mode: studyModeEl.value,
    selectedUnit: unitSelectEl.value
  };
  localStorage.setItem(LOCAL_STUDY_SETTINGS_KEY, JSON.stringify(settings));
}

function loadStudySettings() {
  try {
    const raw = localStorage.getItem(LOCAL_STUDY_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { mode: "all", selectedUnit: "__all__" };
  } catch {
    return { mode: "all", selectedUnit: "__all__" };
  }
}

function mergeProgress(localData, cloudData) {
  const merged = { ...localData };

  for (const [progressKey, cloudValue] of Object.entries(cloudData || {})) {
    const localValue = merged[progressKey];
    if (!localValue) {
      merged[progressKey] = cloudValue;
      continue;
    }

    const localUpdated = Number(localValue.updatedAt || 0);
    const cloudUpdated = Number(cloudValue.updatedAt || 0);

    merged[progressKey] = cloudUpdated >= localUpdated ? cloudValue : localValue;
  }

  return merged;
}

function getProgressContext() {
  const mode = studyModeEl.value;
  const selectedUnit = unitSelectEl.value;

  if (mode === "unit") {
    if (selectedUnit && selectedUnit !== "__all__") {
      return `unit:${selectedUnit}`;
    }
    return "unit:__all__";
  }

  return "all";
}

function getProgressKey(word) {
  return `${getProgressContext()}::${word.id}`;
}

function getProgress(word) {
  const key = getProgressKey(word);
  return wordProgress[key] || { ...DEFAULT_PROGRESS };
}

function isMastered(progress) {
  return Boolean(progress.mastered || (progress.knownStreak || 0) >= 3);
}

function isNewWord(progress) {
  return !progress.lastResult || progress.lastResult === "new";
}

function getFilteredWords() {
  const mode = studyModeEl.value;
  const selectedUnit = unitSelectEl.value;

  if (mode === "unit" && selectedUnit !== "__all__") {
    return words.filter(word => word.unit === selectedUnit);
  }

  return words;
}

function updateStatusCounts() {
  const now = nowTs();
  const filteredWords = getFilteredWords();

  let learnCount = 0;
  let reviewCount = 0;
  let masteredCount = 0;

  filteredWords.forEach(word => {
    const progress = getProgress(word);
    const due = !progress.nextReview || now >= progress.nextReview;
    const mastered = isMastered(progress);
    const isNew = isNewWord(progress);

    if (mastered) {
      masteredCount += 1;
    }

    if (due) {
      if (isNew) {
        learnCount += 1;
      } else {
        reviewCount += 1;
      }
    }
  });

  learnCountEl.textContent = String(learnCount);
  reviewCountEl.textContent = String(reviewCount);
  masteredCountEl.textContent = String(masteredCount);
}

function buildReviewQueue() {
  const now = nowTs();
  const filteredWords = getFilteredWords();

  reviewQueue = filteredWords.filter((word) => {
    const data = getProgress(word);
    return !data.nextReview || now >= data.nextReview;
  });

  reviewQueue = shuffle(reviewQueue);
  updateStatusCounts();
}

function formatMeaning(word) {
  if (word.pos && word.pos.trim()) {
    return `[${word.pos}] ${word.cn}`;
  }
  return word.cn;
}

function hideMeaningImmediately() {
  cnEl.classList.remove("show");
  cnEl.style.transition = "none";
  void cnEl.offsetHeight;
}

function restoreMeaningTransition() {
  requestAnimationFrame(() => {
    cnEl.style.transition = "";
  });
}

function renderNext() {
  dueEl.innerText = String(reviewQueue.length);

  if (reviewQueue.length === 0) {
    currentWord = null;
    krEl.innerText = "🎉";
    cnEl.innerText = "当前模式下没有到期词汇";
    cnEl.classList.add("show");
    infoEl.innerHTML = `今天先到这里`;
    return;
  }

  currentWord = reviewQueue[0];
  const data = getProgress(currentWord);
  const contextText = getProgressContext();
  const masteredText = isMastered(data) ? ' &nbsp; 掌握：<span class="badge">已掌握</span>' : '';

  krEl.innerText = currentWord.kr;
  cnEl.innerText = formatMeaning(currentWord);

  infoEl.innerHTML = `
    单元：<span class="badge">${currentWord.unit}</span>
    &nbsp; 阶段：<span class="badge">${data.stage}</span>
    &nbsp; 连续记住：<span class="badge">${data.knownStreak || 0}</span>
    &nbsp; 模式进度：<span class="badge">${contextText}</span>
    ${masteredText}
  `;
}

function showTranslation() {
  cnEl.classList.add("show");
}

function speak() {
  if (!currentWord) return;
  if (!("speechSynthesis" in window)) {
    setSyncMsg("当前浏览器不支持语音合成。");
    return;
  }

  const msg = new SpeechSynthesisUtterance(currentWord.kr);
  msg.lang = "ko-KR";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(msg);
}

function updateUnitSelectState() {
  unitSelectEl.disabled = studyModeEl.value !== "unit";
}

function initUnitOptions() {
  const units = [...new Set(words.map(word => word.unit))];

  unitSelectEl.innerHTML = '<option value="__all__">全部单元</option>';

  units.forEach(unit => {
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = unit;
    unitSelectEl.appendChild(option);
  });

  const settings = loadStudySettings();
  studyModeEl.value = settings.mode || "all";

  const unitExists = units.includes(settings.selectedUnit);
  unitSelectEl.value = unitExists ? settings.selectedUnit : "__all__";

  updateUnitSelectState();
}

function initFirebase() {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (err) {
    firebaseEnabled = false;
    console.error("Firebase 初始化失败：", err);
    setSyncMsg("Firebase 初始化失败，目前仅可本机使用。");
  }
}

async function loadWords() {
  setSyncMsg("正在加载词库...");

  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`读取 data.json 失败：${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("data.json 顶层必须是数组。");
    }

    const validWords = data.filter(isValidWord);
    if (validWords.length === 0) {
      throw new Error("data.json 里没有有效词条。");
    }

    words = validWords;
    saveLocalWordsCache(validWords);
    initUnitOptions();
    setSyncMsg(`词库加载完成，共 ${validWords.length} 个词条。`);
  } catch (err) {
    console.error(err);
    const fallbackWords = loadLocalWordsCache();

    if (Array.isArray(fallbackWords) && fallbackWords.length > 0) {
      words = fallbackWords.filter(isValidWord);
      initUnitOptions();
      setSyncMsg("data.json 读取失败，已改用本地缓存词库。");
      return;
    }

    setSyncMsg("词库加载失败，请检查 data.json 格式。");
    infoEl.textContent = "data.json 加载失败";
    throw err;
  }
}

function getUserDocRef(uid) {
  return doc(db, "users", uid);
}

async function loadCloudProgress(uid) {
  const ref = getUserDocRef(uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return {};
  }

  const data = snap.data();
  return data.progress || {};
}

async function saveCloudProgress(uid) {
  if (!firebaseEnabled || !currentUser) return;

  const ref = getUserDocRef(uid);

  await setDoc(
    ref,
    {
      progress: wordProgress,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

async function syncAfterLogin(uid) {
  setSyncMsg("正在同步云端进度...");

  const localData = loadLocalProgressCache();
  const cloudData = await loadCloudProgress(uid);

  const hasCloudData = Object.keys(cloudData).length > 0;
  const hasLocalData = Object.keys(localData).length > 0;

  if (!hasCloudData && hasLocalData) {
    wordProgress = localData;
    await saveCloudProgress(uid);
    setSyncMsg("已将本机进度上传到云端。");
  } else if (hasCloudData && !hasLocalData) {
    wordProgress = cloudData;
    saveLocalProgressCache();
    setSyncMsg("已从云端下载进度。");
  } else if (hasCloudData && hasLocalData) {
    wordProgress = mergeProgress(localData, cloudData);
    saveLocalProgressCache();
    await saveCloudProgress(uid);
    setSyncMsg("本机与云端进度已合并同步。");
  } else {
    wordProgress = {};
    saveLocalProgressCache();
    setSyncMsg("这是一个新账号，进度从零开始。");
  }
}

function bindAuthEvents() {
  loginBtn.addEventListener("click", async () => {
    if (!firebaseEnabled) {
      setSyncMsg("Firebase 未启用，当前无法登录。");
      return;
    }

    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
      setSyncMsg("登录失败。若手机浏览器拦截弹窗，可改用 Chrome 再试。");
    }
  });

  logoutBtn.addEventListener("click", async () => {
    if (!firebaseEnabled) return;

    try {
      await signOut(auth);
      setSyncMsg("已退出登录，当前仅使用本机缓存。");
    } catch (err) {
      console.error(err);
      setSyncMsg("退出登录失败。");
    }
  });
}

function listenAuthState() {
  if (!firebaseEnabled) {
    wordProgress = loadLocalProgressCache();
    buildReviewQueue();
    renderNext();
    setUserStatus("未启用云同步（仅本机）");
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    try {
      currentUser = user || null;

      if (currentUser) {
        setUserStatus(`已登录：${currentUser.email || currentUser.uid}`);
        await syncAfterLogin(currentUser.uid);
      } else {
        setUserStatus("未登录（仅本机保存）");
        wordProgress = loadLocalProgressCache();
        setSyncMsg("当前未登录，学习进度仅保存在本机。");
      }

      buildReviewQueue();
      renderNext();
    } catch (err) {
      console.error(err);
      wordProgress = loadLocalProgressCache();
      buildReviewQueue();
      renderNext();
      setSyncMsg("读取进度失败，已回退到本机缓存。");
    }
  });
}

async function handleResult(result) {
  if (!currentWord) return;

  hideMeaningImmediately();

  const now = nowTs();
  const data = { ...getProgress(currentWord) };

  if (result === "known") {
    data.stage = Math.min(data.stage + 1, INTERVALS.length - 1);
    const days = INTERVALS[data.stage];
    data.nextReview = now + daysToMs(days);
    data.knownStreak = (data.knownStreak || 0) + 1;
    if (data.knownStreak >= 3) {
      data.mastered = true;
    }
  } else if (result === "vague") {
    data.nextReview = now + daysToMs(2);
    data.knownStreak = 0;
    data.mastered = false;
  } else {
    data.stage = 0;
    data.nextReview = now + daysToMs(1);
    data.knownStreak = 0;
    data.mastered = false;
  }

  data.lastResult = result;
  data.updatedAt = now;

  const key = getProgressKey(currentWord);
  wordProgress[key] = data;
  saveLocalProgressCache();

  reviewQueue.shift();
  buildReviewQueue();
  renderNext();
  restoreMeaningTransition();

  if (currentUser && firebaseEnabled) {
    try {
      setSyncMsg("正在同步到云端...");
      await saveCloudProgress(currentUser.uid);
      setSyncMsg("云端同步成功。");
    } catch (err) {
      console.error(err);
      setSyncMsg("云端同步失败，但本机已保存。");
    }
  } else {
    setSyncMsg("已保存到本机。");
  }
}

function bindStudyEvents() {
  showBtn.addEventListener("click", showTranslation);
  speakBtn.addEventListener("click", speak);
  knownBtn.addEventListener("click", () => handleResult("known"));
  vagueBtn.addEventListener("click", () => handleResult("vague"));
  unknownBtn.addEventListener("click", () => handleResult("unknown"));
}

function bindStudyModeEvents() {
  studyModeEl.addEventListener("change", () => {
    updateUnitSelectState();

    if (studyModeEl.value === "unit" && unitSelectEl.value === "__all__") {
      const firstRealUnit = [...unitSelectEl.options]
        .map(opt => opt.value)
        .find(v => v !== "__all__");
      if (firstRealUnit) {
        unitSelectEl.value = firstRealUnit;
      }
    }

    saveStudySettings();
    hideMeaningImmediately();
    buildReviewQueue();
    renderNext();
    restoreMeaningTransition();
  });

  unitSelectEl.addEventListener("change", () => {
    saveStudySettings();
    hideMeaningImmediately();
    buildReviewQueue();
    renderNext();
    restoreMeaningTransition();
  });
}

async function startApp() {
  bindStudyEvents();
  bindAuthEvents();
  bindStudyModeEvents();
  initFirebase();
  await loadWords();
  listenAuthState();
}

startApp();
