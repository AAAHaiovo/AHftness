/* ============================================================
   健身 App —— 单页应用
   数据全部存在手机本地（IndexedDB），不上传任何服务器
   ============================================================ */
(function () {
"use strict";

/* ============================================================
   0. 小工具
   ============================================================ */
var $ = function (s, r) { return (r || document).querySelector(s); };
function p2(n) { return (n < 10 ? "0" : "") + n; }
function ds(d) { d = d || new Date(); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
function parseD(s) { var a = s.split("-"); return new Date(+a[0], +a[1] - 1, +a[2]); }
function addD(s, n) { var d = parseD(s); d.setDate(d.getDate() + n); return ds(d); }
function daysBetween(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function fmt(v, d) { d = d == null ? 1 : d; var n = +v; return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toString(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
/* 允许动作要点里使用 <b> 高亮，其余标签一律转义 */
function rich(s) { return esc(s).replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>"); }

var WD = ["日", "一", "二", "三", "四", "五", "六"];
var MON = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

/* ============================================================
   1. 存储
   首选 IndexedDB（能存照片，容量大）。
   万一浏览器禁用 / 卡住 / 报错，自动降级到 localStorage，
   保证 App 至少能用（此时照片功能会不可用）。
   ============================================================ */
var Store = (function () {
  var dbp = null, broken = false, LS = "fitkv:";

  function lsGet(k) { try { var v = localStorage.getItem(LS + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } }
  function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(LS + k); } catch (e) {} }
  function lsKeys() {
    var o = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(LS) === 0) o.push(k.slice(LS.length)); } } catch (e) {}
    return o;
  }

  function open() {
    if (broken) return Promise.reject(new Error("idb off"));
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error("no idb")); return; }
      var done = false;
      /* 有些环境 open() 的回调永远不触发（比如 file:// 协议），加超时兜底 */
      var timer = setTimeout(function () { if (!done) { done = true; rej(new Error("idb timeout")); } }, 2000);
      var r;
      try { r = indexedDB.open("fitness-app", 1); } catch (e) { clearTimeout(timer); rej(e); return; }
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
      r.onsuccess = function () { if (done) return; done = true; clearTimeout(timer); res(r.result); };
      r.onerror = function () { if (done) return; done = true; clearTimeout(timer); rej(r.error || new Error("idb error")); };
      r.onblocked = function () { if (done) return; done = true; clearTimeout(timer); rej(new Error("idb blocked")); };
    }).catch(function (e) { broken = true; throw e; });
    return dbp;
  }

  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction("kv", mode), st = t.objectStore("kv"), req = fn(st);
        t.oncomplete = function () { res(req ? req.result : undefined); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }

  return {
    ok: function () { return !broken; },
    get: function (k) {
      return run("readonly", function (s) { return s.get(k); }).catch(function () { return lsGet(k); });
    },
    set: function (k, v) {
      return run("readwrite", function (s) { return s.put(v, k); }).catch(function (e) {
        if (broken) {
          /* 降级模式：照片（Blob）存不进 localStorage */
          if (typeof Blob !== "undefined" && v instanceof Blob) return;
          if (!lsSet(k, v)) throw e;
          return;
        }
        throw e;
      });
    },
    del: function (k) {
      return run("readwrite", function (s) { return s.delete(k); }).catch(function () { lsDel(k); });
    },
    keys: function () {
      return run("readonly", function (s) { return s.getAllKeys(); }).catch(function () { return lsKeys(); });
    }
  };
})();

/* ============================================================
   2. 默认计划
   ============================================================ */
function EX(id, n, mg, s, r, c, b, rest) { return { id: id, n: n, mg: mg, s: s, r: r, c: c, b: b || "", rest: rest || 90 }; }

var DEFAULT_PLAN = {
  /* 计划换代号。手机上已经存了旧计划时，靠它决定要不要用新版覆盖。
     只改结构不改这个号，老用户永远看不到新计划。 */
  ver: 2,
  warmup: [
    "泡沫轴滚胸椎|10 次",
    "门框胸大肌 / 胸小肌拉伸|每侧 30 秒 × 2",
    "上斜方拉伸|左 2 组 / 右 3 组 × 30 秒",
    "肩胛提肌拉伸|左 2 组 / 右 3 组 × 30 秒",
    "靠墙天使|2 × 10",
    "单臂弹力带下拉|2 × 15　只做左侧",
    "弹力带面拉|2 × 15",
    "下巴回收|2 × 10（停 3 秒）",
    "俯卧 Y-T-W|每个字母 × 10"
  ],
  days: [
    {
      id: "d1", tab: "DAY 1", title: "胸 + 三头", short: "胸",
      hint: "弱点优先：上胸（动作 1、2 排最前，就因为它）",
      ex: [
        EX("e1", "上斜哑铃卧推", "胸", 4, "6–8", "对握 · 凳 30–40° · 肘 45° · <b>沉肩压凳</b>", "瓦氏呼吸", 150),
        EX("e2", "上斜绳索夹胸", "胸", 4, "12–15", "肘角固定 · <b>顶峰夹 1 秒</b>", "常规呼吸", 75),
        EX("e3", "平板杠铃卧推", "胸", 3, "6–8", "前臂垂直 · 触胸乳线 · 拇指绕杠", "瓦氏呼吸", 180),
        EX("e4", "双杠臂屈伸", "胸", 3, "8–10", "负 10kg · 略前倾 · <b>上臂平行即停</b>", "常规呼吸", 120),
        EX("e5", "绳索下压 / 碎颅者", "三头", 3, "10–12", "二选一 · <b>上臂固定不动</b>", "常规呼吸", 75)
      ]
    },
    {
      id: "d2", tab: "DAY 2", title: "背 + 二头", short: "背",
      hint: "先沉肩再屈肘（用肘尖往后扎）· 划船先送肩 · 下巴微收",
      ex: [
        EX("e6", "引体向上", "背", 4, "6–10", "对握 · 1.5 倍肩宽 · <b>先沉肩再拉</b> · 5 秒下放", "吸一口就拉，顶点吐气", 150),
        EX("e7", "宽握高位下拉", "背", 4, "10–12", "后仰只 10–15° · 拉至<b>锁骨</b> · 肘往下收", "常规呼吸", 120),
        EX("e8", "杠铃划船", "背", 4, "6–8", "前倾 45° · <b>拉向肚脐</b> · 肘贴身", "瓦氏呼吸", 150),
        EX("e9", "坐姿绳索划船", "背", 3, "10–12", "V 把窄握 · <b>先送肩再拉</b> · 肘过躯干 · 停 1 秒", "常规呼吸", 90),
        EX("e10", "直臂下压", "背", 3, "12–15", "肘角不变 · 轻重量<b>找背阔肌感觉</b>", "常规呼吸", 60),
        EX("e11", "坐姿绳索二头弯举", "二头", 3, "8–12", "反握 / 对握<b>轮换</b> · 上臂贴死不摆", "常规呼吸", 60)
      ]
    },
    {
      id: "d3", tab: "DAY 3A", title: "肩 + 腹部", short: "肩",
      hint: "和「DAY 3B · 腿 + 臀」轮流练：这套练完，下次自动轮到腿。",
      ex: [
        EX("e12", "哑铃侧平举", "肩", 4, "12–15", "倒水式 · <b>不过肩高</b> · 沉肩 · 用肘尖够天花板", "常规呼吸", 60),
        EX("e13", "面拉", "肩", 4, "15–20", "绳索<b>额头高</b> · 拉到底<b>外旋</b> · 停 1 秒", "常规呼吸", 60),
        EX("e14", "反向蝴蝶机", "肩", 3, "12–15", "胸贴垫 · <b>别耸肩</b> · 停 1 秒", "常规呼吸", 60),
        EX("e15", "实力推", "肩", 3, "6–8", "前臂垂直 · <b>核心收紧不许后仰</b>", "瓦氏呼吸", 150),
        EX("e22", "绳索卷腹", "核心", 3, "12–15", "含胸弓背 · <b>用腹肌把肘拉向膝盖</b> · 不是手臂在拉", "呼气发力，回来吸气", 60),
        EX("e20", "悬挂举腿", "核心", 3, "10", "<b>骨盆后倾</b>，不是单纯抬腿", "常规呼吸", 60),
        EX("e21", "农夫行走", "核心", 3, "40m", "沉肩 · 不摇晃 · 别憋气", "自然呼吸", 90)
      ]
    },
    {
      id: "d4", tab: "DAY 3B", title: "腿 + 臀", short: "腿",
      hint: "和「DAY 3A · 肩 + 腹部」轮流练。深蹲别放第一个，前面先热身腿。",
      ex: [
        EX("e16", "杠铃臀推", "臀", 3, "12", "顶点<b>夹臀 2 秒</b> · 别顶过头", "常规呼吸", 90),
        EX("e17", "保加利亚分腿蹲", "腿", 3, "10/侧", "<b>左腿先做</b> · 躯干略前倾（偏臀）", "常规呼吸", 90),
        EX("e18", "罗马尼亚硬拉", "腿", 3, "10", "<b>双正握 + 助力带</b> · 膝角不变 · 髋往后推", "瓦氏呼吸", 150),
        EX("e19", "全幅度深蹲", "腿", 3, "8", "<b>高杠</b> · 大腿低于水平", "瓦氏呼吸", 180)
      ]
    }
  ]
};

var MUSCLES = ["胸", "背", "肩", "三头", "二头", "腿", "臀", "核心"];

var DEFAULT_SETTINGS = {
  proteinTarget: 140,   // g
  tdee: 3000,           // 每日总消耗 kcal（基础代谢 + 日常活动 + 训练）
  deficitTrain: 200,    // 训练日热量缺口
  deficitRest: 500,     // 休息日热量缺口
  weightTarget: 78,     // kg
  defaultRest: 90       // 秒
};
/* 摄入目标不再固定填，改成按当天消耗倒推：消耗 − 缺口 */

/* ============================================================
   2b. 常吃清单（预置，第一次运行写进本机，之后你自己增删改）
   一份 = 一个常见份量（一碗 / 一盘 / 一个），不按克 —— 你不用称重。
   热量和蛋白都是估算值，觉得不对在 App 里点开就能改。
   ============================================================ */
var FOOD_CATS = [
  ["staple", "主食"], ["meat", "肉蛋豆"], ["veg", "蔬菜"], ["soup", "汤"],
  ["milk", "奶豆"], ["fruit", "水果"], ["snack", "点心加餐"]
];
function F(id, n, u, k, p, cat) { return { id: id, n: n, u: u, k: k, p: p, cat: cat, last: 0 }; }
var DEFAULT_FOODS = [
  /* 主食 */
  F("rice", "米饭", "碗", 230, 4, "staple"),
  F("congee", "粥", "碗", 90, 2, "staple"),
  F("mantou", "馒头", "个", 220, 7, "staple"),
  F("baozi", "包子", "个", 200, 6, "staple"),
  F("noodle", "面条", "碗", 280, 9, "staple"),
  F("dumpling", "饺子", "10个", 400, 15, "staple"),
  F("bread", "全麦面包", "片", 75, 3, "staple"),
  F("sweetpotato", "红薯", "个", 150, 2, "staple"),
  F("corn", "玉米", "根", 110, 3, "staple"),
  F("youtiao", "油条", "根", 230, 4, "staple"),
  /* 肉蛋豆 */
  F("chicken", "鸡胸肉", "份", 165, 31, "meat"),
  F("chickenleg", "煎鸡腿", "个", 220, 22, "meat"),
  F("egg", "鸡蛋", "个", 70, 6, "meat"),
  F("tomatoegg", "番茄炒蛋", "盘", 180, 10, "meat"),
  F("hongshao", "红烧肉", "份", 380, 12, "meat"),
  F("huiguo", "回锅肉", "份", 350, 12, "meat"),
  F("qinjiao", "青椒炒肉", "份", 220, 13, "meat"),
  F("pork", "猪肉", "份", 250, 18, "meat"),
  F("beef", "牛肉", "份", 200, 26, "meat"),
  F("fish_st", "清蒸鱼", "份", 180, 25, "meat"),
  F("fish_br", "红烧鱼", "份", 230, 24, "meat"),
  F("shrimp", "虾", "份", 100, 20, "meat"),
  F("tofu", "豆腐", "份", 120, 10, "meat"),
  F("mapo", "麻婆豆腐", "份", 240, 12, "meat"),
  F("ribs", "排骨", "份", 320, 18, "meat"),
  F("sausage", "香肠", "根", 130, 6, "meat"),
  /* 蔬菜 */
  F("greens", "炒青菜", "盘", 90, 3, "veg"),
  F("veggie", "清炒时蔬", "盘", 80, 3, "veg"),
  F("bean", "干煸豆角", "盘", 150, 4, "veg"),
  F("disanxian", "地三鲜", "盘", 220, 4, "veg"),
  F("cucumber", "凉拌黄瓜", "盘", 40, 1, "veg"),
  F("tomato_cold", "凉拌番茄", "盘", 50, 1, "veg"),
  /* 汤 */
  F("soup_seaweed", "紫菜蛋花汤", "碗", 60, 4, "soup"),
  F("soup_tomato", "番茄蛋汤", "碗", 70, 4, "soup"),
  F("soup_rib", "排骨汤", "碗", 120, 6, "soup"),
  F("soup_winter", "冬瓜汤", "碗", 50, 2, "soup"),
  /* 奶豆 */
  F("milk", "牛奶", "盒", 160, 8, "milk"),
  F("soymilk", "豆浆", "杯", 120, 7, "milk"),
  F("yogurt", "酸奶", "杯", 120, 5, "milk"),
  /* 水果 */
  F("apple", "苹果", "个", 90, 0, "fruit"),
  F("banana", "香蕉", "根", 105, 1, "fruit"),
  F("orange", "橙子", "个", 60, 1, "fruit"),
  /* 点心加餐 */
  F("nuts", "坚果", "把", 180, 5, "snack"),
  F("jianbing", "煎饼果子", "个", 400, 12, "snack"),
  F("milktea", "奶茶", "杯", 350, 3, "snack"),
  F("cake", "蛋糕", "块", 300, 4, "snack"),
  F("chips", "薯片", "包", 300, 3, "snack")
];

/* AI 认的是「像不像你自己拍过的那张」，不是菜名 —— 公开模型里没有番茄炒蛋这种类。
   0.90 是「最低要求有多像」，0.03 是「必须比第二像的那顿再高出一截」。
   两个数都是实测 + 保守取值：宁可不提示，也别乱提示。用一段时间后再调。 */
var AI_MATCH = 0.90, AI_MARGIN = 0.03;

/* ============================================================
   3. 状态
   ============================================================ */
var D = {                       // 数据（持久化）
  plan: null,
  logs: {},                     // "2026-10-15" -> {dayId, start, end, ex:{eid:[{w,r,rir,d}]}, note}
  weight: {},                   // "2026-10-15" -> 70.2
  nutri: {},                    // "2026-10-15" -> {p: 130, k: 2600}
  settings: null,
  photoMeta: [],                // [{id, date, pose}]
  foods: [],                    // 常吃清单 [{id,n,u,k,p,cat,last}]
  meals: []                     // 每顿流水 [{id,date,meal,foods:[…],k,p,emb}]
};

var U = {                       // 界面状态（不持久化）
  tab: "train",
  bodySeg: "weight",
  calSeg: "month",
  calMonth: null,               // Date，当月第一天
  selDate: ds(),
  focus: null,                  // {eid, si}
  delArm: null,                 // 待确认删除的动作 id（第一次点 ✕ 只是上膛）
  urls: [],                     // 照片 objectURL 缓存
  mealDraft: null               // 「记一顿」的草稿，来回切层不丢已选的东西
};

var READY = false;

