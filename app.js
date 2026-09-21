/* 我在意大利背医学词汇 · 单页应用
   数据：terms.json（476 条，按对话词频排序）
   存储：localStorage
   复习：艾宾浩斯间隔 5min → 30min → 12h → 1d → 2d → 4d → 7d → 15d → 30d（全部通过=已掌握）
   打卡：统计「累计打卡天数」（有学习或复习记录的天数总和）
   每日限额：settings.dayLearn 每日新学上限 / settings.dayReview 每日复习上限（9999 = 不限）
*/

const INTERVALS = [5, 30, 720, 1440, 2880, 5760, 10080, 20160, 43200]; // 分钟
const STAGE_LABEL = ['5 分钟', '30 分钟', '12 小时', '1 天', '2 天', '4 天', '7 天', '15 天', '30 天'];
const KEY = 'medVocab.v1';
const BUILD = 'v45 · 2026-09-22';   // 每次更新代码时改这里，用来判断“是否最新版本”

const KIND_LABEL = { word: '单词' };
const KIND_SPEAK = { word: 'en-GB' };

let TERMS = [];      // 单词
let ITEMS = [];      // 全部条目（只剩单词）
let DECK = [];       // 按词频排好的学习顺序（元素为 key）
let byKey = {};      // key -> 条目
let S = null;               // 状态
let session = null;         // 当前学习/复习会话

/* ---------------- 状态 ---------------- */
function defaultState() {
  return {
    known: {},      // en -> 时间戳
    book: {},       // en -> {stage, due, added, ok, fail, mastered}
    gone: {},       // en -> 删除时间（从系统里移除的词）
    fav: {},        // en -> 收藏时间戳
    stats: {},      // 'YYYY-MM-DD' -> {learn, review, ok, fail}
    checkins: {},   // 'YYYY-MM-DD' -> 打卡完成时间（当天学习 + 复习都完成）
    sync: {},       // {up: 上次上传云端时间, down: 上次从云端恢复时间}
    // size: 每轮学习数量，9999 = 不限；reviewMode: auto / instant / manual
    // dayLearn / dayReview: 每日新学、每日复习上限，9999 = 不限
    settings: {
      size: 9999, autoSpeak: true, sizeExplicit: false, reviewMode: 'auto',
      dayLearn: 70, dayReview: 100,
    },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    S = raw ? Object.assign(defaultState(), JSON.parse(raw)) : defaultState();
    S.settings = Object.assign({
      size: 9999, autoSpeak: true, sizeExplicit: false, reviewMode: 'auto',
      dayLearn: 70, dayReview: 100,
    }, S.settings || {});
    S.fav = S.fav || {};                                    // 旧存档没有收藏时补上
    S.gone = S.gone || {};                                  // 旧存档没有删除记录时补上
    S.checkins = S.checkins || {};
    S.sync = S.sync || {};
    if (!S.settings.sizeExplicit) S.settings.size = 9999;   // 老数据统一升级为“不限”
    S.settings.dayLearn = Number(S.settings.dayLearn) > 0 ? Number(S.settings.dayLearn) : 70;
    S.settings.dayReview = Number(S.settings.dayReview) > 0 ? Number(S.settings.dayReview) : 100;
    // 每日新学上限默认由 20 改成 70：老存档里还留着旧默认值 20 的一次性升到 70
    //（如果之前手动选过 10/30/50/100，就不动它）
    if (!S.settings.dayLearnV2) {
      S.settings.dayLearnV2 = true;
      if (Number(S.settings.dayLearn) === 20) S.settings.dayLearn = 70;
    }
    // 老存档迁移：以前“当天有学习或复习记录”就算打过卡，补进打卡表，累计天数不清零
    Object.keys(S.stats).forEach(d => {
      const v = S.stats[d] || {};
      if (((v.learn || 0) + (v.review || 0)) > 0 && !S.checkins[d]) S.checkins[d] = 1;
    });
  } catch (e) {
    S = defaultState();
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 隐私模式等 */ }
}

const todayKey = () => new Date().toISOString().slice(0, 10);
function stat() {
  const k = todayKey();
  if (!S.stats[k]) S.stats[k] = { learn: 0, review: 0, ok: 0, fail: 0 };
  return S.stats[k];
}

/* ---------------- 工具 ---------------- */
const $ = (id) => document.getElementById(id);

function toast(msg, ms = 1700) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function relTime(ts) {
  if (!ts) return '—';
  const d = ts - Date.now();
  const abs = Math.abs(d);
  const mins = Math.round(abs / 60000);
  let s;
  if (mins < 1) s = '不到 1 分钟';
  else if (mins < 60) s = mins + ' 分钟';
  else if (mins < 1440) s = Math.round(mins / 60) + ' 小时';
  else s = Math.round(mins / 1440) + ' 天';
  return d >= 0 ? s + '后' : '已逾期 ' + s;
}

/* 优先挑英式（en-GB）男声：iOS 的 Daniel / Chrome 的 Google UK English Male /
   Edge 的 Microsoft George·Ryan·Thomas / macOS 的 Oliver·Arthur */
const UK_MALE = [
  'daniel', ' google uk english male', 'google uk english male', 'microsoft george',
  'microsoft ryan', 'microsoft thomas', 'microsoft oliver', 'oliver', 'arthur', 'male',
];
let VOICE = null;

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  let vs = [];
  try { vs = speechSynthesis.getVoices() || []; } catch (e) { return null; }
  if (!vs.length) return null;
  const uk = vs.filter(v => /en[-_]GB/i.test(v.lang || ''));
  const pool = uk.length ? uk : vs.filter(v => /^en/i.test(v.lang || ''));
  const named = list => {
    for (const key of list) {
      const hit = pool.find(v => (v.name || '').toLowerCase().includes(key.trim()));
      if (hit) return hit;
    }
    return null;
  };
  return named(UK_MALE) || uk[0] || pool[0] || vs[0] || null;
}

