import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STORAGE_KEY = "korea_vocab_progress_v2";
const LEGACY_STORAGE_KEY = "韩语背词_progress";
const INTERVALS = [1, 2, 4, 7, 15, 30];
const GROUP_SIZE = 10;

const firebaseConfig = {
  apiKey: "AIzaSyB50lA92DSngs6y98PgK1thovNM4liPycU",
  authDomain: "korea-83b2a.firebaseapp.com",
  projectId: "korea-83b2a",
  storageBucket: "korea-83b2a.firebasestorage.app",
  messagingSenderId: "559427597840",
  appId: "1:559427597840:web:49f2decb6ff3753033fc95",
  measurementId: "G-W2MK1L42X0"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const provider = new GoogleAuthProvider();

let words = [];
let currentWord = null;
let currentGroup = [];
let groupPendingSet = new Set();
let groupQueue = [];
let groupsDone = 0;
let mode = "learn";
let activeTask = "new";
let currentUser = null;
let cloudReady = false;
let syncTimer = null;

let state = {
  version: 2,
  updatedAt: null,
  progress: {},
  settings: {
    dailyLimit: 20
  }
};

const $ = (id) => document.getElementById(id);

const els = {
  kr: $("kr"),
  cn: $("cn"),
  info: $("unit-info"),
  learnCount: $("learn-count"),
  reviewCount: $("review-count"),
  masteredCount: $("mastered-count"),
  todayNewCount: $("today-new-count"),
  hardCount: $("hard-count"),
  modeSelect: $("study-mode"),
  unitSelect: $("unit-select"),
  dailyLimit: $("daily-limit"),
  searchInput: $("search-input"),
  searchResults: $("search-results"),
  groupInfo: $("group-info"),
  groupProgress: $("group-progress"),
  syncMsg: $("sync-msg"),
  userStatus: $("user-status"),
  importFile: $("import-file"),
  loginBtn: $("login-btn"),
  logoutBtn: $("logout-btn"),
  taskNewBtn: $("task-new-btn"),
  taskDueBtn: $("task-due-btn"),
  taskTodayBtn: $("task-today-btn"),
  taskHardBtn: $("task-hard-btn")
};

$("show-btn").addEventListener("click", showMeaning);
$("known-btn").addEventListener("click", () => handleResult("known"));
$("vague-btn").addEventListener("click", () => handleResult("vague"));
$("unknown-btn").addEventListener("click", () => handleResult("unknown"));
$("reset-current-btn").addEventListener("click", resetCurrent);
$("reset-all-btn").addEventListener("click", resetAll);
$("speak-btn").addEventListener("click", speakCurrent);
$("export-btn").addEventListener("click", exportProgress);
els.loginBtn.addEventListener("click", loginWithGoogle);
els.logoutBtn.addEventListener("click", logout);
els.importFile.addEventListener("change", importProgress);
els.taskNewBtn.addEventListener("click", () => setActiveTask("new"));
els.taskDueBtn.addEventListener("click", () => setActiveTask("due"));
els.taskTodayBtn.addEventListener("click", () => setActiveTask("today"));
els.taskHardBtn.addEventListener("click", () => setActiveTask("hard"));
els.modeSelect.addEventListener("change", () => startSession());
els.unitSelect.addEventListener("change", () => startSession());
els.dailyLimit.addEventListener("change", () => {
  state.settings.dailyLimit = Number(els.dailyLimit.value);
  saveProgress();
  startSession();
});
els.searchInput.addEventListener("input", renderSearchResults);

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, select")) return;
  if (event.key === " ") {
    event.preventDefault();
    showMeaning();
  }
  if (event.key === "1") handleResult("known");
  if (event.key === "2") handleResult("vague");
  if (event.key === "3") handleResult("unknown");
  if (event.key.toLowerCase() === "p") speakCurrent();
});

load();
initAuth();

async function load() {
  try {
    const response = await fetch("data.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    words = await response.json();
    initUnits();
    loadProgress();
    els.dailyLimit.value = String(state.settings.dailyLimit ?? 20);
    startSession();
    setSyncMessage("进度保存在本机。登录 Google 后会自动同步到云端。", "info");
  } catch (error) {
    setSyncMessage("词库加载失败，请检查 data.json。", "danger");
  }
}

function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    cloudReady = false;
    els.loginBtn.hidden = Boolean(user);
    els.logoutBtn.hidden = !user;

    if (!user) {
      updateUserStatus();
      setSyncMessage("未登录：进度只保存在本机。", "info");
      return;
    }

    updateUserStatus();
    setSyncMessage("正在同步云端进度...", "info");

    try {
      await loadCloudProgress();
      cloudReady = true;
      saveProgress();
      startSession();
      setSyncMessage("云端同步已开启。", "success");
    } catch (error) {
      setSyncMessage(`云端同步失败：${formatFirebaseError(error)}`, "danger");
    }
  });
}

