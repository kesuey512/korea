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
const DEFAULT_PRACTICE_MODE = "choice";

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
let awaitingCopyPractice = false;
let quizLocked = false;

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
  quizOptions: $("quiz-options"),
  quizFeedback: $("quiz-feedback"),
  relatedWords: $("related-words"),
  sentencePractice: $("sentence-practice"),
  sentenceInput: $("sentence-input"),
  saveSentenceBtn: $("save-sentence-btn"),
  sentenceMsg: $("sentence-msg"),
  copyPractice: $("copy-practice"),
  copyInput: $("copy-input"),
  copySubmitBtn: $("copy-submit-btn"),
  copyMsg: $("copy-msg"),
  info: $("unit-info"),
  learnCount: $("learn-count"),
  reviewCount: $("review-count"),
  masteredCount: $("mastered-count"),
  todayNewCount: $("today-new-count"),
  hardCount: $("hard-count"),
  practiceMode: $("practice-mode"),
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
  showBtn: $("show-btn"),
  revealRow: $("reveal-row"),
  resultRow: $("result-row"),
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
els.saveSentenceBtn.addEventListener("click", saveCurrentSentence);
els.copySubmitBtn.addEventListener("click", submitCopyPractice);
els.copyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitCopyPractice();
});
els.loginBtn.addEventListener("click", loginWithGoogle);
els.logoutBtn.addEventListener("click", logout);
els.importFile.addEventListener("change", importProgress);
els.taskNewBtn.addEventListener("click", () => setActiveTask("new"));
els.taskDueBtn.addEventListener("click", () => setActiveTask("due"));
els.taskTodayBtn.addEventListener("click", () => setActiveTask("today"));
els.taskHardBtn.addEventListener("click", () => setActiveTask("hard"));
els.practiceMode.addEventListener("change", () => startSession());
els.modeSelect.addEventListener("change", () => startSession());
els.unitSelect.addEventListener("change", () => startSession());
els.dailyLimit.addEventListener("change", () => {
  state.settings.dailyLimit = Number(els.dailyLimit.value);
  saveProgress();
  startSession();
});
els.searchInput.addEventListener("input", renderSearchResults);

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, select, textarea")) return;
  if (awaitingCopyPractice) return;
  if (isChoicePractice()) {
    const choiceIndex = Number(event.key) - 1;
    if (choiceIndex >= 0 && choiceIndex <= 3) {
      event.preventDefault();
      selectQuizOption(choiceIndex);
    }
    if (event.key.toLowerCase() === "p") speakCurrent();
    return;
  }
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
    setDefaultPracticeMode();
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

function getAllProgressForWord(word) {
  return Object.entries(state.progress)
    .filter(([key]) => key.endsWith(`_${word.id}`))
    .map(([, progress]) => progress);
}

function getHardWordStats(word) {
  const records = getAllProgressForWord(word);
  const totals = records.reduce(
    (stats, progress) => {
      stats.mistakes += progress.mistakes || 0;
      stats.totalReviews += progress.totalReviews || 0;
      if (progress.stage !== -1) stats.learned = true;
      return stats;
    },
    { mistakes: 0, totalReviews: 0, learned: false }
  );

  if (!totals.learned || totals.totalReviews === 0 || totals.mistakes === 0) {
    return { rate: 0, mistakes: totals.mistakes, totalReviews: totals.totalReviews };
  }

  return {
    rate: totals.mistakes / totals.totalReviews,
    mistakes: totals.mistakes,
    totalReviews: totals.totalReviews
  };
}

function getHardWords() {
  return words
    .map((word) => ({
      word,
      stats: getHardWordStats(word)
    }))
    .filter((item) => item.stats.rate > 0)
    .sort(
      (a, b) =>
        b.stats.rate - a.stats.rate ||
        b.stats.mistakes - a.stats.mistakes ||
        b.stats.totalReviews - a.stats.totalReviews ||
        a.word.id.localeCompare(b.word.id)
    )
    .slice(0, 30)
    .map((item) => item.word);
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[，,；;。！？!?（）()、\s]/g, "");
}