/* ---------- 读写 ---------- */
function loadAll() {
  return Promise.all([
    Store.get("plan"), Store.get("logs"), Store.get("weight"),
    Store.get("nutri"), Store.get("settings"), Store.get("photoMeta"),
    Store.get("foods"), Store.get("meals")
  ]).then(function (r) {
    /* 老计划没有 ver（当 1 看），比新版旧就整体换成新版。
       训练记录按动作 id 存，跟计划结构无关，所以换计划不会丢历史。 */
    var storedPlan = r[0];
    if (!storedPlan || (storedPlan.ver || 1) < DEFAULT_PLAN.ver) {
      D.plan = JSON.parse(JSON.stringify(DEFAULT_PLAN));
      if (storedPlan) save("plan");
    } else {
      D.plan = storedPlan;
    }
    D.logs = r[1] || {};
    D.weight = r[2] || {};
    D.nutri = r[3] || {};
    D.settings = Object.assign({}, DEFAULT_SETTINGS, r[4] || {});
    D.photoMeta = r[5] || [];
    /* r[6] 为 null 才是「从没存过」→ 播种预置清单。
       你自己把它删光了会是 []，那种情况不再播种，免得删一个回来一个。 */
    D.foods = r[6] == null ? JSON.parse(JSON.stringify(DEFAULT_FOODS)) : r[6];
    if (r[6] == null) save("foods");
    D.meals = r[7] || [];
    U.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    READY = true;
  });
}
var saveWarned = false;
function save(k) {
  return Store.set(k, D[k]).catch(function (e) {
    if (e && e.name === "QuotaExceededError") {
      if (!saveWarned) { saveWarned = true; toast("手机存储满了，删几张照片或导出备份"); }
    }
  });
}

/* ---------- 查询 ---------- */
function allEx() {
  var out = [];
  D.plan.days.forEach(function (d) { d.ex.forEach(function (e) { out.push(e); }); });
  return out;
}
function findEx(id) {
  var a = allEx();
  for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
  return null;
}
function findDay(id) {
  for (var i = 0; i < D.plan.days.length; i++) if (D.plan.days[i].id === id) return D.plan.days[i];
  return null;
}
/* 最近一次训练日期（含今天之前） */
function lastLogDate(before) {
  var ks = Object.keys(D.logs).filter(function (d) { return D.logs[d] && D.logs[d].dayId; }).sort();
  for (var i = ks.length - 1; i >= 0; i--) if (!before || ks[i] < before) return ks[i];
  return null;
}
/* 今天该练哪天：今天有记录就按记录；否则按上次顺序往后推 */
function todayDayId() {
  var t = ds();
  if (D.logs[t] && D.logs[t].dayId) return D.logs[t].dayId;
  var prev = lastLogDate(t);
  if (!prev) return D.plan.days[0].id;
  var pd = D.logs[prev].dayId, idx = 0;
  D.plan.days.forEach(function (d, i) { if (d.id === pd) idx = i; });
  return D.plan.days[(idx + 1) % D.plan.days.length].id;
}
/* 该动作上一次的记录 */
function lastRecord(eid, beforeDate) {
  var ks = Object.keys(D.logs).sort();
  for (var i = ks.length - 1; i >= 0; i--) {
    var d = ks[i];
    if (beforeDate && d >= beforeDate) continue;
    var lg = D.logs[d];
    if (!lg || !lg.ex || !lg.ex[eid]) continue;
    var sets = lg.ex[eid].filter(function (s) { return s.w || s.r; });
    if (sets.length) return { date: d, sets: sets };
  }
  return null;
}
/* 历史最好 e1RM（Epley） */
function bestE1RM(eid, excludeDate) {
  var best = 0;
  Object.keys(D.logs).forEach(function (d) {
    if (d === excludeDate) return;
    var lg = D.logs[d];
    if (!lg || !lg.ex || !lg.ex[eid]) return;
    lg.ex[eid].forEach(function (s) {
      var w = num(s.w), r = parseInt(s.r, 10);
      if (w > 0 && r > 0) best = Math.max(best, w * (1 + r / 30));
    });
  });
  return best;
}
function logSets(lg, eid) { return (lg.ex && lg.ex[eid]) || []; }
function sessionVolume(lg) {
  var v = 0;
  Object.keys(lg.ex || {}).forEach(function (eid) {
    lg.ex[eid].forEach(function (s) { if (s.d) v += num(s.w) * parseInt(s.r, 10) || 0; });
  });
  return v;
}
function sessionSets(lg) {
  var n = 0;
  Object.keys(lg.ex || {}).forEach(function (eid) {
    lg.ex[eid].forEach(function (s) { if (s.d) n++; });
  });
  return n;
}
/* 7 日均线 */
function weightMA() {
  var ks = Object.keys(D.weight).sort();
  var out = [];
  for (var i = 0; i < ks.length; i++) {
    var from = addD(ks[i], -6), sum = 0, c = 0;
    for (var j = 0; j < ks.length; j++) {
      if (ks[j] >= from && ks[j] <= ks[i]) { sum += D.weight[ks[j]]; c++; }
    }
    out.push({ x: ks[i], y: sum / c });
  }
  return out;
}

/* ---------- 部位配色 / 当天热量 ---------- */
/* 部位名 → CSS 类名后缀。中文直接当类名能用，但映射一次更保险。 */
var MG_KEY = { "胸": "chest", "背": "back", "肩": "shoulder", "三头": "tri", "二头": "bi", "腿": "leg", "臀": "glute", "核心": "core" };
function mgKey(mg) { return MG_KEY[mg] || "other"; }
/* 某个部位在这天练几组 */
function dayMuscles(day) {
  var out = [], map = {};
  day.ex.forEach(function (e) {
    if (!map[e.mg]) { map[e.mg] = { mg: e.mg, n: 0, sets: 0 }; out.push(map[e.mg]); }
    map[e.mg].n++; map[e.mg].sets += e.s;
  });
  return out;
}
function mgChipsHTML(list) {
  return list.map(function (m) {
    return '<span class="mg-chip ' + mgKey(m.mg) + '">' + esc(m.mg) + "<s>" + m.n + "</s></span>";
  }).join("");
}

/* 今天算训练日还是休息日：有训练记录就算训练日；用户手动切过就听用户的 */
function dayMode(date) {
  var n = D.nutri[date];
  if (n && (n.mode === "train" || n.mode === "rest")) return n.mode;
  return D.logs[date] ? "train" : "rest";
}
/* 当天摄入目标 = 每日总消耗 − 当天缺口 */
function kcalTargetFor(date) {
  var s = D.settings;
  var t = num(s.tdee) - (dayMode(date) === "train" ? num(s.deficitTrain) : num(s.deficitRest));
  return Math.round(Math.max(800, t));   /* 缺口填得比消耗还大时兜一下，别出现负数 */
}

/* 动作要点按「·」拆成小药丸，居中整齐分布，不再是一长条左对齐的灰字 */
function cueChips(s) {
  var parts = String(s == null ? "" : s).split("·").map(function (p) { return p.trim(); }).filter(Boolean);
  if (!parts.length) return "";
  return '<div class="cue-chips">' + parts.map(function (p) {
    return '<span class="cue-chip">' + rich(p) + "</span>";
  }).join('<span class="cue-dot">·</span>') + "</div>";
}

/* ---------- 训练记录 ---------- */
function ensureLog(date, dayId) {
  if (!D.logs[date]) {
    D.logs[date] = { dayId: dayId || todayDayId(), start: Date.now(), end: null, ex: {}, note: "" };
  }
  return D.logs[date];
}
function ensureSets(date, ex) {
  var lg = D.logs[date];
  if (!lg.ex[ex.id]) lg.ex[ex.id] = [];
  var arr = lg.ex[ex.id];
  while (arr.length < ex.s) arr.push({ w: "", r: "", rir: "", d: false });
  while (arr.length > ex.s) arr.pop();
  return arr;
}

/* ============================================================
   4. 图表（纯 SVG）
   ============================================================ */
function svgLine(series, opt) {
  opt = opt || {};
  var W = 340, H = opt.h || 168, PL = 34, PR = 10, PT = 14, PB = 24;
  var all = [];
  series.forEach(function (s) { s.vals.forEach(function (v) { all.push(v); }); });
  if (all.length < 1) return "";
  var xs = all.map(function (v) { return v.x; }), ys = all.map(function (v) { return v.y; });
  var x0 = xs.reduce(function (a, b) { return a < b ? a : b; });
  var x1 = xs.reduce(function (a, b) { return a > b ? a : b; });
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  var pad = (y1 - y0) * 0.15; y0 -= pad; y1 += pad;
  var iw = W - PL - PR, ih = H - PT - PB;
  function X(x) { return PL + (x - x0) / ((x1 - x0) || 1) * iw; }
  function Y(y) { return H - PB - (y - y0) / (y1 - y0) * ih; }

  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">';
  for (var i = 0; i <= 3; i++) {
    var yy = PT + i * ih / 3, val = y1 - i * (y1 - y0) / 3;
    s += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#E9EBF0" stroke-width="1"/>';
    s += '<text x="' + (PL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" font-size="9.5" fill="#AEB2BE" text-anchor="end">' + fmt(val, val > 100 ? 0 : 1) + '</text>';
  }
  series.forEach(function (ser) {
    if (!ser.vals.length) return;
    var pts = ser.vals.map(function (v) { return X(v.x).toFixed(1) + "," + Y(v.y).toFixed(1); });
    if (ser.fill && ser.vals.length > 1) {
      var f = "M" + PL + "," + (H - PB) + "L" + pts.join("L") + "L" + X(ser.vals[ser.vals.length - 1].x).toFixed(1) + "," + (H - PB) + "Z";
      s += '<path d="' + f + '" fill="' + (ser.color || "#007AFF") + '" opacity="0.09"/>';
    }
    if (ser.vals.length === 1) {
      s += '<circle cx="' + X(ser.vals[0].x).toFixed(1) + '" cy="' + Y(ser.vals[0].y).toFixed(1) + '" r="3.5" fill="' + (ser.color || "#007AFF") + '"/>';
    } else {
      s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + (ser.color || "#007AFF") + '" stroke-width="' + (ser.w || 2) + '" stroke-linejoin="round" stroke-linecap="round"' + (ser.dash ? ' stroke-dasharray="4 3"' : '') + '/>';
      var last = ser.vals[ser.vals.length - 1];
      if (ser.dot !== false) s += '<circle cx="' + X(last.x).toFixed(1) + '" cy="' + Y(last.y).toFixed(1) + '" r="3.2" fill="' + (ser.color || "#007AFF") + '"/>';
    }
  });
  /* X 轴标签：首 / 中 / 尾 */
  var ticks = [0, Math.floor((x1 - x0) / 2), x1];
  var seen = {};
  ticks.forEach(function (t, i) {
    if (seen[t]) return; seen[t] = 1;
    var d = parseD(tStr(t));
    var lb = (d.getMonth() + 1) + "/" + d.getDate();
    var anc = i === 0 ? "start" : (i === 2 ? "end" : "middle");
    var xx = clamp(X(t), PL, W - PR);
    s += '<text x="' + xx.toFixed(1) + '" y="' + (H - 7) + '" font-size="9.5" fill="#AEB2BE" text-anchor="' + anc + '">' + lb + '</text>';
  });
  function tStr(n) {
    /* x 轴存的是「第几天」的序号，这里换算回日期 */
    return ds(new Date(opt.baseTime + n * 86400000));
  }
  return s + "</svg>";
}

/* 环形进度 */
function svgRing(pct, color, size) {
  size = size || 104;
  var r = size / 2 - 8, c = 2 * Math.PI * r;
  pct = clamp(num(pct), 0, 1);   /* NaN 过 clamp 还是 NaN，会让 dasharray 变成非法值，圆环被画满 */
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="#EDEFF3" stroke-width="9"/>' +
    '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round"' +
    ' stroke-dasharray="' + (c * pct).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>';
}

/* ============================================================
   5. 休息倒计时
   ============================================================ */
var Rest = (function () {
  var endAt = 0, total = 0, tick = null, wakeLock = null;
  function el() { return $("#restBar"); }
  /* 计时条是 fixed 的，会盖住页面最后几十像素。body 上挂个类把底部留白撑开，
     否则最后一组的输入框永远被压在半透明黑条下面。 */
  function show(on) {
    el().hidden = !on;
    document.body.classList.toggle("resting", on);
  }
  function start(sec, label) {
    total = sec; endAt = Date.now() + sec * 1000;
    $("#restLabel").textContent = label || "组间休息";
    show(true); paint();
    if (tick) clearInterval(tick);
    tick = setInterval(paint, 200);
    keepAwake(true);
  }
  function paint() {
    var left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    $("#restTime").textContent = m + ":" + p2(s);
    var pct = total ? clamp(1 - left / total, 0, 1) : 0;
    $("#restFill").style.width = (pct * 100) + "%";
    if (left <= 0) { finish(); }
  }
  function finish() {
    if (tick) { clearInterval(tick); tick = null; }
    beep(); vibrate([120, 60, 120]);
    toast("休息结束，下一组！");
    stop();
  }
  function stop() {
    if (tick) { clearInterval(tick); tick = null; }
    show(false);
    keepAwake(false);
  }
  function add(sec) { endAt += sec * 1000; total += sec; paint(); }
  function keepAwake(on) {
    try {
      if (on && "wakeLock" in navigator && !wakeLock) {
        navigator.wakeLock.request("screen").then(function (w) { wakeLock = w; w.addEventListener("release", function () { wakeLock = null; }); }).catch(function () {});
      } else if (!on && wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    } catch (e) {}
  }
  return { start: start, stop: stop, add: add, keepAwake: keepAwake };
})();

var audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    var t = audioCtx.currentTime;
    [0, 0.18, 0.36].forEach(function (off, i) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = i === 2 ? 1180 : 880;
      g.gain.setValueAtTime(0, t + off);
      g.gain.linearRampToValueAtTime(0.32, t + off + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + off + 0.15);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + off); o.stop(t + off + 0.17);
    });
  } catch (e) {}
}
function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

/* 休息倒计时响铃时，距离你上次点屏幕可能已经过去两分钟了。
   iOS 不允许在「没有用户操作」的时候启动音频，所以必须趁你第一次点屏幕
   就把音频通道打开，否则倒计时结束那一下是哑的。 */
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    /* iOS 要真播过一个声音才算解锁，放一段静音 */
    var b = audioCtx.createBuffer(1, 1, 22050);
    var s = audioCtx.createBufferSource();
    s.buffer = b; s.connect(audioCtx.destination); s.start(0);
  } catch (e) {}
}
["pointerdown", "touchstart", "click", "keydown"].forEach(function (ev) {
  document.addEventListener(ev, unlockAudio, { once: true, passive: true });
});

/* ============================================================
   6. 轻提示
   ============================================================ */
var toastT = null;
function toast(msg, cls) {
  var t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (cls ? " " + cls : "");
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(function () { t.hidden = true; }, 2200);
}

/* ============================================================
   7. 弹层
   ============================================================ */
var sheetOnDone = null;
/* 弹层内部原地重绘用的。加/删/排序动作后要刷新列表，但不想把弹层关掉重开。 */
var sheetRefresh = null;
function refreshSheet() {
  if (!sheetRefresh) return;
  var sb = $("#sheetBody"), y = sb.scrollTop;   /* 记住滚到哪了…… */
  sb.innerHTML = sheetRefresh();
  sb.scrollTop = y;                             /* ……重绘完还回去，别弹回顶部 */
}

function openSheet(title, bodyHTML, onDone, doneLabel) {
  $("#sheetTitle").textContent = title || "";
  var sb = $("#sheetBody");
  sb.onclick = null;          /* 清掉上一个弹层挂的处理函数，避免串台 */
  sb.oninput = null;          /* 同理。营养弹层用 oninput 做实时预览，不清会跟到下一个弹层 */
  sheetRefresh = null;        /* 同理，别让上一个弹层的重绘函数跟过来 */
  sb.scrollTop = 0;
  sb.innerHTML = bodyHTML;
  $("#sheetDone").textContent = doneLabel || "完成";
  $("#sheetDone").style.visibility = onDone ? "visible" : "hidden";
  sheetOnDone = onDone;
  var w = $("#sheetWrap");
  w.hidden = false;
  requestAnimationFrame(function () { w.classList.add("on"); });
  $("#sheetBody").scrollTop = 0;
}
function closeSheet() {
  var w = $("#sheetWrap");
  w.classList.remove("on");
  setTimeout(function () { w.hidden = true; $("#sheetBody").innerHTML = ""; }, 300);
  sheetOnDone = null;
  render();
}
function lightbox(src) {
  $("#lbImg").src = src;
  $("#lightbox").hidden = false;
}

