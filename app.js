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
const BUILD = 'v52 · 2026-09-22';   // 每次更新代码时改这里，用来判断“是否最新版本”

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
    delete S.sync;                                          // 云端同步已下线：清掉旧存档里的同步状态
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
    // 云同步功能已下线：把之前存在本机的同步令牌一并清掉，不留残余
    try { localStorage.removeItem(KEY + '.gh-token'); } catch (e) { /* 隐私模式等 */ }
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

/* 防抖：搜索框每敲一个字就重排整张列表太费，停 200ms 再算 */
const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

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
  pushSnap();                       // 打卡完成顺手留一份本机备份
  renderHome();
  toast('今日打卡完成 🎉 连续坚持中，明天见', 3000);
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
  $('cardRank').textContent = `高频 #${t.rank}`;
  $('cardMode').textContent = session.mode === 'learn'
    ? '学习新词'
    : (bk && bk.mastered ? '已掌握' : `复习 ${(bk ? bk.stage : 0) + 1}/${INTERVALS.length}`);
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

  $('btnStartReview').textContent = dueToday ? `开始复习（${dueToday}）` : (due ? '今日复习已满' : '开始复习');
  $('btnStartReview').disabled = dueToday === 0;
  $('btnStartLearn').textContent = restToday
    ? `开始学习（剩 ${restToday}）`
    : (restAll ? '今日新学已满' : '全部学完');

  // 兼容被浏览器缓存的旧页面：若还存在词频分布模块就隐藏掉
  const freqPanel = $('freqBar');
  if (freqPanel && freqPanel.parentElement) freqPanel.parentElement.remove();
}

/* 累计打卡天数：完成过“今日学习 + 今日复习”的天数总和（不要求连续，断几天也不会清零） */
function checkinDays() {
  return Object.keys(S.checkins || {}).length;
}

/* ---------------- 列表通用：分页渲染 + 事件委托 ----------------
   词库有 600+ 条，一次性把整表塞进 DOM 在手机上会明显卡顿，
   所以：先渲染一页（60 行），点「显示更多」再往后接；行的按钮用事件委托统一处理。 */
const LIST_STEP = 60;

/* 过滤条件变了就回到第一页；点「显示更多」再往后加一页
   注意：结果比一页还少时要按实际条数来，否则会渲染出空行 */
function pageSize(state, sig, total, more) {
  if (state.sig !== sig) { state.sig = sig; state.shown = LIST_STEP; }
  else if (more) state.shown = (state.shown || LIST_STEP) + LIST_STEP;
  state.shown = Math.min(state.shown || LIST_STEP, total);
  return state.shown;
}

function appendMoreButton(list, shown, total, onClick) {
  if (shown >= total) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn ghost more-btn';
  btn.textContent = '显示更多（还有 ' + (total - shown) + ' 条）';
  btn.onclick = onClick;
  list.appendChild(btn);
}

function emptyList(list, text) {
  list.textContent = '';
  const p = document.createElement('p');
  p.className = 'muted small list-empty';
  p.textContent = text;
  list.appendChild(p);
}

/* 列表行里的按钮统一在这里处理（kind: word=单词表 book=生词本） */
function onRowAct(kind, key, act) {
  const t = byKey[key];
  if (!t) return;
  if (act === 'say') { speak(t.front, KIND_SPEAK[t.kind], 2); return; }
  if (act === 'fav') toast(toggleFav(key) ? '已收藏' : '已取消收藏', 1200);
  else if (act === 'book') {
    if (inBook(key)) { delete S.book[key]; toast('已移出生词本'); }
    else { addBook(key); toast('已加入生词本'); }
  } else if (act === 'know') {
    if (kind === 'book') {                      // 生词本：标为已掌握
      S.book[key].mastered = true;
      S.book[key].due = null;
      toast('已标为掌握 ✓');
    } else if (isKnown(key)) {                  // 单词表：取消标记
      delete S.known[key];
      toast('已取消标记');
    } else {                                    // 单词表：标为已认识
      delete S.book[key];
      S.known[key] = Date.now();
      toast('已标为认识 ✓');
    }
  } else if (act === 'del') {                   // 生词本：移出
    delete S.book[key];
    toast('已移出生词本');
  }
  save();
  renderKind('word');
  renderBook();
  renderHome();
  renderStats();
}

/* ---------------- 生词本 ---------------- */
let bookFilter = 'due';
let bookSearch = '';
const bookPage = { sig: '', shown: LIST_STEP };