function getTextChunks(value, size = 2) {
  const text = normalizeText(value);
  if (!text) return [];
  if (text.length <= size) return [text];
  const chunks = [];
  for (let index = 0; index <= text.length - size; index += 1) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function getOverlapScore(source, target) {
  const sourceChunks = new Set(getTextChunks(source));
  const targetChunks = new Set(getTextChunks(target));
  if (sourceChunks.size === 0 || targetChunks.size === 0) return 0;
  let overlap = 0;
  sourceChunks.forEach((chunk) => {
    if (targetChunks.has(chunk)) overlap += 1;
  });
  return overlap / Math.max(sourceChunks.size, targetChunks.size);
}

function getCharacterOverlapScore(source, target) {
  const sourceChars = new Set(normalizeText(source));
  const targetChars = new Set(normalizeText(target));
  if (sourceChars.size === 0 || targetChars.size === 0) return 0;
  let overlap = 0;
  sourceChars.forEach((char) => {
    if (targetChars.has(char)) overlap += 1;
  });
  return overlap / Math.max(sourceChars.size, targetChars.size);
}

function hasSimilarMeaning(source, target) {
  if (!normalizeText(target.cn) || normalizeText(source.cn) === normalizeText(target.cn)) return true;
  return getOverlapScore(source.cn, target.cn) >= 0.3 || getCharacterOverlapScore(source.cn, target.cn) >= 0.45;
}

function getRelatedWordScore(source, target) {
  if (source.id === target.id) return 0;
  const krScore = getOverlapScore(source.kr, target.kr);
  const cnScore = getOverlapScore(source.cn, target.cn);
  const sameUnitBonus = source.unit === target.unit ? 0.08 : 0;
  const samePosBonus = source.pos === target.pos ? 0.05 : 0;
  return krScore * 0.58 + cnScore * 0.32 + sameUnitBonus + samePosBonus;
}

function getMeaningDistractorScore(source, target) {
  if (source.id === target.id) return 0;
  if (hasSimilarMeaning(source, target)) return 0;
  const krChunkScore = getOverlapScore(source.kr, target.kr);
  const krCharScore = getCharacterOverlapScore(source.kr, target.kr);
  if (krChunkScore === 0 && krCharScore < 0.35) return 0;
  const sameUnitBonus = source.unit === target.unit ? 0.08 : 0;
  const samePosBonus = source.pos === target.pos ? 0.12 : 0;
  return krChunkScore * 0.52 + krCharScore * 0.28 + samePosBonus + sameUnitBonus;
}

function getQuizOptions(word) {
  const correct = {
    word,
    text: formatChoiceText(word),
    correct: true
  };
  const usedMeanings = new Set([normalizeText(word.cn)]);
  const rankedDistractors = words
    .map((candidate) => ({
      word: candidate,
      score: getMeaningDistractorScore(word, candidate)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id))
    .map((item) => item.word);

  const fallbackDistractors = shuffle(
    words.filter((candidate) => candidate.id !== word.id && !hasSimilarMeaning(word, candidate))
  );
  const options = [correct];

  [...rankedDistractors, ...fallbackDistractors].forEach((candidate) => {
    if (options.length >= 4) return;
    const key = normalizeText(candidate.cn);
    if (!key || usedMeanings.has(key)) return;
    usedMeanings.add(key);
    options.push({
      word: candidate,
      text: formatChoiceText(candidate),
      correct: false
    });
  });

  return shuffle(options);
}

function formatChoiceText(word) {
  return `[${word.pos}] ${word.cn}`;
}

function resolveRelatedWords(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === "object" && value) return value;
      return words.find((word) => word.id === value || word.kr === value);
    })
    .filter(Boolean);
}

function getAutoConfusingWords(word) {
  return words
    .map((candidate) => ({
      word: candidate,
      score: getRelatedWordScore(word, candidate)
    }))
    .filter((item) => item.score >= 0.2)
    .sort((a, b) => b.score - a.score || a.word.id.localeCompare(b.word.id))
    .slice(0, 5)
    .map((item) => item.word);
}