/* times: 读几遍（默认为 1；单词默认连读两遍） */
function speak(text, lang, times) {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
  const L = lang || 'en-GB';
  const n = Math.max(1, Math.min(4, times || 1));
  try {
    speechSynthesis.cancel();
    const v = VOICE || (VOICE = pickVoice());
    for (let i = 0; i < n; i++) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (v && v.lang) || L;
      if (v) u.voice = v;
      u.rate = 0.88;    // 稍慢一点，更像真人说话
      u.pitch = 0.95;   // 略低，偏男声
      speechSynthesis.speak(u);   // 排队播放：连读两遍
    }
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 条目注册表 ---------------- */
function buildItems() {
  ITEMS = [];
  byKey = {};
  TERMS.forEach(t => ITEMS.push({
    key: t.en, kind: 'word', tag: KIND_LABEL.word,
    front: t.en, ipa: t.ipa || '', back: t.zh || '', sub: '', ex: t.ex || '',
    rank: t.rank, count: null, order: 1 - (t.rank - 1) / Math.max(1, TERMS.length - 1),
  }));
  ITEMS.forEach(i => byKey[i.key] = i);
  DECK = ITEMS.slice().sort((a, b) => b.order - a.order).map(i => i.key);
  pruneStale();
}

/* 词库里已经没有的条目（例如删掉的“句式/短语”）从学习记录里清掉，
   避免旧记录让统计虚高、或让复习队列出现空条目 */
function pruneStale() {
  let changed = false;
  [S.known, S.book, S.fav].forEach(m => {
    Object.keys(m).forEach(k => { if (!byKey[k]) { delete m[k]; changed = true; } });
  });
  if (changed) save();
}

const kindTotal = (kind) => ITEMS.filter(i => i.kind === kind).length;
const kindLearned = (kind) => ITEMS.filter(i => i.kind === kind && (isKnown(i.key) || inBook(i.key))).length;

/* ---------------- 业务 ---------------- */
const isKnown = (en) => !!S.known[en];
const inBook = (en) => !!S.book[en];
const isMastered = (en) => !!(S.book[en] && S.book[en].mastered);
const isFav = (en) => !!S.fav[en];
const isGone = (en) => !!S.gone[en];
/* 从系统里删除一个词：学习记录 / 生词本 / 收藏一起去掉，并记入删除名单 */
function deleteWord(en) {
  S.gone[en] = Date.now();
  delete S.known[en];
  delete S.book[en];
  delete S.fav[en];
}
function restoreAllGone() {
  const n = Object.keys(S.gone).length;
  S.gone = {};
  return n;
}
function toggleFav(en) {
  if (S.fav[en]) { delete S.fav[en]; return false; }
  S.fav[en] = Date.now();
  return true;
}
/* 只统计词库里确实存在的条目 */
const validKeys = (obj) => Object.keys(obj).filter(k => byKey[k]);
const learnedCount = () => validKeys(S.known).length + validKeys(S.book).length;

function dueList() {
  const now = Date.now();
  return Object.keys(S.book)
    .filter(en => byKey[en] && !isGone(en) && !S.book[en].mastered && S.book[en].due <= now)
    .sort((a, b) => S.book[a].due - S.book[b].due);
}

function newQueue(limit) {
  return DECK.filter(k => !isGone(k) && !isKnown(k) && !inBook(k)).slice(0, limit);
}
/* 可用于学习的词条（扣除已删除的） */
const liveItems = () => ITEMS.filter(i => !isGone(i.key));

/* ---------------- 每日限额（每日新学 / 每日复习） ---------------- */
const dayCap = (v, dflt) => { const n = Math.floor(Number(v)); return n > 0 ? n : dflt; };
const dayLearnCap = () => dayCap(S.settings.dayLearn, 70);
const dayReviewCap = () => dayCap(S.settings.dayReview, 100);
const dayLearnUsed = () => (S.stats[todayKey()] ? S.stats[todayKey()].learn || 0 : 0);
const dayReviewUsed = () => (S.stats[todayKey()] ? S.stats[todayKey()].review || 0 : 0);
const dayLearnLeft = () => Math.max(0, dayLearnCap() - dayLearnUsed());
const dayReviewLeft = () => Math.max(0, dayReviewCap() - dayReviewUsed());
/* 今日用量的展示文字：设了上限显示 "3/20 个"，不限则显示 "3 个" */
const usedText = (used, cap, unit) => (cap >= 9999 ? used + ' ' + unit : used + '/' + cap + ' ' + unit);

function addBook(en) {
  const now = Date.now();
  S.book[en] = S.book[en] || { stage: 0, ok: 0, fail: 0, added: now, mastered: false };
  S.book[en].stage = 0;
  S.book[en].mastered = false;
  S.book[en].due = now + INTERVALS[0] * 60000;
  delete S.known[en];
  return S.book[en];
}

function passReview(en) {
  const e = S.book[en];
  e.ok = (e.ok || 0) + 1;
  e.stage += 1;
  if (e.stage >= INTERVALS.length) {
    e.mastered = true;
    e.due = null;
    return null;
  }
  e.due = Date.now() + INTERVALS[e.stage] * 60000;
  return e.due;
}

function failReview(en) {
  const e = S.book[en];
  e.fail = (e.fail || 0) + 1;
  e.stage = 0;
  e.mastered = false;
  e.due = Date.now() + INTERVALS[0] * 60000;
  return e.due;
}

/* ---------------- 今日打卡（学习和复习都完成才算） ---------------- */
/* 学习完成：今日新学额度用完，或已经没新词可学
   复习完成：今日复习额度用完，或（已经没有到期的生词，且今天确实复习过 / 生词本是空的） */
function dailyDone() {
  const learnDone = dayLearnLeft() <= 0 || newQueue(9999).length === 0;
  const reviewDone = dayReviewLeft() <= 0
    || (dueList().length === 0 && (dayReviewUsed() > 0 || Object.keys(S.book).length === 0));
  return learnDone && reviewDone;
}

/* 每次进度变化后统一走这里：存档 → 刷界面 → 判断今日打卡 */
function commit() {
  save();
  renderStudy();
  renderHome();
  renderView(currentView());
  maybeCheckin();
}

function maybeCheckin() {
  const k = todayKey();
  if (S.checkins[k]) return false;      // 今天已经打过卡
  if (!dailyDone()) return false;
  S.checkins[k] = Date.now();
  save();
  renderHome();
  renderSyncInfo();
  toast('今日打卡完成 🎉 正在上传到云端…', 2200);
  cloudSave(true).then(ok => {
    toast(ok ? '今日打卡完成 🎉 进度已同步到云端'
      : '今日打卡完成 🎉 云端没传上去，稍后可手动「保存到云端」', 3000);
  });
  return true;
}

/* ---------------- 学习 / 复习会话 ---------------- */
function startStudy(mode) {
  let queue;
  if (mode === 'learn') {
    const left = dayLearnLeft();
    if (left <= 0) { toast('今日新学已达上限（' + dayLearnCap() + ' 个），明天再学', 2400); return; }
    queue = newQueue(Math.min(left, Number(S.settings.size) || 20));
  } else if (mode === 'review') {
    const left = dayReviewLeft();
    if (left <= 0) { toast('今日复习已达上限（' + dayReviewCap() + ' 次），明天再来', 2400); return; }
    queue = dueList().slice(0, left);
  } else {
    const left = dayReviewLeft();
    if (left <= 0) { toast('今日复习已达上限（' + dayReviewCap() + ' 次），明天再来', 2400); return; }
    queue = Object.keys(S.book).filter(en => !S.book[en].mastered).slice(0, left);
  }

  if (!queue.length) {
    toast(mode === 'review' ? '暂时没有到期的生词，可以学点新词' : '没有更多新词了');
    return;
  }
  clearAutoTimer();
  session = { mode, queue, idx: 0, revealed: false, hist: [] };
  switchView('study');
  renderStudy();
}

function renderStudy() {
  const card = $('studyCard');
  const empty = $('studyEmpty');
  const actions = $('studyActions');

  if (!session || session.idx >= session.queue.length) {
    card.classList.add('hidden');
    actions.classList.add('hidden');
    empty.classList.remove('hidden');
    const n = session ? session.queue.length : 0;
    const td2 = S.stats[todayKey()] || { learn: 0, review: 0 };
    const restNew = newQueue(9999).length;
    const canLearnMore = Math.min(dayLearnLeft(), restNew);
    $('emptyTitle').textContent = session && session.mode === 'learn' ? '本轮新词学完了 🎉' : '本轮复习完成 🎉';
    $('emptyText').textContent = `本轮 ${n} 个 · 今日新学 ${usedText(td2.learn, dayLearnCap(), '个')}`
      + (canLearnMore ? ` · 今日还能学 ${canLearnMore} 个`
        : (restNew ? ' · 今日新学已达上限' : ' · 全部学完'));
    $('btnEmptyAction').textContent = (session && session.mode === 'learn' && canLearnMore) ? '继续学新词' : '返回今日';
    $('studyBar').style.width = '100%';
    $('studyCounter').textContent = `${n} / ${n}`;
    return;
  }

  card.classList.remove('hidden');
  actions.classList.remove('hidden');
  empty.classList.add('hidden');

  const t = byKey[session.queue[session.idx]];
  const bk = S.book[t.key];
  const confirming = !!session.confirm;
  $('cardRank').textContent = `词频 #${t.rank}`;
  $('cardMode').textContent = session.mode === 'learn'
    ? '学习新词'
    : (bk && bk.mastered ? '已掌握' : `第 ${(bk ? bk.stage : 0) + 1} 段复习 · 间隔 ${STAGE_LABEL[Math.min(bk ? bk.stage : 0, 8)]}`);
  $('cardEn').textContent = t.front;
  $('cardIpa').textContent = t.ipa || '';
  $('cardIpa').classList.remove('plain');
  const fav = isFav(t.key);
  const favLabel = $('btnFav').querySelector('span');
  if (favLabel) favLabel.textContent = fav ? '已收藏' : '收藏';
  $('btnFav').classList.toggle('on', fav);
  $('cardEx').textContent = t.ex || '';          // 例句

  // 换卡时给卡片一个轻微的进入动画
  if (session.lastKey !== t.key) {
    session.lastKey = t.key;
    card.classList.remove('card-anim');
    void card.offsetWidth;                        // 重置动画
    card.classList.add('card-anim');
  }
  $('cardZh').textContent = t.back || '';
  $('cardFull').textContent = `${t.back}：${t.front} ${t.ipa}`;
  $('cardAnswer').classList.toggle('hidden', !session.revealed);

  // 答案旁的核对标记
  const choice = confirming ? session.confirm.choice : null;
  $('cardZh').classList.toggle('checked', choice === 'known');
  $('cardZh').classList.toggle('unknown', choice === 'unknown');
  $('cardZh').dataset.mark = choice === 'known' ? '✓ 已记为认识'
    : choice === 'unknown' ? '已加入生词本 · ' + STAGE_LABEL[0] + '后再复习' : '';

  // 三个按钮保持一排：显示答案 / 不认识 / 认识
  const revealedOrConfirmed = session.revealed || confirming;
  $('btnReveal').textContent = revealedOrConfirmed ? '下一个' : '显示答案';
  $('btnUnknown').disabled = choice === 'unknown';
  $('btnKnown').disabled = choice === 'known';
  $('btnUnknown').textContent = choice === 'unknown' ? '不认识 ✓' : (choice === 'known' ? '改判不认识' : '不认识');
  $('btnKnown').textContent = choice === 'known' ? '认识 ✓' : (choice === 'unknown' ? '改认识' : '认识');

  $('studyBar').style.width = (session.idx / session.queue.length * 100) + '%';
  $('studyCounter').textContent = `${session.idx + 1} / ${session.queue.length}`;
  $('btnPrev').disabled = session.idx === 0;

  if (S.settings.autoSpeak && session.lastSpoken !== session.idx) {
    session.lastSpoken = session.idx;
    speak(t.front, KIND_SPEAK[t.kind], 2);   // 卡片出现时连读两遍
  }
}

/* 进入下一个词 */
function next() {
  clearAutoTimer();
  session.idx++;
  restoreCard();
  commit();
}

/* 显示第 idx 张卡片：若这张卡之前判定过，就恢复当时的判定状态（可改判） */
function restoreCard() {
  if (!session) return;
  const rec = session.hist[session.idx];
  if (rec) { session.confirm = rec; session.revealed = true; }
  else { session.confirm = null; session.revealed = false; }
}

/* ← 上一个：可回看并改判 */
function goPrev() {
  if (!session) return;
  if (session.idx === 0) { toast('已经是第一个了'); return; }
  clearAutoTimer();
  session.idx--;
  restoreCard();
  renderStudy();
}

/* 「显示答案」或「下一个」 */
function revealOrNext() {
  if (!session || session.idx >= session.queue.length) return;
  if (!session.revealed && !session.confirm) {
    session.revealed = true;
    renderStudy();
    return;
  }
  if (!session.confirm) toast('已跳过本词（未计入记录）');
  next();
}

/* ---------------- 判定：认识 / 不认识 ---------------- */
/* 应用一次判定（choice: 'known' | 'unknown'） */
function applyJudgement(en, mode, choice) {
  const st = stat();
  if (mode === 'learn') {
    if (choice === 'known') { S.known[en] = Date.now(); delete S.book[en]; }
    else { delete S.known[en]; addBook(en); }
    return;
  }
  if (choice === 'known') { st.ok++; passReview(en); }
  else { st.fail++; failReview(en); }
}

/* 撤销上一次判定，并把词条状态还原到判定前 */
function undoJudgement(en, mode, choice, prev) {
  const st = stat();
  if (mode === 'learn') {
    if (prev.known) S.known[en] = prev.known; else delete S.known[en];
    if (prev.book) S.book[en] = prev.book; else delete S.book[en];
  } else {
    // 复习（含“立即复习全部生词”）走这里
    if (choice === 'known') st.ok = Math.max(0, (st.ok || 0) - 1);
    else st.fail = Math.max(0, (st.fail || 0) - 1);
    S.book[en] = prev;
  }
}

/* 点「认识」/「不认识」：先判定并弹出正确答案，再等用户核对（可改判） */
function answer(choice) {
  if (!session || session.idx >= session.queue.length) return;
  const en = session.queue[session.idx];
  const c = session.confirm;

  // 已在核对状态：点同一个 = 无操作；点另一个 = 改判
  if (c) {
    if (c.choice === choice) return;
    undoJudgement(en, c.mode, c.choice, c.prev);
    applyJudgement(en, c.mode, choice);
    speakAnswered(en);   // 改判也再读一遍
    c.choice = choice;
    toast(choice === 'known'
      ? '已改判为「认识」· 移出生词本'
      : '已改判为「不认识」· 加入生词本，' + STAGE_LABEL[0] + '后再复习', 2400);
    clearAutoTimer();   // 一旦改判就停下来，让用户慢慢核对
    commit();
    return;
  }

  // 第一次判定：保存还原点
  const prev = session.mode === 'learn'
    ? { known: S.known[en], book: S.book[en] ? Object.assign({}, S.book[en]) : undefined }
    : Object.assign({}, S.book[en]);
  if (session.mode === 'learn') stat().learn++;
  else stat().review++;
  applyJudgement(en, session.mode, choice);
  speakAnswered(en);   // 点「认识」/「不认识」后再读一遍这个词

  const rec = { en, mode: session.mode, prev, choice };
  session.hist[session.idx] = rec;
  const isReview = session.mode !== 'learn';
  const rm = S.settings.reviewMode || 'auto';
  const learnMsg = choice === 'known'
    ? '已认识'
    : '已加入生词本 · ' + STAGE_LABEL[0] + '后再复习';

  // 节奏①：判定后立刻进入下一张（不展示答案，仍可用「上一个」回看改判）
  if (rm === 'instant') {
    session.confirm = null;
    session.revealed = false;
    let msg = learnMsg;
    if (isReview) {
      const e = S.book[en];
      msg = choice === 'known'
        ? (e.mastered ? '🎉 已掌握' : '记住了 · 下次复习 ' + relTime(e.due))
        : '没记住 · ' + relTime(e.due) + '再复习一次';
    }
    toast(msg, 1400);
    session.idx++;
    restoreCard();
    commit();
    return;
  }

  session.confirm = rec;
  session.revealed = true;

  if (isReview && choice === 'known' && S.book[en].mastered) {
    toast('🎉 已掌握' + (rm === 'auto' ? ' · 稍后下一张' : ''), 1800);
  } else if (isReview) {
    toast((choice === 'known' ? '已记为认识' : '已记为不认识') + (rm === 'auto' ? ' · 稍后下一张' : ''), 1400);
  } else {
    // 学习新词：认识 / 不认识 都会自动进入下一张
    toast(learnMsg + (rm === 'auto' ? ' · 稍后下一张' : ''), 1400);
  }

  commit();
  scheduleAutoNext(en);
}

/* 节奏②：显示答案 1.5 秒后自动进入下一张（学习新词与复习都适用） */
function scheduleAutoNext(en) {
  clearAutoTimer();
  if (!session) return;
  if ((S.settings.reviewMode || 'auto') !== 'auto') return;
  session.timer = setTimeout(() => {
    if (session && session.confirm && session.confirm.en === en) {
      session.idx++;
      restoreCard();
      commit();
    }
  }, 1500);
}

function clearAutoTimer() {
  if (session && session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function finishDelete(en) {
  const name = byKey[en].front;
  deleteWord(en);
  session.queue.splice(session.idx, 1);
  if (session.hist) session.hist.splice(session.idx, 1);
  restoreCard();
  save();
  toast('已删除「' + name + '」', 1400);
  renderStudy(); renderHome(); renderBook(); renderAll(); renderStats();
  maybeCheckin();
}

function sayCurrentWord() {
  if (!session || session.idx >= session.queue.length) return;
  const it = byKey[session.queue[session.idx]];
  if (!it) return;
  speak(it.front, KIND_SPEAK[it.kind], 2);   // 手动点喇叭/音标：连读两遍
  const fab = $('btnSpeak');
  if (fab) {
    fab.classList.add('playing');
    clearTimeout(fab._t);
    fab._t = setTimeout(() => fab.classList.remove('playing'), 800);
  }
}

/* 判定（认识 / 不认识）之后再读一遍这个词 */
function speakAnswered(en) {
  const it = byKey[en];
  if (it) speak(it.front, KIND_SPEAK[it.kind], 1);
}

function doDelete() {
  if (!session || session.idx >= session.queue.length) return;
  const en = session.queue[session.idx];
  if (!byKey[en]) return;
  if (!confirm('删除「' + byKey[en].front + '」？可在设置里恢复')) return;
  return finishDelete(en);
}

/* ---------------- 首页 ---------------- */
function renderHome() {
  const due = dueList().length;
  const dueToday = Math.min(due, dayReviewLeft());
  const restAll = newQueue(9999).length;
  const restToday = Math.min(restAll, dayLearnLeft());
  $('homeDue').textContent = dueToday;
  const bookN = validKeys(S.book).length;
  $('homeBook').textContent = bookN;
  $('homeLearned').textContent = learnedCount() + ' / ' + liveItems().length;
  $('homeStreak').textContent = checkinDays();
  $('bookPill').textContent = bookN;

  const pct = Math.round(learnedCount() / Math.max(1, liveItems().length) * 100);
  $('homeTip').textContent = `已学 ${pct}%`;
  const bar = $('homeBar');
  if (bar) bar.style.width = pct + '%';

  const td = S.stats[todayKey()] || { learn: 0, review: 0 };
  $('todayLine').textContent = '今日：新学 ' + usedText(td.learn || 0, dayLearnCap(), '个')
    + ' · 复习 ' + usedText(td.review || 0, dayReviewCap(), '次')
    + (S.checkins[todayKey()] ? ' · 今日打卡已完成 ✅' : '');

  $('btnStartReview').textContent = dueToday ? `开始复习（${dueToday}）` : (due ? '今日复习已达上限' : '开始复习');
  $('btnStartReview').disabled = dueToday === 0;
  $('btnStartLearn').textContent = restToday
    ? `开始学习（今日还剩 ${restToday} 个）`
    : (restAll ? '今日新学已达上限' : '全部学完');

  // 兼容被浏览器缓存的旧页面：若还存在词频分布模块就隐藏掉
  const freqPanel = $('freqBar');
  if (freqPanel && freqPanel.parentElement) freqPanel.parentElement.remove();
}

/* 累计打卡天数：完成过“今日学习 + 今日复习”的天数总和（不要求连续，断几天也不会清零） */
function checkinDays() {
  return Object.keys(S.checkins || {}).length;
}

/* ---------------- 生词本 ---------------- */
let bookFilter = 'due';
let bookSearch = '';

function renderBook() {
  const list = $('bookList');
  const all = validKeys(S.book);
  const due = all.filter(en => !S.book[en].mastered && S.book[en].due <= Date.now());
  const mastered = all.filter(en => S.book[en].mastered);
  const favs = validKeys(S.fav);
  $('bookSummary').textContent = `共 ${all.length} 个 · 待复习 ${due.length} · 已掌握 ${mastered.length} · 收藏 ${favs.length}`;

  let items = all;
  if (bookFilter === 'due') items = all.filter(en => !S.book[en].mastered);
  if (bookFilter === 'mastered') items = mastered;
  if (bookFilter === 'fav') items = favs;
  items = bookFilter === 'fav'
    ? items.slice().sort((a, b) => (S.fav[b] || 0) - (S.fav[a] || 0))    // 最近收藏的排前面
    : items.sort((a, b) => (S.book[a].due || Infinity) - (S.book[b].due || Infinity));

  const q = bookSearch.trim().toLowerCase();
  if (q) {
    items = items.filter(en => {
      const t = byKey[en] || {};
      return ((t.front || en) + ' ' + (t.back || '') + ' ' + (t.ipa || '') + ' ' + (t.ex || '')).toLowerCase().includes(q);
    });
  }

  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<p class="muted small">${q ? '没有匹配的词。' : bookFilter === 'fav' ? '还没有收藏的词。' : '这里还是空的。'}</p>`;
    return;
  }
  items.forEach(en => list.appendChild(bookRow(en)));
}

function bookRow(en) {
  const t = byKey[en] || { key: en, kind: 'word', front: en, back: '', ipa: '', sub: '', tag: '单词', rank: '-' };
  const e = S.book[en];
  const fav = isFav(en);
  const row = document.createElement('div');
  row.className = 'row';

  const dots = e ? Array.from({ length: INTERVALS.length },
    (_, i) => `<i class="dot ${i < e.stage ? 'on' : ''}"></i>`).join('') : '';
  const right = escapeHtml(t.ipa || '');
  const meta = e
    ? `${e.mastered ? '<span class="status-chip mastered">已掌握</span>' : `<span class="status-chip book">${relTime(e.due)}</span>`}
       <span class="dots">${dots}</span><span> 对 ${e.ok || 0} / 错 ${e.fail || 0}</span>`
    : '<span class="status-chip">仅收藏</span>';

  row.innerHTML = `
    <div>
      <div class="en">${escapeHtml(t.front)} <span class="ipa">${right}</span></div>
      <div class="zh">${escapeHtml(t.back || '')} ${fav ? '<span class="status-chip fav">收藏</span>' : ''}</div>
      <div class="meta">${meta}</div>
    </div>
    <div class="row-actions">
      <button class="mini" data-act="say" title="朗读"><svg class="ic"><use href="#i-sound"/></svg></button>
      <button class="mini fav${fav ? ' on' : ''}" data-act="fav" title="${fav ? '取消收藏' : '加入收藏'}"><svg class="ic"><use href="#i-star"/></svg></button>
      ${e ? '<button class="mini ok" data-act="know" title="标记为已掌握">掌握</button>'
    + '<button class="mini danger" data-act="del" title="移出生词本">移除</button>'
    : '<button class="mini ok" data-act="book" title="加入生词本">加入生词本</button>'}
    </div>`;

  row.querySelector('[data-act="say"]').onclick = () => speak(t.front, KIND_SPEAK[t.kind]);
  row.querySelector('[data-act="fav"]').onclick = () => {
    const on = toggleFav(en);
    save();
    toast(on ? '已收藏' : '已取消收藏', 1200);
    renderHome(); renderBook(); renderStats(); refreshLists();
  };
  if (e) {
    row.querySelector('[data-act="know"]').onclick = () => {
      S.book[en].mastered = true; S.book[en].due = null; save();
      toast('已标记为掌握'); renderHome(); renderBook(); renderStats(); refreshLists();
    };
    row.querySelector('[data-act="del"]').onclick = () => {
      delete S.book[en]; save();
      toast('已移出生词本'); renderHome(); renderBook(); renderStats(); refreshLists();
    };
  } else {
    row.querySelector('[data-act="book"]').onclick = () => {
      addBook(en); save();
      toast('已加入生词本'); renderHome(); renderBook(); renderStats(); refreshLists();
    };
  }
  return row;
}

function refreshLists() { renderAll(); }

/* ---------------- 列表（单词表） ---------------- */
const LISTS = {
  word: { filter: 'all', search: '', listId: 'allList', empty: '没有匹配的单词。' },
};

function renderKind(kind) {
  const cfg = LISTS[kind];
  const list = $(cfg.listId);
  if (!list) return;
  if (kind === 'word' && $('allCount')) $('allCount').textContent = ITEMS.length + ' 条';   // 条数自动跟着词库走
  const q = cfg.search.trim().toLowerCase();
  const items = liveItems().filter(i => i.kind === kind).filter(i => {
    if (q && !((i.front + ' ' + i.back + ' ' + (i.ipa || '')).toLowerCase().includes(q))) return false;
    if (cfg.filter === 'new') return !isKnown(i.key) && !inBook(i.key);
    if (cfg.filter === 'known') return isKnown(i.key);
    if (cfg.filter === 'book') return inBook(i.key) && !isMastered(i.key);
    if (cfg.filter === 'mastered') return isMastered(i.key);
    return true;
  });

  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<p class="muted small">${cfg.empty}</p>`;
    return;
  }
  const shown = items.slice(0, 1000);   // 词库 476 条，整表都能翻到底
  if (items.length > 300) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = `匹配 ${items.length} 条，先显示前 300 条，请用搜索缩小范围。`;
    list.appendChild(p);
  }
  shown.forEach(i => list.appendChild(itemRow(i, kind)));
}

const renderAll = () => renderKind('word');

function itemRow(t, kind) {
  const row = document.createElement('div');
  row.className = 'row';
  let chip = '<span class="status-chip">未学</span>';
  if (isMastered(t.key)) chip = '<span class="status-chip mastered">已掌握</span>';
  else if (inBook(t.key)) chip = '<span class="status-chip book">生词本</span>';
  else if (isKnown(t.key)) chip = '<span class="status-chip known">已认识</span>';

  const fav = isFav(t.key);
  const head = `#${t.rank} ${escapeHtml(t.front)} <span class="ipa">${escapeHtml(t.ipa || '')}</span>`;
  const sub = '';

  row.innerHTML = `
    <div>
      <div class="en">${head}</div>
      <div class="zh">${escapeHtml(t.back || '')} ${chip}</div>
      ${sub}
    </div>
    <div class="row-actions">
      <button class="mini" data-act="say" title="朗读"><svg class="ic"><use href="#i-sound"/></svg></button>
      <button class="mini fav${fav ? ' on' : ''}" data-act="fav" title="${fav ? '取消收藏' : '收藏'}"><svg class="ic"><use href="#i-star"/></svg></button>
      <button class="mini" data-act="book">${inBook(t.key) ? '移除' : '加生词本'}</button>
      <button class="mini ok" data-act="know">${isKnown(t.key) ? '取消认识' : '认识'}</button>
    </div>`;

  const redraw = () => {
    save(); renderKind(kind); renderBook(); renderHome(); renderStats();
  };
  row.querySelector('[data-act="say"]').onclick = () => speak(t.front, KIND_SPEAK[t.kind]);
  row.querySelector('[data-act="fav"]').onclick = () => {
    const on = toggleFav(t.key);
    toast(on ? '已收藏' : '已取消收藏', 1200);
    redraw();
  };
  row.querySelector('[data-act="book"]').onclick = () => {
    if (inBook(t.key)) { delete S.book[t.key]; toast('已移出生词本'); }
    else { addBook(t.key); toast('已加入生词本'); }
    redraw();
  };
  row.querySelector('[data-act="know"]').onclick = () => {
    if (isKnown(t.key)) { delete S.known[t.key]; }
    else { delete S.book[t.key]; S.known[t.key] = Date.now(); }
    redraw();
  };
  return row;
}

/* ---------------- 备份码解析（导入用） ---------------- */
const SHARE_PREFIX = 'MV1:';

function b64decode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* 把进度压成一段很短的文本：条目用序号表示，时间用“还有几分钟”表示 */
function packState() {
  const idx = new Map(ITEMS.map((it, i) => [it.key, i]));
  const now = Date.now();
  const k = Object.keys(S.known).map(x => idx.get(x)).filter(i => i !== undefined).sort((a, b) => a - b);
  const b = [];
  Object.keys(S.book).forEach(x => {
    const i = idx.get(x);
    if (i === undefined) return;
    const e = S.book[x];
    b.push([i, e.stage || 0, e.mastered ? -1 : Math.round(((e.due || now) - now) / 60000), e.ok || 0, e.fail || 0]);
  });
  b.sort((x, y) => x[0] - y[0]);
  const s = Object.keys(S.stats).sort().map(d => {
    const v = S.stats[d];
    return [d, v.learn || 0, v.review || 0, v.ok || 0, v.fail || 0];
  });
  return JSON.stringify({ v: 1, n: ITEMS.length, st: S.settings, k, b, s });
}

function unpackState(data) {
  const now = Date.now();
  const out = defaultState();
  // 兼容旧版完整存档（{known:{...}, book:{...}}）
  if (data.known || data.book) {
    Object.keys(data.known || {}).forEach(x => { if (byKey[x]) out.known[x] = now; });
    Object.entries(data.book || {}).forEach(([x, e]) => { if (byKey[x]) out.book[x] = Object.assign({}, e); });
    out.stats = data.stats || {};
    out.settings = Object.assign(out.settings, data.settings || {});
    Object.keys(data.fav || {}).forEach(x => { if (byKey[x]) out.fav[x] = data.fav[x] || now; });
    Object.keys(data.gone || {}).forEach(x => { if (byKey[x]) out.gone[x] = data.gone[x] || now; });
    out.checkins = Object.assign({}, data.checkins || {});
    out.sync = Object.assign({}, data.sync || {});
    return out;
  }
  (data.k || []).forEach(i => { const key = ITEMS[i] && ITEMS[i].key; if (key) out.known[key] = now; });
  (data.b || []).forEach(row => {
    const key = ITEMS[row[0]] && ITEMS[row[0]].key;
    if (!key) return;
    out.book[key] = {
      stage: row[1] || 0, ok: row[3] || 0, fail: row[4] || 0, added: now,
      mastered: row[2] < 0, due: row[2] < 0 ? null : now + row[2] * 60000,
    };
  });
  (data.s || []).forEach(row => { out.stats[row[0]] = { learn: row[1], review: row[2], ok: row[3], fail: row[4] }; });
  out.settings = Object.assign(out.settings, data.st || {});
  return out;
}

/* 读取用户选中的文件（兼容不支持 File.text() 的浏览器） */
function readFileText(file) {
  return new Promise((resolve, reject) => {
    if (file.text) { file.text().then(resolve, reject); return; }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('读取文件失败'));
    r.readAsText(file);
  });
}