function initUnits() {
  const units = [...new Set(words.map((word) => word.unit))];
  units.forEach((unit) => {
    const option = document.createElement("option");
    option.value = unit;
    option.innerText = unit;
    els.unitSelect.appendChild(option);
  });
}

function todayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function tomorrowStart() {
  return todayStart() + 86400000;
}

function daysToMs(days) {
  return days * 86400000;
}

function getScopeKey() {
  if (els.modeSelect.value === "unit" && els.unitSelect.value !== "__all__") {
    return `unit:${els.unitSelect.value}`;
  }
  return "all";
}

function getKey(word) {
  return `${getScopeKey()}_${word.id}`;
}

function getProgress(word) {
  const key = getKey(word);
  if (!state.progress[key]) {
    const legacyKey = `${els.modeSelect.value}_${word.id}`;
    if (state.progress[legacyKey]) {
      state.progress[key] = state.progress[legacyKey];
      delete state.progress[legacyKey];
    }
  }
  if (!state.progress[key]) {
    state.progress[key] = {
      stage: -1,
      nextReview: null,
      knownStreak: 0,
      mastered: false,
      learnedDay: null,
      lastResult: null,
      totalReviews: 0,
      mistakes: 0,
      todayReviewDone: false,
      lastKnownDay: null,
      lastReviewDay: null,
      dailyHistory: {},
      updatedAt: null
    };
  }
  return state.progress[key];
}

function getFilteredWords() {
  if (els.modeSelect.value === "all") return words;
  if (els.unitSelect.value === "__all__") return words;
  return words.filter((word) => word.unit === els.unitSelect.value);
}

function getReviewWords() {
  const today = todayStart();
  return getFilteredWords().filter((word) => {
    const progress = getProgress(word);
    return progress.stage !== -1 && progress.nextReview !== null && today >= progress.nextReview;
  });
}

function getHardWordRate(progress) {
  const mistakes = progress.mistakes || 0;
  const totalReviews = progress.totalReviews || 0;
  if (progress.stage === -1 || totalReviews === 0 || mistakes === 0) return 0;
  return mistakes / totalReviews;
}

function getHardWords() {
  return getFilteredWords()
    .map((word) => ({
      word,
      rate: getHardWordRate(getProgress(word))
    }))
    .filter((item) => item.rate > 0)
    .sort((a, b) => b.rate - a.rate || a.word.id.localeCompare(b.word.id))
    .slice(0, 30)
    .map((item) => item.word);
}

function getTodayLearnedCount() {
  const today = todayStart();
  return getFilteredWords().filter((word) => getProgress(word).learnedDay === today).length;
}

function getTodayReviewWords() {
  const today = todayStart();
  return getFilteredWords().filter((word) => {
    const progress = getProgress(word);
    return progress.learnedDay === today && progress.stage !== -1 && !progress.todayReviewDone;
  });
}

function getNewWordCandidates() {
  return getFilteredWords().filter((word) => getProgress(word).stage === -1);
}

function getNewWordLimit() {
  const limit = Number(els.dailyLimit.value);
  if (!limit) return Infinity;
  return Math.max(limit - getTodayLearnedCount(), 0);
}

function getNewWords() {
  const newWords = getNewWordCandidates();
  const limit = getNewWordLimit();
  if (limit === Infinity) return newWords;
  return takeRandom(newWords, limit);
}

function setActiveTask(task) {
  activeTask = task;
  startSession();
}

function startSession() {
  groupsDone = 0;
  updateTaskTabs();

  const dueWords = getReviewWords();
  const todayWords = getTodayReviewWords();
  const hardWords = getHardWords();
  const newWords = getNewWords();

  if (activeTask === "due") {
    mode = "review";
    loadNextGroup(dueWords);
  } else if (activeTask === "today") {
    mode = "today";
    loadNextGroup(todayWords);
  } else if (activeTask === "hard") {
    mode = "hard";
    loadNextGroup(hardWords);
  } else {
    mode = "learn";
    loadNextGroup(newWords);
  }

  updateCounts();
}