function renderBook(more) {
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

  if (!items.length) {
    emptyList(list, q ? '没有匹配的词。' : bookFilter === 'fav' ? '还没有收藏的词。' : '这里还是空的。');
    return;
  }
  const shown = pageSize(bookPage, bookFilter + '|' + q, items.length, more);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i++) frag.appendChild(bookRow(items[i]));
  list.textContent = '';
  list.appendChild(frag);
  appendMoreButton(list, shown, items.length, () => renderBook(true));
}

function bookRow(en) {
  const t = byKey[en] || { key: en, kind: 'word', front: en, back: '', ipa: '', rank: '-' };
  const e = S.book[en];
  const fav = isFav(en);
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.key = en;

  const meta = e
    ? (e.mastered ? '<span class="status-chip mastered">已掌握</span>'
      : '<span class="status-chip book">' + relTime(e.due) + '</span>')
    + (e.mastered ? '' : '<span class="row-tag">第 ' + ((e.stage || 0) + 1) + ' 段</span>')
    + '<span class="row-tag">对 ' + (e.ok || 0) + ' · 错 ' + (e.fail || 0) + '</span>'
    : '<span class="status-chip">仅收藏</span>';

  row.innerHTML = `
    <div class="row-main">
      <div class="en">${escapeHtml(t.front)} <span class="ipa">${escapeHtml(t.ipa || '')}</span></div>
      <div class="meta">${meta}</div>
    </div>
    <div class="row-actions">
      <button type="button" class="mini ico" data-act="say" title="朗读" aria-label="朗读"><svg class="ic"><use href="#i-sound"/></svg></button>
      <button type="button" class="mini ico fav${fav ? ' on' : ''}" data-act="fav" title="${fav ? '取消收藏' : '加入收藏'}" aria-label="收藏"><svg class="ic"><use href="#i-star"/></svg></button>
      ${e
        ? '<button type="button" class="mini ok" data-act="know">标为已掌握</button>'
        + '<button type="button" class="mini danger" data-act="del">移出生词本</button>'
        : '<button type="button" class="mini ok" data-act="book">加入生词本</button>'}
    </div>`;
  return row;
}

function refreshLists() { renderKind('word'); }

/* ---------------- 列表（单词表） ---------------- */
const LISTS = {
  word: { filter: 'all', search: '', listId: 'allList', empty: '没有匹配的单词。', sig: '', shown: LIST_STEP },
};

function kindItems(kind) {
  const cfg = LISTS[kind];
  const q = cfg.search.trim().toLowerCase();
  return liveItems().filter(i => i.kind === kind).filter(i => {
    if (q && !((i.front + ' ' + i.back + ' ' + (i.ipa || '')).toLowerCase().includes(q))) return false;
    if (cfg.filter === 'new') return !isKnown(i.key) && !inBook(i.key);
    if (cfg.filter === 'known') return isKnown(i.key);
    if (cfg.filter === 'book') return inBook(i.key) && !isMastered(i.key);
    if (cfg.filter === 'mastered') return isMastered(i.key);
    return true;
  });
}

function renderKind(kind, more) {
  const cfg = LISTS[kind];
  const list = $(cfg.listId);
  if (!list) return;
  if (kind === 'word' && $('allCount')) $('allCount').textContent = ITEMS.length + ' 条';   // 条数自动跟着词库走
  const items = kindItems(kind);
  if (!items.length) { emptyList(list, cfg.empty); return; }
  const shown = pageSize(cfg, cfg.filter + '|' + cfg.search.trim().toLowerCase(), items.length, more);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i++) frag.appendChild(itemRow(items[i], kind));
  list.textContent = '';
  list.appendChild(frag);
  appendMoreButton(list, shown, items.length, () => renderKind(kind, true));
}

const renderAll = () => renderKind('word');

function itemRow(t, kind) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.key = t.key;
  let chip = '<span class="status-chip">未学</span>';
  if (isMastered(t.key)) chip = '<span class="status-chip mastered">已掌握</span>';
  else if (inBook(t.key)) chip = '<span class="status-chip book">生词本</span>';
  else if (isKnown(t.key)) chip = '<span class="status-chip known">已认识</span>';

  const fav = isFav(t.key);
  row.innerHTML = `
    <div class="row-main">
      <div class="en"><span class="row-tag no">#${t.rank}</span>${escapeHtml(t.front)} <span class="ipa">${escapeHtml(t.ipa || '')}</span></div>
      <div class="zh">${escapeHtml(t.back || '')} ${chip}</div>
    </div>
    <div class="row-actions">
      <button type="button" class="mini ico" data-act="say" title="朗读" aria-label="朗读"><svg class="ic"><use href="#i-sound"/></svg></button>
      <button type="button" class="mini ico fav${fav ? ' on' : ''}" data-act="fav" title="${fav ? '取消收藏' : '收藏'}" aria-label="收藏"><svg class="ic"><use href="#i-star"/></svg></button>
      <button type="button" class="mini" data-act="book">${inBook(t.key) ? '移出生词本' : '加入生词本'}</button>
      <button type="button" class="mini ok" data-act="know">${isKnown(t.key) ? '取消已认识' : '标为已认识'}</button>
    </div>`;
  return row;
}