/* 从任意文本里解析：支持压缩码、旧版 JSON、以及夹在聊天文字里的整段内容 */
async function parseShareText(input) {
  const txt = String(input || '');
  // 允许文本里带换行/空格（微信复制常会自动换行），遇到中文等非代码字符自动停止
  const m = txt.match(/MV1:[\sA-Za-z0-9_\-=+\/]+/);
  if (m) {
    const code = m[0].slice(SHARE_PREFIX.length).replace(/\s+/g, '');
    const kind = code[0];
    let json;
    try {
      const bytes = b64decode(code.slice(1));
      if (kind === 'G') {
        if (!('DecompressionStream' in window)) throw new Error('这台设备的浏览器不支持解压，请改用「从文件导入」');
        json = new TextDecoder().decode(await gunzipBytes(bytes));
      } else {
        json = new TextDecoder().decode(bytes);
      }
    } catch (e) {
      throw new Error(e && e.message ? e.message : '这段文字无法识别');
    }
    try {
      return JSON.parse(json);
    } catch (e) {
      throw new Error('文字好像不完整（缺了开头或结尾），请把整段内容完整复制过来');
    }
  }
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(txt.slice(s, e + 1));
  throw new Error('没找到可导入的内容，请把整段文字都粘进来');
}

/* ---------------- 云端同步（存在 GitHub 仓库里的 progress.json） ----------------
   读：同源读 progress.json，不需要令牌
   写：GitHub Contents API，需要一次性填一个令牌（只存在本机，不会跟着存档上传/导出）
   打卡完成后会自动上传一次；也可以在「进度备份」里手动保存 / 恢复
*/
const CLOUD = {
  api: 'https://api.github.com/repos/jinyinpeng/vocab/contents/progress.json',
  // 用绝对地址：在线版和「离线单文件版」都能读到同一份云端进度
  url: 'https://jinyinpeng.github.io/vocab/progress.json',
  tokenKey: KEY + '.gh-token',
};