function getRelatedWordGroups(word) {
  const synonyms = resolveRelatedWords(word.synonyms);
  const antonyms = resolveRelatedWords(word.antonyms);
  const manualSimilar = resolveRelatedWords(word.similar);
  const manualIds = new Set([...synonyms, ...antonyms, ...manualSimilar].map((item) => item.id || item.kr));
  const autoSimilar = getAutoConfusingWords(word).filter((item) => !manualIds.has(item.id));
  return [
    { title: "近义词", items: synonyms },
    { title: "反义词", items: antonyms },
    { title: "易混淆词", items: [...manualSimilar, ...autoSimilar].slice(0, 5) }
  ].filter((group) => group.items.length > 0);
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
  awaitingCopyPractice = false;
  quizLocked = false;
  const progress = getProgress(currentWord);
  const stageLabel = progress.stage === -1 ? "新词" : `阶段 ${progress.stage}`;
  const nextReview = formatNextReview(progress.nextReview);

  els.kr.innerText = currentWord.kr;
  els.cn.innerText = `[${currentWord.pos}] ${currentWord.cn}`;
  els.cn.classList.remove("show");
  hideQuizOptions();
  renderPracticeControls();
  if (isChoicePractice()) {
    renderQuizOptions(currentWord);
  }
  renderRelatedWords(currentWord);
  els.relatedWords.hidden = true;
  if (mode === "hard") {
    renderSentencePractice(currentWord);
    els.sentencePractice.hidden = true;
  } else {
    hideSentencePractice();
  }
  hideCopyPractice();
  els.info.innerText = `${currentWord.unit} · ${stageLabel} · 连续记住 ${progress.knownStreak} 次${progress.mastered ? " · 已掌握" : ""}${nextReview}`;

  renderGroupInfo();
  updateCounts();
}

function showMeaning() {
  els.cn.classList.add("show");
  if (mode === "hard" && els.relatedWords.innerHTML) {
    els.relatedWords.hidden = false;
  }
  if (mode === "hard") {
    els.sentencePractice.hidden = false;
  }
}

function isChoicePractice() {
  return els.practiceMode.value === "choice";
}

function setDefaultPracticeMode() {
  els.practiceMode.value = DEFAULT_PRACTICE_MODE;
}

function renderPracticeControls() {
  const choice = isChoicePractice();
  els.revealRow.hidden = false;
  els.showBtn.hidden = choice;
  els.resultRow.hidden = choice;
  els.quizOptions.hidden = !choice;
}

function renderQuizOptions(word) {
  const options = getQuizOptions(word);
  els.quizOptions.innerHTML = "";
  els.quizFeedback.innerText = "";
  els.quizFeedback.hidden = true;

  options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiz-option";
    button.dataset.correct = String(option.correct);
    button.innerHTML = `<span>${index + 1}</span><strong>${escapeHtml(option.text)}</strong>`;
    button.addEventListener("click", () => selectQuizOption(index));
    els.quizOptions.appendChild(button);
  });

  els.quizOptions.hidden = false;
}

function hideQuizOptions() {
  els.quizOptions.innerHTML = "";
  els.quizOptions.hidden = true;
  els.quizFeedback.innerText = "";
  els.quizFeedback.hidden = true;
}

function selectQuizOption(index) {
  if (!currentWord || !isChoicePractice() || quizLocked) return;
  const optionButtons = [...els.quizOptions.querySelectorAll(".quiz-option")];
  const selected = optionButtons[index];
  if (!selected) return;

  quizLocked = true;
  const isCorrect = selected.dataset.correct === "true";
  optionButtons.forEach((button) => {
    button.disabled = true;
    if (button.dataset.correct === "true") button.classList.add("correct");
  });

  selected.classList.add(isCorrect ? "selected-correct" : "selected-wrong");
  els.cn.classList.add("show");
  els.quizFeedback.innerText = isCorrect ? "选对了" : "选错了，已按忘记记录";
  els.quizFeedback.dataset.type = isCorrect ? "success" : "danger";
  els.quizFeedback.hidden = false;

  window.setTimeout(() => {
    handleResult(isCorrect ? "known" : "unknown", { skipCopyPractice: true });
  }, isCorrect ? 260 : 850);
}

