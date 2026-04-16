let words = [];
let reviewQueue = [];
let currentWord = null;
let wordProgress = {};

const INTERVALS = [0, 1, 2, 4, 7];

const krEl = document.getElementById("kr");
const cnEl = document.getElementById("cn");
const infoEl = document.getElementById("unit-info");
const learnCountEl = document.getElementById("learn-count");
const reviewCountEl = document.getElementById("review-count");
const masteredCountEl = document.getElementById("mastered-count");
const modeSelect = document.getElementById("study-mode");
const unitSelect = document.getElementById("unit-select");

// ===== 按钮绑定 =====
document.getElementById("show-btn").onclick = showMeaning;
document.getElementById("known-btn").onclick = () => handleResult("known");
document.getElementById("vague-btn").onclick = () => handleResult("vague");
document.getElementById("unknown-btn").onclick = () => handleResult("unknown");
document.getElementById("reset-current-btn").onclick = resetCurrent;
document.getElementById("reset-all-btn").onclick = resetAll;
document.getElementById("speak-btn").onclick = () => {
  if (!currentWord) return;
  const utter = new SpeechSynthesisUtterance(currentWord.kr);
  utter.lang = "ko-KR";
  speechSynthesis.speak(utter);
};

// ===== 时间工具 =====
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysToMs(d) {
  return d * 86400000;
}

// ===== 数据加载 =====
fetch("data.json")
  .then(res => res.json())
  .then(data => {
    words = data;
    initUnits();
    loadProgress();
    buildQueue();
    renderNext();
    document.getElementById("sync-msg").style.display = "none";
  })
  .catch(() => {
    document.getElementById("sync-msg").innerText = "词库加载失败，请检查 data.json";
  });

// ===== 初始化单元 =====
function initUnits() {
  const units = [...new Set(words.map(w => w.unit))];
  units.forEach(u => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.innerText = u;
    unitSelect.appendChild(opt);
  });
}

// ===== 模式过滤 =====
function getFilteredWords() {
  const mode = modeSelect.value;
  if (mode === "all") {
    return words;
  } else {
    const selected = unitSelect.value;
    if (selected === "__all__") return words;
    return words.filter(w => w.unit === selected);
  }
}

// ===== 进度 key =====
function getKey(word) {
  return modeSelect.value + "_" + word.id;
}

// ===== 获取进度 =====
function getProgress(word) {
  const key = getKey(word);
  if (!wordProgress[key]) {
    wordProgress[key] = {
      stage: 0,
      nextReview: todayStart(),
      knownStreak: 0,
      mastered: false,
      todayCount: 0,
      lastReviewedDay: null,
      lastResult: null
    };
  }
  return wordProgress[key];
}

// ===== 构建队列 =====
function buildQueue() {
  const now = todayStart();
  reviewQueue = getFilteredWords().filter(w => {
    const p = getProgress(w);
    if (p.todayCount === undefined) p.todayCount = 0;
    if (p.lastReviewedDay === now && p.todayCount >= 2) return false;
    const isNew = !p.lastResult;
    const due = !p.nextReview || now >= p.nextReview;
    return isNew || due;
  });
  reviewQueue.sort(() => Math.random() - 0.5);
  updateCounts();
}

// ===== 更新统计 =====
function updateCounts() {
  const now = todayStart();
  let learn = 0, review = 0, mastered = 0;
  getFilteredWords().forEach(w => {
    const p = getProgress(w);
    const isNew = !p.lastResult;
    const due = !p.nextReview || now >= p.nextReview;
    if (p.mastered) mastered++;
    if (due) {
      if (isNew) learn++;
      else review++;
    }
  });
  learnCountEl.innerText = learn;
  reviewCountEl.innerText = review;
  masteredCountEl.innerText = mastered;

  const dueCountEl = document.getElementById("due-count");
  if (dueCountEl) dueCountEl.innerText = reviewQueue.length;
}

// ===== 显示释义 =====
function showMeaning() {
  cnEl.classList.add("show");
}

// ===== 渲染单词 =====
function renderNext() {
  if (reviewQueue.length === 0) {
    krEl.innerText = "🎉";
    cnEl.innerText = "没有需要复习的词";
    cnEl.classList.add("show");
    if (infoEl) infoEl.innerText = "";
    return;
  }
  currentWord = reviewQueue[0];
  const p = getProgress(currentWord);
  krEl.innerText = currentWord.kr;
  cnEl.innerText = `[${currentWord.pos}] ${currentWord.cn}`;
  cnEl.classList.remove("show");
  if (infoEl) {
    infoEl.innerText =
      `${currentWord.unit} | 阶段:${p.stage} | 连续:${p.knownStreak || 0} | 今日:${p.todayCount || 0}`;
  }
}

// ===== 核心逻辑 =====
function handleResult(type) {
  if (!currentWord) return;
  const now = todayStart();
  const p = getProgress(currentWord);

  if (p.lastReviewedDay !== now) p.todayCount = 0;
  p.todayCount = (p.todayCount || 0) + 1;
  p.lastReviewedDay = now;

  if (type === "known") {
    p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
    p.nextReview = now + daysToMs(INTERVALS[p.stage]);
    p.knownStreak = (p.knownStreak || 0) + 1;
    if (p.knownStreak >= 3) p.mastered = true;
  } else if (type === "vague") {
    p.nextReview = now + daysToMs(2);
    p.knownStreak = 0;
    p.mastered = false;
  } else {
    p.stage = 0;
    p.nextReview = now + daysToMs(1);
    p.knownStreak = 0;
    p.mastered = false;
  }

  p.lastResult = type;
  saveProgress();
  reviewQueue.shift();
  buildQueue();
  renderNext();
}

// ===== 本地存储 =====
function saveProgress() {
  localStorage.setItem("progress", JSON.stringify(wordProgress));
}

function loadProgress() {
  const p = localStorage.getItem("progress");
  if (p) wordProgress = JSON.parse(p);
}

// ===== 重置 =====
function resetCurrent() {
  const mode = modeSelect.value;
  Object.keys(wordProgress).forEach(k => {
    if (k.startsWith(mode + "_")) delete wordProgress[k];
  });
  saveProgress();
  buildQueue();
  renderNext();
}

function resetAll() {
  localStorage.clear();
  location.reload();
}

// ===== 监听 =====
modeSelect.onchange = () => { buildQueue(); renderNext(); };
unitSelect.onchange = () => { buildQueue(); renderNext(); };
