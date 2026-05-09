const STORAGE_KEY = "korea_vocab_progress_v2";
const LEGACY_STORAGE_KEY = "韩语背词_progress";
const INTERVALS = [1, 2, 4, 7, 15, 30];
const GROUP_SIZE = 10;

let words = [];
let currentWord = null;
let currentGroup = [];
let groupPendingSet = new Set();
let groupQueue = [];
let groupsDone = 0;
let mode = "learn";

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
  modeSelect: $("study-mode"),
  unitSelect: $("unit-select"),
  dailyLimit: $("daily-limit"),
  searchInput: $("search-input"),
  searchResults: $("search-results"),
  groupInfo: $("group-info"),
  groupProgress: $("group-progress"),
  syncMsg: $("sync-msg"),
  userStatus: $("user-status"),
  importFile: $("import-file")
};

$("show-btn").addEventListener("click", showMeaning);
$("known-btn").addEventListener("click", () => handleResult("known"));
$("vague-btn").addEventListener("click", () => handleResult("vague"));
$("unknown-btn").addEventListener("click", () => handleResult("unknown"));
$("reset-current-btn").addEventListener("click", resetCurrent);
$("reset-all-btn").addEventListener("click", resetAll);
$("speak-btn").addEventListener("click", speakCurrent);
$("export-btn").addEventListener("click", exportProgress);
els.importFile.addEventListener("change", importProgress);
els.modeSelect.addEventListener("change", startSession);
els.unitSelect.addEventListener("change", startSession);
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

async function load() {
  try {
    const response = await fetch("data.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    words = await response.json();
    initUnits();
    loadProgress();
    els.dailyLimit.value = String(state.settings.dailyLimit ?? 20);
    startSession();
    setSyncMessage("进度保存在本机。可用导出/导入在设备间迁移，接入云端后可自动同步。", "info");
  } catch (error) {
    setSyncMessage("词库加载失败，请检查 data.json。", "danger");
  }
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

function getTodayLearnedCount() {
  const today = todayStart();
  return getFilteredWords().filter((word) => getProgress(word).learnedDay === today).length;
}

function getNewWords() {
  const newWords = getFilteredWords().filter((word) => getProgress(word).stage === -1);
  const limit = Number(els.dailyLimit.value);
  if (!limit) return newWords;
  return newWords.slice(0, Math.max(limit - getTodayLearnedCount(), 0));
}

function startSession() {
  groupsDone = 0;
  const reviewWords = getReviewWords();
  const newWords = getNewWords();

  if (reviewWords.length > 0) {
    mode = "review";
    loadNextGroup(reviewWords);
  } else if (newWords.length > 0) {
    mode = "learn";
    loadNextGroup(newWords);
  } else {
    showAllDone();
  }

  updateCounts();
}

function loadNextGroup(wordPool) {
  currentGroup = wordPool.slice(0, GROUP_SIZE);
  if (currentGroup.length === 0) {
    showAllDone();
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
  els.groupInfo.innerText = `${mode === "learn" ? "学习" : "复习"}模式 · 第 ${groupsDone + 1} 组`;
  els.groupProgress.innerText = `本组进度：${done} / ${total}`;
}

function renderNext() {
  if (groupQueue.length === 0) {
    if (groupPendingSet.size === 0) {
      groupsDone += 1;
      onGroupComplete();
      return;
    }
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
  const progress = getProgress(currentWord);
  progress.lastResult = type;
  progress.totalReviews = (progress.totalReviews || 0) + 1;
  progress.updatedAt = Date.now();

  if (type === "known") {
    progress.knownStreak = (progress.knownStreak || 0) + 1;
    progress.mastered = progress.knownStreak >= 3;

    if (progress.stage === -1) {
      progress.stage = 0;
      progress.learnedDay = today;
      progress.nextReview = tomorrowStart();
    } else {
      progress.stage = Math.min(progress.stage + 1, INTERVALS.length - 1);
      progress.nextReview = today + daysToMs(INTERVALS[progress.stage]);
    }

    groupPendingSet.delete(currentWord.id);
  } else {
    progress.knownStreak = 0;
    progress.mastered = false;
    progress.mistakes = (progress.mistakes || 0) + 1;
    progress.stage = Math.max(progress.stage, 0);
    if (type === "vague" && progress.stage > 0) {
      progress.stage -= 1;
    }
    progress.nextReview = tomorrowStart();
    groupQueue.push(currentWord);
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
    const remaining = mode === "learn" ? getNewWords() : getReviewWords();
    if (remaining.length > 0) {
      loadNextGroup(remaining);
      return;
    }
    startSession();
  }, 900);
}

function showAllDone() {
  currentWord = null;
  els.kr.innerText = "今日完成";
  els.cn.innerText = getReviewWords().length === 0 && getNewWords().length === 0
    ? "当前范围没有到期复习，或今日新词额度已用完。"
    : "今天的任务全部完成。";
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

  getFilteredWords().forEach((word) => {
    const progress = getProgress(word);
    if (progress.mastered) mastered += 1;
    if (progress.stage === -1) learn += 1;
    if (progress.stage !== -1 && progress.nextReview !== null && today >= progress.nextReview) review += 1;
  });

  els.learnCount.innerText = learn;
  els.reviewCount.innerText = review;
  els.masteredCount.innerText = mastered;
  els.todayNewCount.innerText = getTodayLearnedCount();
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
  startSession();
}

function setSyncMessage(message, type = "info") {
  els.syncMsg.innerText = message;
  els.syncMsg.dataset.type = type;
  els.userStatus.innerText = "本机保存 · 可导入/导出";
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
