/*
 * charts.js —— 图表模块（真实数据版）
 *
 * 两张图：
 *   1) chart-trend  各等级价格趋势（多线，真实日频/月频序列）
 *   2) chart-spread 等级价差（同一粮种内各等级单价横向条形）
 *
 * 原「中国地图」已移除：分省真实价格指标零星且不一致（多省只有产量没有价格、
 * 糯米完全没有分省价格），硬画会得到"31 省只点亮 5 个"的误导性画面。
 *
 * 关键约束（沿用不闪动刷新的做法）：
 *   每张图都有数据签名，签名不变时一次 setOption 都不调用 —— 这样定时刷新才不会闪。
 *
 * 窄屏（手机 / 微信内置浏览器）：画布从约 1100px 缩到约 350px，
 * 字号、边距、图例、色条宽度都要另配一套，否则标签会互相压叠。
 * 判定统一向 main.js 的 WL.isNarrow() 取，不在这里另算阈值。
 */
(function () {
  "use strict";

  window.WL = window.WL || {};

  /* 等级配色：同一粮种内各等级按顺序取色（浅底深字主题） */
  var GRADE_COLORS = ["#1E6FEB", "#2E9BFF", "#38C6F4", "#7C93B0", "#A8B8CC"];

  var STATIC = window.location.search.indexOf("static=1") >= 0;

  var inst = { trend: null, spread: null };
  var lastSig = { trend: "", spread: "" };

  /**
   * 渲染计数：供 ?diag=1 自检读取。
   * 「刷新时 render 不增、skip 递增」是「数据没变就不动图表、因此不会闪」的硬证据。
   */
  var stats = { trendRender: 0, trendSkip: 0, spreadRender: 0, spreadSkip: 0 };

  function $(id) { return document.getElementById(id); }

  /** 动画时长：静态模式下统一归零，保证截图与快照可复现 */
  function anim(ms) { return STATIC ? 0 : ms; }

  /**
   * 图表分辨率补偿：舞台是 1920×1080 再整体 transform: scale(s) 显示，
   * canvas 若按 1:1 渲染，缩小屏幕上会发虚、放大屏幕上会糊。
   */
  function chartDpr() {
    var base = window.devicePixelRatio || 1;
    var s = (window.WL && WL.scale) || 1;
    var d = base * s;
    return Math.max(1, Math.min(3, d));
  }

  function tipBox() {
    return {
      backgroundColor: "rgba(255,255,255,0.97)",
      borderColor: "#D8E2F0",
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: "#1B2A41", fontSize: 12 },
      extraCssText: "box-shadow:0 4px 16px rgba(20,40,80,.12);border-radius:8px;"
    };
  }

  var AXIS_LINE = { lineStyle: { color: "#DCE5F0" } };
  var SPLIT_LINE = { lineStyle: { color: "#EEF3F9", type: "dashed" } };

  /** 窄屏判定：向 main.js 取，保持「单一事实源」——不在这里另算一套窗口宽度阈值 */
  function MOBILE() {
    return !!(window.WL && window.WL.isNarrow && window.WL.isNarrow());
  }

  /** 坐标轴文字样式。手机画布窄（约 350px），字号必须跟着降，
      否则类目轴标签会互相压叠、糊成一团。
      每次返回**新对象**而不是共用常量：ECharts 内部会改写传入的样式对象，
      共用一份会出现"改了趋势图、价差图跟着变"的隐性串味。 */
  function axisLabel(extra) {
    var o = { color: "#61758F", fontSize: MOBILE() ? 10 : 11 };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      }
    }
    return o;
  }

  /* ============================================================
     数据签名 —— 铁律：数据没变就不 setOption
     ============================================================ */

  function sigTrend(t) {
    if (!t || !t.series) return "";
    var s = t.grain.name + "|" + t.days;
    t.series.forEach(function (x) {
      s += "|" + x.grade + ":" + x.points.length;
      var last = x.points[x.points.length - 1];
      s += ":" + (last ? last.date + "=" + last.price : "none");
    });
    return s;
  }

  function sigSpread(a) {
    if (!a || !a.grades) return "";
    var s = a.grain.name;
    a.grades.forEach(function (g) { s += "|" + g.grade + "=" + g.price; });
    return s;
  }

  /* ============================================================
     图 1：各等级价格趋势
     ============================================================ */

  function buildTrendOption(t) {
    // 各等级的数据点日期可能不一致（日频 vs 月频），用全部日期的并集做类目轴
    var dateSet = {};
    t.series.forEach(function (x) {
      (x.points || []).forEach(function (p) { dateSet[p.date] = true; });
    });
    var dates = Object.keys(dateSet).sort();
    var mob = MOBILE();

    var series = t.series.map(function (x, i) {
      var map = {};
      (x.points || []).forEach(function (p) { map[p.date] = p.price; });
      return {
        name: x.grade,
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: mob ? 4 : 5,
        showSymbol: dates.length <= (mob ? 30 : 40),
        connectNulls: false,          // 月频数据在日轴上不连线，避免视觉上假装"每天都有数"
        lineStyle: { width: 2, color: GRADE_COLORS[i % GRADE_COLORS.length] },
        itemStyle: { color: GRADE_COLORS[i % GRADE_COLORS.length] },
        areaStyle: t.series.length === 1
          ? { opacity: 0.12, color: GRADE_COLORS[0] } : null,
        data: dates.map(function (d) {
          return map[d] === undefined ? null : map[d];
        })
      };
    });

    return {
      animationDuration: anim(700),
      animationDurationUpdate: anim(650),
      animationEasing: "cubicOut",
      animationEasingUpdate: "cubicOut",
      // 窄屏：左侧留白收窄（省给曲线本身），顶部留宽一点给换行后的图例
      grid: mob
        ? { left: 40, right: 10, top: 40, bottom: 24 }
        : { left: 52, right: 18, top: 34, bottom: 28 },
      tooltip: (function () {
        var o = tipBox();
        o.trigger = "axis";
        o.valueFormatter = function (v) {
          return (v === null || v === undefined) ? "无数据" : Number(v).toFixed(2) + " 元/斤";
        };
        return o;
      })(),
      legend: (function () {
        var o = {
          top: 2, right: 6, icon: "roundRect",
          itemWidth: 10, itemHeight: 8, itemGap: 12,
          textStyle: { color: "#61758F", fontSize: mob ? 10 : 11 }
        };
        if (mob) {
          // 窄屏图例平分整行并开启滚动：等级多的粮种（大米 3 档）在手机上一行放不下，
          // 不设 scroll 会被静默截断，用户以为"少画了一条线"。
          o.left = 0; o.right = 0; o.type = "scroll";
          o.itemGap = 8; o.textStyle.fontSize = 10;
        }
        return o;
      })(),
      xAxis: {
        type: "category",
        data: dates.map(function (d) { return String(d).slice(5); }),
        boundaryGap: false,
        axisLine: AXIS_LINE,
        axisTick: { show: false },
        axisLabel: (function () {
          var a = axisLabel();
          a.hideOverlap = true;
          return a;
        })()
      },
      yAxis: {
        type: "value",
        name: "元/斤",
        nameTextStyle: { color: "#8A9AB0", fontSize: mob ? 10 : 11 },
        scale: true,                  // 价格波动小，不从 0 起，否则看不出变化
        splitLine: SPLIT_LINE,
        axisLine: { show: false },
        axisLabel: axisLabel({ formatter: "{value}" })
      },
      series: series
    };
  }

  /* ============================================================
     图 2：等级价差
     ============================================================ */

  function buildSpreadOption(a) {
    var rows = (a.grades || []).filter(function (g) { return g.price !== null; });
    // 横向条形习惯上从下往上排，这里让价格从低到高自下而上，便于一眼看出档次
    rows.sort(function (x, y) { return x.price - y.price; });

    var min = rows.length ? rows[0].price : 0;
    var max = rows.length ? rows[rows.length - 1].price : 0;
    var mob = MOBILE();

    return {
      animationDuration: anim(650),
      animationDurationUpdate: anim(600),
      animationEasing: "cubicOut",
      animationEasingUpdate: "cubicOut",
      // 右侧留白给条尾的数字标签；窄屏标签字号小，留白也相应收窄
      grid: mob
        ? { left: 4, right: 52, top: 10, bottom: 6, containLabel: true }
        : { left: 8, right: 66, top: 12, bottom: 8, containLabel: true },
      tooltip: (function () {
        var o = tipBox();
        o.trigger = "item";
        o.formatter = function (p) {
          var g = rows[p.dataIndex];
          if (!g) return "";
          return g.grade + "<br/>" + Number(g.price).toFixed(2) + " 元/斤"
            + "<br/><span style='color:#8A9AB0'>" + g.source + " · " + g.date
            + " · " + (g.freq_label || "") + "</span>";
        };
        return o;
      })(),
      xAxis: {
        type: "value",
        scale: true,
        splitLine: SPLIT_LINE,
        axisLine: { show: false },
        axisLabel: axisLabel()
      },
      yAxis: {
        type: "category",
        data: rows.map(function (g) { return g.grade; }),
        axisLine: AXIS_LINE,
        axisTick: { show: false },
        // 等级名较长（如「三等（深加工收购）」），窄屏给不出 130px，收窄并截断，
        // 完整名称仍可在 tooltip 里看到
        axisLabel: axisLabel({ width: mob ? 92 : 130, overflow: "truncate" })
      },
      series: [{
        type: "bar",
        barWidth: mob ? 12 : 14,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: function (p) {
            // 最低档用灰蓝，最高档用主色，中间的按顺序 —— 让人一眼看出档位关系
            if (rows.length > 1 && p.dataIndex === rows.length - 1) return "#1E6FEB";
            if (p.dataIndex === 0) return "#7C93B0";
            return "#2E9BFF";
          }
        },
        label: {
          show: true,
          position: "right",
          distance: 8,
          color: "#1B2A41",
          fontSize: mob ? 10 : 11,
          formatter: function (p) { return Number(p.value).toFixed(2); }
        },
        data: rows.map(function (g) { return g.price; }),
        markLine: (min !== max) ? {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#C9D6E6", type: "dashed" },
          label: { show: false },
          data: [{ type: "max", xAxis: max }]
        } : null
      }]
    };
  }

  /* ============================================================
     初始化 / 更新
     ============================================================ */

  function mk(id) {
    var el = $(id);
    if (!el) return null;
    var c = window.echarts.init(el, null, { devicePixelRatio: chartDpr() });
    return c;
  }

  function init() {
    if (!window.echarts) return;
    // 静态模式在 main.js 里加好 body.is-static 之后再进来，动画开关才生效
    STATIC = document.body.classList.contains("is-static")
      || window.location.search.indexOf("static=1") >= 0;
    inst.trend = mk("chart-trend");
    inst.spread = mk("chart-spread");
    if (inst.trend) inst.trend.setOption(buildTrendOption({ grain: { name: "大米" }, days: 0, series: [] }), true);
    if (inst.spread) inst.spread.setOption(buildSpreadOption({ grain: { name: "大米" }, grades: [] }), true);
  }

  function updateTrend(t, force) {
    if (!inst.trend || !t) return;
    var sig = sigTrend(t);
    if (!force && sig === lastSig.trend) { stats.trendSkip++; return; }
    lastSig.trend = sig;
    stats.trendRender++;
    inst.trend.setOption(buildTrendOption(t), !!force);
  }

  function updateSpread(a, force) {
    if (!inst.spread || !a) return;
    var sig = sigSpread(a);
    if (!force && sig === lastSig.spread) { stats.spreadSkip++; return; }
    lastSig.spread = sig;
    stats.spreadRender++;
    inst.spread.setOption(buildSpreadOption(a), !!force);
  }

  function resize() {
    if (inst.trend) { inst.trend.resize({ devicePixelRatio: chartDpr() }); }
    if (inst.spread) { inst.spread.resize({ devicePixelRatio: chartDpr() }); }
  }

  window.WL.charts = {
    init: init,
    resize: resize,
    updateTrend: updateTrend,
    updateSpread: updateSpread,
    ready: function () { return !!(inst.trend && inst.spread); },
    /*
     * 必须返回**副本**：自检会把快照对象整体 JSON 序列化，
     * 如果返回引用，刷新前后两次快照会在序列化时都读到最终值，
     * 于是"零重绘"的证据看起来像"计数没动"，反而不可信。
     */
    stats: function () {
      return {
        trendRender: stats.trendRender, trendSkip: stats.trendSkip,
        spreadRender: stats.spreadRender, spreadSkip: stats.spreadSkip
      };
    },
    GRADE_COLORS: GRADE_COLORS
  };
})();
