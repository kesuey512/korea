let words = [];
let reviewQueue = [];
let currentWord = null;
let wordProgress = {};

// 艾宾浩斯间隔（天）：第1次记住后0天（当天复习），之后1、2、4、7天
const INTERVALS = [0, 1, 2, 4, 7, 15, 30];

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
// 返回今天零点的时间戳
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

// ===== 初始化单元选择 =====
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

// ===== 获取/初始化进度 =====
function getProgress(word) {
  const key = getKey(word);
  if (!wordProgress[key]) {
    wordProgress[key] = {
      stage: 0,            // 艾宾浩斯阶段
      nextReview: todayStart(), // 下次复习时间（零点时间戳）
      knownStreak: 0,      // 连续"记住"次数
      mastered: false,     // 是否已掌握
      lastResult: null,    // 上次结果：known/vague/unknown
      todayReviewCount: 0, // 今天已复习次数（用于模糊/忘记当日最多复习一次）
      lastReviewedDay: null // 上次复习是哪天（零点时间戳）
    };
  }
  return wordProgress[key];
}

// ===== 构建队列 =====
function buildQueue() {
  const today = todayStart();

  reviewQueue = getFilteredWords().filter(w => {
    const p = getProgress(w);

    // 新词：从未学过
    const isNew = !p.lastResult;
    if (isNew) return true;

    // 到期需要复习
    if (today < p.nextReview) return false;

    // 规则2：当天已因模糊/忘记复习过一次，不再重复加入队列
    // （点击认识后推入艾宾浩斯不受此限制）
    if (
      p.lastReviewedDay === today &&
      p.todayReviewCount >= 1 &&
      (p.lastResult === "vague" || p.lastResult === "unknown")
    ) {
      return false;
    }

    return true;
  });

  // 打乱顺序
  reviewQueue.sort(() => Math.random() - 0.5);

  updateCounts();
}

// ===== 更新统计面板 =====
function updateCounts() {
  const today = todayStart();
  let learn = 0, review = 0, mastered = 0;

  getFilteredWords().forEach(w => {
    const p = getProgress(w);
    const isNew = !p.lastResult;
    const due = today >= p.nextReview;

    if (p.mastered) mastered++;
    if (isNew) learn++;
    else if (due && !isNew) review++;
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

// ===== 渲染下一个单词 =====
function renderNext() {
  if (reviewQueue.length === 0) {
    krEl.innerText = "🎉";
    cnEl.innerText = "今天的任务完成了！";
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
      `${currentWord.unit} | 阶段 ${p.stage} | 连续记住 ${p.knownStreak} 次${p.mastered ? " ⭐已掌握" : ""}`;
  }
}

// ===== 核心逻辑 =====
function handleResult(type) {
  if (!currentWord) return;

  const today = todayStart();
  const p = getProgress(currentWord);

  // 重置当天计数（如果跨天了）
  if (p.lastReviewedDay !== today) {
    p.todayReviewCount = 0;
  }

  p.todayReviewCount += 1;
  p.lastReviewedDay = today;
  p.lastResult = type;

  if (type === "known") {
    // 推进艾宾浩斯阶段
    p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
    // 下次复习 = 今天零点 + 间隔天数
    p.nextReview = today + daysToMs(INTERVALS[p.stage]);
    p.knownStreak = (p.knownStreak || 0) + 1;

    // 连续3次记住 = 已掌握（但仍继续按曲线复习）
    if (p.knownStreak >= 3) p.mastered = true;

  } else if (type === "vague") {
    // 规则5：模糊 → 间隔1天（明天零点后可复习）
    // 当日若第一次遇到，加入当日队列再复习一次（buildQueue 控制）
    p.stage = Math.max(p.stage - 1, 0); // 稍微退一步
    p.nextReview = today + daysToMs(1);
    p.knownStreak = 0;
    p.mastered = false;

  } else {
    // 规则6：忘记 → 重置阶段，第二天复习
    p.stage = 0;
    p.nextReview = today + daysToMs(1);
    p.knownStreak = 0;
    p.mastered = false;
  }

  saveProgress();

  // 从队列移除当前词
  reviewQueue.shift();

  // 规则2：模糊/忘记时，当天第一次遇到则重新加入队尾让用户再练一次
  if ((type === "vague" || type === "unknown") && p.todayReviewCount === 1) {
    reviewQueue.push(currentWord);
  }

  updateCounts();
  renderNext();
}

// ===== 本地存储 =====
function saveProgress() {
  localStorage.setItem("韩语背词_progress", JSON.stringify(wordProgress));
}

function loadProgress() {
  const p = localStorage.getItem("韩语背词_progress");
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
  localStorage.removeItem("韩语背词_progress");
  location.reload();
}

// ===== 监听模式/单元切换 =====
modeSelect.onchange = () => { buildQueue(); renderNext(); };
unitSelect.onchange = () => { buildQueue(); renderNext(); };