function loadNextGroup(wordPool) {
  currentGroup = takeRandom(wordPool, GROUP_SIZE);
  if (currentGroup.length === 0) {
    showTaskDone();
    return;
  }

  groupPendingSet = new Set(currentGroup.map((word) => word.id));
  groupQueue = shuffle([...currentGroup]);
  renderGroupInfo();
  renderNext();
}

function renderGroupInfo() {
  const total = currentGroup.length;
  const pending = groupPendingSet.size;
  const done = total - pending;
  els.groupInfo.innerText = `${getTaskLabel()} · 第 ${groupsDone + 1} 组`;
  els.groupProgress.innerText = `本组进度：${done} / ${total}`;
}

function renderNext() {
  if (groupQueue.length === 0) {
    if (groupPendingSet.size === 0) {
      groupsDone += 1;
      onGroupComplete();
      return;
    }
    // Start the next pass only after the current pass has shown every queued word.
    groupQueue = shuffle(currentGroup.filter((word) => groupPendingSet.has(word.id)));
  }

  currentWord = groupQueue.shift();
  const progress = getProgress(currentWord);
  const stageLabel = progress.stage === -1 ? "新词" : `阶段 ${progress.stage}`;
  const nextReview = formatNextReview(progress.nextReview);

  els.kr.innerText = currentWord.kr;
  els.cn.innerText = `[${currentWord.pos}] ${currentWord.cn}`;
  els.cn.classList.remove("show");
  els.info.innerText = `${currentWord.unit} · ${stageLabel} · 连续记住 ${progress.knownStreak} 次${progress.mastered ? " · 已掌握" : ""}${nextReview}`;

  renderGroupInfo();
  updateCounts();
}

function showMeaning() {
  els.cn.classList.add("show");
}

function handleResult(type) {
  if (!currentWord) return;

  const today = todayStart();
  const todayKey = formatDateKey(today);
  const progress = getProgress(currentWord);
  progress.lastResult = type;
  progress.totalReviews = (progress.totalReviews || 0) + 1;
  progress.updatedAt = Date.now();
  recordDailyHistory(progress, todayKey, type);

  if (type === "known") {
    if (progress.lastKnownDay !== today) {
      progress.knownStreak = (progress.knownStreak || 0) + 1;
      progress.lastKnownDay = today;
      progress.lastReviewDay = today;
      progress.mastered = progress.knownStreak >= 3;
    }

    if (progress.stage === -1) {
      progress.stage = 0;
      progress.learnedDay = today;
      progress.nextReview = tomorrowStart();
    } else if (mode === "today") {
      progress.todayReviewDone = true;
      progress.nextReview = tomorrowStart();
    } else {
      progress.stage = Math.min(progress.stage + 1, INTERVALS.length - 1);
      progress.nextReview = today + daysToMs(INTERVALS[progress.stage]);
    }

    groupPendingSet.delete(currentWord.id);
  } else {
    if (progress.lastReviewDay !== today) {
      progress.knownStreak = 0;
      progress.lastReviewDay = today;
    }
    progress.mastered = false;
    progress.mistakes = (progress.mistakes || 0) + 1;
    if (mode === "learn" && progress.stage === -1) {
      progress.nextReview = null;
    } else {
      progress.stage = Math.max(progress.stage, 0);
      if ((mode === "review" || mode === "hard") && type === "vague" && progress.stage > 0) {
        progress.stage -= 1;
      }
      progress.nextReview = tomorrowStart();
    }
    groupPendingSet.add(currentWord.id);
  }

  saveProgress();
  renderNext();
}

function onGroupComplete() {
  currentWord = null;
  els.kr.innerText = "完成";
  els.cn.innerText = `第 ${groupsDone} 组完成`;
  els.cn.classList.add("show");
  els.info.innerText = "";
  els.groupProgress.innerText = "";

  window.setTimeout(() => {
    const remaining = getActiveTaskWords();
    if (remaining.length > 0) {
      loadNextGroup(remaining);
      return;
    }
    startSession();
  }, 900);
}

function showTaskDone() {
  currentWord = null;
  els.kr.innerText = "当前任务完成";
  els.cn.innerText = getEmptyTaskMessage();
  els.cn.classList.add("show");
  els.info.innerText = "";
  els.groupInfo.innerText = "";
  els.groupProgress.innerText = "";
  updateCounts();
}