/* ============================================================
   8. 导航
   ============================================================ */
var TABS = [
  { id: "train", t: "训练", ic: '<path d="M4 9.5v5M7 6.5v11M17 6.5v11M20 9.5v5M7 12h10"/>' },
  { id: "cal", t: "日历", ic: '<rect x="3" y="5" width="18" height="16" rx="3.5"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
  { id: "diet", t: "饮食", ic: '<path d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 10v11M17.5 3c-1.4 1.5-2 3.4-2 5.5s.7 3 2 3.5v9"/>' },
  { id: "body", t: "身体", ic: '<circle cx="12" cy="6" r="3.2"/><path d="M5.5 21v-3.5a6.5 6.5 0 0 1 13 0V21"/>' },
  { id: "plan", t: "计划", ic: '<rect x="4.8" y="4.6" width="14.4" height="16.2" rx="3.4"/><path d="M9.2 4.6V3.4h5.6v1.2"/><path d="M8.8 11.2h6.4M8.8 15.2h4.2"/>' }
];

function buildTabs() {
  $("#tabs").innerHTML = TABS.map(function (t) {
    return '<button data-tab="' + t.id + '" class="' + (U.tab === t.id ? "on" : "") + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + t.ic + '</svg>' +
      "<span>" + t.t + "</span></button>";
  }).join("");
}

/* ============================================================
   9. 屏幕渲染
   ============================================================ */
function render() {
  if (!READY) return;
  U.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
  U.urls = [];
  buildTabs();
  var v = $("#view");
  if (U.tab === "train") v.innerHTML = viewTrain();
  else if (U.tab === "cal") v.innerHTML = viewCal();
  else if (U.tab === "diet") v.innerHTML = viewDiet();
  else if (U.tab === "body") v.innerHTML = viewBody();
  else v.innerHTML = viewPlan();
  setHeader();
  if (U.tab === "train") restoreFocus();
}

function setHeader() {
  var t = "", s = "";
  if (U.tab === "train") {
    var did = todayDayId(), d = findDay(did);
    t = "训练"; s = d ? d.title : "";
  } else if (U.tab === "cal") { t = "日历"; s = ds(); }
  else if (U.tab === "diet") { t = "饮食"; s = ds(); }
  else if (U.tab === "body") { t = "身体"; s = "体重 " + latestWeightTxt(); }
  else { t = "计划"; s = "三分化"; }
  $("#hdrTitle").textContent = t;
  $("#hdrSub").textContent = s;
}
function latestWeightTxt() {
  var ks = Object.keys(D.weight).sort();
  return ks.length ? fmt(D.weight[ks[ks.length - 1]], 1) + " kg" : "未记录";
}

/* ---------------- 训练 ---------------- */
function viewTrain() {
  var today = ds();
  var did = todayDayId(), day = findDay(did);
  if (!day) return '<div class="empty"><div class="t">计划是空的</div><div class="d">去「计划」页加几个动作</div></div>';

  var h = "";
  var isToday = !!D.logs[today];
  var hh = new Date().getHours();
  var greet = hh < 11 ? "早上好" : hh < 14 ? "中午好" : hh < 18 ? "下午好" : "晚上好";

  /* 顶部当日卡 */
  h += '<div class="pad" style="padding-bottom:12px">';
  h += '<div class="card"><div class="card-pad" style="padding:16px var(--gap)">';
  /* 「换一天」用绝对定位浮在右上角，不占流。
     否则它会把居中的标题往左推，居中的其实不是整张卡的中线。 */
  h += '<div style="position:relative">';
  h += '<div style="text-align:center">';
  h += '<div style="font-size:13px;color:var(--tx2);margin-bottom:3px">' + greet + " · " + (parseD(today).getMonth() + 1) + "月" + parseD(today).getDate() + "日</div>";
  h += '<div style="font-size:24px;font-weight:700;letter-spacing:-.6px">' + esc(day.title) + "</div>";
  h += '<div class="mg-chips" style="margin-top:7px;justify-content:center">' + mgChipsHTML(dayMuscles(day)) + "</div>";
  h += '<div style="font-size:13px;color:var(--tx2);margin-top:6px">' + day.ex.length + " 个动作 · " + day.ex.reduce(function (a, e) { return a + e.s; }, 0) + " 组" + (isToday ? " · 进行中" : "") + "</div>";
  h += "</div>";
  h += '<button class="qb" data-act="pickDay" style="height:34px;position:absolute;right:0;top:50%;transform:translateY(-50%)">换一天</button>';
  h += "</div></div></div></div>";

  /* 热身（未开始时折叠） */
  if (!isToday) {
    h += '<div class="sec"><div class="sec-t">热身 <span class="r" data-act="togWarm" id="warmTog">展开</span></div>';
    h += '<div class="card" id="warmCard" hidden>' + D.plan.warmup.map(function (w, i) {
      var p = w.split("|");
      return '<div class="row"><div class="rl"><div class="rt">' + esc(p[0]) + '</div><div class="rs">' + esc(p[1] || "") + "</div></div></div>";
    }).join("") + "</div></div>";
  } else {
    h += '<div class="sec"><div class="sec-t">热身 <span class="r">已跳过</span></div></div>';
  }

  /* 动作 */
  h += '<div class="sec"><div class="sec-t">' + esc(day.tab) + " · " + esc(day.title) + "</div>";
  if (day.hint) h += '<div class="note" style="padding-bottom:8px">' + rich(day.hint) + "</div>";

  if (!isToday) {
    h += '<div class="pad" style="padding-bottom:10px"><button class="btn" data-act="start">开始今天的训练</button></div>';
  }

  day.ex.forEach(function (ex, i) {
    h += exCard(ex, i + 1, isToday);
  });
  h += "</div>";

  /* 结束按钮 */
  if (isToday) {
    var lg = D.logs[today];
    var vol = sessionVolume(lg), ns = sessionSets(lg);
    h += '<div class="pad"><div class="stats" style="margin-bottom:12px">' +
      '<div class="stat"><div class="v">' + fmt(vol, 0) + '<small>kg</small></div><div class="l">总容量</div></div>' +
      '<div class="stat"><div class="v">' + ns + '</div><div class="l">已完成组</div></div>' +
      "</div>";
    if (lg.end) h += '<button class="btn gray" data-act="reopen">已结束 · 点此继续记录</button>';
    else h += '<button class="btn" data-act="end">结束今天的训练</button>';
    h += "</div>";
  }
  return h;
}

function exCard(ex, n, active) {
  var today = ds();
  var lg = D.logs[today];
  var sets = lg ? ensureSets(today, ex) : [];
  var doneN = sets.filter(function (s) { return s.d; }).length;
  var allDone = sets.length && doneN === sets.length;
  var last = lastRecord(ex.id, today);
  var best = bestE1RM(ex.id, today);

  var h = '<div class="ex' + (allDone ? " done" : "") + '" data-ex="' + ex.id + '">';
  h += '<div class="ex-hd" data-act="exInfo" data-ex="' + ex.id + '">';
  h += '<span class="ex-i" data-n="' + n + '">' + (allDone ? "✓" : n) + "</span>";
  h += '<span class="ex-nm">' + esc(ex.n) + '<span class="badge ' + mgKey(ex.mg) + '" style="margin-left:6px;vertical-align:3px">' + esc(ex.mg) + "</span></span>";
  h += '<span class="ex-set">' + ex.s + "×" + esc(ex.r) + "</span>";
  h += "</div>";
  if (ex.c) h += cueChips(ex.c);

  if (last) {
    /* 只列 3 组、不带 kg —— 列头已经写了「重量 kg」。也不写日期：
       这行左边是「上次」，右边是「全部照上次」，中间只剩 200px 出头。
       日期要再占 40px，三位数重量（100×10）就一定会被省略号切掉。
       想看哪次练的，点动作名进详情，那里有带日期的完整历史。
       所以字号压到 12px，分隔符用「 · 」——全角空格一个就 13px，三个吃掉 39px。 */
    var t = last.sets.filter(function (s) { return s.w || s.r; }).slice(0, 3).map(function (s) {
      return (s.w || "—") + "×" + (s.r || "—");
    }).join(" · ");
    h += '<div class="ex-last"><span class="el-main">上次 <b>' + esc(t) + "</b></span>";
    /* 「全部照上次」从快捷行挪上来：快捷行要留给用户点名的 4 个，5 个挤一行会断行 */
    if (active) h += '<button class="qb gray mini" data-act="copyAll" data-ex="' + ex.id + '">全部照上次</button>';
    h += "</div>";
  }
  /* 没有历史记录时这里原本有一行灰字提示（「第一次做，轻一点找准动作」），
     已按要求删掉。没记录就干脆不显示这一行，卡片更干净。 */

  if (active) {
    h += '<div class="quick">';
    h += '<button class="qb" data-act="bump" data-ex="' + ex.id + '" data-v="2.5">+2.5kg</button>';
    h += '<button class="qb" data-act="bump" data-ex="' + ex.id + '" data-v="-2.5">−2.5kg</button>';
    h += '<button class="qb gray" data-act="copyPrev" data-ex="' + ex.id + '">复制上一组</button>';
    h += '<button class="qb gray" data-act="rest" data-ex="' + ex.id + '">休息 ' + ex.rest + "s</button>";
    h += "</div>";
  }

  h += '<table class="sets"><thead><tr><th>组</th><th>重量 kg</th><th>次数</th><th>RIR</th></tr></thead><tbody>';
  for (var i = 0; i < ex.s; i++) {
    var s = sets[i] || { w: "", r: "", rir: "", d: false };
    h += "<tr>";
    h += '<td><button class="sn' + (s.d ? " on" : "") + '" data-act="tog" data-ex="' + ex.id + '" data-si="' + i + '">' + (s.d ? "✓" : i + 1) + "</button></td>";
    if (active) {
      h += '<td><input class="cell' + (s.d ? " on" : "") + '" inputmode="decimal" placeholder="—" value="' + esc(s.w) + '" data-in="w" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
      h += '<td><input class="cell' + (s.d ? " on" : "") + '" inputmode="numeric" placeholder="—" value="' + esc(s.r) + '" data-in="r" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
      h += '<td><input class="cell rir' + (s.d ? " on" : "") + '" inputmode="numeric" placeholder="—" value="' + esc(s.rir) + '" data-in="rir" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
    } else {
      h += '<td style="color:var(--tx3)">—</td><td style="color:var(--tx3)">—</td><td style="color:var(--tx3)">—</td>';
    }
    h += "</tr>";
  }
  h += '</tbody></table><div style="height:14px"></div></div>';
  return h;
}

/* 输入框保持焦点 */
var focusSel = null;
function restoreFocus() {
  if (!focusSel) return;
  var e = document.querySelector(focusSel);
  if (e && e.tagName === "INPUT") { e.focus(); try { e.setSelectionRange(e.value.length, e.value.length); } catch (x) {} }
  focusSel = null;
}

/* ---------------- 日历 ---------------- */
function viewCal() {
  var h = "";
  h += '<div class="seg">' +
    '<button data-act="calSeg" data-v="month" class="' + (U.calSeg === "month" ? "on" : "") + '">月历</button>' +
    '<button data-act="calSeg" data-v="freq" class="' + (U.calSeg === "freq" ? "on" : "") + '">部位频率</button></div>';
  if (U.calSeg === "month") h += calMonthHTML();
  else h += heatHTML();

  var s = calStatsHTML();
  h += s;
  return h;
}

function calMonthHTML() {
  var d = U.calMonth, y = d.getFullYear(), m = d.getMonth();
  var first = new Date(y, m, 1), startWd = first.getDay();
  var daysIn = new Date(y, m + 1, 0).getDate();
  var prevDays = new Date(y, m, 0).getDate();
  var today = ds();
  var now = new Date();
  var canNext = !(y === now.getFullYear() && m === now.getMonth());

  var h = '<div class="cal-hd"><div class="cal-m">' + y + "年" + (m + 1) + "月</div>";
  h += '<div class="cal-nav"><button data-act="calPrev">‹</button>';
  h += '<button data-act="calNext"' + (canNext ? "" : " disabled") + ">›</button></div></div>";
  h += '<div class="cal"><div class="cal-wk">' + WD.map(function (w) { return "<div>" + w + "</div>"; }).join("") + "</div>";
  h += '<div class="cal-grid">';
  for (var i = startWd - 1; i >= 0; i--) h += '<div class="cal-d pad">' + (prevDays - i) + "</div>";
  for (var dd = 1; dd <= daysIn; dd++) {
    var dateStr = y + "-" + p2(m + 1) + "-" + p2(dd);
    var lg = D.logs[dateStr];
    var cls = "cal-d";
    if (dateStr === today) cls += " today";
    if (dateStr === U.selDate) cls += " sel";
    if (lg && lg.dayId) cls += " workout";
    var dtag = "";
    if (lg && lg.dayId) { var dy = findDay(lg.dayId); dtag = '<span class="dtag">' + esc(dy ? dy.short : "练") + "</span>"; }
    h += '<div class="' + cls + '" data-act="pickDate" data-d="' + dateStr + '">' + dd + dtag + "</div>";
  }
  var tail = (7 - ((startWd + daysIn) % 7)) % 7;
  for (var t = 1; t <= tail; t++) h += '<div class="cal-d pad">' + t + "</div>";
  h += "</div></div>";

  /* 选中日详情 */
  h += dayDetailHTML(U.selDate);
  return h;
}

function dayDetailHTML(date) {
  var lg = D.logs[date];
  var d = parseD(date);
  var head = (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WD[d.getDay()];
  if (!lg || !lg.dayId) {
    return '<div class="sec" style="margin-top:20px"><div class="sec-t">' + head + "</div>" +
      '<div class="card"><div class="card-pad" style="text-align:center;padding:26px 16px;color:var(--tx2);font-size:15px">这天没有训练记录</div></div></div>';
  }
  var dy = findDay(lg.dayId);
  var vol = sessionVolume(lg), ns = sessionSets(lg);
  var h = '<div class="sec" style="margin-top:20px"><div class="sec-t">' + head + "</div>";
  h += '<div class="card"><div class="card-pad">';
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
  h += '<div style="font-size:19px;font-weight:700;flex:1">' + esc(dy ? dy.title : lg.dayId) + "</div>";
  h += '<span class="badge g">' + ns + " 组 · " + fmt(vol, 0) + "kg</span></div>";
  (dy ? dy.ex : []).forEach(function (ex) {
    var sets = logSets(lg, ex.id).filter(function (s) { return s.w || s.r; });
    if (!sets.length) return;
    h += '<div style="padding:7px 0;border-top:.5px solid var(--line)">';
    h += '<div style="font-size:15px;font-weight:600">' + esc(ex.n) + "</div>";
    h += '<div style="font-size:13px;color:var(--tx2);margin-top:2px">' + sets.map(function (s) {
      return (s.w ? s.w + "kg" : "—") + "×" + (s.r || "—") + (s.rir !== "" && s.rir != null ? " @" + s.rir : "");
    }).join("　") + "</div>";
    h += "</div>";
  });
  if (lg.note) h += '<div style="padding:10px 0 2px;border-top:.5px solid var(--line);font-size:14px;color:var(--tx2)">' + esc(lg.note) + "</div>";
  h += "</div></div>";
  h += '<div class="pad" style="margin-top:10px"><button class="btn gray sm" data-act="delLog" data-d="' + date + '">删除这天的记录</button></div>';
  h += "</div>";
  return h;
}

function heatHTML() {
  /* 每个肌群最近 12 次训练的组数 */
  var dates = Object.keys(D.logs).filter(function (d) { return D.logs[d] && D.logs[d].dayId; }).sort().slice(-12);
  if (!dates.length) return '<div class="empty"><div class="ic">📊</div><div class="t">还没有训练数据</div><div class="d">练几次之后这里会显示各部位的训练频率</div></div>';

  var h = '<div class="card" style="padding:14px 12px 6px"><div class="chart-t" style="padding:0 0 12px">各部位训练频率</div>';
  h += '<div style="font-size:11px;color:var(--tx2);padding:0 0 10px">每根柱 = 一次训练，越蓝组数越多</div>';

  var maxSets = 1;
  var grid = {};
  MUSCLES.forEach(function (mg) {
    grid[mg] = dates.map(function (d) { return countSets(d, mg); });
    grid[mg].forEach(function (v) { if (v > maxSets) maxSets = v; });
  });

  MUSCLES.forEach(function (mg) {
    var vals = grid[mg];
    var lastIdx = -1;
    for (var i = vals.length - 1; i >= 0; i--) if (vals[i] > 0) { lastIdx = i; break; }
    var ago = lastIdx >= 0 ? daysBetween(dates[lastIdx], ds()) : null;
    var total = vals.reduce(function (a, b) { return a + b; }, 0);
    h += '<div class="heat-row"><div class="heat-lb">' + mg + "</div><div class=\"heat-bars\">";
    vals.forEach(function (v) {
      var cls = v === 0 ? "" : (v / maxSets < 0.34 ? "h1" : v / maxSets < 0.67 ? "h2" : "h3");
      h += '<div class="heat-b ' + cls + '" title="' + v + ' 组"></div>';
    });
    h += '</div><div class="heat-n">' + (ago === null ? "<b>没练</b>" : ago === 0 ? "<b>今天</b>" : ago + " 天前") +
      '<div style="font-size:10px;color:var(--tx3)">共 ' + total + " 组</div></div></div>";
  });
  h += "</div>";
  return h;
}
function countSets(date, mg) {
  var lg = D.logs[date];
  if (!lg) return 0;
  var n = 0;
  Object.keys(lg.ex || {}).forEach(function (eid) {
    var ex = findEx(eid);
    if (ex && ex.mg === mg) n += lg.ex[eid].filter(function (s) { return s.d; }).length;
  });
  return n;
}

function calStatsHTML() {
  var today = ds();
  /* 本周 */
  var d = new Date(), wd = (d.getDay() + 6) % 7;   // 周一为 0
  var monday = addD(today, -wd);
  var weekN = 0;
  for (var i = 0; i < 7; i++) { var x = addD(monday, i); if (D.logs[x] && D.logs[x].dayId) weekN++; }
  /* 本月 */
  var ms = today.slice(0, 7), monN = 0;
  Object.keys(D.logs).forEach(function (k) { if (k.slice(0, 7) === ms && D.logs[k].dayId) monN++; });
  /* 总计 */
  var totN = Object.keys(D.logs).filter(function (k) { return D.logs[k].dayId; }).length;

  return '<div class="sec" style="margin-top:20px"><div class="sec-t">统计</div><div class="stats">' +
    '<div class="stat"><div class="v">' + weekN + '<small>次</small></div><div class="l">本周</div></div>' +
    '<div class="stat"><div class="v">' + monN + '<small>次</small></div><div class="l">本月</div></div>' +
    '<div class="stat"><div class="v">' + totN + '<small>次</small></div><div class="l">累计</div></div>' +
    "</div></div>";
}

/* ---------------- 饮食 ---------------- */
function viewDiet() {
  var today = ds();
  var n = D.nutri[today] || { p: 0, k: 0 };
  var st = D.settings;
  var tp = num(st.proteinTarget) || DEFAULT_SETTINGS.proteinTarget;
  var mode = dayMode(today);
  var tk = kcalTargetFor(today);
  /* 一律过 num()：以前切训练日/休息日会存下只有 mode、没有 p/k 的对象，
     直接取 n.p 是 undefined，算出来是 NaN（数字显示 NaN，圆环的
     stroke-dashoffset 拿到 NaN 被判非法，退回默认值就画成一个满圈）。 */
  var np = num(n.p), nk = num(n.k);
  var h = "";

  /* 训练日 / 休息日：App 先自己猜，猜错了点一下就能改 */
  h += '<div class="seg">' +
    '<button data-act="nutMode" data-v="train" class="' + (mode === "train" ? "on" : "") + '">训练日 −' + num(st.deficitTrain) + "</button>" +
    '<button data-act="nutMode" data-v="rest" class="' + (mode === "rest" ? "on" : "") + '">休息日 −' + num(st.deficitRest) + "</button></div>";

  h += '<div class="pad" style="padding-bottom:14px"><div class="card"><div class="card-pad">';
  h += '<div class="ring-wrap">';
  h += '<div class="ring" data-act="editP">' + svgRing(np / tp, "#007AFF") + '<div class="rv"><b>' + Math.round(np) + "</b><s>/ " + tp + " g 蛋白</s></div></div>";
  h += '<div class="ring" data-act="editK">' + svgRing(nk / tk, "#FF9500") + '<div class="rv"><b>' + Math.round(nk) + "</b><s>/ " + tk + " kcal</s></div></div>";
  h += "</div>";
  h += '<div class="diet-eq">消耗 <b>' + num(st.tdee) + "</b> − 缺口 <b>" +
    num(mode === "train" ? st.deficitTrain : st.deficitRest) + "</b>（" +
    (mode === "train" ? "训练日" : "休息日") + "）= 今天吃 <b>" + tk + " kcal</b></div>";
  var left = tp - np;
  h += '<div style="text-align:center;font-size:14px;color:var(--tx2);padding:6px 0 2px">' +
    (left > 0 ? "还差 <b style='color:var(--blue)'>" + Math.round(left) + " g</b> 蛋白" : "<b style='color:var(--green)'>蛋白达标了</b>，保持") + "</div>";
  h += "</div></div></div>";

  /* 记一顿：主路径。拍照（可选）→ AI 认「像不像你上次拍的」→ 点几样常吃的 */
  h += '<div class="sec" style="margin-top:14px"><div class="sec-t">这顿吃了什么</div>';
  h += '<div class="pad" style="padding-bottom:8px"><button class="btn" data-act="mealSheet">拍照记一顿</button></div>';
  h += '<div class="card">' + mealRowsHTML(today) + "</div></div>";

  /* 快捷加 */
  h += '<div class="sec"><div class="sec-t">快速记录</div>';
  h += '<div class="pad"><div class="qb-grid g4">';
  [20, 30, 40, 50].forEach(function (v) { h += '<button class="qb" data-act="addP" data-v="' + v + '">+' + v + "g 蛋白</button>"; });
  h += "</div>";
  h += '<div class="qb-grid g3" style="margin-top:8px">';
  [300, 500, 800].forEach(function (v) { h += '<button class="qb" data-act="addK" data-v="' + v + '" style="color:#B26A00">+' + v + " kcal</button>"; });
  h += "</div>";
  h += '<button class="btn sec sm" data-act="editP" style="margin-top:12px">手动输入今天的数值</button>';
  h += "</div></div>";

  /* 最近 7 天 */
  var rows = "";
  for (var i = 0; i < 7; i++) {
    var d = addD(today, -i);
    var v = D.nutri[d];
    var m = dayMode(d), tgt = kcalTargetFor(d);
    var lb = i === 0 ? "今天" : i === 1 ? "昨天" : (parseD(d).getMonth() + 1) + "/" + parseD(d).getDate();
    /* 判断「记没记过」看数值，不看对象在不在：只切过一次模式的日子
       也会留下一个对象，按以前那样判断就会显示成「NaNg · NaN」。 */
    var vp = v ? num(v.p) : 0, vk = v ? num(v.k) : 0, has = vp || vk;
    rows += '<div class="row" data-act="editP" data-d="' + d + '">' +
      '<div class="rl"><div class="rt">' + lb + "</div></div>" +
      '<span class="mode-chip ' + m + '">' + (m === "train" ? "练" : "休") + "</span>" +
      '<div class="rv meal-num">' + (has ? Math.round(vp) + "g · " + Math.round(vk) : "—") +
        '<s class="rv-t">/' + tgt + "</s></div>" +
      '<span class="chev">›</span></div>';
  }
  h += '<div class="sec"><div class="sec-t">最近 7 天</div><div class="card">' + rows + "</div></div>";

  h += '<div class="foot">蛋白目标 ' + tp + "g 是按你 70kg 体重的 1.6–2.2 g/kg 区间取的中间值。<br>热量目标 = 每日总消耗 − 当天缺口，都在「设置」里改。</div>";
  return h;
}

/* ---------------- 身体 ---------------- */
function viewBody() {
  var h = '<div class="seg">' +
    '<button data-act="bodySeg" data-v="weight" class="' + (U.bodySeg === "weight" ? "on" : "") + '">体重</button>' +
    '<button data-act="bodySeg" data-v="photo" class="' + (U.bodySeg === "photo" ? "on" : "") + '">照片</button></div>';
  return h + (U.bodySeg === "weight" ? weightHTML() : photoHTML());
}

function weightHTML() {
  var ks = Object.keys(D.weight).sort();
  var h = "";
  var cur = ks.length ? D.weight[ks[ks.length - 1]] : null;
  var ma = weightMA();
  var maCur = ma.length ? ma[ma.length - 1].y : null;

  h += '<div class="stats" style="margin-bottom:14px">';
  h += '<div class="stat"><div class="v">' + (cur == null ? "—" : fmt(cur, 1)) + '<small>kg</small></div><div class="l">最新</div></div>';
  h += '<div class="stat"><div class="v">' + (maCur == null ? "—" : fmt(maCur, 1)) + '<small>kg</small></div><div class="l">7日均线</div></div>';
  var goal = D.settings.weightTarget;
  h += '<div class="stat"><div class="v">' + (cur == null ? "—" : fmt(goal - cur, 1)) + '<small>kg</small></div><div class="l">距目标 ' + goal + "</div></div>";
  h += "</div>";

  h += '<div class="pad" style="padding-bottom:14px"><button class="btn" data-act="addWeight">记录今天的体重</button></div>';

  if (ks.length >= 2) {
    /* 只画最近 180 天 */
    var from = addD(ds(), -180);
    var pts = ks.filter(function (k) { return k >= from; });
    var base = parseD(pts[0]).getTime();
    var sRaw = pts.map(function (k) { return { x: daysBetween(pts[0], k), y: D.weight[k] }; });
    var maMap = {}; ma.forEach(function (p) { maMap[p.x] = p.y; });
    var sMA2 = pts.filter(function (k) { return maMap[k] != null; })
                  .map(function (k) { return { x: daysBetween(pts[0], k), y: maMap[k] }; });

    h += '<div class="chart"><div class="chart-t">体重趋势 <span class="v">' + (cur == null ? "" : fmt(cur, 1) + " kg") + "</span></div>";
    h += svgLine([
      { name: "daily", vals: sRaw, color: "#C9CCD4", w: 1.4, dot: false, fill: true },
      { name: "ma", vals: sMA2, color: "#007AFF", w: 2.4 }
    ], { h: 178, baseTime: base });
    h += '<div class="lg"><span><i style="background:#007AFF"></i>7日均线</span><span><i style="background:#C9CCD4"></i>每日</span></div>';
    h += "</div>";
    h += '<div class="note">看均线，别看单日。体重一天上下浮动 1kg 很正常。</div>';
  } else {
    h += '<div class="empty"><div class="ic">⚖️</div><div class="t">记两次以上才能画曲线</div><div class="d">每天起床后、上厕所后、饭前称，条件一致才准</div></div>';
  }

  /* 记录列表 */
  if (ks.length) {
    var rows = ks.slice(-14).reverse().map(function (k, i) {
      var prev = ks[ks.indexOf(k) - 1];
      var dif = prev != null ? D.weight[k] - D.weight[prev] : null;
      var dtxt = dif == null ? "" : (dif > 0 ? "+" : "") + fmt(dif, 1);
      var col = dif == null ? "var(--tx2)" : dif > 0 ? "var(--green)" : dif < 0 ? "var(--red)" : "var(--tx2)";
      return '<div class="row"><div class="rl"><div class="rt">' + k.slice(5).replace("-", "月") + "日</div></div>" +
        '<div class="rv" style="color:' + col + '">' + dtxt + "</div>" +
        '<div style="font-weight:600;min-width:66px;text-align:right">' + fmt(D.weight[k], 1) + " kg</div></div>";
    }).join("");
    h += '<div class="sec" style="margin-top:20px"><div class="sec-t">记录</div><div class="card">' + rows + "</div></div>";
  }
  return h;
}

function photoHTML() {
  var h = "";
  h += '<div class="pad" style="padding-bottom:16px"><button class="btn" data-act="addPhoto">添加照片</button></div>';
  if (!D.photoMeta.length) {
    h += '<div class="empty"><div class="ic">📷</div><div class="t">还没有照片</div><div class="d">建议每月固定一天，同样光线、同样距离<br>拍正面 / 侧面 / 背面三张</div></div>';
    return h;
  }
  /* 按月分组 */
  var bym = {};
  D.photoMeta.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (p) {
    var m = p.date.slice(0, 7);
    (bym[m] = bym[m] || []).push(p);
  });
  Object.keys(bym).sort().reverse().forEach(function (m) {
    var arr = bym[m];
    h += '<div class="ph-month"><b>' + m.slice(0, 4) + "年" + (+m.slice(5, 7)) + "月</b><s>" + arr.length + " 张</s></div>";
    h += '<div class="ph-grid">';
    arr.sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (p) {
      h += '<div class="ph" data-act="viewPhoto" data-id="' + p.id + '"><div style="color:var(--tx3);font-size:11px">加载中</div>' +
        '<button class="del" data-act="delPhoto" data-id="' + p.id + '">✕</button>' +
        '<span class="lb">' + esc(p.pose) + "</span></div>";
    });
    h += "</div>";
  });
  h += '<div class="foot">照片只存在这台手机里，不会上传到任何地方。</div>';
  /* 异步填图 */
  setTimeout(fillPhotos, 0);
  return h;
}
function fillPhotos() {
  var nodes = document.querySelectorAll(".ph[data-id]");
  Array.prototype.forEach.call(nodes, function (n) {
    var id = n.getAttribute("data-id");
    Store.get("photo:" + id).then(function (blob) {
      if (!blob) { n.querySelector("div").textContent = "已丢失"; return; }
      var url = URL.createObjectURL(blob);
      U.urls.push(url);
      var img = document.createElement("img");
      img.src = url;
      img.alt = "";
      var first = n.firstChild;
      n.replaceChild(img, first);
    });
  });
}