function getToken() { try { return localStorage.getItem(CLOUD.tokenKey) || ''; } catch (e) { return ''; } }
function setToken(t) {
  try {
    if (t) localStorage.setItem(CLOUD.tokenKey, t);
    else localStorage.removeItem(CLOUD.tokenKey);
  } catch (e) { /* 隐私模式等 */ }
}

/* UTF-8 安全的 base64（GitHub 接口要求） */
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderSyncInfo() {
  const el = $('cloudInfo');
  if (!el) return;
  const s = S.sync || {};
  const parts = [getToken() ? '令牌已保存 ✓' : '还没填令牌（保存到云端需要）'];
  if (s.up) parts.push('上次上传 ' + fmtTime(s.up));
  if (s.down) parts.push('上次恢复 ' + fmtTime(s.down));
  el.textContent = parts.join(' · ');
  const ti = $('tokenInfo');
  if (ti) ti.textContent = getToken() ? '已保存（只存在这台设备上）' : '';
  const box = $('cloudToken');
  if (box) box.placeholder = getToken() ? '已保存令牌，重新粘贴可替换' : '粘贴令牌，或把整条一键链接粘进来';
}

async function cloudSha(token) {
  const res = await fetch(CLOUD.api + '?t=' + Date.now(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) return null;                       // 404 = 云端还没有这个文件
  return (await res.json()).sha || null;
}

async function cloudSave(silent) {
  const token = getToken();
  if (!token) {
    if (!silent) {
      // 把「填写同步令牌」那一块自动展开并聚焦，省得用户找不到
      const wrap = $('cloudTokenWrap');
      if (wrap) {
        wrap.open = true;
        try { wrap.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
      }
      const box = $('cloudToken');
      if (box) setTimeout(() => { try { box.focus(); } catch (e) { /* 忽略 */ } }, 300);
      toast('这台设备还没填令牌：把令牌（或整条一键链接）粘到下面框里保存', 4000);
    }
    return false;
  }
  const put = sha => fetch(CLOUD.api, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({
      message: '云备份 ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
      content: b64encodeUtf8(JSON.stringify(S, null, 1)),
      branch: 'main',
    }, sha ? { sha } : {})),
  });
  try {
    let res = await put(await cloudSha(token));
    if (res.status === 409 || res.status === 422) res = await put(await cloudSha(token));   // 云端刚被改过：重取 sha 再传
    if (!res.ok) {
      const hint = res.status === 401 ? '（令牌无效或已过期）'
        : res.status === 403 ? '（令牌权限不够，需要 public_repo 权限）'
          : res.status === 404 ? '（仓库或权限不对）' : '';
      throw new Error('HTTP ' + res.status + hint);
    }
    S.sync = Object.assign({}, S.sync, { up: Date.now() });
    save();
    renderSyncInfo();
    if (!silent) toast('已保存到云端 ✓');
    return true;
  } catch (e) {
    if (!silent) toast('保存失败：' + ((e && e.message) || e), 3200);
    return false;
  }
}

