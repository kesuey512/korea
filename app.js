let words = [];
let currentWord = null;
let wordProgress = {};

// 艾宾浩斯间隔（天）：阶段0=学习当天，阶段1=第二天，之后按曲线
// 第一次记住后 → 明天复习（间隔1天）
const INTERVALS = [1, 2, 4, 7, 15, 30];

// ===== 模式状态 =====
// mode: "learn" | "review"
let mode = "learn";

// ===== 分组状态 =====
// 每组10个单词，所有单词都需要被"认识"后才结束本组
let currentGroup = [];         // 当前组的单词列表（每组最多10个）
let groupPendingSet = new Set(); // 本组中尚未点击"认识"的单词id集合
let groupQueue = [];           // 当前组的学习队列（含重复项，直到全部认识）
let groupsDone = 0;            // 今天已完成的组数

// ===== DOM =====
const krEl = document.getElementById("kr");
const cnEl = document.getElementById("cn");
const infoEl = document.getElementById("unit-info");
const learnCountEl = document.getElementById("learn-count");
const reviewCountEl = document.getElementById("review-count");
const masteredCountEl = document.getElementById("mastered-count");
const modeSelect = document.getElementById("study-mode");
const unitSelect = document.getElementById("unit-select");

// 组进度显示（如果HTML中有这些元素）
const groupInfoEl = document.getElementById("group-info");
const groupProgressEl = document.getElementById("group-progress");

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

function tomorrowStart() {
  return todayStart() + 86400000;
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
    startSession();
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
  const studyMode = modeSelect.value;
  if (studyMode === "all") return words;
  const selected = unitSelect.value;
  if (selected === "__all__") return words;
  return words.filter(w => w.unit === selected);
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
      stage: -1,           // -1=未学过，0~N=艾宾浩斯阶段
      nextReview: null,    // 下次复习的零点时间戳，null=未学过
      knownStreak: 0,      // 连续"认识"次数
      mastered: false,     // 是否已掌握（连续3次认识）
      learnedDay: null,    // 首次学习的零点时间戳
      lastResult: null,    // 上次结果
    };
  }
  return wordProgress[key];
}

// ===== 获取需要"学习"的新词（从未学过） =====
function getNewWords() {
  return getFilteredWords().filter(w => {
    const p = getProgress(w);
    return p.stage === -1;
  });
}

// ===== 获取今天需要"复习"的单词 =====
function getReviewWords() {
  const today = todayStart();
  return getFilteredWords().filter(w => {
    const p = getProgress(w);
    if (p.stage === -1) return false;        // 还没学过
    if (p.nextReview === null) return false;
    return today >= p.nextReview;
  });
}

// ===== 会话初始化：决定进入学习还是复习 =====
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
    return;
  }

  updateCounts();
}

// ===== 加载下一组（10个单词）=====
function loadNextGroup(wordPool) {
  // 取前10个
  currentGroup = wordPool.slice(0, 10);

  if (currentGroup.length === 0) {
    checkSessionDone();
    return;
  }

  // 初始化本组的"待认识"集合
  groupPendingSet = new Set(currentGroup.map(w => w.id));

  // 构建本组队列：打乱顺序
  groupQueue = shuffle([...currentGroup]);

  renderGroupInfo();
  renderNext();
}

// ===== 渲染组信息 =====
function renderGroupInfo() {
  const total = currentGroup.length;
  const pending = groupPendingSet.size;
  const known = total - pending;

  if (groupInfoEl) {
    const modeLabel = mode === "learn" ? "学习" : "复习";
    groupInfoEl.innerText = `${modeLabel}模式 · 第 ${groupsDone + 1} 组`;
  }
  if (groupProgressEl) {
    groupProgressEl.innerText = `本组进度：${known} / ${total} 已认识`;
  }
}

// ===== 渲染下一个单词 =====
function renderNext() {
  if (groupQueue.length === 0) {
    // 队列为空，检查本组是否完成
    if (groupPendingSet.size === 0) {
      // 本组全部认识，进入下一组
      groupsDone++;
      onGroupComplete();
    } else {
      // 还有未认识的，但队列空了（理论上不会，只是保险）
      groupQueue = shuffle(
        currentGroup.filter(w => groupPendingSet.has(w.id))
      );
      renderNext();
    }
    return;
  }

  currentWord = groupQueue.shift();
  const p = getProgress(currentWord);

  krEl.innerText = currentWord.kr;
  cnEl.innerText = `[${currentWord.pos}] ${currentWord.cn}`;
  cnEl.classList.remove("show");

  if (infoEl) {
    const stageLabel = p.stage === -1 ? "新词" : `阶段 ${p.stage}`;
    infoEl.innerText =
      `${currentWord.unit} | ${stageLabel} | 连续认识 ${p.knownStreak} 次${p.mastered ? " ⭐已掌握" : ""}`;
  }

  renderGroupInfo();
  updateCounts();
}

