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

/**
 * =========================
 * 1. 先把这里替换成你自己的 Firebase 配置
 * =========================
 */
const firebaseConfig = {
  apiKey: "AIzaSyB50lA92DSngs6y98PgK1thovNM4liPycU",
  authDomain: "korea-83b2a.firebaseapp.com",
  projectId: "korea-83b2a",
  storageBucket: "korea-83b2a.firebasestorage.app",
  messagingSenderId: "559427597840",
  appId: "1:559427597840:web:49f2decb6ff3753033fc95",
  measurementId: "G-W2MK1L42X0"
};

/**
 * =========================
 * 2. 基础配置
 * =========================
 */
const INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60];
const LOCAL_WORDS_CACHE_KEY = "kr_words_cache_v1";
const LOCAL_PROGRESS_CACHE_KEY = "kr_progress_local_cache_v2";

const DEFAULT_PROGRESS = {
  stage: 0,
  nextReview: 0,
  lastResult: "new",
  updatedAt: 0
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

/**
 * =========================
 * 3. DOM
 * =========================
 */
const krEl = document.getElementById("kr");
const cnEl = document.getElementById("cn");
const dueEl = document.getElementById("due-count");
const infoEl = document.getElementById("unit-info");
const syncMsgEl = document.getElementById("sync-msg");
const userStatusEl = document.getElementById("user-status");

const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const speakBtn = document.getElementById("speak-btn");
const showBtn = document.getElementById("show-btn");
const knownBtn = document.getElementById("known-btn");
const vagueBtn = document.getElementById("vague-btn");
const unknownBtn = document.getElementById("unknown-btn");

/**
 * =========================
 * 4. 工具函数
 * =========================
 */
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

function getProgress(word) {
  return wordProgress[word.id] || { ...DEFAULT_PROGRESS };
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

function mergeProgress(localData, cloudData) {
  const merged = { ...localData };

  for (const [wordId, cloudValue] of Object.entries(cloudData || {})) {
    const localValue = merged[wordId];
    if (!localValue) {
      merged[wordId] = cloudValue;
      continue;
    }

    const localUpdated = Number(localValue.updatedAt || 0);
    const cloudUpdated = Number(cloudValue.updatedAt || 0);

    merged[wordId] = cloudUpdated >= localUpdated ? cloudValue : localValue;
  }

  return merged;
}

function buildReviewQueue() {
  const now = nowTs();

  reviewQueue = words.filter((word) => {
    const data = getProgress(word);
    return !data.nextReview || now >= data.nextReview;
  });

  reviewQueue = shuffle(reviewQueue);
}

function renderNext() {
  dueEl.innerText = String(reviewQueue.length);

  if (reviewQueue.length === 0) {
    currentWord = null;
    krEl.innerText = "🎉";
    cnEl.innerText = "任务已完成！";
    cnEl.classList.add("show");
    infoEl.innerHTML = `今天没有待复习词汇`;
    return;
  }

  currentWord = reviewQueue[0];
  const data = getProgress(currentWord);

  krEl.innerText = currentWord.kr;
  cnEl.innerText = currentWord.cn;
  cnEl.classList.remove("show");

  infoEl.innerHTML = `
    单元：<span class="badge">${currentWord.unit}</span>
    &nbsp; 阶段：<span class="badge">${data.stage}</span>
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

/**
 * =========================
 * 5. Firebase 初始化
 * =========================
 */
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

/**
 * =========================
 * 6. 词库加载
 * =========================
 */
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
    setSyncMsg(`词库加载完成，共 ${validWords.length} 个词条。`);
  } catch (err) {
    console.error(err);
    const fallbackWords = loadLocalWordsCache();

    if (Array.isArray(fallbackWords) && fallbackWords.length > 0) {
      words = fallbackWords.filter(isValidWord);
      setSyncMsg("data.json 读取失败，已改用本地缓存词库。");
      return;
    }

    setSyncMsg("词库加载失败，请检查 data.json 格式。");
    infoEl.textContent = "data.json 加载失败";
    throw err;
  }
}

/**
 * =========================
 * 7. 云端同步
 * =========================
 */
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

/**
 * =========================
 * 8. 登录
 * =========================
 */
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

/**
 * =========================
 * 9. 背词逻辑
 * =========================
 */
async function handleResult(result) {
  if (!currentWord) return;

  const now = nowTs();
  const data = { ...getProgress(currentWord) };

  if (result === "known") {
    data.stage = Math.min(data.stage + 1, INTERVALS.length - 1);
    const days = INTERVALS[data.stage];
    data.nextReview = now + daysToMs(days);
  } else if (result === "vague") {
    data.nextReview = now + daysToMs(2);
  } else {
    data.stage = 0;
    data.nextReview = now + daysToMs(1);
  }

  data.lastResult = result;
  data.updatedAt = now;

  wordProgress[currentWord.id] = data;
  saveLocalProgressCache();

  reviewQueue.shift();
  renderNext();

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

/**
 * =========================
 * 10. 事件绑定
 * =========================
 */
function bindStudyEvents() {
  showBtn.addEventListener("click", showTranslation);
  speakBtn.addEventListener("click", speak);
  knownBtn.addEventListener("click", () => handleResult("known"));
  vagueBtn.addEventListener("click", () => handleResult("vague"));
  unknownBtn.addEventListener("click", () => handleResult("unknown"));
}

/**
 * =========================
 * 11. 启动
 * =========================
 */
async function startApp() {
  bindStudyEvents();
  bindAuthEvents();
  initFirebase();
  await loadWords();
  listenAuthState();
}

startApp();