/* 一键配置：把令牌放在 #tok=… 里用手机点开，就自动存好并抹掉地址栏里的令牌
   （# 后面的内容不会发给服务器，只在本地传递） */
function applyTokenFromUrl() {
  const m = (location.hash || '').match(/tok=([A-Za-z0-9_\-]+)/);
  if (!m) return false;
  setToken(m[1]);
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (e) { location.hash = ''; }
  renderSyncInfo();
  toast('云端同步已配好 ✓ 打卡完成后会自动上传', 3600);
  // 本机已经有进度就顺手备份一次；空进度不会覆盖云端
  if (learnedCount() + checkinDays() > 0) setTimeout(() => cloudSave(true), 1500);
  return true;
}

async function cloudLoad() {
  try {
    const res = await fetch(CLOUD.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(res.status === 404
        ? '云端还没有备份（先在常用设备点一次「保存到云端」）' : 'HTTP ' + res.status);
    }
    const data = await res.json();
    const keepUp = (S.sync || {}).up;
    S = unpackState(data);
    if (!S.settings.sizeExplicit) S.settings.size = 9999;
    S.settings.dayLearn = Number(S.settings.dayLearn) > 0 ? Number(S.settings.dayLearn) : 70;
    S.settings.dayReview = Number(S.settings.dayReview) > 0 ? Number(S.settings.dayReview) : 100;
    S.sync = Object.assign({}, S.sync, { up: keepUp || S.sync.up, down: Date.now() });
    save();
    session = null;
    renderAll2();
    toast('已从云端恢复：已学 ' + learnedCount() + ' / ' + liveItems().length, 2800);
    return true;
  } catch (e) {
    toast('恢复失败：' + ((e && e.message) || e), 3200);
    return false;
  }
}