/* ---------------- 计划 ---------------- */
function viewPlan() {
  var h = "";
  h += '<div class="note" style="padding-bottom:14px">点某一天可以加动作、改组数次数、调顺序、删除。<br>点动作名字看要点和历史记录。</div>';
  D.plan.days.forEach(function (d) {
    var totalSets = d.ex.reduce(function (a, e) { return a + e.s; }, 0);
    h += '<div class="sec"><div class="sec-t">' + esc(d.tab) + "</div>";
    h += '<div class="card">';
    /* 天标题：部位标签一眼可见，点进去就能编辑 */
    h += '<div class="row day-hd" data-act="openDay" data-day="' + d.id + '">';
    h += '<div class="rl"><div class="rt">' + esc(d.title) + "</div>";
    h += '<div class="mg-chips" style="margin-top:6px">' + mgChipsHTML(dayMuscles(d)) + "</div></div>";
    h += '<span class="rh">' + d.ex.length + " 个动作 · " + totalSets + " 组</span>";
    h += '<span class="chev">›</span></div>';
    /* 动作按部位分段，部位名单独一行 —— 之前和动作名挤在一条灰字里，看不出来 */
    var prevMg = null;
    d.ex.forEach(function (ex) {
      if (ex.mg !== prevMg) {
        h += '<div class="mg-sep ' + mgKey(ex.mg) + '">' + esc(ex.mg) + "</div>";
        prevMg = ex.mg;
      }
      h += '<div class="row" data-act="exInfo" data-ex="' + ex.id + '">' +
        '<div class="rl"><div class="rt" style="font-size:16px">' + esc(ex.n) + "</div>" +
        '<div class="rs">' + ex.s + "×" + esc(ex.r) + " · 休息 " + ex.rest + "s</div></div>" +
        '<span class="chev">›</span></div>';
    });
    h += "</div></div>";
  });
  h += '<div class="sec"><div class="sec-t">热身</div><div class="card">' + D.plan.warmup.map(function (w) {
    var p = w.split("|");
    return '<div class="row"><div class="rl"><div class="rt" style="font-size:16px">' + esc(p[0]) + '</div><div class="rs">' + esc(p[1] || "") + "</div></div></div>";
  }).join("") + "</div>";
  h += '<div class="pad" style="margin-top:10px"><button class="btn sec sm" data-act="editWarm">编辑热身</button></div></div>';
  h += '<div class="foot">计划改动会自动保存。</div>';
  return h;
}

