/*
 * main.js —— 前端入口（真实数据版 v0.7.0）
 *
 * 数据来自 /api/*（真实粮食价格，日频/月频），不再是模拟数据。
 *
 * 保留的「不闪动刷新」机制（见技能 live-dashboard-refresh）：
 *   ① 键控增量渲染 reconcile()  —— key 相同的行复用同一个 DOM 节点
 *   ② 图表数据签名              —— 数据没变则一次 setOption 都不调用
 *   ③ 数字滚动仅在值确实变化时触发 + rAF 配 setTimeout 兜底
 * 刷新间隔已改为 30 分钟：真实数据是日频，秒级轮询毫无意义。
 *
 * v0.7.0 新增「窄屏 / 微信」双模式：
 *   宽屏（>900px）沿用 1920×1080 定尺舞台整体缩放；
 *   窄屏（≤900px，含手机与微信内置浏览器）改走响应式单列布局，
 *   此时 fit() 必须放弃缩放，否则 30px 的标题会被缩到 6px 无法阅读。
 *   模式判定与 style.css 的 @media 用同一个阈值，两侧不允许各自为政。
 */
(function () {
  "use strict";

  /* ============================================================
     常量
     ============================================================ */

  var DESIGN_W = 1920;
  var DESIGN_H = 1080;

  /* 窄屏阈值：必须与 style.css 中 @media (max-width: 900px) 完全一致。
     两边一旦不一致，就会出现「CSS 已切成单列、JS 还在写 transform: scale()」的错乱。 */
  var NARROW_QUERY = "(max-width: 900px)";

  var GRAINS = ["高粱", "大米", "糯米", "小麦", "玉米"];

  var ROLL_MS = 720;                    // 数字滚动时长
  var FLASH_MS = 900;                   // 数值变动闪动时长
  var REFRESH_MS = 30 * 60 * 1000;      // 刷新间隔：30 分钟（真实数据为日频）
  var HEAVY_EVERY = 4;                  // 每 4 轮重取一次对比表/来源表

  /* ============================================================
     全局命名空间
     ============================================================ */

  window.WL = window.WL || {};

  WL.version = "0.8.0";
  WL.stage = 8;
  WL.scale = 1;
  WL.static = false;                    // ?static=1 时为 true：关闭全部动效与轮询

  /* 窄屏 / 微信：对外暴露成函数而非布尔值——窗口尺寸会在旋转、拖拽窗口时变化，
     缓存成布尔值必然过期。图表模块也用它们决定字号与边距。 */
  WL.isNarrow = isNarrow;
  WL.isWechat = isWechat;

  WL.state = {
    activeGrain: "大米",
    refreshMs: REFRESH_MS,
    dataDate: null,                     // 最新数据日期
    fetchedAt: null,                    // 取数时间
    overview: null,
    sources: null,
    lastAnalysis: null,                 // 最近一次单粮分析响应：跨模式重绘图表时复用，避免再请求
    timer: null,
    busy: false,
    rounds: 0,
    refreshCount: 0,
    narrow: false                       // 上一轮的模式，用于识别「跨过阈值」这一事件
  };

  /** 滚动类列表的「记录序列签名」：不变则完全不碰 DOM，轮播动画才不会被打断 */
  var newsSig = null;
  var tickerSig = null;

  /** 正在滚动中的数字节点（用于页面切后台时立即落值） */
  var ROLLING = [];

  function rollStop(node) {
    var i = ROLLING.indexOf(node);
    if (i >= 0) ROLLING.splice(i, 1);
  }

  /** 把所有在滚的数字立刻落到终值——切后台时调用，避免停在中途的假数字 */
  function rollFlush() {
    ROLLING.slice().forEach(function (node) {
      if (node.__raf) { cancelAnimationFrame(node.__raf); node.__raf = null; }
      clearTimeout(node.__rollT);
      if (node.__num !== undefined) {
        var d = (node.__d === undefined) ? 2 : node.__d;
        textHead(node).nodeValue = node.__num.toFixed(d);
      }
      rollStop(node);
    });
  }

  /* ============================================================
     小工具
     ============================================================ */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function setText(id, text) {
    var n = $(id);
    if (n) n.textContent = text;
  }

  function txt(id) {
    var n = $(id);
    return n ? n.textContent.trim() : null;
  }

  /**
   * 取元素开头的文本节点（必要时创建）。
   * 用于「只改数字、保留其后的 <small>元/斤</small>」——用 nodeValue 而非 innerHTML，
   * 既不会重置同级子元素，也没有任何注入风险。
   */
  function textHead(node) {
    var c = node.firstChild;
    if (c && c.nodeType === 3) return c;
    var t = document.createTextNode("");
    node.insertBefore(t, node.firstChild);
    return t;
  }

  /**
   * 数字滚动。关键约束：**只在数值确实发生变化时触发**。
   * 真实数据是日频，绝大多数刷新里数字是不变的；无条件重播会让整屏每轮跳一次。
   * @returns {boolean} 本次是否真的变化（调用方据此决定要不要闪动）
   */
  function rollTo(node, value, digits) {
    if (!node) return false;
    var to = Number(value);
    if (!isFinite(to)) return false;

    var d = (digits === undefined) ? 2 : digits;
    var first = (node.__num === undefined);
    var from = first ? 0 : node.__num;
    var eps = 0.5 * Math.pow(10, -d);
    var changed = first || Math.abs(from - to) >= eps;

    node.__num = to;
    node.__d = d;
    var head = textHead(node);

    if (WL.static || !changed) {
      if (changed) head.nodeValue = to.toFixed(d);
      return changed;
    }

    if (ROLLING.indexOf(node) < 0) ROLLING.push(node);
    if (node.__raf) cancelAnimationFrame(node.__raf);
    clearTimeout(node.__rollT);

    var t0 = null;
    (function step(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / ROLL_MS);
      var e = 1 - Math.pow(1 - p, 3);
      head.nodeValue = (from + (to - from) * e).toFixed(d);
      if (p < 1) {
        node.__raf = requestAnimationFrame(step);
      } else {
        node.__raf = null;
        clearTimeout(node.__rollT);
        head.nodeValue = to.toFixed(d);
        rollStop(node);
      }
    })(t0 = performance.now());

    /*
     * 兜底：rAF 在页面切后台、被节流或被虚拟时钟挂起时会停止回调，
     * 数字会永久停在中间帧上——屏幕上就是一个"不对的数"。
     */
    node.__rollT = setTimeout(function () {
      if (node.__raf) { cancelAnimationFrame(node.__raf); node.__raf = null; }
      head.nodeValue = to.toFixed(d);
      rollStop(node);
    }, ROLL_MS + 60);

    return true;
  }

  function flash(node) {
    if (!node || WL.static) return;
    node.classList.remove("is-flash");
    void node.offsetWidth;               // 强制重排，同一段动画才能被重复触发
    node.classList.add("is-flash");
    clearTimeout(node.__flashT);
    node.__flashT = setTimeout(function () {
      node.classList.remove("is-flash");
    }, FLASH_MS);
  }

  function rollFlash(id, value, digits) {
    var n = $(id);
    if (rollTo(n, value, digits)) flash(n);
  }

  function rollFlashNode(node, value, digits) {
    if (rollTo(node, value, digits)) flash(node);
  }

  /** 涨跌方向：>0.005% 判涨，<-0.005% 判跌，其间视为持平 */
  function dirCls(v) {
    var x = Number(v) || 0;
    if (x > 0.005) return "is-up";
    if (x < -0.005) return "is-down";
    return "is-flat";
  }

  /** 涨跌文案，如「▲ 0.51%」「▼ 1.70%」「— 0.00%」 */
  function chgText(v) {
    var x = Number(v) || 0;
    if (x > 0.005) return "▲ " + x.toFixed(2) + "%";
    if (x < -0.005) return "▼ " + Math.abs(x).toFixed(2) + "%";
    return "— 0.00%";
  }

  /** 频率中文 */
  function freqLabel(f) {
    return f === "D" ? "日频" : (f === "M" ? "月频" : (f || ""));
  }

  /* ============================================================
     运行模式判定：宽屏（定尺缩放大屏） / 窄屏（手机·微信，流式单列）
     ============================================================ */

  /** 是否处于窄屏模式。
      判定源是媒体查询本身，与 style.css 的 @media 同源同阈值——
      JS 若另算一套（比如用 innerWidth < 768），迟早会和 CSS 对不上。 */
  function isNarrow() {
    if (window.matchMedia) return window.matchMedia(NARROW_QUERY).matches;
    return window.innerWidth <= 900;
  }

  /** 是否微信内置浏览器：Android 走 X5 内核、iOS 走 WKWebView，UA 里都会带 MicroMessenger */
  function isWechat() {
    return /MicroMessenger/i.test(navigator.userAgent || "");
  }

  /** 把当前模式写到 body 上，供样式与自检读取 */
  function syncModeClass() {
    var n = isNarrow();
    document.body.classList.toggle("is-narrow", n);
    document.body.classList.toggle("is-wechat", isWechat());
    WL.state.narrow = n;
    return n;
  }

  /* ============================================================
     等比缩放：把 1920×1080 舞台塞进任意窗口，多余区域居中留白
     窄屏模式下不缩放，布局交给 CSS 媒体查询（见 style.css）
     ============================================================ */
  function fit() {
    var stage = $("stage");
    if (!stage) return;

    if (isNarrow()) {
      /* 必须显式清掉内联 transform：内联样式优先级高于媒体查询里的 CSS，
         不清掉就会「CSS 已经切成单列流式布局，却还被整体缩放成一个指甲盖大」。 */
      stage.style.transform = "none";
      WL.scale = 1;
      return;
    }

    var s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    var tx = (window.innerWidth - DESIGN_W * s) / 2;
    var ty = (window.innerHeight - DESIGN_H * s) / 2;
    stage.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
    WL.scale = s;
  }

  /* ============================================================
     加载态：用计数而非布尔值，避免并发操作互相把加载态关掉
     （类名用 is-busy 而非 is-loading——后者在样式表里已被占用为「文字弱化色」）
     ============================================================ */
  var loadingCount = 0;

  function pushLoading() {
    loadingCount++;
    document.body.classList.add("is-busy");
  }

  function popLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) document.body.classList.remove("is-busy");
  }

  /* ------------------------------------------------------------
     静态快照取数
     ------------------------------------------------------------
     快照版页面（发布在资料库，供微信内打开）没有后端，数据在构建时
     固化进 window.__SNAPSHOT__。这里按接口路径把数据取出来，命中即零请求。
     取不到时若确知是快照版，宁可明确报错也不发请求 —— 否则只会在控制台
     刷出一堆 404，把真正的错误盖掉。
     ------------------------------------------------------------ */
  function snapPick(path) {
    var s = window.__SNAPSHOT__;
    if (!s) return null;
    var m;

    if (path.indexOf("/api/overview") === 0) return s.overview || null;
    if (path.indexOf("/api/compare") === 0) return s.compare || null;
    if (path.indexOf("/api/sources") === 0) return s.sources || null;

    if (path.indexOf("/api/movers") === 0) {
      var mv = s.movers;
      if (!mv) return null;
      m = path.match(/limit=(\d+)/);
      var lim = m ? parseInt(m[1], 10) : 8;
      // 快照存的是完整榜单，按调用方要的条数截断
      return {
        up: (mv.up || []).slice(0, lim),
        down: (mv.down || []).slice(0, lim),
        total: mv.total,
        unit: mv.unit,
        meta: mv.meta
      };
    }

    m = path.match(/^\/api\/grain\/([^/]+)\/analysis/);
    if (m) {
      var name = decodeURIComponent(m[1]);
      return (s.analysis && s.analysis[name]) || null;
    }
    return null;
  }

  /** 当前是否跑在快照版（数据已固化，无后端可请求） */
  WL.snapshot = function () { return !!window.__SNAPSHOT__; };

  /* ============================================================
     接口请求封装
     服务端统一返回 { code, msg, data }，HTTP 状态恒为 200，
     因此前端只需判断 code，不必区分网络错误 / HTTP 错误 / 业务错误三套分支。
     ============================================================ */
  WL.api = function (path) {
    var snap = snapPick(path);
    if (snap) return Promise.resolve(snap);          // 快照命中：零请求

    if (window.__SNAPSHOT__) {                       // 快照版却没有该数据：当作明确错误
      return Promise.reject(new Error("快照中缺少该接口数据：" + path));
    }

    return fetch(path, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json.code !== 0) throw new Error(json.msg || ("接口返回 code=" + json.code));
        return json.data;
      });
  };

  /* ============================================================
     键控列表增量渲染
     ============================================================ */

  var LISTS = {};

  /**
   * 增量渲染一个列表：key 相同的节点复用，只更新内容；成员或顺序变化时才动 DOM 结构。
   * 用 innerHTML 整块重建的话，CSS transition 永远播不出来（新节点没有"旧值"），
   * 轮播动画也会每轮被打断——这是"整屏反复闪动"最常见的根因。
   */
  function reconcile(boxId, items, keyOf, build, paint) {
    var box = $(boxId);
    if (!box) return;
    var st = LISTS[boxId] || (LISTS[boxId] = { map: {}, order: "" });

    var keys = [];
    items.forEach(function (it) {
      var k = String(keyOf(it));
      keys.push(k);
      if (!st.map[k]) st.map[k] = build(it);
      paint(st.map[k], it);
    });

    var order = keys.join("|");
    if (order === st.order) return;      // 成员与顺序都没变：不做任何结构操作

    var keep = {};
    keys.forEach(function (k) { keep[k] = true; });
    Object.keys(st.map).forEach(function (k) {
      if (!keep[k]) {
        if (st.map[k].parentNode) st.map[k].parentNode.removeChild(st.map[k]);
        delete st.map[k];
      }
    });
    // appendChild 对已有子节点是「移动」而非「重建」，节点身份与动画状态都保留
    keys.forEach(function (k) { box.appendChild(st.map[k]); });
    st.order = order;
  }

  /** 记录序列签名：用于滚动/轮播类列表，不变则完全不碰 DOM */
  function seqSig(name, rows) {
    var s = rows.map(function (r) {
      return Object.keys(r).map(function (k) { return r[k]; }).join("~");
    }).join("||");
    if (SEQ[name] === s) return false;
    SEQ[name] = s;
    return true;
  }
  var SEQ = {};

  /* ============================================================
     渲染：核心指标条
     ============================================================ */

  function renderKpi(ov) {
    var k = ov.kpi;

    setText("kpi-avg-label", "五粮均价");
    setText("kpi-max-label", "最高价 · " + (k.max_price ? k.max_price.grain : "—"));
    setText("kpi-min-label", "最低价 · " + (k.min_price ? k.min_price.grain : "—"));

    rollFlash("kpi-avg", k.avg_price, 2);
    rollFlash("kpi-max", k.max_price ? k.max_price.value : NaN, 2);
    rollFlash("kpi-min", k.min_price ? k.min_price.value : NaN, 2);

    setText("kpi-grains", String(k.grain_count));
    setText("kpi-grades", String(k.grade_count));
    setText("kpi-move", k.up_count + " / " + k.down_count);

    var dnode = $("kpi-date");
    setText("kpi-date", k.latest_date || "--");
    if (dnode) dnode.classList.add("kpi__value--date");
  }

  /* ============================================================
     渲染：五粮分等级卡片
     ============================================================ */

  function gradeRow(g) {
    var row = el("span", "grow");
    row.appendChild(el("span", "grow__name", g.grade));
    row.appendChild(el("span", "grow__val", "--"));
    row.appendChild(el("span", "grow__chg is-flat", "--"));
    return row;
  }

  function paintGradeRow(row, g) {
    var v = row.children[1];
    var c = row.children[2];
    if (g.price === null || g.price === undefined) {
      v.textContent = "—";
      c.textContent = "取数失败";
      c.className = "grow__chg is-flat";
      row.title = g.error || "该档位暂无数据";
      return;
    }
    rollTo(v, g.price, 2);
    c.textContent = chgText(g.change_pct);
    c.className = "grow__chg " + dirCls(g.change_pct);
    row.title = g.grade + "　" + g.source + "　" + g.date
      + "　原始值 " + (g.raw_value === null ? "—" : g.raw_value) + " " + g.raw_unit;
  }

  function renderCards(grains) {
    grains.forEach(function (g) {
      var card = document.querySelector('.gcard[data-grain="' + g.name + '"]');
      if (!card) return;

      // 代表价：卡片主行
      var bnode = card.querySelector(".gcard__price b");
      if (bnode) rollFlashNode(bnode, g.price, 2);

      var cnode = card.querySelector(".gcard__chg");
      if (cnode) {
        cnode.textContent = chgText(g.change_pct);
        cnode.className = "gcard__chg " + dirCls(g.change_pct);
      }
      card.title = g.name + "　代表规格：" + (g.rep_grade || "—")
        + "　" + (g.source || "") + "　" + (g.date || "");

      // 分等级明细：键控增量渲染，key = 等级名
      reconcile("grades-" + g.name, g.grades || [],
        function (x) { return x.grade; },
        gradeRow, paintGradeRow);
    });
    updateActive();
  }

  function updateActive() {
    var list = document.querySelectorAll(".gcard");
    for (var i = 0; i < list.length; i++) {
      var on = list[i].getAttribute("data-grain") === WL.state.activeGrain;
      list[i].classList.toggle("is-active", on);
      list[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    setText("trend-grain", WL.state.activeGrain);
    setText("spread-grain", WL.state.activeGrain);
  }

  /* ============================================================
     渲染：涨跌榜
     ============================================================ */

  function barRow() {
    var li = el("li", "bar-item");
    li.appendChild(el("span", "bar-item__name", "--"));
    var track = el("span", "bar-item__track");
    var fill = el("span", "bar-item__fill");
    track.appendChild(fill);
    li.appendChild(track);
    li.appendChild(el("span", "bar-item__val", "--"));
    return li;
  }

  function paintBarRow(li, r) {
    li.children[0].textContent = r.grain + " · " + r.grade;
    var fill = li.children[1].firstChild;
    // 条形长度按涨跌幅绝对值归一（上限 1.5%），方向用颜色区分
    var mag = Math.min(Math.abs(r.change_pct || 0) / 1.5, 1);
    var w = Math.max(2, mag * 100);
    fill.style.width = w.toFixed(1) + "%";
    fill.className = "bar-item__fill " + dirCls(r.change_pct);
    li.children[2].textContent = chgText(r.change_pct);
    li.children[2].className = "bar-item__val " + dirCls(r.change_pct);
    li.title = r.source + " · " + r.date + " · " + freqLabel(r.freq);
  }

  function renderUpdown(mv) {
    var rows = (mv.up || []).concat(mv.down || []);
    // 按涨跌幅从高到低排，涨的在前
    rows.sort(function (a, b) { return (b.change_pct || 0) - (a.change_pct || 0); });
    rows = rows.slice(0, 8);
    reconcile("updown-list", rows,
      function (r) { return r.grain + "|" + r.grade; },
      barRow, paintBarRow);
  }

  /* ============================================================
     渲染：各档价格对比
     ============================================================ */

  function rankRow() {
    var li = el("li", "rank-row");
    li.appendChild(el("span", "rank-row__no", "--"));
    li.appendChild(el("span", "rank-row__name", "--"));
    var val = el("span", "rank-row__val", "--");
    val.appendChild(el("i", null, "元/斤"));
    li.appendChild(val);
    var bg = el("span", "rank-row__bg");
    li.appendChild(bg);
    return li;
  }

  function paintRankRow(li, r) {
    li.children[0].textContent = r.rank;
    li.children[1].textContent = r.grain + " · " + r.grade;
    // 只改数字、保留后面的「元/斤」小字
    var val = li.children[2];
    var head = val.firstChild && val.firstChild.nodeType === 3
      ? val.firstChild : val.insertBefore(document.createTextNode(""), val.firstChild);
    head.nodeValue = Number(r.price).toFixed(2);
    li.children[3].style.width = r.pct.toFixed(1) + "%";
    li.title = r.source + " · " + r.date + " · " + freqLabel(r.freq);
  }

  function renderCompare(cmp) {
    var rows = (cmp.list || []).slice(0, 10).map(function (r, i) {
      return { rank: i + 1, grain: r.grain, grade: r.grade, price: r.price,
               pct: r.price / (cmp.list[0].price || 1) * 100,
               source: r.source, date: r.date, freq: r.freq };
    });
    reconcile("rank-price", rows,
      function (r) { return r.grain + "|" + r.grade; },
      rankRow, paintRankRow);
  }

  /* ============================================================
     渲染：数据来源与更新（滚动列表）+ 底部 ticker
     ============================================================ */

  function newsRow() {
    var d = el("div", "news-row");
    d.appendChild(el("span", "news-row__time", "--"));
    d.appendChild(el("span", "news-row__title", "--"));
    d.appendChild(el("span", "news-row__val", "--"));
    return d;
  }

  function newsRowData(r) {
    return {
      k: r.grain + "|" + r.grade,
      date: (r.date || "--").slice(5),
      title: r.grain + " · " + r.grade + "　" + r.source + "（" + r.freq_label + "）",
      val: r.price === null ? "—" : Number(r.price).toFixed(2) + " 元/斤"
    };
  }

  function renderSources(src) {
    var rows = (src.list || []).map(newsRowData);
    if (seqSig("news", rows)) {
      reconcile("news-track", rows, function (r) { return r.k; }, newsRow, function (d, r) {
        d.children[0].textContent = r.date;
        d.children[1].textContent = r.title;
        d.children[2].textContent = r.val;
      });
      // 轮播需要双份数据首尾衔接才能无缝
      var box = $("news-track");
      if (box && box.children.length && !box.dataset.duped) {
        Array.prototype.slice.call(box.children).forEach(function (n) {
          box.appendChild(n.cloneNode(true));
        });
        box.dataset.duped = "1";
      }
    }
    setText("sources-summary", src.ok_count + "/" + src.total + " 条可取数");

    var tk = (src.list || []).map(function (r) {
      return { k: r.grain + "|" + r.grade,
               text: r.grain + " " + r.grade + "：" + (r.price === null ? "—" : Number(r.price).toFixed(2) + " 元/斤")
                     + "（" + r.source + "，更新至 " + (r.date || "—") + "）" };
    });
    if (seqSig("ticker", tk)) {
      var track = $("ticker-track");
      if (track) {
        track.innerHTML = "";
        var frag = document.createDocumentFragment();
        // 两遍，保证横向滚动无缝
        for (var pass = 0; pass < 2; pass++) {
          tk.forEach(function (t) {
            frag.appendChild(el("span", "ticker__item", t.text));
          });
        }
        track.appendChild(frag);
      }
    }
  }

  /* ============================================================
     渲染：数据状态标注（诚实性要求：页面必须显示数据日期与频率）
     ============================================================ */

  function renderMeta(meta) {
    var freqs = {};
    (WL.state.overview && WL.state.overview.grains || []).forEach(function (g) {
      (g.grades || []).forEach(function (x) { freqs[freqLabel(x.freq)] = true; });
    });
    var fl = Object.keys(freqs).join(" / ") || "日频 / 月频";
    setText("data-badge", fl);
    setText("maker-date", meta.latest_date || "--");
    setText("trend-freq", fl);
    var fm = $("footer-meta");
    if (fm) {
      fm.textContent = "均价口径：" + (meta.avg_basis || "—")
        + "　·　涨跌幅口径：" + (meta.change_basis || "—")
        + "　·　取数时间 " + (meta.fetched_at || "—");
    }
  }

  /* ============================================================
     取数
     ============================================================ */

  function loadHeavy() {
    return Promise.all([
      WL.api("/api/compare"),
      WL.api("/api/sources")
    ]).then(function (res) {
      renderCompare(res[0]);
      WL.state.sources = res[1];
      renderSources(res[1]);
    });
  }

  /** 用最近一次接口数据重绘两个图表，不触网。
      用途：跨过窄屏/宽屏阈值时图表的字号、边距、图例位置要换一套参数，
      必须带 force 重绘；为此再发一次请求既慢又没必要。 */
  function repaintCharts(force) {
    var a = WL.state.lastAnalysis;
    if (!a || !WL.charts) return;
    WL.charts.updateSpread(a, force);
    WL.charts.updateTrend({
      grain: a.grain,
      days: (a.trend.series[0] ? a.trend.series[0].points.length : 0),
      series: a.trend.series
    }, force);
  }

  function loadActiveGrain(force) {
    return WL.api("/api/grain/" + encodeURIComponent(WL.state.activeGrain) + "/analysis")
      .then(function (a) {
        WL.state.lastAnalysis = a;      // 存下来，供模式切换时免请求重绘
        repaintCharts(force);
        var pts = a.trend.series[0] ? a.trend.series[0].points.length : 0;
        setText("trend-days", pts);
        setText("spread-stat", a.spread && a.spread.pct !== null
          ? "价差 " + a.spread.value.toFixed(2) + " 元/斤（" + a.spread.pct.toFixed(2) + "%）" : "单一规格");
        var note = $("spread-note");
        if (note && a.spread) note.textContent = a.spread.note;
        var summary = a.grades.filter(function (g) { return g.price !== null; })
          .map(function (g) { return g.grade + " " + g.price.toFixed(2); }).join("　·　");
        setText("trend-summary", summary);
      })
      .catch(function (err) {
        console.error("[五粮大屏] 载入「" + WL.state.activeGrain + "」失败：", err.message);
      });
  }

  function loadAll() {
    return WL.api("/api/overview").then(function (ov) {
      WL.state.overview = ov;
      WL.state.dataDate = ov.kpi.latest_date;
      WL.state.fetchedAt = ov.kpi.fetched_at;
      renderKpi(ov);
      renderCards(ov.grains || []);
      renderMeta(ov.meta || {});
      return WL.api("/api/movers?limit=8");
    }).then(function (mv) {
      renderUpdown(mv);
      return loadHeavy();
    }).then(function () {
      return loadActiveGrain(true);
    });
  }

  /* ============================================================
     刷新
     只重取「会变」的数据：核心指标 + 五粮分等级价格 + 涨跌榜。
     对比表/来源表变化慢，每 HEAVY_EVERY 轮兜底重取一次。
     ============================================================ */
  function refresh() {
    if (WL.state.busy) return Promise.resolve();
    WL.state.rounds++;
    WL.state.refreshCount++;

    return WL.api("/api/overview").then(function (ov) {
      WL.state.overview = ov;
      WL.state.dataDate = ov.kpi.latest_date;
      renderKpi(ov);
      renderCards(ov.grains || []);
      renderMeta(ov.meta || {});
      var jobs = [WL.api("/api/movers?limit=8").then(renderUpdown), loadActiveGrain(false)];
      if (WL.state.rounds % HEAVY_EVERY === 0) jobs.push(loadHeavy());
      return Promise.all(jobs);
    });
  }

  /* ============================================================
     定时器：页面不可见时暂停，恢复时立刻补一次
     ============================================================ */
  function stopTimer() {
    if (WL.state.timer) {
      clearInterval(WL.state.timer);
      WL.state.timer = null;
    }
  }

  function startTimer() {
    stopTimer();
    if (WL.static) return;              // 静态模式不轮询：截图与快照必须可复现
    if (WL.snapshot()) return;          // 快照版：数据是固化的，轮询只会反复重绘同一份数据
    WL.state.timer = setInterval(function () {
      refresh().catch(function (err) {
        console.error("[五粮大屏] 定时刷新失败：", err.message);
      });
    }, WL.state.refreshMs);
  }

  /* ============================================================
     切换粮食
     ============================================================ */
  function switchGrain(name) {
    if (!name || name === WL.state.activeGrain) return;
    WL.state.activeGrain = name;
    updateActive();

    var track = $("news-track");
    if (track) { track.innerHTML = ""; track.removeAttribute("data-duped"); }
    newsSig = null;

    WL.state.busy = true;
    pushLoading();
    loadActiveGrain(true)               // force：图表整幅重绘，带入场动画
      .catch(function (err) {
        console.error("[五粮大屏] 切换「" + name + "」失败：", err.message);
      })
      .then(function () {
        WL.state.busy = false;
        popLoading();
      });
  }

  /* ============================================================
     微信提示条
     只在「微信内置浏览器 + 窄屏」两个条件同时满足时出现：
     微信 PC 端视口足够宽，本来就能看到完整大屏，弹提示纯属打扰。
     ============================================================ */
  function setupWechatTip() {
    if (!(isWechat() && isNarrow())) return;

    var tip = $("wx-tip");
    if (!tip) return;

    var KEY = "wl-wx-tip-closed";
    var closed = false;
    try { closed = window.sessionStorage.getItem(KEY) === "1"; }
    catch (e) { closed = false; }        // 隐私模式 / 禁用存储：当作未关闭处理，不抛错

    if (!closed) tip.hidden = false;

    var btn = $("wx-tip-close");
    if (btn) {
      btn.addEventListener("click", function () {
        tip.hidden = true;
        try { window.sessionStorage.setItem(KEY, "1"); } catch (e) { /* 存不了就算了 */ }
      });
    }
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindEvents() {
    var box = $("gcards");
    if (box) {
      box.addEventListener("click", function (e) {
        var node = e.target;
        while (node && node !== box) {
          if (node.classList && node.classList.contains("gcard")) {
            switchGrain(node.getAttribute("data-grain"));
            return;
          }
          node = node.parentNode;
        }
      });
    }

    /* 跨过窄屏阈值（手机旋转、拖拽窗口宽度）时必须连做三件事：
       重算缩放 → 换一套图表参数重绘 → 重新量图表尺寸。
       只调 resize() 是不够的：图表的字号、边距、图例位置是按模式写死的，不重绘就仍是旧的那套。 */
    function refreshMode() {
      var before = WL.state.narrow;
      var now = syncModeClass();
      fit();
      if (now !== before) repaintCharts(true);
      if (WL.charts) WL.charts.resize();
    }

    window.addEventListener("resize", refreshMode);

    /* 横竖屏切换在部分手机浏览器里不触发 resize，必须单独监听。
       且旋转动画结束前读到的窗口尺寸还是旧值，延迟一点才是最终尺寸。 */
    window.addEventListener("orientationchange", function () {
      setTimeout(refreshMode, 260);
    });

    // 切后台停轮询（省资源，也避免回来时一次性补一堆请求）；切回前台先补一次
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        rollFlush();                    // 在滚的数字立刻落值，别让用户回来看到半截假数字
        stopTimer();
      } else {
        refresh().catch(function () { /* 单次失败不打断轮询 */ });
        startTimer();
      }
    });
  }

  /* ============================================================
     自检模式：?diag=1
     把运行期状态写进隐藏的 <pre id="diag-out">，供自动化验收脚本读取。
     正常访问完全不产生输出，也不额外消耗性能。
       ?diag=1                        读首屏状态
       ?diag=1&diag_switch=玉米,大米   程序化依次点击切换
       ?diag=1&diag_refresh=1         强制走一轮刷新并比对
       ?diag=1&diag_timer=1&diag_observe=20000   观察定时器是否真在跑
     ============================================================ */

  function snapshotState() {
    var de = document.documentElement;

    var cards = {};
    var cardList = document.querySelectorAll(".gcard");
    for (var i = 0; i < cardList.length; i++) {
      var c = cardList[i];
      var rows = [];
      var grows = c.querySelectorAll(".grow");
      for (var j = 0; j < grows.length; j++) {
        rows.push({
          grade: grows[j].children[0].textContent,
          price: grows[j].children[1].textContent,
          chg: grows[j].children[2].textContent
        });
      }
      cards[c.getAttribute("data-grain")] = {
        price: c.querySelector(".gcard__price b").textContent,
        chg: c.querySelector(".gcard__chg").textContent,
        active: c.classList.contains("is-active"),
        gradeCount: rows.length,
        grades: rows
      };
    }

    var bars = [];
    var barList = document.querySelectorAll("#updown-list .bar-item");
    for (var k = 0; k < barList.length; k++) {
      bars.push({
        name: barList[k].children[0].textContent,
        width: barList[k].children[1].firstChild.style.width,
        val: barList[k].children[2].textContent
      });
    }

    var makerNode = document.querySelector(".maker");

    /* 窄屏/微信模式的取证字段：这些是判断"到底有没有真的换成响应式布局"的直接证据，
       只看 overflowX 不够——如果只缩放不换布局，横向同样可能不溢出，但字会小到看不清。 */
    var stageNode = $("stage");
    var stageRect = stageNode ? stageNode.getBoundingClientRect() : null;
    var titleNode = document.querySelector(".topbar__title");
    var kpibarNode = document.querySelector(".kpibar");
    var wxTipNode = $("wx-tip");

    return {
      innerW: window.innerWidth, innerH: window.innerHeight,
      docW: de.scrollWidth, docH: de.scrollHeight,
      overflowX: de.scrollWidth > window.innerWidth,
      overflowY: de.scrollHeight > window.innerHeight,
      scale: Number(WL.scale.toFixed(4)),
      mode: isNarrow() ? "narrow" : "desktop",
      isNarrow: isNarrow(),
      isWechat: isWechat(),
      bodyClassNarrow: document.body.classList.contains("is-narrow"),
      stageW: stageRect ? Math.round(stageRect.width) : null,
      stageH: stageRect ? Math.round(stageRect.height) : null,
      stageTransform: stageNode ? (stageNode.style.transform || "none") : null,
      titleFontSize: titleNode ? parseFloat(window.getComputedStyle(titleNode).fontSize) : null,
      bodyFontSize: parseFloat(window.getComputedStyle(document.body).fontSize),
      kpiCols: kpibarNode ? window.getComputedStyle(kpibarNode).gridTemplateColumns.split(" ").length : null,
      wxTipVisible: !!(wxTipNode && !wxTipNode.hidden),
      grain: WL.state.activeGrain,
      dataDate: WL.state.dataDate,
      fetchedAt: WL.state.fetchedAt,
      maker: makerNode ? makerNode.textContent.trim() : null,
      kpiAvg: txt("kpi-avg"), kpiMax: txt("kpi-max"), kpiMin: txt("kpi-min"),
      kpiGrains: txt("kpi-grains"), kpiGrades: txt("kpi-grades"),
      kpiMove: txt("kpi-move"), kpiDate: txt("kpi-date"),
      trendGrain: txt("trend-grain"), spreadGrain: txt("spread-grain"),
      trendSummary: txt("trend-summary"), spreadStat: txt("spread-stat"),
      sourcesSummary: txt("sources-summary"),
      cardCount: cardList.length,
      gradeRowCount: document.querySelectorAll(".grow").length,
      updownRows: barList.length,
      rankRows: document.querySelectorAll("#rank-price .rank-row").length,
      newsRows: document.querySelectorAll("#news-track .news-row").length,
      tickerItems: document.querySelectorAll("#ticker-track .ticker__item").length,
      busy: document.body.classList.contains("is-busy"),
      refreshCount: WL.state.refreshCount,
      hasTimer: WL.state.timer !== null,
      chartsReady: !!(WL.charts && WL.charts.ready()),
      chartStats: (WL.charts && WL.charts.stats) ? WL.charts.stats() : null,
      cards: cards,
      updown: bars
    };
  }

  function collectNodes(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  function runDiag() {
    var q = window.location.search;
    var mSwitch = q.match(/diag_switch=([^&]+)/);
    var wantRefresh = q.indexOf("diag_refresh=1") >= 0;
    var mWait = q.match(/diag_wait=(\d+)/);
    var mObs = q.match(/diag_observe=(\d+)/);
    var wait = mWait ? Number(mWait[1]) : 2600;

    var out = { url: window.location.href, refreshMs: WL.state.refreshMs };

    function dump() {
      var pre = document.createElement("pre");
      pre.id = "diag-out";
      pre.style.display = "none";
      pre.textContent = "@@DIAG@@" + JSON.stringify(out) + "@@END@@";
      document.body.appendChild(pre);
    }

    setTimeout(function () {
      var newsBefore = collectNodes("#news-track .news-row");
      var barsBefore = {};
      collectNodes("#updown-list .bar-item").forEach(function (li) {
        barsBefore[li.children[0].textContent] = li;
      });
      var growBefore = collectNodes(".grow");

      out.initial = snapshotState();

      var chain = Promise.resolve();

      if (mSwitch) {
        var names = decodeURIComponent(mSwitch[1]).split(",");
        out.switchSeq = names;
        out.afterSwitch = [];
        names.forEach(function (nm) {
          chain = chain.then(function () {
            var card = document.querySelector('.gcard[data-grain="' + nm + '"]');
            if (!card) throw new Error("未找到粮食卡片：" + nm);
            card.click();
            return new Promise(function (r) { setTimeout(r, 1800); });
          }).then(function () {
            var s = snapshotState();
            s.clicked = nm;
            out.afterSwitch.push(s);
            // 顺带记录该粮种的接口真值，供"页面 = 接口"比对
            return WL.api("/api/grain/" + encodeURIComponent(nm) + "/analysis")
              .then(function (a) {
                s.apiGrades = a.grades.map(function (g) {
                  return { grade: g.grade, price: g.price };
                });
                s.apiRep = a.rep ? { grade: a.rep.grade, price: a.rep.price } : null;
              }).catch(function () { s.apiError = "接口取数失败"; });
          });
        });
      }

      if (wantRefresh) {
        chain = chain.then(function () {
          out.fetchedAtBefore = WL.state.fetchedAt;
          return refresh();
        }).then(function () {
          return new Promise(function (r) { setTimeout(r, 1200); });
        }).then(function () {
          out.fetchedAtAfter = WL.state.fetchedAt;
          out.dataChanged = out.fetchedAtBefore !== out.fetchedAtAfter;
          out.afterRefresh = snapshotState();
          var newsAfter = collectNodes("#news-track .news-row");
          out.newsNodesReused = newsBefore.length > 0
            && newsBefore.length === newsAfter.length
            && newsBefore.every(function (n, i) { return n === newsAfter[i]; });
          var barsAfter = {};
          collectNodes("#updown-list .bar-item").forEach(function (li) {
            barsAfter[li.children[0].textContent] = li;
          });
          out.updownNodesReused = Object.keys(barsBefore).every(function (k) {
            return barsAfter[k] === barsBefore[k];
          });
          var growAfter = collectNodes(".grow");
          out.growNodesReused = growBefore.length > 0
            && growBefore.length === growAfter.length
            && growBefore.every(function (n, i) { return n === growAfter[i]; });
        });
      }

      if (mObs) {
        chain = chain.then(function () {
          out.observeMs = Number(mObs[1]);
          out.refreshCountBefore = WL.state.refreshCount;
          return new Promise(function (r) { setTimeout(r, out.observeMs); });
        }).then(function () {
          out.refreshCountAfter = WL.state.refreshCount;
          out.afterObserve = snapshotState();
        });
      }

      chain.then(dump, function (e) {
        out.error = String((e && e.message) || e);
        dump();
      });
    }, wait);
  }

  /* ============================================================
     启动
     ============================================================ */
  function init() {
    var isDiag = window.location.search.indexOf("diag=1") >= 0;

    // ?static=1：关闭全部过渡/轮播动画与定时刷新，用于截图验收与数据快照
    if (window.location.search.indexOf("static=1") >= 0) {
      document.body.classList.add("is-static");
      WL.static = true;
    }

    // ?grain=玉米：指定初始选中粮食
    var m = window.location.search.match(/grain=([^&]+)/);
    if (m) {
      var q = decodeURIComponent(m[1]);
      if (GRAINS.indexOf(q) >= 0) WL.state.activeGrain = q;
    }

    syncModeClass();                    // 先把宽屏/窄屏/微信写进 body，fit() 与图表都要读
    fit();
    bindEvents();
    updateActive();
    setupWechatTip();

    // 图表实例：必须在本函数加好 .is-static 之后再初始化，静态模式的动画开关才生效
    if (WL.charts) WL.charts.init();

    pushLoading();
    loadAll()
      .then(function () {
        console.log("[五粮大屏] 真实数据版加载完成 " + WL.version
          + "　模式：" + (isNarrow() ? "窄屏（流式单列）" : "宽屏（定尺缩放）")
          + (isWechat() ? "·微信" : "")
          + "　默认粮食：" + WL.state.activeGrain
          + "　缩放比：" + WL.scale.toFixed(3)
          + "　数据日期：" + WL.state.dataDate
          + "　刷新间隔：" + (WL.static ? "静态模式（不轮询）" : (WL.state.refreshMs / 60000) + " 分钟"));
      })
      .catch(function (err) {
        console.error("[五粮大屏] 加载失败：", err.message);
      })
      .then(function () {
        popLoading();
        if (isDiag) {
          runDiag();
          if (window.location.search.indexOf("diag_timer=1") >= 0) startTimer();
        } else {
          startTimer();
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