/* ---------------- 下拉更新 / 检查更新 ---------------- */

/* 服务器是否还能连上（连不上说明在离线用本机缓存，或在用已经失效的旧地址） */
async function serverReachable() {
  try {
    const res = await fetch('app.js?probe=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch (e) { return false; }
}

function doUpdate() {
  // 先确认服务器还在，避免"看起来更新了、其实还是本机缓存的旧版本"
  serverReachable().then(ok => {
    if (!ok && navigator.onLine) {
      toast('连不上服务器，现在用的是本机缓存的 ' + BUILD + '，稍后再试', 3000);
      return;
    }
    try { location.replace(location.pathname + '?u=' + Date.now()); }   // 带时间戳绕过缓存
    catch (e) { location.reload(); }
  });
}

/* 打开应用时探一次：连不上就说明在用本机缓存，直接告诉用户 */
let netWarned = false;
async function watchServer() {
  if (netWarned || !navigator.onLine) return;
  if (await serverReachable()) return;
  netWarned = true;
  toast('连不上服务器，正在用本机缓存的 ' + BUILD, 3200);
}

async function checkUpdate() {
  const info = $('updateInfo');
  info.textContent = '检查中…';
  try {
    const res = await fetch('app.js', { cache: 'no-store' });
    const txt = await res.text();
    const m = txt.match(/const BUILD = '([^']+)'/);
    if (m && m[1] !== BUILD) {
      info.textContent = '发现新版本（' + m[1] + '），正在更新…';
      setTimeout(doUpdate, 400);
    } else {
      info.textContent = '已是最新版本（' + BUILD + '）';
    }
  } catch (e) {
    info.textContent = '连不上服务器（现在用的是本机缓存 ' + BUILD + '），稍后再试';
  }
}

function initPullToRefresh() {
  const el = $('ptr');            // 提示条已移除：这里不再显示任何文字，下拉静默更新
  const label = $('ptrText');
  let startY = null, dist = 0, busy = false;

  const ui = (state) => {
    if (!el || !label) return;
    el.classList.toggle('show', state !== 'idle');
    el.classList.toggle('ready', state === 'ready');
    label.textContent = state === 'busy' ? '正在更新…'
      : state === 'ready' ? '松手更新到最新版本'
        : '下拉更新到最新版本';
  };

  document.addEventListener('touchstart', e => {
    if (busy || window.scrollY > 4 || e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY; dist = 0;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (startY === null || busy) return;
    const d = e.touches[0].clientY - startY;
    if (d <= 0) { dist = 0; ui('idle'); return; }
    dist = d;
    ui(d > 70 ? 'ready' : 'pull');
    if (d > 12 && e.cancelable) e.preventDefault();
  }, { passive: false });

  const finish = () => {
    if (startY === null) return;
    const d = dist;
    startY = null;
    dist = 0;
    if (d > 70) { busy = true; ui('busy'); setTimeout(doUpdate, 200); }
    else ui('idle');
  };
  document.addEventListener('touchend', finish);
  document.addEventListener('touchcancel', finish);
}

/* ---------------- 统计 ---------------- */
function renderStats() {
  const bookKeys = validKeys(S.book);
  const knownN = Object.keys(S.known).length;
  const mastered = bookKeys.filter(en => S.book[en].mastered).length;
  let ok = 0, fail = 0;
  bookKeys.forEach(en => { ok += S.book[en].ok || 0; fail += S.book[en].fail || 0; });
  const t = todayKey();
  const tbl = ['stLearned', 'stKnown', 'stBook', 'stMastered', 'stToday', 'stRate'];
  tbl.forEach((id, i) => {
    const v = [learnedCount(), knownN, bookKeys.length, mastered, (S.stats[t] ? S.stats[t].review : 0),
      (ok + fail ? Math.round(ok / (ok + fail) * 100) + '%' : '—')][i];
    $(id).textContent = v;
  });

  // 近 7 天
  const chart = $('chart7');
  chart.innerHTML = '';
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d);
  }
  const vals = days.map(d => {
    const s = S.stats[d.toISOString().slice(0, 10)];
    return s ? s.learn + s.review : 0;
  });
  const max = Math.max(1, ...vals);
  days.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<span class="v">${vals[i] || ''}</span>
      <div class="b" style="height:${Math.round(vals[i] / max * 78) + 4}px"></div>
      <span class="t">${d.getMonth() + 1}/${d.getDate()}</span>`;
    chart.appendChild(col);
  });

  // 阶段分布
  const cs = $('chartStage');
  cs.innerHTML = '';
  const counts = Array(INTERVALS.length).fill(0);
  bookKeys.forEach(en => {
    const e = S.book[en];
    if (e.mastered) return;
    counts[Math.min(e.stage, INTERVALS.length - 1)]++;
  });
  const mx = Math.max(1, ...counts);
  counts.forEach((c, i) => {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<span class="v">${c || ''}</span>
      <div class="b" style="height:${Math.round(c / mx * 78) + 4}px"></div>
      <span class="t">${i + 1}段</span>`;
    cs.appendChild(col);
  });
}