function updateCounts() {
  const today = todayStart();
  let learn = 0;
  let review = 0;
  let mastered = 0;
  let hard = 0;

  getFilteredWords().forEach((word) => {
    const progress = getProgress(word);
    if (progress.mastered) mastered += 1;
    if (progress.stage === -1) learn += 1;
    if (progress.stage !== -1 && progress.nextReview !== null && today >= progress.nextReview) review += 1;
  });

  hard = getHardWords().length;

  els.learnCount.innerText = learn;
  els.reviewCount.innerText = review;
  els.masteredCount.innerText = mastered;
  els.todayNewCount.innerText = getTodayLearnedCount();
  els.hardCount.innerText = hard;
  updateTaskTabs();
}

function renderSearchResults() {
  const query = els.searchInput.value.trim().toLowerCase();
  els.searchResults.innerHTML = "";

  if (!query) {
    els.searchResults.hidden = true;
    return;
  }

  const matches = words
    .filter((word) => [word.kr, word.cn, word.pos, word.unit].some((value) => String(value).toLowerCase().includes(query)))
    .slice(0, 12);

  matches.forEach((word) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-item";
    item.innerHTML = `<strong>${escapeHtml(word.kr)}</strong><span>${escapeHtml(word.cn)}</span><small>${escapeHtml(word.unit)} · ${escapeHtml(word.pos)}</small>`;
    item.addEventListener("click", () => {
      currentWord = word;
      currentGroup = [word];
      groupPendingSet = new Set([word.id]);
      groupQueue = [];
      els.searchInput.value = "";
      els.searchResults.hidden = true;
      renderNextFromSearch(word);
    });
    els.searchResults.appendChild(item);
  });

  if (matches.length === 0) {
    els.searchResults.innerHTML = `<div class="empty-result">没有找到匹配单词</div>`;
  }
  els.searchResults.hidden = false;
}

function renderNextFromSearch(word) {
  const progress = getProgress(word);
  currentWord = word;
  els.kr.innerText = word.kr;
  els.cn.innerText = `[${word.pos}] ${word.cn}`;
  els.cn.classList.add("show");
  els.info.innerText = `${word.unit} · ${progress.stage === -1 ? "新词" : `阶段 ${progress.stage}`}`;
  els.groupInfo.innerText = "搜索预览";
  els.groupProgress.innerText = "";
}

function getActiveTaskWords() {
  if (activeTask === "due") return getReviewWords();
  if (activeTask === "today") return getTodayReviewWords();
  if (activeTask === "hard") return getHardWords();
  return getNewWords();
}

function getTaskLabel() {
  if (mode === "review") return "到期复习";
  if (mode === "today") return "复习今日新词";
  if (mode === "hard") return "顽固词";
  return "学习新词";
}

function getEmptyTaskMessage() {
  if (activeTask === "due") return "当前范围没有到期复习。";
  if (activeTask === "today") return "今天新学的单词已复习完，或今天还没有新学单词。";
  if (activeTask === "hard") return "当前范围没有顽固词。连续记住后，词会自动离开这个分区。";
  return "当前范围今日新词额度已用完，或没有未学单词。";
}

function updateTaskTabs() {
  const buttons = {
    new: els.taskNewBtn,
    due: els.taskDueBtn,
    today: els.taskTodayBtn,
    hard: els.taskHardBtn
  };

  Object.entries(buttons).forEach(([task, button]) => {
    button.classList.toggle("active", activeTask === task);
  });

  els.taskNewBtn.innerText = `学习新词 ${Math.min(getNewWordCandidates().length, getNewWordLimit())}`;
  els.taskDueBtn.innerText = `到期复习 ${getReviewWords().length}`;
  els.taskTodayBtn.innerText = `复习今日新词 ${getTodayReviewWords().length}`;
  els.taskHardBtn.innerText = `顽固词 ${getHardWords().length}`;
}

function speakCurrent() {
  if (!currentWord || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(currentWord.kr);
  utterance.lang = "ko-KR";
  window.speechSynthesis.speak(utterance);
}

function saveProgress() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSave();
}

function recordDailyHistory(progress, dayKey, result) {
  progress.dailyHistory ||= {};
  const day = progress.dailyHistory[dayKey] || {
    firstResult: result,
    attempts: 0
  };
  day.attempts = (day.attempts || 0) + 1;
  progress.dailyHistory[dayKey] = day;
}

function formatDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadProgress() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      state = { ...state, ...JSON.parse(raw) };
      state.progress ||= {};
      state.settings ||= { dailyLimit: 20 };
      return;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    try {
      state.progress = JSON.parse(legacy);
      saveProgress();
      return;
    } catch {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `korea-progress-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importProgress(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      state = mergeState(state, imported);
      saveProgress();
      startSession();
      setSyncMessage("进度已导入并合并。", "success");
    } catch {
      setSyncMessage("导入失败，请选择有效的进度 JSON 文件。", "danger");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function mergeState(localState, incomingState) {
  const incomingProgress = incomingState.progress || incomingState;
  const merged = {
    ...localState,
    progress: { ...localState.progress },
    settings: { ...localState.settings, ...(incomingState.settings || {}) }
  };

  Object.entries(incomingProgress).forEach(([key, value]) => {
    const local = merged.progress[key];
    if (!local || (value.updatedAt || 0) > (local.updatedAt || 0)) {
      merged.progress[key] = value;
    }
  });

  return merged;
}

async function loginWithGoogle() {
  try {
    setSyncMessage("正在打开 Google 登录...", "info");
    await signInWithPopup(auth, provider);
  } catch (error) {
    setSyncMessage(`登录失败：${formatFirebaseError(error)}`, "danger");
  }
}

async function logout() {
  try {
    await flushCloudSave();
    await signOut(auth);
  } catch (error) {
    setSyncMessage(`退出失败：${formatFirebaseError(error)}`, "danger");
  }
}

function getCloudDocRef() {
  if (!currentUser) return null;
  return doc(db, "users", currentUser.uid, "vocab", "progress");
}

async function loadCloudProgress() {
  const ref = getCloudDocRef();
  if (!ref) return;

  const snapshot = await getDoc(ref);
  if (snapshot.exists()) {
    const data = snapshot.data();
    const cloudState = data.stateJson ? JSON.parse(data.stateJson) : data.state;
    if (cloudState) {
      state = mergeState(state, cloudState);
    }
  }

  await saveCloudProgress();
}

function scheduleCloudSave() {
  if (!currentUser || !cloudReady) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    saveCloudProgress().catch((error) => {
      setSyncMessage(`云端保存失败：${formatFirebaseError(error)}。本机进度仍已保存。`, "danger");
    });
  }, 600);
}

async function flushCloudSave() {
  if (!currentUser || !cloudReady) return;
  window.clearTimeout(syncTimer);
  await saveCloudProgress();
}

async function saveCloudProgress() {
  const ref = getCloudDocRef();
  if (!ref) return;

  await setDoc(ref, {
    uid: currentUser.uid,
    email: currentUser.email || null,
    stateJson: JSON.stringify(state),
    updatedAt: serverTimestamp()
  });

  setSyncMessage("云端同步已保存。", "success");
}

function resetCurrent() {
  if (!confirm("确定重置当前范围的进度吗？")) return;
  const scope = getScopeKey();
  Object.keys(state.progress).forEach((key) => {
    if (key.startsWith(`${scope}_`)) delete state.progress[key];
  });
  saveProgress();
  startSession();
}

function resetAll() {
  if (!confirm("确定清空全部进度吗？")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  state.progress = {};
  saveProgress();
  startSession();
}

function setSyncMessage(message, type = "info") {
  els.syncMsg.innerText = message;
  els.syncMsg.dataset.type = type;
  updateUserStatus();
}

function updateUserStatus() {
  if (currentUser) {
    els.userStatus.innerText = `已登录 · ${currentUser.email || currentUser.displayName || "Google 账号"}`;
    return;
  }
  els.userStatus.innerText = "本机保存 · 可导入/导出";
}

function formatFirebaseError(error) {
  const code = error?.code || "unknown";
  const message = error?.message || "未知错误";
  const hints = {
    "permission-denied": "权限被拒绝，请检查 Firestore 规则是否已发布。",
    "unavailable": "Firestore 暂时不可用或网络连接失败。",
    "not-found": "Firestore 数据库可能还没有创建。",
    "failed-precondition": "Firestore 数据库或索引配置未完成。",
    "auth/unauthorized-domain": "当前网站域名没有加入 Firebase Authentication 授权域名。",
    "auth/popup-closed-by-user": "登录弹窗被关闭。",
    "auth/operation-not-allowed": "Google 登录方式还没有启用。"
  };
  return `${code} · ${hints[code] || message}`;
}

function formatNextReview(timestamp) {
  if (!timestamp) return "";
  const days = Math.ceil((timestamp - todayStart()) / 86400000);
  if (days <= 0) return " · 今天复习";
  if (days === 1) return " · 明天复习";
  return ` · ${days} 天后复习`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function takeRandom(array, count) {
  return shuffle([...array]).slice(0, count);
}
