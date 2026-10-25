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
  ver: 4,
  /* 热身分五组：common = 每次必做（治体态）；d1–d4 = 当天专项（练哪就热哪）；
     ramp = 递增热身组（正式组之前的轻重量组）；after = 训练后静态拉伸。
     静态拉伸原来排在训练前 —— 会轻微掉力量，2026-10-16 挪到训练后了。 */
  warmup: {
    common: [
      "泡沫轴滚胸椎|10 次",
      "靠墙天使|2 × 10　激活下斜方",
      "单臂弹力带下拉|2 × 15　只做左侧",
      "下巴回收|2 × 10（停 3 秒）",
      "俯卧 Y-T-W|每个字母 × 10"
    ],
    d1: [
      "弹力带肩外旋|2 × 15 / 侧　肩袖预热，左肩弹响必做",
      "四点跪姿胸椎旋转|每侧 8 次",
      "肩胛俯卧撑（或推墙加一）|2 × 10　唤醒前锯肌",
      "空杆上斜卧推|2 × 10　过一遍沉肩压凳、肘 45°"
    ],
    d2: [
      "弹力带直臂下压|2 × 15　预演「背阔肌发力」",
      "肩胛引体 / 悬垂沉肩|2 × 8　专练「先把肩往下压」",
      "弹力带下拉|2 × 12",
      "悬垂放松|30 秒"
    ],
    d3: [
      "弹力带肩外旋|2 × 15 / 侧",
      "哑铃侧平举|1 × 15　用 4–5kg 只找「沉肩 + 肘带」",
      "面拉|1 × 15　用最轻重量只找「肘高 + 顶点外旋」"
    ],
    d4: [
      "髋绕环 / 90-90 转髋|每侧 8 次",
      "臀桥|2 × 15　先夹臀再顶",
      "蚌式|2 × 15 / 侧　臀中肌，防膝盖内扣",
      "靠墙踝背屈|每侧 10 次",
      "空杆深蹲 + 空杆 RDL|2 × 8 / 2 × 10　过一遍动作模式",
      "弹力带肩外旋|2 × 15 / 侧　这天后面还有实力推，肩袖要先热开"
    ],
    ramp: [
      "递增热身组|空杆/最轻 ×10 → 50% ×8 → 70% ×5 → 85% ×2 → 歇 2 分钟开练。只做当天第一个动作"
    ],
    after: [
      "门框胸大肌 / 胸小肌拉伸|每侧 30 秒 × 2",
      "上斜方拉伸|左 2 组 / 右 3 组 × 30 秒",
      "肩胛提肌拉伸|左 2 组 / 右 3 组 × 30 秒"
    ]
  },
  days: [
    {
      id: "d1", tab: "DAY 1", title: "胸 + 三头", short: "胸",
      hint: "弱点优先：上胸（动作 1、2 排最前，就因为它）",
      ex: [
        EX("e1", "上斜哑铃卧推", "胸", 4, "6–8", "对握 · 凳 30–40° · 肘 45° · <b>沉肩压凳</b>", "瓦氏呼吸", 150),
        EX("e2", "上斜绳索夹胸", "胸", 4, "12–15", "龙门架<b>低位</b>滑轮 · 肘角固定 · 往<b>下巴方向</b>夹 · 顶点双手<b>交叉过中线</b> · 夹紧 1 秒", "常规呼吸", 75),
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
      hint: "三天里的最后一天。练完这套<b>明天休息</b>，休息完从胸重新开始。",
      ex: [
        EX("e12", "哑铃侧平举", "肩", 4, "12–15", "倒水式 · <b>不过肩高</b> · 沉肩 · 用肘尖够天花板", "常规呼吸", 60),
        EX("e13", "面拉", "肩", 4, "15–20", "用<b>长绳</b> · 绳索<b>额头高</b> · 肘与肩同高 · <b>先拉开再外旋</b> · 停 1 秒", "常规呼吸", 60),
        EX("e14", "反向蝴蝶机", "肩", 3, "12–15", "胸贴垫 · <b>别耸肩</b> · 停 1 秒", "常规呼吸", 60),
        EX("e15", "实力推", "肩", 3, "6–8", "前臂垂直 · <b>核心收紧不许后仰</b>", "瓦氏呼吸", 150),
        EX("e22", "绳索卷腹", "核心", 3, "12–15", "含胸弓背 · <b>用腹肌把肘拉向膝盖</b> · 不是手臂在拉", "呼气发力，回来吸气", 60),
        EX("e20", "悬挂举腿", "核心", 3, "10", "<b>骨盆后倾</b>，不是单纯抬腿", "常规呼吸", 60),
        EX("e21", "农夫行走", "核心", 3, "40m", "沉肩 · 不摇晃 · 别憋气", "自然呼吸", 90)
      ]
    },
    {
      id: "d4", tab: "DAY 3B", title: "肩 + 腿 + 臀", short: "腿",
      hint: "和「DAY 3A · 肩 + 腹部」隔一轮轮着练。练完这套<b>明天休息</b>，休息完从胸重新开始。<br><b>肩在前、腿和臀在后</b> —— 肩练累了不妨碍腿蹬，反过来腿练到发抖再托举就很危险。",
      ex: [
        /* 肩的三个用新 id（e23–e25），不复用 d3 的 e12/e13/e15。
           findEx() 全计划找第一个同 id 的动作，两天共用一个 id 会让
           「那天几组」读到另一天的定义 —— 所以宁可拆成两套，各记各的历史。
           顺序跟 DAY 3A 保持一致：侧平举 → 面拉 → 反向蝴蝶机 → 实力推。
           四个都要有 —— DAY 3A 是四个，这里是同一套肩，不能少一个。 */
        EX("e23", "哑铃侧平举", "肩", 4, "12–15", "倒水式 · <b>不过肩高</b> · 沉肩 · 用肘尖够天花板", "常规呼吸", 60),
        EX("e24", "面拉", "肩", 4, "15–20", "用<b>长绳</b> · 绳索<b>额头高</b> · 肘与肩同高 · <b>先拉开再外旋</b> · 停 1 秒", "常规呼吸", 60),
        EX("e26", "反向蝴蝶机", "肩", 3, "12–15", "胸贴垫 · <b>别耸肩</b> · 停 1 秒", "常规呼吸", 60),
        EX("e25", "实力推", "肩", 3, "6–8", "前臂垂直 · <b>核心收紧不许后仰</b>", "瓦氏呼吸", 150),
        EX("e16", "杠铃臀推", "臀", 3, "12", "顶点<b>夹臀 2 秒</b> · 别顶过头", "常规呼吸", 90),
        EX("e17", "保加利亚分腿蹲", "腿", 3, "10/侧", "<b>左腿先做</b> · 躯干略前倾（偏臀）", "常规呼吸", 90),
        EX("e18", "罗马尼亚硬拉", "腿", 3, "10", "<b>双正握 + 助力带</b> · 膝角不变 · 髋往后推", "瓦氏呼吸", 150),
        EX("e19", "全幅度深蹲", "腿", 3, "8", "<b>高杠</b> · 大腿低于水平", "瓦氏呼吸", 180)
      ]
    }
  ],
  /* 轮转顺序。这里同时管「练哪天」和「哪天休息」——
     days 只放训练日，「休息」不是一天的动作表，所以单独写成这个序列。
     胸 → 背 → 肩+腹 → 休息 → 胸 → 背 → 肩+腿+臀 → 休息 → 循环（8 天一轮） */
  cycle: ["d1", "d2", "d3", "rest", "d1", "d2", "d4", "rest"]
};