/* ---------------- 导航 ---------------- */
function currentView() {
  const el = document.querySelector('.view.active');
  return el ? el.id.replace('view-', '') : 'home';
}

function renderView(name) {
  if (name === 'home') renderHome();
  else if (name === 'wordbook') renderBook();
  else if (name === 'all') renderAll();
  else if (name === 'stats') renderStats();
}

function switchView(name) {
  if (name !== 'study') clearAutoTimer();   // 离开学习/复习页就暂停自动下一张
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  renderView(name);
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* 某些环境不支持 */ }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    if (b.dataset.view === 'study' && !session) { startStudy('learn'); return; }
    switchView(b.dataset.view);
  });

  $('btnStartReview').onclick = () => startStudy('review');
  $('btnStartLearn').onclick = () => startStudy('learn');
  $('btnReveal').onclick = () => revealOrNext();
  $('btnKnown').onclick = () => answer('known');
  $('btnUnknown').onclick = () => answer('unknown');
  $('btnPrev').onclick = () => goPrev();
  $('btnPrev2').onclick = () => goPrev();
  $('btnEmptyAction').onclick = () => {
    const again = session && session.mode === 'learn'
      && Math.min(dayLearnLeft(), newQueue(9999).length);
    session = null;
    if (again) startStudy('learn'); else switchView('home');
  };
  $('cardIpa').onclick = () => sayCurrentWord();
  // 卡片右下角的喇叭
  $('btnSpeak').onclick = () => sayCurrentWord();
  $('btnFav').onclick = () => {
    if (!session || session.idx >= session.queue.length) return;
    const en = session.queue[session.idx];
    const on = toggleFav(en);
    save();
    toast(on ? '已收藏' : '已取消收藏', 1200);
    renderStudy(); renderBook(); renderHome();
  };
  $('btnDel').onclick = () => doDelete();
  $('btnExtraReview').onclick = () => startStudy('extra');
  $('autoSpeak').addEventListener('change', e => { S.settings.autoSpeak = e.target.checked; save(); });

  $('bookFilters').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    bookFilter = c.dataset.f;
    [...e.currentTarget.children].forEach(x => x.classList.toggle('active', x === c));
    renderBook();
  });
  [['allFilters', 'word', 'searchInput']]
    .forEach(([fid, kind, sid]) => {
      $(fid).addEventListener('click', e => {
        const c = e.target.closest('.chip'); if (!c) return;
        LISTS[kind].filter = c.dataset.f;
        [...e.currentTarget.children].forEach(x => x.classList.toggle('active', x === c));
        renderKind(kind);
      });
      $(sid).addEventListener('input', e => { LISTS[kind].search = e.target.value; renderKind(kind); });
    });

  $('bookSearch').addEventListener('input', e => { bookSearch = e.target.value; renderBook(); });

  // 侧栏/顶部快捷入口：有待复习就复习，否则学新词
  $('railGo').onclick = () => {
    if (dueList().length) startStudy('review'); else startStudy('learn');
  };

  $('reviewMode').addEventListener('change', e => {
    S.settings.reviewMode = e.target.value;
    save();
    toast(e.target.value === 'instant' ? '复习：判定后立刻下一张'
      : e.target.value === 'manual' ? '复习：显示答案后自己点「下一个」'
        : '复习：显示答案 1.5 秒后自动下一张');
    renderStudy();
  });

  $('sessionSize').addEventListener('change', e => {
    S.settings.size = Number(e.target.value);
    S.settings.sizeExplicit = true;
    save();
    toast(S.settings.size >= 9999 ? '已设为不限：一直学到你自己停下来' : '每轮学习 ' + S.settings.size + ' 个新词');
    renderHome();
  });

  $('dayLearn').addEventListener('change', e => {
    S.settings.dayLearn = Number(e.target.value);
    save();
    toast(S.settings.dayLearn >= 9999 ? '每日新学：不限' : '每日最多学 ' + S.settings.dayLearn + ' 个新词');
    renderHome();
  });

  $('dayReview').addEventListener('change', e => {
    S.settings.dayReview = Number(e.target.value);
    save();
    toast(S.settings.dayReview >= 9999 ? '每日复习：不限' : '每日最多复习 ' + S.settings.dayReview + ' 次');
    renderHome();
  });

  $('themeBtn').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY + '.theme', next);
  };

  const applyImported = (data, msgId) => {
    S = unpackState(data);
    if (!S.settings.sizeExplicit) S.settings.size = 9999;
    save();
    session = null;
    renderAll2();
    const info = '导入成功：已学 ' + learnedCount() + ' / ' + ITEMS.length;
    if (msgId) $(msgId).textContent = info;
    toast(info, 2600);
  };

  const importText = async (text, msgId) => {
    if (msgId) $(msgId).textContent = '';
    try {
      applyImported(await parseShareText(text), msgId);
      return true;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msgId) $(msgId).textContent = msg;
      toast('导入失败：' + msg, 3200);
      return false;
    }
  };

  $('btnCloudSave').onclick = () => cloudSave(false);
  $('btnCloudLoad').onclick = () => {
    if (!confirm('从云端恢复会用云端的进度覆盖本机（进度、生词本、收藏、设置），继续？')) return;
    cloudLoad();
  };
  $('btnTokenSave').onclick = () => {
    const raw = ($('cloudToken').value || '').trim();
    // 允许直接粘贴令牌，也允许把整条「一键链接」粘进来（自动从里面取令牌）
    const hit = raw.match(/tok=([A-Za-z0-9_\-]+)/);
    const v = hit ? hit[1] : raw;
    if (!v) { toast('请先粘贴令牌，或把那条一键链接整个粘进来', 3000); return; }
    if (!/^(gh[pousr]_|github_pat_)/.test(v)) { toast('这看起来不是 GitHub 令牌（应以 ghp_ / gho_ 开头）', 3000); return; }
    setToken(v);
    $('cloudToken').value = '';
    renderSyncInfo();
    toast('令牌已保存，现在可以「保存到云端」了');
  };
  $('btnTokenClear').onclick = () => {
    setToken('');
    renderSyncInfo();
    toast('已清除令牌', 1400);
  };

  $('btnCheckUpdate').onclick = () => checkUpdate();

  $('btnWechat').onclick = () => {
    const wrap = $('wechatWrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) $('wechatInfo').textContent = '';
  };

  $('btnOpenWeChat').onclick = () => {
    try { window.location.href = 'weixin://'; } catch (e) { /* 电脑上无此协议 */ }
  };

  $('btnPickFile').onclick = () => $('fileInput').click();

  $('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('wechatInfo').textContent = '正在读取 ' + f.name + ' …';
    await importText(await readFileText(f), 'wechatInfo');
    e.target.value = '';
  });

  $('btnDoImport').onclick = () => importText($('pasteBox').value, 'pasteInfo');

  $('btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'medvocab-backup-' + todayKey() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('btnImport').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,.txt,application/json,text/plain';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      await importText(await readFileText(f), null);
    };
    inp.click();
  };
  $('btnRestore').onclick = () => {
    const n = restoreAllGone();
    if (!n) { toast('没有已删除的词'); return; }
    save(); toast('已恢复 ' + n + ' 个词', 1600);
    renderStudy(); renderHome(); renderBook(); renderAll(); renderStats();
  };
  $('btnReset').onclick = () => {
    if (!confirm('确定清空全部学习进度？此操作不可撤销。')) return;
    S = defaultState(); save(); session = null; renderAll2();
    toast('已清空，重新开始');
  };

  document.addEventListener('keydown', e => {
    if (/input|textarea|select/i.test((e.target.tagName || ''))) return;
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      if (session) revealOrNext();
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); return; }
    if (e.key === '1' || e.key === 'j') { answer('unknown'); return; }
    if (e.key === '2' || e.key === 'k') { answer('known'); return; }
    if (e.key.toLowerCase() === 'r' && session && session.idx < session.queue.length) {
      const it = byKey[session.queue[session.idx]];
      speak(it.front, KIND_SPEAK[it.kind]);
    }
  });
}