/* ---------------- 备份文件解析（恢复用） ---------------- */
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

/* 备份文件就是一段 JSON；这里宽松一点，文件前后夹了别的字符也能解析出来 */
function parseBackupText(input) {
  const txt = String(input || '');
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('这个文件不像是备份文件');
  try {
    return JSON.parse(txt.slice(s, e + 1));
  } catch (err) {
    throw new Error('备份内容读不出来（文件可能不完整）');
  }
}

/* ---------------- 进度备份状态 ---------------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderBackupInfo() {
  const el = $('backupInfo');
  if (!el) return;
  const parts = ['已学 ' + learnedCount() + ' / ' + liveItems().length];
  const snaps = listSnaps();
  if (snaps.length) parts.push('本机自动备份 ' + snapCount() + ' 份（最新 ' + fmtTime(snaps[0].t) + '）');
  if (S.lastBackupAt) parts.push('上次导出 ' + fmtTime(S.lastBackupAt));
  if (S.lastRestoreAt) parts.push('上次恢复 ' + fmtTime(S.lastRestoreAt));
  el.textContent = parts.join(' · ');
}

/* ---------------- 本机自动备份（「一键恢复」直接用这份，不弹任何窗口） ----------------
   浏览器不允许网页去翻手机的「文件」，所以进度另存一份在本机：
   每天第一次打开 App、打卡完成、以及手动备份时各留一份，最多留 5 份。 */
const SNAP_KEY = KEY + '.snaps';
const SNAP_MAX = 5;

function listSnaps() {
  try {
    const arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => x && x.t && x.d) : [];
  } catch (e) { return []; }
}
const snapCount = () => listSnaps().length;

/* 把当前进度存成一份本机备份（和最新一份内容一样就跳过） */
function pushSnap() {
  try {
    const arr = listSnaps();
    const d = JSON.stringify(S);
    if (arr.length && arr[0].d === d) return false;
    arr.unshift({ t: Date.now(), d });
    localStorage.setItem(SNAP_KEY, JSON.stringify(arr.slice(0, SNAP_MAX)));
    return true;
  } catch (e) { return false; }   // 空间不足等，忽略
}

/* 每天最多自动留一份（没学过任何东西就不留，免得塞满空白存档） */
function autoDailySnap() {
  const day = 24 * 3600 * 1000;
  const snaps = listSnaps();
  if (snaps.length && (Date.now() - snaps[0].t) < day) return;
  if ((learnedCount() + checkinDays()) === 0) return;
  if (pushSnap()) renderBackupInfo();
}

const backupFileName = () => 'medvocab-backup-' + todayKey() + '.json';

/* 备份完记一笔时间，顺便刷新状态行 */
function afterBackup() {
  S.lastBackupAt = Date.now();
  save();
  pushSnap();                     // 同时在本机留一份，「一键恢复」就不用弹窗口了
  renderBackupInfo();
}