/* ============================================================
   10. 事件
   ============================================================ */
document.addEventListener("click", function (e) {
  var t = e.target.closest("[data-act]");
  var tabBtn = e.target.closest("#tabs button");
  if (tabBtn) {
    U.tab = tabBtn.getAttribute("data-tab");
    try { history.replaceState(null, "", "#" + U.tab); } catch (x) {}
    window.scrollTo({ top: 0, behavior: "instant" });
    render();
    return;
  }
  if (!t) return;
  var act = t.getAttribute("data-act");
  var ex = t.getAttribute("data-ex");
  var si = t.getAttribute("data-si");

  switch (act) {
    case "togWarm": $("#warmCard").hidden = !$("#warmCard").hidden; $("#warmTog").textContent = $("#warmCard").hidden ? "展开" : "收起"; break;
    case "start":
      ensureLog(ds(), todayDayId()); save("logs"); render();
      toast("开始训练，加油 💪"); break;
    case "end":
      var lg = D.logs[ds()];
      if (lg) { lg.end = Date.now(); save("logs"); render(); toast("训练完成 🎉"); }
      break;
    case "reopen":
      var lg2 = D.logs[ds()];
      if (lg2) { lg2.end = null; save("logs"); render(); }
      break;
    case "pickDay": pickDaySheet(); break;
    case "exInfo": exInfoSheet(ex); break;
    case "bump": bumpWeight(ex, parseFloat(t.getAttribute("data-v"))); break;
    case "copyAll": copyAll(ex); break;
    case "copyPrev": copyPrev(ex); break;
    case "rest": Rest.start(findEx(ex).rest, findEx(ex).n); break;
    case "tog": toggleSet(ex, +si); break;
    case "calSeg": U.calSeg = t.getAttribute("data-v"); render(); break;
    case "bodySeg": U.bodySeg = t.getAttribute("data-v"); render(); break;
    case "calPrev": U.calMonth = new Date(U.calMonth.getFullYear(), U.calMonth.getMonth() - 1, 1); render(); break;
    case "calNext": U.calMonth = new Date(U.calMonth.getFullYear(), U.calMonth.getMonth() + 1, 1); render(); break;
    case "pickDate": U.selDate = t.getAttribute("data-d"); render(); break;
    case "delLog": delLog(t.getAttribute("data-d")); break;
    case "addWeight": weightSheet(); break;
    case "addPhoto": addPhotoSheet(); break;
    case "viewPhoto": Store.get("photo:" + t.getAttribute("data-id")).then(function (b) { if (b) lightbox(URL.createObjectURL(b)); }); break;
    case "delPhoto": delPhoto(t.getAttribute("data-id")); break;
    case "editP": nutriSheet(t.getAttribute("data-d") || ds(), "p"); break;
    case "editK": nutriSheet(ds(), "k"); break;
    case "mealSheet": mealSheet(ds()); break;
    case "mealView": mealViewSheet(t.getAttribute("data-id")); break;
    case "addP": addNutri("p", +t.getAttribute("data-v")); break;
    case "addK": addNutri("k", +t.getAttribute("data-v")); break;
    case "nutMode":
      var dn = ds(), mm = t.getAttribute("data-v");
      /* 必须带 p/k 一起建：今天还没记过东西时，光写 mode 会留下一个
         没有 p 和 k 的对象，饮食页读 n.p 得到 undefined，一路算成 NaN。 */
      var no = D.nutri[dn] || { p: 0, k: 0 };
      no.mode = mm; D.nutri[dn] = no;
      save("nutri"); render();
      toast(mm === "train" ? "今天按训练日算" : "今天按休息日算");
      break;
    case "openDay": dayEditorSheet(t.getAttribute("data-day")); break;
    case "editWarm": warmEditorSheet(); break;
  }
});

/* 输入 */
document.addEventListener("input", function (e) {
  var el = e.target;
  if (!el.hasAttribute || !el.hasAttribute("data-in")) return;
  var eid = el.getAttribute("data-ex"), si = +el.getAttribute("data-si"), f = el.getAttribute("data-in");
  var lg = D.logs[ds()];
  if (!lg) return;
  var ex = findEx(eid); if (!ex) return;
  var arr = ensureSets(ds(), ex);
  var s = arr[si]; if (!s) return;
  var wasDone = s.d;
  s[f] = el.value;
  if (f === "r") s.d = el.value.trim() !== "";
  save("logs");
  /* 只更新这一行，不重绘（否则会丢焦点） */
  var row = el.closest("tr");
  Array.prototype.forEach.call(row.querySelectorAll(".cell"), function (c) { c.classList.toggle("on", !!s.d); });
  var badge = row.querySelector(".sn");
  badge.classList.toggle("on", !!s.d);
  badge.textContent = s.d ? "✓" : (si + 1);
  /* 卡片完成态 */
  var card = el.closest(".ex");
  var allDone = arr.every(function (x) { return x.d; });
  card.classList.toggle("done", allDone);
  var ic = card.querySelector(".ex-i");
  ic.textContent = allDone ? "✓" : ic.getAttribute("data-n");
  /* 刚完成一组 → 查纪录 + 起休息计时 */
  if (!wasDone && s.d) {
    checkPR(eid, si);
    Rest.start(ex.rest, ex.n);
  }
});

document.addEventListener("focusin", function (e) {
  var el = e.target;
  if (el.hasAttribute && el.hasAttribute("data-in")) {
    U.focus = { eid: el.getAttribute("data-ex"), si: +el.getAttribute("data-si") };
    focusSel = '[data-in][data-ex="' + U.focus.eid + '"][data-si="' + U.focus.si + '"]';
  }
});

/* ============================================================
   11. 训练操作
   ============================================================ */
function toggleSet(eid, si) {
  var today = ds();
  var lg = D.logs[today];
  /* 没点「开始今天的训练」就直接记录？那就自动开始，不要白白咽掉这一下。 */
  if (!lg) { lg = ensureLog(today, todayDayId()); toast("已自动开始今天的训练"); }
  var ex = findEx(eid); var arr = ensureSets(today, ex);
  var s = arr[si];
  s.d = !s.d;
  if (s.d && !s.r && !s.w) {
    var last = lastRecord(eid, today);
    if (last && last.sets[si]) { s.w = last.sets[si].w; s.r = last.sets[si].r; }
  }
  save("logs"); render();
  if (s.d) { Rest.start(ex.rest, ex.n); checkPR(eid, si); }
}
function curSet(eid) {
  var today = ds();
  var lg = D.logs[today];
  if (!lg) lg = ensureLog(today, todayDayId());   /* 同上：快捷按钮不该无声失效 */
  var ex = findEx(eid); var arr = ensureSets(today, ex);
  var si = (U.focus && U.focus.eid === eid) ? U.focus.si : 0;
  return { arr: arr, si: si, ex: ex };
}
function bumpWeight(eid, delta) {
  var c = curSet(eid); if (!c.arr) return;
  var s = c.arr[c.si];
  var w = num(s.w) + delta;
  if (w < 0) w = 0;
  s.w = w ? fmt(w, 2).replace(/\.?0+$/, "") : "";
  save("logs");
  var inp = document.querySelector('[data-in="w"][data-ex="' + eid + '"][data-si="' + c.si + '"]');
  if (inp) inp.value = s.w;
  toast("第 " + (c.si + 1) + " 组 → " + (s.w || "空"));
}
function copyAll(eid) {
  var today = ds(); var lg = D.logs[today]; if (!lg) return;
  var ex = findEx(eid); var arr = ensureSets(today, ex);
  var last = lastRecord(eid, today);
  if (!last) { toast("没有历史记录"); return; }
  for (var i = 0; i < arr.length; i++) {
    var src = last.sets[i] || last.sets[last.sets.length - 1];
    if (src) { arr[i].w = src.w; arr[i].r = src.r; arr[i].rir = src.rir; arr[i].d = !!(src.w || src.r); }
  }
  save("logs"); render();
  toast("已填入上次的数据，按实际改");
}
function copyPrev(eid) {
  var c = curSet(eid); if (!c.arr) return;
  if (c.si === 0) { toast("这是第一组"); return; }
  var prev = c.arr[c.si - 1];
  c.arr[c.si].w = prev.w; c.arr[c.si].r = prev.r; c.arr[c.si].rir = prev.rir;
  c.arr[c.si].d = !!(prev.w || prev.r);
  save("logs"); render();
}

/* 检查是否破纪录（和「历史最好」以及「今天前面几组」比） */
function checkPR(eid, si) {
  var today = ds(); var lg = D.logs[today]; if (!lg) return;
  var sets = lg.ex[eid] || [];
  var s = sets[si]; if (!s) return;
  var w = num(s.w), r = parseInt(s.r, 10);
  if (!(w > 0 && r > 0)) return;
  var e1 = w * (1 + r / 30);
  var prev = bestE1RM(eid, today);
  sets.forEach(function (x, i) {
    if (i === si || !x.d) return;
    var xw = num(x.w), xr = parseInt(x.r, 10);
    if (xw > 0 && xr > 0) prev = Math.max(prev, xw * (1 + xr / 30));
  });
  if (e1 > prev && prev > 0) {
    toast("🎉 " + findEx(eid).n + " 新纪录！估算 1RM " + fmt(e1, 1) + "kg", "pr");
    vibrate([60, 40, 60]);
  }
}

/* ============================================================
   12. 弹层内容
   ============================================================ */
function pickDaySheet() {
  var today = ds(), cur = todayDayId();
  var h = "";
  D.plan.days.forEach(function (d) {
    h += '<div class="card" style="margin-bottom:0"><div class="row" data-act="setDay" data-day="' + d.id + '">' +
      '<div class="rl"><div class="rt">' + esc(d.tab) + "　" + esc(d.title) + '</div><div class="rs">' + d.ex.length + " 个动作</div></div>" +
      (d.id === cur ? '<span style="color:var(--blue);font-weight:700">✓</span>' : "") + "</div></div>";
  });
  openSheet("今天练哪天", h, null);
  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-act=setDay]"); if (!t) return;
    var lg = ensureLog(today, t.getAttribute("data-day"));
    lg.dayId = t.getAttribute("data-day");
    save("logs"); closeSheet();
  };
}

function exInfoSheet(eid) {
  var ex = findEx(eid); if (!ex) return;
  var last = lastRecord(eid, ds());
  var best = bestE1RM(eid, ds());
  var h = "";
  h += '<div class="card"><div class="card-pad">';
  h += '<div style="font-size:22px;font-weight:700;letter-spacing:-.5px">' + esc(ex.n) + "</div>";
  h += '<div style="font-size:14px;color:var(--tx2);margin-top:4px">' + esc(ex.mg) + " · " + ex.s + "×" + esc(ex.r) + " · 休息 " + ex.rest + " 秒</div>";
  if (ex.c) h += '<div style="font-size:15px;color:#3A3A40;margin-top:12px;line-height:1.5">' + rich(ex.c) + "</div>";
  if (ex.b) h += '<div style="font-size:13px;color:var(--tx2);margin-top:8px">呼吸：' + esc(ex.b) + "</div>";
  h += "</div></div>";

  /* 历史曲线 */
  var hist = [];
  Object.keys(D.logs).sort().forEach(function (d) {
    var lg = D.logs[d];
    if (!lg.ex || !lg.ex[eid]) return;
    var w = 0, r = 0, n = 0;
    lg.ex[eid].forEach(function (s) {
      var sw = num(s.w), sr = parseInt(s.r, 10);
      if (sw > 0 && sr > 0) { w += sw; r += sr; n++; }
    });
    if (!n) return;
    hist.push({ d: d, w: w / n, e1: Math.max.apply(null, lg.ex[eid].map(function (s) { return num(s.w) * (1 + (parseInt(s.r, 10) || 0) / 30); })) });
  });
  if (hist.length >= 2) {
    var base = parseD(hist[0].d).getTime();
    var baseIdx = parseD(hist[0].d);
    var s1 = hist.map(function (x) { return { x: daysBetween(hist[0].d, x.d), y: x.w }; });
    var s2 = hist.map(function (x) { return { x: daysBetween(hist[0].d, x.d), y: x.e1 }; });
    h += '<div class="sec" style="margin-top:18px"><div class="sec-t">力量趋势</div><div class="chart">';
    h += '<div class="chart-t">平均重量 <span class="v">' + fmt(hist[hist.length - 1].w, 1) + " kg</span></div>";
    h += svgLine([{ vals: s1, color: "#007AFF", w: 2.4, fill: true }], { h: 150, baseTime: base });
    h += '<div class="lg"><span>共 ' + hist.length + " 次记录</span></div>";
    h += "</div></div>";
  } else if (hist.length === 1) {
    h += '<div class="note" style="margin-top:14px">这个动作才记了 1 次，再练几次就能看到曲线。</div>';
  }

  if (best > 0) h += '<div class="sec" style="margin-top:16px"><div class="sec-t">个人纪录</div><div class="card"><div class="card-pad" style="display:flex;align-items:center"><div style="flex:1;font-size:15px">估算 1RM（Epley）</div><div style="font-size:22px;font-weight:700;color:var(--orange)">' + fmt(best, 1) + " kg</div></div></div></div>";

  var allSets = [];
  Object.keys(D.logs).sort().reverse().forEach(function (d) {
    var lg = D.logs[d];
    if (!lg.ex || !lg.ex[eid]) return;
    var ss = lg.ex[eid].filter(function (s) { return s.w || s.r; });
    if (ss.length) allSets.push({ d: d, ss: ss });
  });
  if (allSets.length) {
    h += '<div class="sec" style="margin-top:16px"><div class="sec-t">历史记录</div><div class="card">';
    allSets.slice(0, 10).forEach(function (x) {
      h += '<div class="row"><div class="rl"><div class="rt" style="font-size:15px">' + x.d.slice(5).replace("-", "/") + '</div></div>' +
        '<div class="rv" style="font-size:14px">' + x.ss.map(function (s) { return (s.w || "—") + "×" + (s.r || "—"); }).join("　") + "</div></div>";
    });
    h += "</div></div>";
  }
  openSheet("动作详情", h, null, "关闭");
}

/* ---------- 计划编辑：加 / 改 / 排序 / 删 ----------
   之前这些按钮只在 HTML 里生成了，事件里根本没有对应分支，
   点下去毫无反应 —— 所以「跟贴纸一样」。 */