function renderAll2() {
  renderHome(); renderBook(); refreshLists(); renderStats();
  $('sessionSize').value = String(S.settings.size);
  $('dayLearn').value = String(dayLearnCap());
  $('dayReview').value = String(dayReviewCap());
  $('autoSpeak').checked = !!S.settings.autoSpeak;
  $('reviewMode').value = S.settings.reviewMode || 'auto';
  renderSyncInfo();
  const bi = $('buildInfo');
  if (bi) bi.textContent = '当前版本 ' + BUILD;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 离线可用（PWA） ---------------- */
function initOffline() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // 单文件离线版没有服务器，跳过
  const secure = location.protocol === 'https:'
    || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) return;   // http 打开时浏览器不允许离线缓存，静默跳过
  try {
    // 注意：sw.js 每次发布新版本时，把下面的 ?v= 数字 +1
    //（CDN/代理会缓存同路径文件，加版本号才能让浏览器拿到新的 Service Worker）
    navigator.serviceWorker.register('sw.js?v=27', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(reg => {
        const bi = $('buildInfo');
        if (bi) bi.textContent = '当前版本 ' + BUILD + ' · 离线可用';
        // 把本次真正用到的脚本 / 样式报给 Service Worker 缓存，保证离线时版本一致
        try {
          const own = performance.getEntriesByType('resource')
            .map(e => e.name)
            .filter(n => n.startsWith(location.origin + '/') && /\.(js|css|json|png|webmanifest)(\?|$)/.test(n));
          if (reg.active) reg.active.postMessage({ type: 'cache-urls', urls: [...new Set(own)] });
        } catch (e) { /* 老浏览器没有 performance API 时忽略 */ }
      })
      .catch(() => { /* 不支持或注册失败时按普通网页使用 */ });
  } catch (e) { /* 老浏览器忽略 */ }
}

/* ---------------- 启动 ---------------- */
async function init() {
  loadState();
  const theme = localStorage.getItem(KEY + '.theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme);

  try {
    // 带版本号取词库，保证拿到的是与代码匹配的最新词库（含例句）
    TERMS = await (await fetch('terms.json?v=' + BUILD.split(' ')[0])).json();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">无法读取 terms.json，请通过本地服务器（http://localhost:…）打开本页面。</p>';
    return;
  }
  buildItems();
  // 支持「一键链接」配置云端令牌：App 已经开着时点链接不会重新加载，所以也监听 hash 变化
  applyTokenFromUrl();
  window.addEventListener('hashchange', applyTokenFromUrl);

  bind();
  initPullToRefresh();
  renderAll2();
  initOffline();
  setTimeout(watchServer, 1600);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') watchServer(); });
}

if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
init();