/* 直接触发浏览器下载（桌面浏览器用；download 属性不会被当成导航） */
function downloadFile(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (e) { /* 忽略 */ }
    URL.revokeObjectURL(url);
  }, 8000);
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

  // 列表行的按钮：一个监听管住整张表（行是动态生成的，逐行挂监听在手机上很卡）
  [['allList', 'word'], ['bookList', 'book']].forEach(([id, kind]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.row');
      if (row && row.dataset.key) onRowAct(kind, row.dataset.key, btn.dataset.act);
    });
  });

  const setWordSearch = debounce(v => { LISTS.word.search = v; renderKind('word'); }, 200);
  const setBookSearch = debounce(v => { bookSearch = v; renderBook(); }, 200);

  $('bookFilters').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    bookFilter = c.dataset.f;
    [...e.currentTarget.children].forEach(x => x.classList.toggle('active', x === c));
    renderBook();
  });
  $('allFilters').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    LISTS.word.filter = c.dataset.f;
    [...e.currentTarget.children].forEach(x => x.classList.toggle('active', x === c));
    renderKind('word');
  });
  $('searchInput').addEventListener('input', e => setWordSearch(e.target.value));
  $('bookSearch').addEventListener('input', e => setBookSearch(e.target.value));

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

  const importText = (text, msgId) => {
    if (msgId) $(msgId).textContent = '';
    try {
      applyImported(parseBackupText(text), msgId);
      return true;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msgId) $(msgId).textContent = msg;
      toast('导入失败：' + msg, 3200);
      return false;
    }
  };

  $('btnCheckUpdate').onclick = () => checkUpdate();

  /* 一键备份：无论如何都不离开当前页面
     ① 手机上（支持分享文件的浏览器）→ 弹系统面板，选「存储到"文件"」
     ② 电脑/其它浏览器 → 在隐藏 iframe 里下载 */
  $('btnExport').onclick = () => {
    const name = backupFileName();
    const text = JSON.stringify(S, null, 1);
    let file = null;
    try { file = new File([text], name, { type: 'application/json' }); } catch (e) { file = null; }
    const canShareFile = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));

    if (canShareFile) {
      // 系统面板一弹出来就会盖住整个页面，所以这里的提示要等面板关掉之后再弹
      navigator.share({ files: [file], title: name }).then(() => {
        afterBackup();
        toast('已存到手机「文件」里 ✓', 3000);
      }).catch(err => {
        if (err && err.name === 'AbortError') {
          toast('已取消。要备份就再点一次「一键备份」，在面板里选「存储到"文件"」', 4200);
          return;
        }
        downloadFile(text, name);                       // 分享失败时退回下载
        afterBackup();
        toast('备份已下载：' + name, 3600);
      });
      return;
    }

    downloadFile(text, name);
    afterBackup();
    toast('备份已存到「文件」里：' + name, 4000);
  };

  /* 一键恢复：直接用本机自动备份里最新的一份，不弹任何窗口
     （浏览器不让网页翻手机的「文件」，所以本机备份才是真正"一键"的那份） */
  $('btnImport').onclick = () => {
    const snaps = listSnaps();
    if (!snaps.length) {                       // 本机还没留下过备份，只能去「文件」里挑
      toast('本机还没有自动备份，去「文件」里选一份吧', 3200);
      $('btnPickFile').click();
      return;
    }
    const latest = snaps[0];
    // 本机已经有进度时才确认一句，避免手滑覆盖（新机恢复直接过）
    if ((learnedCount() + checkinDays()) > 0
      && !confirm('用本机自动备份（' + fmtTime(latest.t) + '）恢复？现在的进度会被覆盖')) return;
    pushSnap();                                // 恢复前先把当前进度也留一份
    applyImported(parseBackupText(latest.d), null);
    pushSnap();
    S.lastRestoreAt = Date.now();
    save();
    renderBackupInfo();
    toast('已用本机自动备份恢复（' + fmtTime(latest.t) + '）', 3400);
  };

  /* 想挑更早的备份时，才去打开手机的「文件」 */
  $('btnPickFile').onclick = () => {
    const inp = $('fileInput');
    inp.value = '';       // 允许重复选同一个文件
    inp.click();
  };

  $('fileInput').addEventListener('change', async e => {
    const inp = e.target;
    const f = inp.files && inp.files[0];
    if (!f) return;
    // 本机已经有进度时才多问一句，避免手滑覆盖（新机恢复直接过）
    if ((learnedCount() + checkinDays()) > 0
      && !confirm('用「' + f.name + '」覆盖本机现在的学习进度？')) { inp.value = ''; return; }
    const ok = await importText(await readFileText(f), null);
    if (ok) {
      S.lastRestoreAt = Date.now();
      save();
      renderBackupInfo();
    }
    inp.value = '';
  });
  $('btnRestore').onclick = () => {
    const n = restoreAllGone();
    if (!n) { toast('没有已删除的词'); return; }
    save(); toast('已恢复 ' + n + ' 个词', 1600);
    renderStudy(); renderHome(); renderBook(); renderAll(); renderStats();
  };
  $('btnReset').onclick = () => {
    if (!confirm('确定清空全部学习进度？此操作不可撤销。')) return;
    pushSnap();                       // 清空前先留一份，万一是手滑还能用「一键恢复」找回来
    S = defaultState(); save(); session = null; renderAll2();
    toast('已清空，重新开始（可用「一键恢复」找回）', 3200);
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
  renderBackupInfo();
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
    navigator.serviceWorker.register('sw.js?v=28', { updateViaCache: 'none' })
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

  bind();
  initPullToRefresh();
  autoDailySnap();      // 每天自动留一份本机备份，供「一键恢复」直接用
  renderAll2();
  initOffline();
  setTimeout(watchServer, 1600);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') watchServer(); });
}

if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
init();