function dayEditorSheet(dayId) {
  var day = findDay(dayId); if (!day) return;
  U.delArm = null;   /* 上次上膛没点的，别留到这次 */
  openSheet(day.title, dayEditorHTML(day), null, "关闭");
  sheetRefresh = function () { return dayEditorHTML(day); };
  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var a = t.getAttribute("data-act"), id = t.getAttribute("data-id");
    if (a === "addEx") { exEditorSheet(null, dayId); return; }
    if (a === "edEx") { exEditorSheet(id, dayId); return; }
    var i = -1;
    day.ex.forEach(function (x, k) { if (x.id === id) i = k; });
    if (i < 0) return;
    if (a === "mvEx") {
      var j = i + parseInt(t.getAttribute("data-v"), 10);
      if (j < 0 || j >= day.ex.length) return;
      var tmp = day.ex[i]; day.ex[i] = day.ex[j]; day.ex[j] = tmp;
      save("plan"); refreshSheet(); render();
    } else if (a === "rmEx") {
      /* 不用 confirm()：加到主屏幕后 iOS 可能把 confirm 吞掉，
         那删除就永远点不动了。改成「再点一次确认」。 */
      if (U.delArm !== id) {
        U.delArm = id; refreshSheet();
        setTimeout(function () { if (U.delArm === id) { U.delArm = null; refreshSheet(); } }, 3000);
        return;
      }
      U.delArm = null;
      day.ex = day.ex.filter(function (x) { return x.id !== id; });
      save("plan"); refreshSheet(); render();
      toast("已删除");
    }
  };
}
function dayEditorHTML(day) {
  var h = '<div class="sec"><div class="sec-t">动作（' + day.ex.length + "）</div><div class=\"card\">";
  if (!day.ex.length) h += '<div class="row"><div class="rl"><div class="rs">这一天还没有动作</div></div></div>';
  day.ex.forEach(function (ex, i) {
    var arm = U.delArm === ex.id;
    h += '<div class="row ed-row">';
    h += '<div class="rl" data-act="edEx" data-id="' + ex.id + '">' +
      '<div class="rt" style="font-size:16px">' + esc(ex.n) + "</div>" +
      '<div class="rs"><span class="mg-chip sm ' + mgKey(ex.mg) + '">' + esc(ex.mg) + "</span> " +
        ex.s + "×" + esc(ex.r) + " · 休息 " + ex.rest + "s</div></div>";
    h += '<button class="qb gray mini" data-act="mvEx" data-id="' + ex.id + '" data-v="-1"' + (i === 0 ? " disabled" : "") + ">↑</button>";
    h += '<button class="qb gray mini" data-act="mvEx" data-id="' + ex.id + '" data-v="1"' + (i === day.ex.length - 1 ? " disabled" : "") + ">↓</button>";
    h += '<button class="qb mini ' + (arm ? "danger" : "gray") + '" data-act="rmEx" data-id="' + ex.id + '">' + (arm ? "确认" : "✕") + "</button>";
    h += "</div>";
  });
  h += "</div></div>";
  h += '<div class="pad" style="margin-top:14px"><button class="btn sec sm" data-act="addEx">+ 添加动作</button></div>';
  h += '<div class="note">点动作名字可以改名称、部位、组数、次数、休息和要点。</div>';
  return h;
}

function exEditorSheet(eid, dayId) {
  var ex = eid ? findEx(eid) : null;
  var isNew = !ex;
  if (isNew) ex = EX("e" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36), "", "胸", 3, "8–12", "", "", 90);
  var h = "";
  h += '<div class="card">';
  h += '<div class="fld"><label>名称</label><input type="text" id="edName" value="' + esc(ex.n) + '" placeholder="比如：绳索卷腹"></div>';
  h += '<div class="fld"><label>部位</label><select id="edMg">' + MUSCLES.map(function (m) { return '<option' + (m === ex.mg ? " selected" : "") + ">" + m + "</option>"; }).join("") + "</select></div>";
  h += '<div class="fld"><label>组数</label><input class="num" type="number" id="edSets" value="' + ex.s + '" min="1" max="12"></div>';
  h += '<div class="fld"><label>目标次数</label><input type="text" id="edReps" value="' + esc(ex.r) + '" placeholder="6–8 / 12 / 10/侧"></div>';
  h += '<div class="fld"><label>组间休息（秒）</label><input class="num" type="number" id="edRest" value="' + ex.rest + '" step="15"></div>';
  h += "</div>";
  h += '<div class="sec" style="margin-top:16px"><div class="sec-t">动作要点</div><div class="card">' +
    '<div style="padding:12px var(--gap)"><textarea id="edCue" style="width:100%;border:none;background:transparent;font-size:16px;line-height:1.5;min-height:70px;resize:none;outline:none">' + esc(ex.c || "") + "</textarea></div></div>" +
    '<div class="note">用「 · 」隔开的每一段，在训练页会显示成一行整齐的小标签。<br>用 &lt;b&gt;加粗&lt;/b&gt; 标重点。</div></div>';
  openSheet(isNew ? "添加动作" : "编辑动作", h, function () {
    var nm = $("#edName").value.trim();
    if (!nm) { toast("动作名字不能空着"); return "keep"; }
    ex.n = nm;
    ex.mg = $("#edMg").value;
    ex.s = clamp(parseInt($("#edSets").value, 10) || 3, 1, 12);
    ex.r = $("#edReps").value.trim() || "8–12";
    ex.rest = clamp(parseInt($("#edRest").value, 10) || 90, 0, 600);
    ex.c = $("#edCue").value.trim();
    if (isNew) { var d = findDay(dayId); if (d) d.ex.push(ex); }
    save("plan");
    if (dayId) {   /* 从某一天的编辑里进来的，存完回到那一天 */
      toast(isNew ? "已添加「" + ex.n + "」" : "已保存");
      dayEditorSheet(dayId);
      return "keep";
    }
    toast("已保存");
  }, isNew ? "添加" : "保存");
  if (isNew) setTimeout(function () { var e = $("#edName"); if (e) e.focus(); }, 350);
}

function warmEditorSheet() {
  openSheet("编辑热身", warmEditorHTML(), null, "关闭");
  sheetRefresh = function () { return warmEditorHTML(); };
  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var a = t.getAttribute("data-act");
    if (a === "addWarm") { warmItemSheet(-1); return; }
    var i = parseInt(t.getAttribute("data-i"), 10);
    if (a === "edWarm") { warmItemSheet(i); return; }
    if (a === "rmWarm") { D.plan.warmup.splice(i, 1); save("plan"); refreshSheet(); toast("已删除"); }
  };
}
function warmEditorHTML() {
  var h = '<div class="card">';
  if (!D.plan.warmup.length) h += '<div class="row"><div class="rl"><div class="rs">还没有热身项</div></div></div>';
  D.plan.warmup.forEach(function (w, i) {
    var p = w.split("|");
    h += '<div class="row">' +
      '<div class="rl" data-act="edWarm" data-i="' + i + '"><div class="rt" style="font-size:16px">' + esc(p[0]) + "</div>" +
      (p[1] ? '<div class="rs">' + esc(p[1]) + "</div>" : "") + "</div>" +
      '<button class="qb gray mini" data-act="rmWarm" data-i="' + i + '">✕</button></div>';
  });
  h += "</div>";
  h += '<div class="pad" style="margin-top:14px"><button class="btn sec sm" data-act="addWarm">+ 添加热身项</button></div>';
  h += '<div class="note">点热身项可以改名字和说明。</div>';
  return h;
}
function warmItemSheet(i) {
  var isNew = i < 0;
  var p = (isNew ? "" : D.plan.warmup[i] || "").split("|");
  var h = '<div class="card">' +
    '<div class="fld"><label>名称</label><input type="text" id="wmN" value="' + esc(p[0] || "") + '" placeholder="比如：靠墙天使"></div>' +
    '<div class="fld"><label>说明</label><input type="text" id="wmS" value="' + esc(p[1] || "") + '" placeholder="比如：2 × 10"></div>' +
    "</div>";
  openSheet(isNew ? "添加热身项" : "编辑热身项", h, function () {
    var nm = $("#wmN").value.trim();
    if (!nm) { toast("名字不能空着"); return "keep"; }
    var line = nm + "|" + $("#wmS").value.trim();
    if (isNew) D.plan.warmup.push(line); else D.plan.warmup[i] = line;
    save("plan");
    toast("已保存");
    warmEditorSheet();
    return "keep";
  }, isNew ? "添加" : "保存");
  setTimeout(function () { var e = $("#wmN"); if (e) e.focus(); }, 350);
}

function weightSheet() {
  var t = ds();
  var cur = D.weight[t];
  var h = '<div class="card"><div class="fld"><label>体重（kg）</label><input class="num" type="text" inputmode="decimal" id="wIn" placeholder="70.0" value="' + (cur == null ? "" : cur) + '" autofocus></div></div>';
  h += '<div class="note">' + t.slice(5).replace("-", "月") + "日 · 建议固定在早上、空腹、上完厕所后称</div>";
  openSheet("记录体重", h, function () {
    var v = parseFloat($("#wIn").value);
    if (!isNaN(v) && v > 20 && v < 300) { D.weight[t] = v; save("weight"); toast("已记录 " + fmt(v, 1) + " kg"); }
  }, "保存");
  setTimeout(function () { var e = $("#wIn"); if (e) e.focus(); }, 350);
}

/* 营养数值：默认「加这一顿」——你只输这次吃的量，App 自己跟原来的相加。
   另给一个「改成总数」的口子，专门用来改绝对值（记错了、想清零）。
   历史日期（最近 7 天点进来）走同一套，只是「原来」取那一天的值。 */
function nutriSheet(date, focus) {
  var mode = "add";                    /* add = 累加本次；set = 直接改成总数 */
  var dl = date.slice(5).replace("-", "/");

  function cur() { return D.nutri[date] || { p: 0, k: 0 }; }
  function previewLine(p0, k0, dP, dK) {
    return dl + "：原来 <b>" + Math.round(p0) + " g</b> ＋ 这次 <b>" + Math.round(dP) +
      " g</b> ＝ <b>" + Math.round(p0 + dP) + " g</b><br>热量 <b>" + Math.round(k0) +
      "</b> ＋ <b>" + Math.round(dK) + "</b> ＝ <b>" + Math.round(k0 + dK) + " kcal</b>";
  }
  function html() {
    var v = cur(), p0 = num(v.p), k0 = num(v.k), h = "";
    h += '<div class="seg" style="margin:0 0 14px">' +
      '<button data-nm="add" class="' + (mode === "add" ? "on" : "") + '">加这一顿</button>' +
      '<button data-nm="set" class="' + (mode === "set" ? "on" : "") + '">改成总数</button></div>';
    h += '<div class="card">';
    if (mode === "add") {
      h += '<div class="fld"><label>本次蛋白（g）</label><input class="num" type="text" inputmode="decimal" id="nP" placeholder="0" value=""></div>';
      h += '<div class="fld"><label>本次热量（kcal）</label><input class="num" type="text" inputmode="numeric" id="nK" placeholder="0" value=""></div>';
      h += "</div>";
      h += '<div class="note" id="nPrev">' + previewLine(p0, k0, 0, 0) + "</div>";
    } else {
      h += '<div class="fld"><label>蛋白总数（g）</label><input class="num" type="text" inputmode="decimal" id="nP" value="' + Math.round(p0) + '"></div>';
      h += '<div class="fld"><label>热量总数（kcal）</label><input class="num" type="text" inputmode="numeric" id="nK" value="' + Math.round(k0) + '"></div>';
      h += "</div>";
      h += '<div class="note" id="nPrev">直接填 ' + dl + " 想显示的总数，会盖掉现在的值。</div>";
    }
    h += '<div class="note">' + date.slice(5).replace("-", "月") + "日</div>";
    return h;
  }

  openSheet("饮食 · " + dl, html(), function () {
    /* 保留 mode，否则每手动改一次数值，当天的训练/休息标记就被抹掉了 */
    var o = D.nutri[date] || {};
    var p0 = num(o.p), k0 = num(o.k);
    var ip = num($("#nP").value), ik = num($("#nK").value);
    if (mode === "add") { o.p = p0 + ip; o.k = k0 + ik; }
    else { o.p = ip; o.k = ik; }
    D.nutri[date] = o;
    save("nutri");
    toast(mode === "add" ? "已加上 · 今天 " + Math.round(o.k) + " kcal" : "已改成 " + Math.round(o.k) + " kcal");
  }, "保存");

  sheetRefresh = function () { return html(); };
  $("#sheetBody").onclick = function (e) {
    var b = e.target.closest("[data-nm]"); if (!b) return;
    mode = b.getAttribute("data-nm");
    refreshSheet();
    var el = $("#nP"); if (el) el.focus();
  };
  /* 实时预览：只改 #nPrev 那一行字，不重绘整块 —— 否则输入框会丢焦点 */
  $("#sheetBody").oninput = function (e) {
    if (mode !== "add") return;
    var el = e.target;
    if (!el || (el.id !== "nP" && el.id !== "nK")) return;
    var pv = $("#nPrev"); if (!pv) return;
    var o = D.nutri[date] || {};
    pv.innerHTML = previewLine(num(o.p), num(o.k), num($("#nP").value), num($("#nK").value));
  };
  setTimeout(function () { var el = $("#" + (focus === "k" ? "nK" : "nP")); if (el) el.focus(); }, 350);
}
function addNutri(f, v) {
  var t = ds();
  var o = D.nutri[t] || { p: 0, k: 0 };
  /* 先把 p 和 k 补齐再累加：老数据可能只有 mode，
     只补被点的那个字段的话，另一个仍是 undefined。 */
  o.p = num(o.p); o.k = num(o.k);
  o[f] = o[f] + v;
  D.nutri[t] = o; save("nutri"); render();
  toast("+" + v + (f === "p" ? "g 蛋白" : " kcal"));
}

/* ============================================================
   11b. 记一顿 —— 拍照 + 点选常吃
   ------------------------------------------------------------
   照片不存（只在弹层开着的时候当预览，关掉就没了）。
   存下来的只有两样：这一顿吃了什么，和一个约 1.4KB 的「指纹」。

   指纹是 MobileNet 倒数第二层的 1024 维输出（不是那 1000 个菜名 ——
   公开模型里根本没有「番茄炒蛋」这种类）。它认不出菜名，但很擅长回答
   「这张跟你上次拍的那张像不像」。所以第一次你手动告诉它这是什么，
   下次它就能猜出来。越用越准。

   不变量：D.nutri[date] 永远是当天汇总的唯一真相。D.meals 只是流水，
   绝不拿它反推 nutri。
   ============================================================ */

/* ---------- 常吃清单 ---------- */
function foodFind(id) {
  var f = null;
  D.foods.forEach(function (x) { if (x.id === id) f = x; });
  return f;
}
function foodsRecent() {
  return D.foods.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
}
function foodsByCat(cat) {
  return D.foods.filter(function (f) { return f.cat === cat; });
}

/* ---------- 草稿（不持久化，来回切层不丢已选） ---------- */
function mealSlotNow() {
  var hh = new Date().getHours();
  return hh < 10 ? "早" : hh < 15 ? "午" : hh < 21 ? "晚" : "加";
}
function mealDraft(date) {
  if (U.mealDraft && U.mealDraft.date === date) return U.mealDraft;
  U.mealDraft = { date: date, meal: mealSlotNow(), items: [], photoUrl: "", emb: null, ai: null };
  return U.mealDraft;
}
function mealTotal(dr) {
  var k = 0, p = 0;
  dr.items.forEach(function (it) { k += num(it.k) * it.qty; p += num(it.p) * it.qty; });
  return { k: Math.round(k), p: Math.round(p) };
}
function mealHas(dr, fid) {
  return dr.items.some(function (it) { return it.fid === fid; });
}
function fmtQty(q) { return q === 0.5 ? "½" : q === 1.5 ? "1½" : q === 2.5 ? "2½" : String(q); }
function mealNames(m) {
  var ns = m.foods.map(function (x) { return x.n; });
  return ns.length > 4 ? ns.slice(0, 4).join("、") + " 等 " + ns.length + " 样" : ns.join("、");
}
function dropPhoto(dr) {
  if (dr.photoUrl) { try { URL.revokeObjectURL(dr.photoUrl); } catch (e) {} }
  dr.photoUrl = ""; dr.emb = null; dr.ai = null;
}