/* 热身分组。第三个是弹层里分段控件用的短名（七个按钮挤不下长名字）。 */
var WARM_GROUPS = [
  ["common", "热身 · 每次必做", "每次"],
  ["d1", "热身 · DAY 1 胸+三头", "胸"],
  ["d2", "热身 · DAY 2 背+二头", "背"],
  ["d3", "热身 · DAY 3A 肩+腹", "肩"],
  ["d4", "热身 · DAY 3B 肩+腿+臀", "腿"],
  ["ramp", "热身 · 递增热身组", "递增"],
  ["after", "训练后拉伸", "训练后"]
];
/* 老版本的热身是一个整体数组（不分天）。手机上存过老计划时别让它炸 —— 当「每次必做」读。 */
function warmArr(k) {
  var w = D.plan && D.plan.warmup;
  if (!w) return [];
  if (Object.prototype.toString.call(w) === "[object Array]") return k === "common" ? w : [];
  return w[k] || [];
}
/* 写入前先确保这一组存在。warmArr 在「这一组还没建过」时会返回一个临时空数组，
   往它里面 push 是白 push —— 所以改动一律走这个。 */
function warmEnsure(k) {
  var w = D.plan.warmup;
  if (!w || Object.prototype.toString.call(w) === "[object Array]") {
    D.plan.warmup = { common: w || [] };
    w = D.plan.warmup;
  }
  if (!w[k]) w[k] = [];
  return w[k];
}
function warmRowHTML(w, big) {
  var p = w.split("|");
  return '<div class="row"><div class="rl"><div class="rt"' + (big ? ' style="font-size:16px"' : "") + ">" +
    esc(p[0]) + '</div><div class="rs">' + esc(p[1] || "") + "</div></div></div>";
}

var MUSCLES = ["胸", "背", "肩", "三头", "二头", "腿", "臀", "核心"];