function renderRelatedWords(word) {
  els.relatedWords.innerHTML = "";
  if (mode !== "hard") return;

  const groups = getRelatedWordGroups(word);
  if (groups.length === 0) return;

  els.relatedWords.innerHTML = groups
    .map(
      (group) => `
        <section class="related-section">
          <div class="related-title">${escapeHtml(group.title)}</div>
          <div class="related-list">
            ${group.items
              .map(
                (item) => `
                  <div class="related-chip">
                    <strong>${escapeHtml(item.kr)}</strong>
                    <span>${escapeHtml(item.cn || "")}</span>
                  </div>
                `
              )
              .join("")}
          </div>
        </section>
      `
    )
    .join("");
}

function renderSentencePractice(word) {
  const progress = getProgress(word);
  els.sentenceInput.value = progress.exampleSentence || "";
  els.sentenceMsg.innerText = progress.exampleSentence ? "已保存上次造句" : "";
  els.sentenceMsg.dataset.type = progress.exampleSentence ? "success" : "";
}

function hideSentencePractice() {
  els.sentencePractice.hidden = true;
  els.sentenceInput.value = "";
  els.sentenceMsg.innerText = "";
  els.sentenceMsg.dataset.type = "";
}

function saveCurrentSentence() {
  if (!currentWord || mode !== "hard") return;
  const sentence = els.sentenceInput.value.trim();
  const progress = getProgress(currentWord);
  progress.exampleSentence = sentence;
  progress.updatedAt = Date.now();
  saveProgress();
  els.sentenceMsg.innerText = sentence ? "已保存" : "已清空";
  els.sentenceMsg.dataset.type = "success";
}

function showCopyPractice() {
  awaitingCopyPractice = true;
  els.copyInput.value = "";
  els.copyMsg.innerText = "";
  els.copyMsg.dataset.type = "";
  els.copyPractice.hidden = false;
  window.setTimeout(() => els.copyInput.focus(), 0);
}

function hideCopyPractice() {
  awaitingCopyPractice = false;
  els.copyPractice.hidden = true;
  els.copyInput.value = "";
  els.copyMsg.innerText = "";
  els.copyMsg.dataset.type = "";
}

function normalizeCopyValue(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function submitCopyPractice() {
  if (!awaitingCopyPractice || !currentWord) return;
  if (normalizeCopyValue(els.copyInput.value) !== normalizeCopyValue(currentWord.kr)) {
    els.copyMsg.innerText = "再输入一次，必须和当前单词一致";
    els.copyMsg.dataset.type = "danger";
    return;
  }
  hideCopyPractice();
  renderNext();
}

function handleResult(type, options = {}) {
  if (!currentWord) return;
  if (awaitingCopyPractice) return;

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
  if (mode === "review" && type !== "known" && !options.skipCopyPractice) {
    showMeaning();
    showCopyPractice();
    return;
  }
  renderNext();
}

function onGroupComplete() {
  currentWord = null;
  els.kr.innerText = "完成";
  els.cn.innerText = `第 ${groupsDone} 组完成`;
  els.cn.classList.add("show");
  els.relatedWords.hidden = true;
  els.relatedWords.innerHTML = "";
  hideSentencePractice();
  hideCopyPractice();
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
  els.relatedWords.hidden = true;
  els.relatedWords.innerHTML = "";
  hideSentencePractice();
  hideCopyPractice();
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
  awaitingCopyPractice = false;
  quizLocked = false;
  els.kr.innerText = word.kr;
  els.cn.innerText = `[${word.pos}] ${word.cn}`;
  els.cn.classList.remove("show");
  hideQuizOptions();
  renderPracticeControls();
  if (isChoicePractice()) {
    renderQuizOptions(word);
  } else {
    els.cn.classList.add("show");
  }
  els.relatedWords.hidden = true;
  els.relatedWords.innerHTML = "";
  hideSentencePractice();
  hideCopyPractice();
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
  if (activeTask === "hard") return "现在还没有错过的已复习单词。顽固词会按错误率自动取最高 30 个。";
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