/* ---------- 那一顿的弹层 ---------- */
function mealSheet(date) {
  var dr = mealDraft(date);
  openSheet("记一顿 · " + date.slice(5).replace("-", "/"), mealSheetHTML(dr), function () {
    return mealCommit(dr);
  }, "记下这一顿");
  sheetRefresh = function () { return mealSheetHTML(dr); };

  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-ms],[data-mf],[data-mqi],[data-mr],[data-mph],[data-muse],[data-mfnew],[data-mfe]");
    if (!t) return;

    if (t.hasAttribute("data-ms")) { dr.meal = t.getAttribute("data-ms"); refreshSheet(); return; }

    if (t.hasAttribute("data-mph")) { mealPickPhoto(dr, t.getAttribute("data-mph")); return; }

    if (t.hasAttribute("data-mfe")) {          /* 点菜名 → 改这份食物的数字 */
      var it3 = dr.items[+t.getAttribute("data-mfe")];
      if (!it3) return;
      foodEditSheet(it3.fid, function (f2) {
        if (!f2) {                                   /* 这个食物被删了：这一顿里也拿掉 */
          dr.items = dr.items.filter(function (x) { return x !== it3; });
        } else {                                     /* 数字改了：这顿也按新的算，别还按旧的 */
          it3.n = f2.n; it3.u = f2.u; it3.k = num(f2.k); it3.p = num(f2.p);
        }
        mealSheet(dr.date);
      });
      return;
    }

    if (t.hasAttribute("data-muse")) {          /* 接受 AI 的建议：整组填进托盘 */
      var c = dr.ai && dr.ai.cand;
      if (!c) return;
      dr.items = c.meal.foods.map(function (x) {
        return { fid: x.fid, n: x.n, u: x.u, k: num(x.k), p: num(x.p), qty: x.qty || 1 };
      });
      refreshSheet();
      toast("照上次那顿填好了，不对就改");
      return;
    }

    if (t.hasAttribute("data-mfnew")) {
      /* 新加的食物直接进这一顿 —— 你是在记这顿的时候加它的，多半就是刚吃的那道 */
      foodEditSheet(null, function (made) {
        if (made) dr.items.push({ fid: made.id, n: made.n, u: made.u, k: num(made.k), p: num(made.p), qty: 1 });
        mealSheet(dr.date);
      });
      return;
    }

    if (t.hasAttribute("data-mf")) {
      var fid = t.getAttribute("data-mf");
      if (mealHas(dr, fid)) dr.items = dr.items.filter(function (it) { return it.fid !== fid; });
      else {
        var f = foodFind(fid);
        if (f) dr.items.push({ fid: f.id, n: f.n, u: f.u, k: num(f.k), p: num(f.p), qty: 1 });
      }
      refreshSheet(); return;
    }

    if (t.hasAttribute("data-mqi")) {
      var i = +t.getAttribute("data-mqi"), it2 = dr.items[i];
      if (!it2) return;
      var step = t.getAttribute("data-mq") === "+" ? 0.5 : -0.5;
      it2.qty = clamp(Math.round((it2.qty + step) * 2) / 2, 0.5, 3);
      refreshSheet(); return;
    }

    if (t.hasAttribute("data-mr")) {
      dr.items.splice(+t.getAttribute("data-mr"), 1);
      refreshSheet(); return;
    }
  };

  /* 匹配过的那顿，把它的指纹也记下来 —— 同一个模型算的，可以直接比 */
}

function mealSheetHTML(dr) {
  var tot = mealTotal(dr), h = "";

  h += '<div class="seg" style="margin:0 0 14px">' + ["早", "午", "晚", "加"].map(function (s) {
    return '<button data-ms="' + s + '" class="' + (dr.meal === s ? "on" : "") + '">' + s + "餐</button>";
  }).join("") + "</div>";

  h += '<div class="pad" style="padding-bottom:10px">';
  if (dr.photoUrl) {
    h += '<div class="card"><div class="card-pad meal-photo">' +
      '<img class="meal-thumb" src="' + dr.photoUrl + '" alt="">' +
      '<div class="meal-photo-t">照片只用来认这一顿，<b>不会存下来</b>。</div>' +
      '<button class="qb mini gray" data-mph="rm">✕</button></div></div>';
  } else {
    h += '<div class="meal-photo-btns">' +
      '<button class="btn sec sm" data-mph="cam">拍照</button>' +
      '<button class="btn sec sm" data-mph="lib">从相册选</button></div>';
  }
  h += "</div>";

  if (dr.photoUrl) h += aiBoxHTML(dr);

  if (dr.items.length) {
    h += '<div class="sec" style="margin:16px 0 12px"><div class="sec-t">这一顿（' + dr.items.length + "）</div><div class=\"card\">";
    dr.items.forEach(function (it, i) {
      h += '<div class="row tray-row">' +
        '<div class="rl" data-mfe="' + i + '"><div class="rt" style="font-size:16px">' + esc(it.n) + " ›</div>" +
        '<div class="rs">' + Math.round(num(it.k) * it.qty) + " kcal · " + Math.round(num(it.p) * it.qty) + " g 蛋白</div></div>" +
        '<button class="qb mini gray" data-mqi="' + i + '" data-mq="-">−</button>' +
        '<span class="qty-v">' + fmtQty(it.qty) + "</span>" +
        '<button class="qb mini gray" data-mqi="' + i + '" data-mq="+">＋</button>' +
        '<button class="qb mini gray" data-mr="' + i + '">✕</button></div>';
    });
    h += "</div></div>";
  }

  h += '<div class="sec" style="margin:16px 0 12px"><div class="sec-t">常吃</div><div class="food-grid">';
  foodsRecent().forEach(function (f) { h += foodChipHTML(f, mealHas(dr, f.id)); });
  h += "</div>";
  h += '<div class="pad" style="margin-top:10px"><button class="btn sec sm" data-mfnew="1">+ 新增常吃</button></div></div>';

  h += '<div class="sec" style="margin:16px 0 0"><div class="sec-t">全部</div>';
  FOOD_CATS.forEach(function (c) {
    var arr = foodsByCat(c[0]);
    if (!arr.length) return;
    h += '<div class="cat-t">' + c[1] + "</div>";
    h += '<div class="food-grid">';
    arr.forEach(function (f) { h += foodChipHTML(f, mealHas(dr, f.id)); });
    h += "</div>";
  });
  h += "</div>";

  h += '<div class="note">点一下食物＝一份。吃了一半按 −，吃了两碗按 ＋。<br>' +
    "点「这一顿」里的<b>菜名</b>能改它一份是多少热量——改的是「常吃」里的数字，以后每次都按新的算。</div>";
  h += '<div class="meal-total">本顿合计 <b>' + tot.k + "</b> kcal · <b>" + tot.p + "</b> g 蛋白</div>";

  return h;
}

function foodChipHTML(f, on) {
  return '<button class="food' + (on ? " on" : "") + '" data-mf="' + f.id + '">' + esc(f.n) +
    "<s>" + Math.round(num(f.k)) + "</s></button>";
}

/* ---------- AI 提示条 ---------- */
function aiBoxHTML(dr) {
  var a = dr.ai;
  if (!a) return "";
  if (a.st === "loading") return '<div class="pad" style="padding-bottom:12px"><div class="ai-box"><span class="ai-spin"></span>' + esc(a.msg) + "</div></div>";
  if (a.st === "err") return '<div class="pad" style="padding-bottom:12px"><div class="ai-box warn">' + esc(a.msg) + "</div></div>";
  if (a.st === "ok" && a.cand) {
    var m = a.cand.meal;
    return '<div class="pad" style="padding-bottom:12px"><div class="ai-box hit">看着像 <b>' +
      esc(m.date.slice(5).replace("-", "/")) + "</b> 那顿 · " + esc(mealNames(m)) +
      '<button class="btn sm" data-muse="1" style="margin-top:10px;width:100%">就用这一组</button></div></div>';
  }
  return '<div class="pad" style="padding-bottom:12px"><div class="ai-box">这张没认出来。下面点一下是哪几样，<b>下次拍同一道菜它就记住了</b>。</div></div>';
}

/* ---------- 拍照 / 相册 ---------- */
function mealPickPhoto(dr, how) {
  if (how === "rm") { dropPhoto(dr); refreshSheet(); return; }
  pickPhoto(function (file) {
    dropPhoto(dr);
    dr.photoUrl = URL.createObjectURL(file);
    var firstTime = !_embModel;
    dr.ai = { st: "loading", msg: firstTime ? "第一次要下载 AI（约 18MB，只下一次），大概十几秒…" : "正在看这张…" };
    refreshSheet();

    var img = new Image();
    img.onload = function () {
      ensureAI(function (err) {
        if (err) {
          dr.ai = { st: "err", msg: "AI 没加载上（可能是没连上网）。不影响记，直接点下面常吃的就行。" };
          refreshSheet(); return;
        }
        try {
          dr.emb = vecToStr(embedImage(img));
          dr.ai = { st: "ok", cand: aiMatch(dr.emb) };
        } catch (e) {
          dr.emb = null;
          dr.ai = { st: "err", msg: "这张图读不了，直接点下面常吃的就行。" };
        }
        refreshSheet();
      });
    };
    img.onerror = function () { dr.ai = { st: "err", msg: "这张图读不了" }; refreshSheet(); };
    img.src = dr.photoUrl;
  }, how === "cam");
}

/* ---------- 提交 ---------- */
function mealCommit(dr) {
  if (!dr.items.length) { toast("先点一下吃了什么"); return "keep"; }
  var date = dr.date, tot = mealTotal(dr);
  if (!tot.k && !tot.p) { toast("这几样的热量都是 0，先改一下它们的数字"); return "keep"; }

  /* 累加进当天汇总。先 num() 补齐 p/k：老数据可能只有 mode。mode 原样保留 */
  var o = D.nutri[date] || { p: 0, k: 0 };
  o.p = num(o.p) + tot.p;
  o.k = num(o.k) + tot.k;
  D.nutri[date] = o;

  var id = "m" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  D.meals.push({
    id: id, date: date, meal: dr.meal,
    foods: dr.items.slice(),        /* 存快照：以后改常吃清单不会篡改历史 */
    k: tot.k, p: tot.p,
    emb: dr.emb || null             /* 指纹约 1.4KB，照片本身不留 */
  });

  var now = Date.now();
  dr.items.forEach(function (it) {
    var f = foodFind(it.fid);
    if (f) f.last = now;            /* 记过就排到「常吃」前面 */
  });

  save("nutri"); save("meals"); save("foods");
  dropPhoto(dr);
  U.mealDraft = null;
  toast(dr.meal + "餐已记下 · " + tot.k + " kcal · " + tot.p + " g 蛋白");
  return null;
}

/* ---------- 饮食页：今天已记的几顿 ---------- */
function mealRowsHTML(date) {
  var ms = D.meals.filter(function (m) { return m.date === date; });
  if (!ms.length) {
    return '<div class="row"><div class="rl"><div class="rs">今天还没记。' +
      "第一顿随便点几样，以后拍照它就认得了。</div></div></div>";
  }
  return ms.map(function (m) {
    return '<div class="row" data-act="mealView" data-id="' + m.id + '">' +
      '<span class="meal-chip">' + esc(m.meal) + "</span>" +
      '<div class="rl"><div class="rt" style="font-size:16px">' + esc(mealNames(m)) + "</div>" +
      '<div class="rs">' + Math.round(num(m.k)) + " kcal · " + Math.round(num(m.p)) + " g 蛋白" +
      (m.emb ? " · 认得住" : "") + "</div></div>" +
      '<span class="chev">›</span></div>';
  }).join("");
}

/* ---------- 某一顿：详情 / 删除 ---------- */
function mealViewSheet(id) {
  U.delArm = null;
  function find() {
    var m = null;
    D.meals.forEach(function (x) { if (x.id === id) m = x; });
    return m;
  }
  function html() {
    var m = find();
    if (!m) return '<div class="note">这一顿已经删掉了。</div>';
    var h = '<div class="card">';
    m.foods.forEach(function (it) {
      h += '<div class="row"><div class="rl"><div class="rt" style="font-size:16px">' + esc(it.n) + "</div>" +
        '<div class="rs">' + fmtQty(it.qty) + " " + esc(it.u || "份") + " · " +
        Math.round(num(it.k) * it.qty) + " kcal · " + Math.round(num(it.p) * it.qty) + " g 蛋白</div></div></div>";
    });
    h += "</div>";
    h += '<div class="note">' + esc(m.date) + " · " + esc(m.meal) + "餐 · 合计 " + Math.round(num(m.k)) +
      " kcal · " + Math.round(num(m.p)) + " g 蛋白<br>照片没有存，只留了一个指纹用来下次认它。</div>";
    var arm = U.delArm === id;
    h += '<div class="pad" style="margin-top:14px"><button class="btn ' + (arm ? "danger" : "gray") +
      ' sm" data-md="1">' + (arm ? "再点一次，确认删除" : "删掉这一顿") + "</button></div>";
    return h;
  }
  openSheet("这一顿", html(), null, "关闭");
  sheetRefresh = html;
  $("#sheetBody").onclick = function (e) {
    var b = e.target.closest("[data-md]"); if (!b) return;
    if (U.delArm !== id) {                  /* 第一次点只是上膛，3 秒后自动收回 */
      U.delArm = id; refreshSheet();
      setTimeout(function () { if (U.delArm === id) { U.delArm = null; if (find()) refreshSheet(); } }, 3000);
      return;
    }
    var m = find(); if (!m) return;
    var o = D.nutri[m.date] || { p: 0, k: 0 };
    /* 下限 0：你手动改过总数的话，别扣成负数 */
    o.p = Math.max(0, num(o.p) - num(m.p));
    o.k = Math.max(0, num(o.k) - num(m.k));
    D.nutri[m.date] = o;
    D.meals = D.meals.filter(function (x) { return x.id !== id; });
    save("nutri"); save("meals");
    U.delArm = null;
    toast("已删除这一顿");
    closeSheet();
  };
}

/* ---------- 常吃：新增 / 改 / 删（嵌在「记一顿」上面那一层） ---------- */
function foodEditSheet(id, after) {
  var isNew = !id, f = null;
  D.foods.forEach(function (x) { if (x.id === id) f = x; });
  if (isNew) f = F("f" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36), "", "份", 0, 0, "meat");

  var h = '<div class="card">';
  h += '<div class="fld"><label>名称</label><input type="text" id="fdN" value="' + esc(f.n) + '" placeholder="比如：番茄炒蛋"></div>';
  h += '<div class="fld"><label>一份叫</label><input type="text" id="fdU" value="' + esc(f.u) + '" placeholder="份 / 碗 / 个" style="width:90px;text-align:right"></div>';
  h += '<div class="fld"><label>一份热量（kcal）</label><input class="num" type="text" inputmode="numeric" id="fdK" value="' + Math.round(num(f.k)) + '"></div>';
  h += '<div class="fld"><label>一份蛋白（g）</label><input class="num" type="text" inputmode="decimal" id="fdP" value="' + Math.round(num(f.p)) + '"></div>';
  h += '<div class="fld"><label>归到哪类</label><select id="fdC">' + FOOD_CATS.map(function (c) {
    return '<option value="' + c[0] + '"' + (c[0] === f.cat ? " selected" : "") + ">" + c[1] + "</option>";
  }).join("") + "</select></div>";
  h += "</div>";
  h += '<div class="note">按你平时吃的那一份填就行，不用称重。以后点一下就是这一份。</div>';
  if (!isNew) h += '<div class="pad" style="margin-top:14px"><button class="btn danger sm" data-fd="del">删掉这个食物</button></div>';

  openSheet(isNew ? "新增常吃" : "编辑常吃", h, function () {
    var nm = $("#fdN").value.replace(/^\s+|\s+$/g, "");
    if (!nm) { toast("名字不能空着"); return "keep"; }
    f.n = nm;
    f.u = $("#fdU").value.replace(/^\s+|\s+$/g, "") || "份";
    f.k = Math.max(0, Math.round(num($("#fdK").value)));
    f.p = Math.max(0, Math.round(num($("#fdP").value)));
    f.cat = $("#fdC").value;
    if (isNew) { f.last = Date.now(); D.foods.push(f); }   /* 新加的排到「常吃」最前面 */
    save("foods");
    toast(isNew ? "已加进常吃" : "已保存");
    if (after) { after(f); return "keep"; }     /* 把这条回给调用方，然后回到「记一顿」那层 */
    return null;
  }, isNew ? "添加" : "保存");

  $("#sheetBody").onclick = function (e) {
    var b = e.target.closest("[data-fd]"); if (!b) return;
    D.foods = D.foods.filter(function (x) { return x.id !== f.id; });
    save("foods");
    toast("已删除");
    if (after) { after(null); return; }         /* null = 被删了，调用方自己看着办 */
    closeSheet();
  };
  setTimeout(function () { var el = $("#fdN"); if (el) el.focus(); }, 350);
}