// ===== 显示释义 =====
function showMeaning() {
  cnEl.classList.add("show");
}

// ===== 核心逻辑 =====
function handleResult(type) {
  if (!currentWord) return;

  const today = todayStart();
  const p = getProgress(currentWord);

  p.lastResult = type;

  if (type === "known") {
    p.knownStreak = (p.knownStreak || 0) + 1;
    if (p.knownStreak >= 3) p.mastered = true;

    if (mode === "learn") {
      // 学习模式：首次认识 → 明天复习（阶段0）
      if (p.stage === -1) {
        p.stage = 0;
        p.learnedDay = today;
        p.nextReview = tomorrowStart(); // 明天零点后可复习
      } else {
        // 学习模式下已有阶段（极少情况）
        p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
        p.nextReview = today + daysToMs(INTERVALS[p.stage]);
      }
    } else {
      // 复习模式：推进艾宾浩斯阶段
      p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
      p.nextReview = today + daysToMs(INTERVALS[p.stage]);
    }

    // 从本组"待认识"中移除 → 该词本组已掌握
    groupPendingSet.delete(currentWord.id);

  } else if (type === "vague") {
    // 模糊：稍微退一步，明天复习
    p.knownStreak = 0;
    p.mastered = false;
    if (p.stage > 0) p.stage = Math.max(p.stage - 1, 0);
    p.nextReview = tomorrowStart();

    // 本组中仍然未认识，保留在 groupPendingSet 中
    // 将该词重新加入队列末尾（本组内再练一次）
    groupQueue.push(currentWord);

  } else {
    // 忘记：重置阶段，明天复习
    p.knownStreak = 0;
    p.mastered = false;
    p.stage = Math.max(p.stage, 0); // 保持在0，不退回-1
    p.nextReview = tomorrowStart();

    // 本组中仍然未认识，保留在 groupPendingSet 中
    // 将该词重新加入队列末尾
    groupQueue.push(currentWord);
  }

  saveProgress();
  renderNext();
}

// ===== 本组完成后处理 =====
function onGroupComplete() {
  // 显示本组完成提示
  krEl.innerText = "✓";
  cnEl.innerText = `第 ${groupsDone} 组完成！`;
  cnEl.classList.add("show");
  if (infoEl) infoEl.innerText = "";
  if (groupProgressEl) groupProgressEl.innerText = "";

  // 短暂延迟后加载下一组
  setTimeout(() => {
    const remaining = mode === "learn" ? getNewWords() : getReviewWords();
    if (remaining.length > 0) {
      loadNextGroup(remaining);
    } else {
      // 当前模式做完，检查另一种模式
      if (mode === "learn") {
        const reviewWords = getReviewWords();
        if (reviewWords.length > 0) {
          mode = "review";
          groupsDone = 0;
          loadNextGroup(reviewWords);
          return;
        }
      }
      showAllDone();
    }
  }, 1500);
}

// ===== 全部完成 =====
function showAllDone() {
  krEl.innerText = "🎉";
  cnEl.innerText = "今天的任务全部完成！";
  cnEl.classList.add("show");
  if (infoEl) infoEl.innerText = "";
  if (groupInfoEl) groupInfoEl.innerText = "";
  if (groupProgressEl) groupProgressEl.innerText = "";
  currentWord = null;
  updateCounts();
}

// ===== 会话结束检查 =====
function checkSessionDone() {
  const reviewWords = getReviewWords();
  const newWords = getNewWords();
  if (reviewWords.length === 0 && newWords.length === 0) {
    showAllDone();
  } else {
    startSession();
  }
}

// ===== 更新统计面板 =====
function updateCounts() {
  const today = todayStart();
  let learn = 0, review = 0, mastered = 0;

  getFilteredWords().forEach(w => {
    const p = getProgress(w);
    if (p.mastered) mastered++;
    if (p.stage === -1) learn++;
    else if (p.nextReview !== null && today >= p.nextReview) review++;
  });

  learnCountEl.innerText = learn;
  reviewCountEl.innerText = review;
  masteredCountEl.innerText = mastered;

  const dueCountEl = document.getElementById("due-count");
  if (dueCountEl) {
    dueCountEl.innerText = groupPendingSet ? groupPendingSet.size : 0;
  }
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
  const studyMode = modeSelect.value;
  Object.keys(wordProgress).forEach(k => {
    if (k.startsWith(studyMode + "_")) delete wordProgress[k];
  });
  saveProgress();
  startSession();
}

function resetAll() {
  localStorage.removeItem("韩语背词_progress");
  location.reload();
}

// ===== 工具：打乱数组 =====
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===== 监听模式/单元切换 =====
modeSelect.onchange = () => { startSession(); };
unitSelect.onchange = () => { startSession(); };