var DEFAULT_SETTINGS = {
  /* 消耗从 3000 改成 2600：3000 是按「每天都有大运动量」估的，日常上课 +
     一周三练的学生到不了。181cm/70kg 按 Mifflin × 1.5 算出来约 2600。
     目标摄入 = 2600 − 缺口，训练日 2400、休息日 2100，跟饮食计划对得上。
     （这个只影响新装 / 清空数据后的默认值；已经存过的设置不会被覆盖，
       要改得自己去「设置」里改。）*/
  proteinTarget: 150,   // g
  tdee: 2600,           // 每日总消耗 kcal（基础代谢 + 日常活动 + 训练）
  deficitTrain: 200,    // 训练日热量缺口
  deficitRest: 500,     // 休息日热量缺口
  weightTarget: 78,     // kg
  defaultRest: 90,      // 秒
  /* RIR（还能再做几次）那一列。默认关 —— 大部分人不用，
     留着白占一列、每组还多一个要跳过的框。设置里能开回来。
     已经填过的 RIR 数据不会丢，开了就还能看见。 */
  showRir: false
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
  meals: []                     // 每顿流水 [{id,date,meal,foods:[…],k,p}]
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
  mealDraft: null,              // 「记一顿」的草稿，来回切层不丢已选的东西
  foodMg: false,                // 「记一顿」里是否开着「管理常吃」模式
  dietPlanOpen: false           // 饮食页底部「每天怎么吃」速查卡是否展开
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
/* 轮转序列。老计划里没有 cycle 这个字段，退回「一天接一天、没有休息」的老算法，
   免得读旧数据时炸掉。 */
function planCycle() {
  var c = D.plan && D.plan.cycle;
  if (c && c.length) return c;
  return D.plan.days.map(function (d) { return d.id; });
}
/* 今天停在循环的第几格。
   今天有记录就按记录；否则拿上次训练在循环里的位置，往后推「隔了几天」。
   关键：推的是日历天数，不是「练了几次」—— 因为休息日不产生记录，
   按次数推的话第二天会卡在休息这一格出不去。
   休息日要用这个下标算「下一次练哪天」—— 循环里有两个「休息」，
   不能拿 indexOf("rest") 去猜是哪一格。 */
function todayCycleIndex() {
  var t = ds();
  var cyc = planCycle();
  if (!cyc.length) return 0;
  if (D.logs[t] && D.logs[t].dayId) {
    var i0 = cyc.indexOf(D.logs[t].dayId);
    return i0 < 0 ? 0 : i0;
  }
  var prev = lastLogDate(t);
  if (!prev) return 0;
  var pos = cyc.indexOf(D.logs[prev].dayId);
  if (pos < 0) return 0;             /* 上次那天不在循环里（换过计划/手选过）→ 从头上算 */
  var gap = daysBetween(prev, t);
  if (gap < 1) gap = 1;
  return (pos + gap) % cyc.length;
}
/* 今天该练哪天（或「休息」） */
function todayDayId() {
  var t = ds();
  if (D.logs[t] && D.logs[t].dayId) return D.logs[t].dayId;
  return planCycle()[todayCycleIndex()];
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
/* 上次第 i 组；上次没做到那么多组，就沿用上次最后一组。
   灰字预填和「点 ✓ 直接记」都走这一条，保证格子写的是什么、点下去记的就是什么。 */
function lastSetSrc(last, i) {
  if (!last || !last.sets || !last.sets.length) return null;
  return last.sets[i] || last.sets[last.sets.length - 1];
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

/* 某一天算训练日还是休息日。
   1) 用户自己切过 → 听用户的（这是唯一能覆盖自动判断的口子）
   2) 那天有训练记录 → 训练日
   3) 就是今天 → 直接问循环。所以早上还没点「开始」的时候，
      饮食页就已经按「今天练还是今天休」给目标了，
      不会出现「今天要练、饮食页却按休息日 −500 算」这种对不上的情况。
   4) 其它（过去某天、没记录）→ 当休息日 */
function dayMode(date) {
  var n = D.nutri[date];
  if (n && (n.mode === "train" || n.mode === "rest")) return n.mode;
  if (D.logs[date]) return "train";
  if (date === ds()) {
    var did = todayDayId();
    if (did === "rest") return "rest";
    if (findDay(did)) return "train";
  }
  return "rest";
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
    /* 「休息」不是一天的动作表，绝不能当成训练记录存下来 ——
       否则日历里会出现一条显示成 "rest" 的训练。真从休息日误触进来，
       退到循环里的第一个训练日。 */
    var id = dayId || todayDayId();
    if (id === "rest") id = planCycle()[0];
    D.logs[date] = { dayId: id, start: Date.now(), end: null, ex: {}, note: "" };
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
  /* 系统在 App 退到后台时会自动把「屏幕常亮」放掉（iOS 尤其如此），
     切回来不会自己恢复 —— 结果就是休息到一半屏幕自己黑了。
     所以每次回到前台，只要计时还在跑，就重新申请一次，并立刻补画一遍
     （补画还会顺手处理「计时其实早就结束了」：paint() 里到点就 finish()）。*/
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && tick) { keepAwake(true); paint(); }
  });
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
    t = "训练"; s = d ? d.title : (did === "rest" ? "休息日" : "");
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
  if (did === "rest") return viewRest();
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

  /* 热身（未开始时折叠）：每次必做的 + 当天专项 + 递增热身组 */
  if (!isToday) {
    var wItems = warmArr("common").concat(warmArr(day.id), warmArr("ramp"));
    h += '<div class="sec"><div class="sec-t">热身 <span class="r" data-act="togWarm" id="warmTog">展开</span></div>';
    h += '<div class="card" id="warmCard" hidden>' + wItems.map(function (w) { return warmRowHTML(w); }).join("") + "</div></div>";
    var wAfter = warmArr("after");
    if (wAfter.length) {
      h += '<div class="sec"><div class="sec-t">训练后拉伸 <span class="r" data-act="togWarm2" id="warmTog2">展开</span></div>';
      h += '<div class="card" id="warmCard2" hidden>' + wAfter.map(function (w) { return warmRowHTML(w); }).join("") + "</div></div>";
    }
  } else {
    h += '<div class="sec"><div class="sec-t">热身 <span class="r">已跳过</span></div></div>';
  }

  /* 动作 */
  h += '<div class="sec"><div class="sec-t">' + esc(day.tab) + " · " + esc(day.title) + "</div>";
  if (day.hint) h += '<div class="note" style="padding-bottom:8px">' + rich(day.hint) + "</div>";

  if (!isToday) {
    h += '<div class="pad" style="padding-bottom:10px"><button class="btn" data-act="start">开始今天的训练</button></div>';
  } else {
    /* 一键预填。只填空格子，不会冲掉你刚输的东西；
       填完照样要点每组的 ✓ 才算做完，所以不会「替你记」。
       按钮下面那句是给第一次用的人看的 —— 灰字不是数据，别被它骗。 */
    h += '<div class="pad" style="padding-bottom:6px"><button class="btn sec sm" data-act="fillDay">今天照上次填好</button>' +
      '<div class="note" style="padding:8px 2px 0;text-align:center">格子里的浅灰字是上次的数，点 ✓ 才会真的记下来</div></div>';
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

/* ---------------- 休息日 ----------------
   循环轮到「休息」这一格时显示。休息日不写任何记录，
   完全靠 todayDayId() 按日历天数推出来。 */
function viewRest() {
  var today = ds();
  var hh = new Date().getHours();
  var greet = hh < 11 ? "早上好" : hh < 14 ? "中午好" : hh < 18 ? "下午好" : "晚上好";
  var prev = lastLogDate(today);
  var pd = prev ? findDay(D.logs[prev].dayId) : null;
  var cyc = planCycle();
  var nextDay = findDay(cyc[(todayCycleIndex() + 1) % cyc.length]);

  var h = '<div class="pad" style="padding-bottom:12px">';
  h += '<div class="card"><div class="card-pad" style="padding:26px var(--gap);text-align:center">';
  h += '<div style="font-size:13px;color:var(--tx2);margin-bottom:3px">' + greet + " · " +
    (parseD(today).getMonth() + 1) + "月" + parseD(today).getDate() + "日</div>";
  h += '<div style="font-size:26px;font-weight:700;letter-spacing:-.6px">今天休息</div>';
  h += '<div style="font-size:13.5px;color:var(--tx2);margin-top:8px;line-height:1.65">' +
    "练三天、休一天 —— 今天这一格不是偷懒，<br>肌肉是今天长出来的。</div>";
  if (pd) h += '<div style="font-size:12.5px;color:var(--tx3);margin-top:14px">上次练的是「' + esc(pd.title) + "」</div>";
  if (nextDay) h += '<div style="font-size:12.5px;color:var(--tx3);margin-top:4px">下一次练：' + esc(nextDay.title) + "</div>";
  h += "</div></div></div>";

  h += '<div class="sec"><div class="sec-t">今天可以做</div><div class="card">';
  [
    ["走路 20–30 分钟", "散步就行，别当成有氧训练去做"],
    ["把练后拉伸再来一遍", "门框胸大肌、上斜方、肩胛提肌 —— 计划页能翻到"],
    ["睡够 7–8 小时", "这一条比上面两条加起来都重要"],
    ["蛋白照样吃够", "休息日也在修复，别今天就不吃了"]
  ].forEach(function (x) {
    h += '<div class="row" style="padding:11px 16px"><div class="rl">' +
      '<div class="rt" style="font-size:15px">' + x[0] + "</div>" +
      '<div class="rs">' + x[1] + "</div></div></div>";
  });
  h += "</div></div>";

  h += '<div class="pad"><button class="btn sec" data-act="pickDay">今天还是想练</button></div>';
  h += '<div class="foot">循环：胸 → 背 → 肩+腹 → 休息 → 胸 → 背 → 肩+腿+臀 → 休息</div>';
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
  /* RIR 列默认藏起来 —— 大部分人不用它，白占一列还不好按。
     设置里能开回来。 */
  var showRir = !!D.settings.showRir;

  /* 灰字预填：空格子里用浅灰显示上次同一组的数。
     它只是「提示」，不是真数据 —— 点 ✓ 才会写进记录，所以不会污染历史。
     好处是你看得见该上多少，不用回忆；坏处是看灰字时别误以为已经记过了。 */
  function ph(i, f) {
    var src = lastSetSrc(last, i);
    var v = src ? src[f] : "";
    return (v === 0 || v) ? String(v) : "—";
  }

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

  h += '<table class="sets"><thead><tr><th>组</th><th>重量 kg</th><th>次数</th>' +
    (showRir ? "<th>RIR</th>" : "") + "</tr></thead><tbody>";
  for (var i = 0; i < ex.s; i++) {
    var s = sets[i] || { w: "", r: "", rir: "", d: false };
    h += "<tr>";
    h += '<td><button class="sn' + (s.d ? " on" : "") + '" data-act="tog" data-ex="' + ex.id + '" data-si="' + i + '">' + (s.d ? "✓" : i + 1) + "</button></td>";
    if (active) {
      h += '<td><input class="cell' + (s.d ? " on" : "") + '" inputmode="decimal" placeholder="' + esc(ph(i, "w")) + '" value="' + esc(s.w) + '" data-in="w" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
      h += '<td><input class="cell' + (s.d ? " on" : "") + '" inputmode="numeric" placeholder="' + esc(ph(i, "r")) + '" value="' + esc(s.r) + '" data-in="r" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
      if (showRir) h += '<td><input class="cell rir' + (s.d ? " on" : "") + '" inputmode="numeric" placeholder="' + esc(ph(i, "rir")) + '" value="' + esc(s.rir) + '" data-in="rir" data-ex="' + ex.id + '" data-si="' + i + '"></td>';
    } else {
      h += '<td style="color:var(--tx3)">—</td><td style="color:var(--tx3)">—</td>' + (showRir ? '<td style="color:var(--tx3)">—</td>' : "");
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

  /* 记一顿：点几样常吃的 → 自动算出这顿多少热量和蛋白 → 加进今天 */
  h += '<div class="sec" style="margin-top:14px"><div class="sec-t">这顿吃了什么</div>';
  h += '<div class="pad" style="padding-bottom:8px"><button class="btn" data-act="mealSheet">记一顿</button></div>';
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

  h += dietPlanHTML();

  h += '<div class="foot">蛋白目标 ' + tp + "g 是按你 70kg 体重的 1.6–2.2 g/kg 区间取的中间值。<br>热量目标 = 每日总消耗 − 当天缺口，都在「设置」里改。</div>";
  return h;
}

/* ---------------- 饮食计划（速查卡） ----------------
   纯静态参考：早上照着买、在食堂照着点。
   不参与任何计算，也不写存储 —— 要改计划就改下面两个数组。 */
var DIET_PLAN = [
  { t: "早餐", k: 620, p: 42, it: "希腊酸奶 120 g · 燕麦 65 g · 蓝莓干 20 g · 鸡蛋 3 个" },
  { t: "午餐", k: 825, p: 48, it: "米饭 1.5 碗 · 番茄炒蛋 · 西兰花 · 去皮卤鸭腿 1 个<br>食堂的菜一律先过一遍热水再吃" },
  { t: "训练前后", k: 215, p: 25, it: "香蕉 1 根 · 蛋白粉 1 勺" },
  { t: "晚餐", k: 460, p: 32, it: "燕麦 65 g（或全麦面包 100 g）· 花生酱 15 g · 蛋白粉 1 勺" }
];
var DIET_BUY = [
  { n: "希腊酸奶 120 g 杯装", c: "¥3.5", s: "冷藏。放阴凉处，一杯一开，开封当天喝完" },
  { n: "蓝莓干 20 g", c: "¥0.8", s: "常温。每天只倒 20 g 出来，袋子收起来" },
  { n: "真空卤鸭腿 1 袋", c: "¥3.5", s: "常温。吃前热水冲一下，皮撕掉" },
  { n: "燕麦 100 g", c: "¥1.3", s: "常温，放一学期不怕坏" },
  { n: "苹果 1 个", c: "¥1.5", s: "常温，补纤维（这块最容易缺）" }
];

/* 这张表是固定的（2120 kcal），可今天的目标是跟着「练 / 休」变的
   （训练日 2600−200=2400，休息日 2600−500=2100）。两个数字各说各的会很误导，
   所以把差额直接算出来写在卡片头上：差多少、怎么补、补什么。 */
function dietPlanDayHTML() {
  var today = ds();
  var mode = dayMode(today);
  var tk = kcalTargetFor(today);
  var total = 0;
  DIET_PLAN.forEach(function (m) { total += m.k; });
  var diff = tk - total;
  var note;
  if (Math.abs(diff) <= 60) {
    note = "这张表合计 " + total + " kcal，跟今天的目标正好对上，热量不用再调。";
  } else if (diff > 0) {
    note = "这张表合计 " + total + " kcal，比目标少 <b>" + Math.round(diff) + " kcal</b> —— " +
      (mode === "train"
        ? "训练前后那顿再加 <b>1 根香蕉 + 半勺蛋白粉</b>，正好补上。"
        : "加 <b>1 根香蕉</b>就够了。");
  } else {
    note = "这张表合计 " + total + " kcal，比目标多 <b>" + Math.round(-diff) + " kcal</b> —— " +
      "晚餐燕麦少 20 g，或者花生酱减 5 g。";
  }
  var protein = 0;
  DIET_PLAN.forEach(function (m) { protein += m.p; });
  return '<div class="dp-day"><b>' + (mode === "train" ? "今天练" : "今天休息") + "</b>" +
    ' · 目标 <b>' + tk + " kcal</b> · 蛋白 " + protein + " g" +
    '<div class="dp-s">' + note + "</div></div>";
}

function dietPlanHTML() {
  var totalK = 0;
  DIET_PLAN.forEach(function (m) { totalK += m.k; });
  var todayTk = kcalTargetFor(ds());
  var todayMode = dayMode(ds());
  var h = '<div class="sec"><div class="sec-t">每天怎么吃</div>';
  h += '<div class="card"><div class="row" data-act="dietPlan">' +
    '<div class="rl"><div class="rt">饮食计划 · 照着吃、照着买</div>' +
    '<div class="rs">' + (todayMode === "train" ? "今天练 " : "今天休息 ") + todayTk +
    " kcal · 这张表 " + totalK + " kcal · 147 g 蛋白</div></div>" +
    '<span class="chev">' + (U.dietPlanOpen ? "⌄" : "›") + "</span></div>";

  if (U.dietPlanOpen) {
    h += '<div class="card-pad" style="border-top:1px solid var(--line)">';
    h += dietPlanDayHTML();
    DIET_PLAN.forEach(function (m) {
      h += '<div class="dp-meal"><div class="dp-hd"><b>' + m.t + "</b>" +
        "<s>" + m.k + " kcal · " + m.p + " g</s></div>" +
        '<div class="dp-it">' + m.it + "</div></div>";
    });
    h += '<div class="dp-sum">合计 ≈2120 kcal · 147 g 蛋白 · 68 g 脂肪。<br>' +
      "蛋白 147 g ≈ 你 70 kg 的 2.1 g/kg，在区间里。脂肪 68 g 已经在底线之上，别再往下压。</div>";
    h += "</div>";

    h += '<div class="card-pad" style="border-top:1px solid var(--line)">';
    h += '<div class="dp-t">每天买什么 · 不到 12 元</div>';
    DIET_BUY.forEach(function (b) {
      h += '<div class="dp-buy"><b>' + b.n + "</b><s>" + b.c + "</s>" +
        '<div class="dp-s">' + b.s + "</div></div>";
    });
    h += '<div class="dp-sum">合计 ¥10.6 / 天（¥12 的上限内）</div>';
    h += "</div>";

    h += '<div class="card-pad" style="border-top:1px solid var(--line)">';
    h += '<div class="dp-t">几条不能忘的</div>';
    h += '<div class="dp-s">· 食堂的菜<b>过一遍热水</b>再吃 —— 最省事、收益最大的一步，一天省 200–300 kcal<br>' +
      "· 卤鸭腿吃前热水冲一下，皮撕掉<br>" +
      "· 蓝莓干一袋 500 g 有 1350 kcal，别整袋抓着吃<br>" +
      "· 脂肪别低于 55 g —— 它管睾酮，低了恢复和状态都会掉<br>" +
      "· 酸奶胀包、开盖有异味就扔；只是变酸、出水还能吃</div>";
    h += "</div>";
  }
  h += "</div></div>";
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
  /* 把轮转顺序摆出来 —— 「休息」也是循环里的一格，不画出来就容易忘 */
  h += '<div class="sec"><div class="sec-t">循环 · 练三天休一天</div><div class="card"><div class="card-pad">' +
    '<div style="font-size:13.5px;color:var(--tx2);line-height:1.9">' +
    planCycle().map(function (id) {
      if (id === "rest") return '<b style="color:var(--green)">休息</b>';
      var dd = findDay(id);
      return dd ? esc(dd.short) : "?";
    }).join('<span style="color:var(--tx3)"> → </span>') +
    '</div></div></div></div>';
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
  WARM_GROUPS.forEach(function (g) {
    var items = warmArr(g[0]);
    if (!items.length) return;
    h += '<div class="sec"><div class="sec-t">' + esc(g[1]) + '</div><div class="card">' +
      items.map(function (w) { return warmRowHTML(w, true); }).join("") + "</div></div>";
  });
  h += '<div class="sec"><div class="pad"><button class="btn sec sm" data-act="editWarm">编辑热身</button></div></div>';
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
    case "togWarm2": $("#warmCard2").hidden = !$("#warmCard2").hidden; $("#warmTog2").textContent = $("#warmCard2").hidden ? "展开" : "收起"; break;
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
    case "fillDay": fillDayFromLast(); break;
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
    /* 每次重新打开「记一顿」都从普通模式开始 —— 免得上次开着「管理常吃」，
       这次一进来点啥都进编辑页，莫名其妙。 */
    case "mealSheet": U.foodMg = false; mealSheet(ds()); break;
    case "dietPlan": U.dietPlanOpen = !U.dietPlanOpen; render(); break;
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
  /* 格子里是灰字、你什么都没打就点了 ✓ —— 那就把灰字那个数记下来。
     以前这里取 last.sets[si]，上次没做到这一组就取了个空的，灰字有数、点下去却是空的。 */
  if (s.d && !s.r && !s.w) {
    var src = lastSetSrc(lastRecord(eid, today), si);
    if (src) { s.w = src.w; s.r = src.r; s.rir = src.rir; }
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
  /* 不要在这里再 .replace(/\.?0+$/, "") 去尾零 —— fmt 用的是 toString()，
     本来就不会有「10.00」这种尾巴，那个正则会去删有效数字：
     10 会变成 1、20 变成 2、100 变成 1。这是以前留下的坑。 */
  s.w = w ? fmt(w, 2) : "";
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
    var src = lastSetSrc(last, i);
    if (src) { arr[i].w = src.w; arr[i].r = src.r; arr[i].rir = src.rir; arr[i].d = !!(src.w || src.r); }
  }
  save("logs"); render();
  toast("已填入上次的数据，按实际改");
}
/* 「今天照上次填好」：把今天所有动作一次按上次填满。
   跟「全部照上次」的区别：不动 d（不打勾），所以填完还是要一组一组点 ✓。
   只填空格子 —— 已经填过的（自己打的、刚填的）一律不动，免得把刚输的冲掉。 */
function fillDayFromLast() {
  var today = ds();
  var lg = D.logs[today];
  if (!lg) { toast("先点「开始今天的训练」"); return; }
  var day = findDay(lg.dayId);
  if (!day) { toast("今天的计划找不到了，去「计划」页看看"); return; }

  var n = 0, noHist = 0;
  day.ex.forEach(function (ex) {
    var arr = ensureSets(today, ex);
    var last = lastRecord(ex.id, today);
    if (!last) { noHist++; return; }
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (s.w || s.r) continue;                       /* 已经有数：不动 */
      var src = lastSetSrc(last, i);
      if (!src) continue;
      s.w = src.w; s.r = src.r; s.rir = src.rir;
      n++;
    }
  });

  if (!n) { toast("已经填好了，只改有变化的那几组"); return; }
  save("logs"); render();
  toast("填了 " + n + " 组" + (noHist ? "（" + noHist + " 个动作没有历史，空着）" : "") + "，只改有变化的那几组");
}
function copyPrev(eid) {
  var c = curSet(eid); if (!c.arr) return;
  if (c.si === 0) { toast("这是第一组"); return; }
  var prev = c.arr[c.si - 1];
  var tgt = c.arr[c.si];
  var wasDone = !!tgt.d;
  tgt.w = prev.w; tgt.r = prev.r; tgt.rir = prev.rir;
  tgt.d = !!(prev.w || prev.r);
  save("logs"); render();
  /* 复制完这一组就等于「这组做完了」，跟手输数字、点 ✓ 是同一条路，
     所以照样要查纪录 + 起休息倒计时。以前漏了这两步，复制完一直不进计时。 */
  if (!wasDone && tgt.d) { checkPR(eid, c.si); Rest.start(c.ex.rest, c.ex.n); }
  toast("第 " + (c.si + 1) + " 组 → " + (tgt.w || "空") + " × " + (tgt.r || "—"));
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
  if (!U.warmKey) U.warmKey = "common";
  openSheet("编辑热身", warmEditorHTML(), null, "关闭");
  sheetRefresh = function () { return warmEditorHTML(); };
  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var a = t.getAttribute("data-act");
    if (a === "warmTab") { U.warmKey = t.getAttribute("data-k"); refreshSheet(); return; }
    if (a === "addWarm") { warmItemSheet(-1); return; }
    var i = parseInt(t.getAttribute("data-i"), 10);
    if (a === "edWarm") { warmItemSheet(i); return; }
    if (a === "rmWarm") { warmEnsure(U.warmKey).splice(i, 1); save("plan"); refreshSheet(); toast("已删除"); }
  };
}
function warmEditorHTML() {
  var h = '<div class="seg" style="margin-bottom:12px">' + WARM_GROUPS.map(function (g) {
    return '<button data-act="warmTab" data-k="' + g[0] + '" class="' + (U.warmKey === g[0] ? "on" : "") + '">' + esc(g[2]) + "</button>";
  }).join("") + "</div>";
  var arr = warmArr(U.warmKey);
  h += '<div class="card">';
  if (!arr.length) h += '<div class="row"><div class="rl"><div class="rs">这一组还没有热身项</div></div></div>';
  arr.forEach(function (w, i) {
    var p = w.split("|");
    h += '<div class="row">' +
      '<div class="rl" data-act="edWarm" data-i="' + i + '"><div class="rt" style="font-size:16px">' + esc(p[0]) + "</div>" +
      (p[1] ? '<div class="rs">' + esc(p[1]) + "</div>" : "") + "</div>" +
      '<button class="qb gray mini" data-act="rmWarm" data-i="' + i + '">✕</button></div>';
  });
  h += "</div>";
  h += '<div class="pad" style="margin-top:14px"><button class="btn sec sm" data-act="addWarm">+ 添加热身项</button></div>';
  h += '<div class="note">点热身项可以改名字和说明。上面切换「每次 / 胸 / 背 / 肩 / 腿 / 递增 / 训练后」，就是训练页里那几组。</div>';
  return h;
}
function warmItemSheet(i) {
  var isNew = i < 0;
  var arr = warmEnsure(U.warmKey);
  var p = (isNew ? "" : arr[i] || "").split("|");
  var h = '<div class="card">' +
    '<div class="fld"><label>名称</label><input type="text" id="wmN" value="' + esc(p[0] || "") + '" placeholder="比如：靠墙天使"></div>' +
    '<div class="fld"><label>说明</label><input type="text" id="wmS" value="' + esc(p[1] || "") + '" placeholder="比如：2 × 10"></div>' +
    "</div>";
  openSheet(isNew ? "添加热身项" : "编辑热身项", h, function () {
    var nm = $("#wmN").value.trim();
    if (!nm) { toast("名字不能空着"); return "keep"; }
    var line = nm + "|" + $("#wmS").value.trim();
    var a2 = warmEnsure(U.warmKey);
    if (isNew) a2.push(line); else a2[i] = line;
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
   11b. 记一顿 —— 点选常吃，自动算热量
   ------------------------------------------------------------
   点几样常吃的菜 → 每样按「一份」算好的 kcal / 蛋白加起来 →
   一次累加进当天汇总。吃半份按 −，吃两碗按 ＋。

   （以前的「拍照让 AI 认这是哪道菜」已经去掉了：公开模型认不出中餐，
     而且要多下 17.7MB。清单点选本身就够快。）

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
  U.mealDraft = { date: date, meal: mealSlotNow(), items: [] };
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

/* ---------- 那一顿的弹层 ---------- */
function mealSheet(date) {
  var dr = mealDraft(date);
  openSheet("记一顿 · " + date.slice(5).replace("-", "/"), mealSheetHTML(dr), function () {
    return mealCommit(dr);
  }, "记下这一顿");
  sheetRefresh = function () { return mealSheetHTML(dr); };

  $("#sheetBody").onclick = function (e) {
    var t = e.target.closest("[data-ms],[data-mf],[data-mqi],[data-mr],[data-mfnew],[data-mfe],[data-fme],[data-fmg]");
    if (!t) return;

    if (t.hasAttribute("data-ms")) { dr.meal = t.getAttribute("data-ms"); refreshSheet(); return; }

    if (t.hasAttribute("data-fmg")) { U.foodMg = !U.foodMg; refreshSheet(); return; }

    if (t.hasAttribute("data-fme")) {          /* 管理模式：点常吃 → 改它 / 删它 */
      var fid2 = t.getAttribute("data-fme");
      foodEditSheet(fid2, function (f2) {
        if (!f2) {                               /* 删了：托盘里这一样也拿掉，不然合计还挂着它 */
          dr.items = dr.items.filter(function (it) { return it.fid !== fid2; });
        } else {                                 /* 改了：托盘里那份数也跟着更新 */
          dr.items.forEach(function (it) {
            if (it.fid === fid2) { it.n = f2.n; it.u = f2.u; it.k = num(f2.k); it.p = num(f2.p); }
          });
        }
        mealSheet(dr.date);
      });
      return;
    }

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

  h += '<div class="sec" style="margin:16px 0 12px"><div class="sec-t">常吃</div>';
  if (U.foodMg) {
    h += '<div class="note" style="margin:0 0 10px">管理模式：点<b>任意一个食物</b>进去，可以改数字，也可以删掉它。</div>';
  }
  h += '<div class="food-grid">';
  foodsRecent().forEach(function (f) { h += foodChipHTML(f, mealHas(dr, f.id)); });
  h += "</div>";
  h += '<div class="pad" style="margin-top:10px;display:flex;gap:8px">' +
    '<button class="btn sec sm" data-mfnew="1">+ 新增常吃</button>' +
    (D.foods.length ? '<button class="btn ' + (U.foodMg ? "" : "sec ") +
      'sm" data-fmg="1">' + (U.foodMg ? "完成" : "管理常吃") + "</button>" : "") +
    "</div></div>";

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

  if (!U.foodMg) {
    h += '<div class="note">点一下食物＝一份。吃了一半按 −，吃了两碗按 ＋。<br>' +
      "点「这一顿」里的<b>菜名</b>能改它一份是多少热量——改的是「常吃」里的数字，以后每次都按新的算。<br>" +
      "想去掉某个常吃 → 点上面的<b>「管理常吃」</b>。</div>";
  }
  h += '<div class="meal-total">本顿合计 <b>' + tot.k + "</b> kcal · <b>" + tot.p + "</b> g 蛋白</div>";

  return h;
}

/* 「管理常吃」模式下，chip 不再往这一顿里加东西，改成点进编辑页（那里有删除）。
   两种模式下用的是不同的属性名，所以不会串。 */
function foodChipHTML(f, on) {
  var mg = U.foodMg;
  return '<button class="food' + (on ? " on" : "") + (mg ? " mg" : "") + '"' +
    (mg ? ' data-fme="' + f.id + '"' : ' data-mf="' + f.id + '"') + ">" +
    (mg ? '<i class="food-x">✕</i>' : "") +
    esc(f.n) + "<s>" + Math.round(num(f.k)) + "</s></button>";
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
    k: tot.k, p: tot.p
  });

  var now = Date.now();
  dr.items.forEach(function (it) {
    var f = foodFind(it.fid);
    if (f) f.last = now;            /* 记过就排到「常吃」前面 */
  });

  save("nutri"); save("meals"); save("foods");
  U.mealDraft = null;
  toast(dr.meal + "餐已记下 · " + tot.k + " kcal · " + tot.p + " g 蛋白");
  return null;
}

/* ---------- 饮食页：今天已记的几顿 ---------- */
function mealRowsHTML(date) {
  var ms = D.meals.filter(function (m) { return m.date === date; });
  if (!ms.length) {
    return '<div class="row"><div class="rl"><div class="rs">今天还没记。' +
      "下面点几样常吃的，它就自己算好热量。</div></div></div>";
  }
  return ms.map(function (m) {
    return '<div class="row" data-act="mealView" data-id="' + m.id + '">' +
      '<span class="meal-chip">' + esc(m.meal) + "</span>" +
      '<div class="rl"><div class="rt" style="font-size:16px">' + esc(mealNames(m)) + "</div>" +
      '<div class="rs">' + Math.round(num(m.k)) + " kcal · " + Math.round(num(m.p)) + " g 蛋白</div></div>" +
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
    Math.round(s.tdee - s.deficitRest) + "</b> kcal。<br>" +
    "饮食页会自动挑：轮到你练的那天用训练日的数，休息那天用休息日的数。</div></div>";

  h += '<div class="sec"><div class="sec-t">记录</div><div class="card">';
  h += '<div class="row" data-act="togRir"><div class="rl"><div class="rt">显示 RIR 列</div>' +
    '<div class="rs">RIR = 这组做完还能再做几次。不填也行，默认关</div></div>' +
    '<span class="chev" id="rirState" style="font-size:14px;color:' +
    (s.showRir ? "var(--blue)" : "var(--tx3)") + '">' + (s.showRir ? "开" : "关") + "</span></div>";
  h += "</div></div>";

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
    else if (a === "togRir") {
      /* 立刻生效、立刻保存，不用等「保存」——顺手就把这一行的字改了，
         省得重开整个弹层（那样会把你没保存的输入冲掉）。 */
      s.showRir = !s.showRir;
      var el = $("#rirState");
      if (el) {
        el.textContent = s.showRir ? "开" : "关";
        el.style.color = s.showRir ? "var(--blue)" : "var(--tx3)";
      }
      save("settings");
    }
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