/* ============================================================
   11c. AI：MobileNet 特征 + 「像不像」匹配
   ------------------------------------------------------------
   tf.min.js 和模型都按需加载：App 启动时一个字节都不碰，
   第一次点「拍照」才拉，之后由 Service Worker 缓存下来，离线可用。
   ============================================================ */
var _embModel = null, _aiWant = null;

function loadTF(cb) {
  if (window.tf && window.tf.loadLayersModel) { cb(null); return; }
  var s = document.createElement("script");
  s.src = "tf.min.js";
  s.onload = function () { cb(window.tf ? null : new Error("tf 没起来")); };
  s.onerror = function () { cb(new Error("tf.min.js 下载失败")); };
  document.head.appendChild(s);
}
function ensureAI(cb) {
  if (_embModel) { cb(null); return; }
  if (_aiWant) { _aiWant.push(cb); return; }        /* 正在加载：排队等着，别重复下 18MB */
  _aiWant = [cb];
  function flush(err) {
    var q = _aiWant; _aiWant = null;
    q.forEach(function (fn) { fn(err); });
  }
  loadTF(function (e1) {
    if (e1) { flush(e1); return; }
    tf.loadLayersModel("model/model.json").then(function (base) {
      /* 取倒数第二层（全局平均池化）当特征，不用最后那 1000 个菜名 */
      var pool = null;
      base.layers.forEach(function (l) { if (l.getClassName() === "GlobalAveragePooling2D") pool = l; });
      _embModel = tf.model({ inputs: base.inputs, outputs: (pool || base.layers[base.layers.length - 2]).output });
      flush(null);
    }).catch(function (e2) { flush(e2); });
  });
}
/* 中心方形裁切到 224×224 —— 和模型训练时的取景一致，也避免拉伸变形 */
function to224(img) {
  var c = document.createElement("canvas");
  c.width = 224; c.height = 224;
  var s = Math.min(img.width, img.height);
  c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 224, 224);
  return c;
}
function embedImage(img) {
  return tf.tidy(function () {
    var x = tf.browser.fromPixels(to224(img)).toFloat().expandDims(0);
    var half = tf.scalar(127.5);                    /* MobileNet 要 [-1,1] 输入 */
    var out = _embModel.predict(x.sub(half).div(half));
    return Array.prototype.slice.call(out.dataSync());
  });
}
/* 压成 1024 个字节再转 base64（约 1.4KB）。
   特征都是 ReLU 后的非负值，等比压到 0–255 不影响余弦相似度。 */
function vecToStr(v) {
  var n = v.length, u = new Uint8Array(n), i, m = 0;
  for (i = 0; i < n; i++) if (v[i] > m) m = v[i];
  if (m <= 0) m = 1;
  for (i = 0; i < n; i++) u[i] = clamp(Math.round((v[i] / m) * 255), 0, 255);
  var s = "";
  for (i = 0; i < n; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function strToVec(s) {
  var b = atob(s), u = new Uint8Array(b.length), i;
  for (i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function cosVec(a, b) {
  var s = 0, na = 0, nb = 0, i, n = Math.min(a.length, b.length);
  for (i = 0; i < n; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return s / Math.sqrt(na * nb);
}
function setKey(m) {
  return m.foods.map(function (x) { return x.fid || x.n; }).sort().join("|");
}
/* 找最像的那一顿。两道关卡都过才敢提示：
   ① 最像的要 ≥ AI_MATCH；② 还要比「另一组不一样的菜」里最像的那顿再高出 AI_MARGIN。
   实测：同一道菜 0.96–1.00，不同菜 0.38–0.82。这两条是保守取值，宁可不提示。 */
function aiMatch(str) {
  var q = strToVec(str), best = null, bestS = -1;
  D.meals.forEach(function (m) {
    if (!m.emb) return;
    var s = cosVec(q, strToVec(m.emb));
    if (s > bestS) { bestS = s; best = m; }
  });
  if (!best || bestS < AI_MATCH) return null;
  var key = setKey(best), other = -1;
  D.meals.forEach(function (m) {
    if (!m.emb || setKey(m) === key) return;
    var s = cosVec(q, strToVec(m.emb));
    if (s > other) other = s;
  });
  if (other >= 0 && bestS - other < AI_MARGIN) return null;
  return { meal: best, score: bestS };
}

function addPhotoSheet() {
  var t = ds();
  var h = '<div class="note" style="padding-bottom:14px">选一个角度，然后拍照或从相册选。</div><div class="card">';
  ["正面", "侧面", "背面"].forEach(function (p) {
    h += '<div class="row" data-act="doPhoto" data-pose="' + p + '"><div class="rl"><div class="rt">' + p + '</div></div><span class="chev">›</span></div>';
  });
  h += "</div>";
  h += '<div class="note">照片会压缩到长边 1200px 后存在本机，不会上传。</div>';
  openSheet("添加照片", h, null, "关闭");
  $("#sheetBody").onclick = function (e) {
    var t2 = e.target.closest('[data-act="doPhoto"]'); if (!t2) return;
    var pose = t2.getAttribute("data-pose");
    closeSheet();
    pickPhoto(function (file) {
      compress(file, 1200, function (blob) {
        var id = "p" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        Store.set("photo:" + id, blob).then(function () {
          D.photoMeta.push({ id: id, date: ds(), pose: pose });
          save("photoMeta");
          U.tab = "body"; U.bodySeg = "photo";
          toast(pose + "照片已保存");
          render();
        });
      });
    });
  };
}
function pickPhoto(cb, cam) {
  var inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  if (cam) inp.setAttribute("capture", "environment");   /* 手机点「拍照」直接进相机，不弹选择菜单 */
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", function () {
    var f = inp.files && inp.files[0];
    document.body.removeChild(inp);
    if (f) cb(f);
  });
  inp.click();
}
function compress(file, maxSide, cb) {
  var img = new Image(), url = URL.createObjectURL(file);
  img.onload = function () {
    var w = img.width, h = img.height, sc = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    if (c.toBlob) c.toBlob(function (b) { cb(b); }, "image/jpeg", 0.82);
    else cb(dataURLtoBlob(c.toDataURL("image/jpeg", 0.82)));
  };
  img.onerror = function () { URL.revokeObjectURL(url); toast("这张图读不了"); };
  img.src = url;
}
function dataURLtoBlob(u) {
  var a = u.split(","), m = a[0].match(/:(.*?);/)[1], b = atob(a[1]);
  var n = b.length, arr = new Uint8Array(n);
  while (n--) arr[n] = b.charCodeAt(n);
  return new Blob([arr], { type: m });
}
function delPhoto(id) {
  if (!confirm("删掉这张照片？删了就找不回来了。")) return;
  Store.del("photo:" + id).then(function () {
    D.photoMeta = D.photoMeta.filter(function (p) { return p.id !== id; });
    save("photoMeta"); render();
  });
}
function delLog(date) {
  if (!confirm("删除 " + date + " 的训练记录？")) return;
  delete D.logs[date]; save("logs"); render();
}

function settingsSheet() {
  var s = D.settings;
  var h = "";
  h += '<div class="sec"><div class="sec-t">目标</div><div class="card">';
  h += '<div class="fld"><label>每日蛋白（g）</label><input class="num" type="number" id="stP" value="' + s.proteinTarget + '"></div>';
  h += '<div class="fld"><label>每日总消耗（kcal）</label><input class="num" type="number" id="stT" value="' + s.tdee + '" step="50"></div>';
  h += '<div class="fld"><label>训练日缺口（kcal）</label><input class="num" type="number" id="stDT" value="' + s.deficitTrain + '" step="50"></div>';
  h += '<div class="fld"><label>休息日缺口（kcal）</label><input class="num" type="number" id="stDR" value="' + s.deficitRest + '" step="50"></div>';
  h += '<div class="fld"><label>目标体重（kg）</label><input class="num" type="number" id="stW" value="' + s.weightTarget + '" step="0.5"></div>';
  h += '<div class="fld"><label>默认休息（秒）</label><input class="num" type="number" id="stR" value="' + s.defaultRest + '" step="15"></div>';
  h += "</div>";
  h += '<div class="note">蛋白建议 1.6–2.2 g/kg。你 70kg → 112–155g。<br>' +
    '总消耗 = 基础代谢 + 日常活动 + 训练。<br>' +
    '按现在的数：训练日吃 <b>' + Math.round(s.tdee - s.deficitTrain) + "</b> kcal，休息日吃 <b>" +
    Math.round(s.tdee - s.deficitRest) + "</b> kcal。</div></div>";

  h += '<div class="sec"><div class="sec-t">数据</div><div class="card">';
  h += '<div class="row" data-act="export"><div class="rl"><div class="rt">导出备份</div><div class="rs">存成一个文件，换手机时用</div></div><span class="chev">›</span></div>';
  h += '<div class="row" data-act="import"><div class="rl"><div class="rt">导入备份</div><div class="rs">从备份文件恢复</div></div><span class="chev">›</span></div>';
  h += "</div></div>";

  h += '<div class="sec"><div class="sec-t">危险操作</div><div class="card">';
  h += '<div class="row" data-act="wipe"><div class="rl"><div class="rt" style="color:var(--red)">清空所有数据</div><div class="rs">训练记录、体重、饮食、照片全部删除</div></div></div>';
  h += "</div></div>";

  h += '<div class="foot">数据全部保存在这台手机本地，不会上传到任何服务器。<br>唯一会丢的情况：从主屏幕删掉这个 App，或清除 Safari 数据。<br>所以请偶尔用「导出备份」存一份到 iCloud。</div>';
  openSheet("设置", h, function () {
    s.proteinTarget = clamp(parseInt($("#stP").value, 10) || 140, 30, 400);
    s.tdee = clamp(parseInt($("#stT").value, 10) || 3000, 800, 8000);
    s.deficitTrain = clamp(parseInt($("#stDT").value, 10) || 200, 0, 2000);
    s.deficitRest = clamp(parseInt($("#stDR").value, 10) || 500, 0, 2000);
    s.weightTarget = clamp(parseFloat($("#stW").value) || 78, 30, 200);
    s.defaultRest = clamp(parseInt($("#stR").value, 10) || 90, 0, 600);
    save("settings"); toast("已保存");
  }, "保存");

  $("#sheetBody").onclick = function (e) {
    var r = e.target.closest("[data-act]"); if (!r) return;
    var a = r.getAttribute("data-act");
    if (a === "export") { closeSheet(); doExport(); }
    else if (a === "import") { closeSheet(); doImport(); }
    else if (a === "wipe") { closeSheet(); doWipe(); }
  };
}

/* ============================================================
   13. 备份
   ============================================================ */
function doExport() {
  toast("正在打包…");
  Store.keys().then(function (keys) {
    var photoKeys = keys.filter(function (k) { return k.indexOf("photo:") === 0; });
    return Promise.all(photoKeys.map(function (k) {
      return Store.get(k).then(function (b) { return blobToDataURL(b).then(function (u) { return { k: k, u: u }; }); });
    })).then(function (photos) {
      var pack = { app: "fitness-app", v: 1, at: new Date().toISOString(), data: D, photos: photos };
      var blob = new Blob([JSON.stringify(pack)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "健身备份-" + ds() + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1500);
      toast("备份已生成，存到「文件」里");
    });
  });
}
function blobToDataURL(b) {
  return new Promise(function (res) {
    if (!b) { res(""); return; }
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { res(""); };
    fr.readAsDataURL(b);
  });
}
function doImport() {
  var inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json,application/json";
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", function () {
    var f = inp.files && inp.files[0];
    document.body.removeChild(inp);
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var pack = JSON.parse(fr.result);
        if (!pack || pack.app !== "fitness-app") { toast("这不是本 App 的备份文件"); return; }
        if (!confirm("导入会覆盖当前所有数据，确定吗？")) return;
        var ps = (pack.photos || []).map(function (p) {
          return dataURLtoBlob(p.u);
        });
        var keysJson = (pack.photos || []).map(function (p) { return p.k; });
        var jobs = keysJson.map(function (k, i) { return Store.set(k, ps[i]); });
        jobs.push(Store.set("plan", pack.data.plan || D.plan));
        jobs.push(Store.set("logs", pack.data.logs || {}));
        jobs.push(Store.set("weight", pack.data.weight || {}));
        jobs.push(Store.set("nutri", pack.data.nutri || {}));
        jobs.push(Store.set("photoMeta", pack.data.photoMeta || []));
        jobs.push(Store.set("settings", pack.data.settings || DEFAULT_SETTINGS));
        /* 常吃清单和吃饭流水。旧备份里没有这两个字段 → foods 用 null 让 loadAll 去播种预置清单 */
        jobs.push(Store.set("foods", pack.data.foods == null ? null : pack.data.foods));
        jobs.push(Store.set("meals", pack.data.meals == null ? [] : pack.data.meals));
        Promise.all(jobs).then(function () { location.reload(); });
      } catch (e) { toast("文件读不了，可能损坏了"); }
    };
    fr.readAsText(f);
  });
  inp.click();
}
function doWipe() {
  if (!confirm("确定清空所有数据？这个操作不可恢复。")) return;
  if (!confirm("真的确定吗？建议先导出备份。")) return;
  Store.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return Store.del(k); }));
  }).then(function () { location.reload(); });
}

/* ============================================================
   14. 启动
   ============================================================ */
$("#btnGear").addEventListener("click", settingsSheet);
$("#restPlus").addEventListener("click", function () { Rest.add(30); });
$("#restSkip").addEventListener("click", function () { Rest.stop(); });
$("#lbClose").addEventListener("click", function () { $("#lightbox").hidden = true; });
$("#lightbox").addEventListener("click", function (e) { if (e.target.id === "lightbox") $("#lightbox").hidden = true; });
$("#sheetCancel").addEventListener("click", closeSheet);
$("#sheetMask").addEventListener("click", closeSheet);
$("#sheetDone").addEventListener("click", function () {
  /* onDone 返回 "keep" = 它自己又开了一层（比如存完动作回到那一天的列表）。
     这时不能关，否则刚打开的那层会被一起关掉。 */
  var r = sheetOnDone ? sheetOnDone() : null;
  if (r !== "keep") closeSheet();
});

/* 禁掉两指捏合缩放。
   index.html 的 viewport 管住了安卓和桌面 Chrome，但 iOS 从 iOS 10 起
   直接无视 user-scalable=no，只能在这里拦。
   只在「两根手指以上」时拦 —— 单指滚页面、滚弹层、点输入框全都不受影响。
   passive:false 是必须的，否则 preventDefault() 会被浏览器忽略。 */
document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener("gesturechange", function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener("touchmove", function (e) {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

window.addEventListener("scroll", function () {
  $("#hdr").classList.toggle("scrolled", window.scrollY > 12);
}, { passive: true });

/* 页面切回前台时刷新倒计时 */
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && !$("#restBar").hidden) Rest.add(0);
});

/* 先用默认数据把画面画出来 —— 避免读存储时的白屏等待，
   数据到了再重绘一次。 */
D.plan = JSON.parse(JSON.stringify(DEFAULT_PLAN));
D.settings = Object.assign({}, DEFAULT_SETTINGS);
U.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
READY = true;
var bootHash = (location.hash || "").replace(/^#\/?/, "");
if (bootHash && TABS.some(function (t) { return t.id === bootHash; })) U.tab = bootHash;
render();

loadAll().then(function () {
  render();
  if (!Store.ok()) {
    setTimeout(function () { toast("存储受限：照片功能不可用，但记录仍会保存"); }, 900);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
}).catch(function (e) {
  console.warn("load failed", e);
  toast("数据读取失败，已用默认计划");
});

})();
