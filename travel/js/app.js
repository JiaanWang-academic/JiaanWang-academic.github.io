/* =========================================================
 * 我的足迹地图 —— 点亮中国
 * 纯前端 / 数据存本地 localStorage
 * ========================================================= */
(function () {
  'use strict';

  const GEO = window.CHINA_GEO;
  if (!GEO) { alert('地图数据未加载，请确认 data/china-geo.js 存在'); return; }

  const CITIES = GEO.list.cities;
  const PROVINCES = GEO.list.provinces;
  const META = GEO.meta;

  const byAdcode = new Map(CITIES.map((c) => [String(c.adcode), c]));
  const byName = new Map(CITIES.map((c) => [c.name, c]));
  const provByCode = new Map(PROVINCES.map((p) => [String(p.adcode), p]));
  const provByName = new Map(PROVINCES.map((p) => [p.name, p]));
  const citiesOfProv = new Map();
  CITIES.forEach((c) => {
    const k = String(c.pcode);
    if (!citiesOfProv.has(k)) citiesOfProv.set(k, []);
    citiesOfProv.get(k).push(c);
  });

  const REGIONS = ['华北', '东北', '华东', '华中', '华南', '西南', '西北'];

  /* ---------------- 旅行标签 ---------------- */
  const TAGDEF = (window.CITY_TAGS && window.CITY_TAGS.tags) || {};
  const TAGCATS = ['自然', '人文', '体验'];
  const tagInfoOf = new Map();   // adcode -> {t,s,tip,b}
  const citiesOfTag = new Map(); // tag -> [city]
  const seasonOf = new Map();    // adcode -> {months,anytime}

  const SEASON = window.SEASON;
  const NOW_MONTH = new Date().getMonth() + 1;
  let seasonMonth = NOW_MONTH;   // 当季面板正在查看的月份
  let seasonTag = '';            // 当季面板的标签筛选（单选）

  const STATUS = {
    lived:   { key: 'lived',   name: '住过', color: '#1b4fa8', light: '#3a6fc4' },
    visited: { key: 'visited', name: '去过', color: '#4a9ef0', light: '#7fbcf6' },
    transit: { key: 'transit', name: '路过', color: '#a7d2f7', light: '#c3e0fa' },
    wish:    { key: 'wish',    name: '想去', color: '#f6c35c', light: '#fbd98f' },
  };
  const BRUSHES = ['visited', 'lived', 'transit', 'wish', 'erase'];
  const LIT = ['visited', 'lived', 'transit']; // 计入「已点亮」

  const THEME = {
    light: { mapBg: '#ffffff', fill: '#ffffff', stroke: '#d4dbe6', prov: '#8e9cb0', hover: '#ffe3a6', text: '#1b2434', dim: '#6b7688', panel: '#ffffff', line: '#e2e8f1', nanhai: '#9aa7b8' },
    dark:  { mapBg: '#111823', fill: '#1b2430', stroke: '#2c3747', prov: '#56657b', hover: '#6b5520', text: '#e8edf5', dim: '#8b97aa', panel: '#161d28', line: '#27313f', nanhai: '#56657b' },
  };

  const KEY = 'china-travel-map:v1';

  /* ---------------- 状态 ---------------- */
  let state = {
    records: {},               // { adcode: {s, y, n, r} }
    settings: { theme: 'light', brush: 'visited', instant: false, home: null },
  };
  let view = { mode: 'city', pcode: null };   // city | province | single
  let currentCity = null;
  let pending = null;          // 待确认点亮的城市（防误触）
  let seasonLayer = false;     // 地图上高亮当季推荐
  let undoSnapshot = null;

  /** 待确认操作的目标状态：null 表示「取消点亮」 */
  function pendingTarget() {
    if (!pending) return null;
    const brush = state.settings.brush;
    const cur = statusOf(pending);
    if (brush === 'erase' || cur === brush) return null;
    return STATUS[brush];
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        state.records = d.records || {};
        Object.assign(state.settings, d.settings || {});
      }
    } catch (e) { console.warn('读取本地数据失败', e); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, records: state.records, settings: state.settings })); }
    catch (e) { toast('保存失败：本地存储空间不足'); }
  }
  const theme = () => THEME[state.settings.theme] || THEME.light;
  const recOf = (c) => c && state.records[String(c.adcode)];
  const statusOf = (c) => { const r = recOf(c); return r && r.s; };

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const chartEl = $('chart');

  /* ---------------- 地图注册 ---------------- */
  echarts.registerMap('cn-city', GEO.cities);
  echarts.registerMap('cn-prov', GEO.provinces);
  const registered = new Set(['cn-city', 'cn-prov']);

  function provMapName(pcode) {
    const name = 'prov-' + pcode;
    if (!registered.has(name)) {
      const p = provByCode.get(String(pcode));
      const feats = GEO.cities.features.filter((f) => {
        const pr = f.properties;
        return String(pr.pcode) === String(pcode) || pr.name === '#界#' + (p && p.name);
      });
      echarts.registerMap(name, { type: 'FeatureCollection', features: feats });
      registered.add(name);
    }
    return name;
  }

  const chart = echarts.init(chartEl, null, { renderer: 'canvas' });

  /* ---------------- 统计 ---------------- */
  function stats() {
    const litCities = [];
    const wish = [];
    Object.keys(state.records).forEach((code) => {
      const c = byAdcode.get(code);
      if (!c) return;
      const s = state.records[code].s;
      if (LIT.indexOf(s) >= 0) litCities.push(c);
      else if (s === 'wish') wish.push(c);
    });
    const provSet = new Set(litCities.map((c) => String(c.pcode)));
    const area = litCities.reduce((a, c) => a + c.area, 0);
    return {
      litCities, wish, provSet, area,
      cityPct: litCities.length / META.cityCount,
      provPct: provSet.size / META.provinceCount,
      areaPct: area / META.totalArea,
    };
  }

  /* ---------------- 地图渲染 ---------------- */
  function seriesDataForCities(list) {
    const t = theme();
    const data = list.map((c) => {
      const st = STATUS[statusOf(c)];
      const item = {
        name: c.name,
        value: st ? 1 : 0,
        itemStyle: { areaColor: st ? st.color : t.fill, borderColor: t.stroke, borderWidth: 0.6 },
        emphasis: { itemStyle: { areaColor: st ? st.light : t.hover } },
      };
      // 当季图层：未点亮 + 本月正当季的推荐城市，高亮成暖色
      if (seasonLayer && !st && offsetOf(c, NOW_MONTH) === 0) {
        const s = seasonFor(c);
        if (s && !s.anytime) {
          item.itemStyle = { areaColor: '#ffb648', borderColor: '#e08a21', borderWidth: 0.8 };
          item.emphasis = { itemStyle: { areaColor: '#ffc978' } };
        }
      }
      // 待确认：虚线描边 + 目标颜色预览
      if (pending && pending.adcode === c.adcode) {
        const target = pendingTarget();
        item.itemStyle = {
          areaColor: target ? target.light : (st ? st.light : t.hover),
          borderColor: t.text, borderWidth: 1.8, borderType: 'dashed',
          shadowBlur: 12, shadowColor: 'rgba(47,127,224,.55)',
        };
      }
      return item;
    });
    // 省界 & 南海诸岛（纯装饰）
    PROVINCES.forEach((p) => {
      data.push({
        name: '#界#' + p.name,
        itemStyle: { borderColor: t.prov, borderWidth: 1, areaColor: 'transparent', opacity: 1 },
        emphasis: { disabled: true }, silent: true, tooltip: { show: false },
      });
    });
    data.push({
      name: '南海诸岛',
      itemStyle: { areaColor: t.nanhai, borderColor: t.nanhai, borderWidth: 0.5 },
      emphasis: { disabled: true }, silent: true, tooltip: { show: false },
    });
    return data;
  }

  function mixColor(a, b, t) {
    const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
    const h = (v) => Math.round(v).toString(16).padStart(2, '0');
    return '#' + h(r1 + (r2 - r1) * t) + h(g1 + (g2 - g1) * t) + h(b1 + (b2 - b1) * t);
  }

  function seriesDataForProvinces() {
    const t = theme();
    const data = PROVINCES.map((p) => {
      const list = citiesOfProv.get(String(p.adcode)) || [];
      const lit = list.filter((c) => LIT.indexOf(statusOf(c)) >= 0).length;
      const ratio = list.length ? lit / list.length : 0;
      const color = lit === 0 ? t.fill : mixColor('#cfe5fb', '#1b4fa8', Math.pow(ratio, 0.6));
      return {
        name: p.name, value: lit,
        itemStyle: { areaColor: color, borderColor: t.prov, borderWidth: 0.8 },
        emphasis: { itemStyle: { areaColor: lit ? color : t.hover } },
        _total: list.length,
      };
    });
    data.push({
      name: '南海诸岛',
      itemStyle: { areaColor: t.nanhai, borderColor: t.nanhai },
      emphasis: { disabled: true }, silent: true, tooltip: { show: false },
    });
    return data;
  }

  const shortProv = (n) => n.replace(/(维吾尔自治区|回族自治区|壮族自治区|自治区|特别行政区|省|市)$/, '');

  function provinceLabelMarks() {
    const t = theme();
    return {
      symbol: 'circle', symbolSize: 1, silent: true, animation: false,
      itemStyle: { color: 'transparent' },
      label: {
        show: true, position: 'inside', color: t.dim, fontSize: 11,
        formatter: (p) => p.name,
      },
      data: PROVINCES.map((p) => ({ name: shortProv(p.name), coord: p.center })),
    };
  }

  function titleText() {
    const s = stats();
    if (view.mode === 'single') {
      const p = provByCode.get(String(view.pcode));
      const list = citiesOfProv.get(String(view.pcode)) || [];
      const lit = list.filter((c) => LIT.indexOf(statusOf(c)) >= 0).length;
      return { text: p.name, sub: `已点亮 ${lit} / ${list.length} 市` };
    }
    return { text: '我的足迹', sub: `已点亮 ${s.provSet.size} 省 ${s.litCities.length} 市` };
  }

  function buildOption(resetView) {
    const t = theme();
    const tt = titleText();
    let mapName, data, extra = {};

    if (view.mode === 'province') {
      mapName = 'cn-prov';
      data = seriesDataForProvinces();
      extra.markPoint = provinceLabelMarks();
    } else if (view.mode === 'single') {
      mapName = provMapName(view.pcode);
      data = seriesDataForCities(citiesOfProv.get(String(view.pcode)) || []);
      extra.label = {
        show: true, color: t.dim, fontSize: 11,
        formatter: (p) => (p.name.indexOf('#') === 0 ? '' : p.name.replace(/(市|地区|自治州|盟)$/, '')),
      };
      extra.emphasis = { label: { show: true, color: t.text, fontWeight: 'bold' } };
    } else {
      mapName = 'cn-city';
      data = seriesDataForCities(CITIES);
      extra.markPoint = provinceLabelMarks();
    }

    const series = Object.assign({
      type: 'map', map: mapName, roam: true, scaleLimit: { min: 0.8, max: 14 },
      selectedMode: false, animationDurationUpdate: 300,
      labelLayout: { hideOverlap: true },
      label: { show: false },
      emphasis: { label: { show: false }, itemStyle: { borderColor: t.text, borderWidth: 0.8 } },
      itemStyle: { areaColor: t.fill, borderColor: t.stroke, borderWidth: 0.6 },
      data,
    }, extra);

    if (resetView) { series.zoom = view.mode === 'single' ? 1 : 1.25; series.center = null; }

    return {
      backgroundColor: t.mapBg,
      title: {
        text: tt.text, subtext: tt.sub, left: 'center', top: 14, itemGap: 6,
        textStyle: { color: t.dim, fontSize: 13, fontWeight: 'normal' },
        subtextStyle: { color: t.text, fontSize: 18, fontWeight: 'bold' },
        backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 12,
        padding: [10, 20, 12, 20], textAlign: 'center',
      },
      tooltip: {
        trigger: 'item', confine: true, borderWidth: 0,
        backgroundColor: 'rgba(20,28,40,.92)', textStyle: { color: '#fff', fontSize: 12 },
        formatter: tooltipFormatter,
      },
      series: [series],
    };
  }

  function tooltipFormatter(p) {
    const name = p.name || '';
    if (name.indexOf('#界#') === 0 || name === '南海诸岛') return '';
    if (view.mode === 'province') {
      const prov = provByName.get(name);
      if (!prov) return '';
      const list = citiesOfProv.get(String(prov.adcode)) || [];
      const lit = list.filter((c) => LIT.indexOf(statusOf(c)) >= 0);
      return `<b>${name}</b><br/>已点亮 ${lit.length} / ${list.length} 市<br/>` +
        (lit.length ? lit.slice(0, 8).map((c) => c.label).join('、') + (lit.length > 8 ? ' …' : '') : '还没去过') +
        '<br/><span style="opacity:.6">点击进入该省</span>';
    }
    const c = byName.get(name);
    if (!c) return '';
    const r = recOf(c);
    const info = tipOf(c);
    const lines = [`<b>${c.label}</b> <span style="opacity:.6">${c.province}</span>`];
    if (info) {
      lines.push(`<span style="color:#ffd98a">${info.t.map((t) => (TAGDEF[t] ? TAGDEF[t].icon + t : t)).join(' ')}</span>`);
      if (info.tip) lines.push(`<span style="opacity:.85">${escapeHtml(info.tip)}</span>`);
      const off = offsetOf(c, NOW_MONTH);
      const se = seasonFor(c);
      if (se && !se.anytime && off >= 0) {
        const t = off === 0 ? '🔥 当季正合适' : `📅 ${OFFSET_TEXT[off]}可以去`;
        lines.push(`<span style="color:#ffb648">${t}（最佳 ${escapeHtml(info.b)}）</span>`);
      }
    }
    if (r) {
      lines.push(`状态：${STATUS[r.s].name}${r.y ? ' · ' + r.y + ' 年' : ''}${r.r ? ' · ' + '★'.repeat(r.r) : ''}`);
      if (r.n) lines.push(`<span style="opacity:.8">${escapeHtml(r.n).slice(0, 40)}</span>`);
    } else {
      lines.push(`<span style="opacity:.6">尚未点亮，点击${state.settings.instant ? '标记' : '后确认'}</span>`);
    }
    lines.push(`<span style="opacity:.5">面积约 ${c.area.toLocaleString()} km²</span>`);
    return lines.join('<br/>');
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  function renderMap(resetView) {
    chart.setOption(buildOption(resetView), resetView ? { replaceMerge: ['series'] } : false);
  }

  /* ---------------- 侧边栏渲染 ---------------- */
  function renderStats() {
    const s = stats();
    $('statProvince').textContent = s.provSet.size;
    $('statCity').textContent = s.litCities.length;
    $('statArea').textContent = (s.area / 10000).toFixed(1);
    $('statWish').textContent = s.wish.length;
    $('barProvince').style.width = (s.provPct * 100).toFixed(1) + '%';
    $('barCity').style.width = (s.cityPct * 100).toFixed(1) + '%';
    $('barArea').style.width = (s.areaPct * 100).toFixed(1) + '%';
    $('barWish').style.width = Math.min(100, s.wish.length * 4) + '%';
    $('statProvince').title = `全国 ${META.provinceCount} 个省级行政区`;
    $('statCity').title = `全国 ${META.cityCount} 个地级行政区，已覆盖 ${(s.cityPct * 100).toFixed(1)}%`;
    $('statArea').title = `约占国土面积 ${(s.areaPct * 100).toFixed(1)}%`;
  }

  function renderHome() {
    const h = homeCity();
    const el = $('homeNow');
    if (!h) {
      el.innerHTML = '<span class="tiny">填写后，推荐城市会按离你的距离由近到远排序</span>';
      $('homeInput').value = '';
      return;
    }
    el.innerHTML = `📍 当前出发地：<b>${h.label}</b>　<span class="home-clear" id="homeClear">清除</span>`;
    $('homeInput').value = h.label;
  }

  function setHome(city) {
    state.settings.home = city ? String(city.adcode) : null;
    save();
    renderHome();
    renderSeasonMini();
    if (!$('atlas').hidden) renderAtlas();
  }

  function renderSeasonMini() {
    const pool = seasonPool(NOW_MONTH);
    const now = pool.filter((x) => x.off === 0);
    const wish = now.filter((x) => x.wish);
    const box = $('seasonMini');
    $('seasonTitle').childNodes[0].nodeValue = `${NOW_MONTH}月去哪儿 `;
    $('seasonHint').textContent = now.length ? `${now.length} 个当季去处` : '';
    if (!now.length) { box.innerHTML = '<p class="empty">本月的推荐城市都去过了 🎉</p>'; return; }
    const pick = (wish.length ? wish : now).slice(0, 4);
    box.innerHTML =
      (wish.length ? `<p class="season-note">💛 想去清单里有 ${wish.length} 个当季可出发</p>` : '') +
      pick.map((x) => `<div class="seachip" data-code="${x.c.adcode}">
        <b>${x.c.label}</b>${x.dist != null ? `<em>${distLabel(x.dist)}</em>` : ''}
        <span>${escapeHtml(x.info.tip || '')}</span>
      </div>`).join('');
  }

  function renderTagCloud() {
    const { got } = tagStats();
    const box = $('tagCloud');
    $('tagSummary').textContent = `${got.length} / ${Object.keys(TAGDEF).length} 种`;
    if (!got.length) { box.innerHTML = '<p class="empty">点亮城市后，这里会出现你收集到的标签</p>'; return; }
    box.innerHTML = got.map((g) => tagChipHtml(g.tag, ` <b>${g.mine.length}</b>`)).join('');
  }

  function renderRegions() {
    const box = $('regionList');
    box.innerHTML = REGIONS.map((rg) => {
      const list = CITIES.filter((c) => c.region === rg);
      const lit = list.filter((c) => LIT.indexOf(statusOf(c)) >= 0).length;
      const pct = list.length ? (lit / list.length) * 100 : 0;
      return `<div class="region"><span>${rg}</span>
        <span class="rbar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="rnum">${lit}/${list.length}</span></div>`;
    }).join('');
  }

  function renderYears() {
    const box = $('yearList');
    const map = new Map();
    Object.keys(state.records).forEach((code) => {
      const r = state.records[code];
      if (LIT.indexOf(r.s) < 0) return;
      const y = r.y || '未记录';
      map.set(y, (map.get(y) || 0) + 1);
    });
    if (!map.size) { box.innerHTML = '<p class="empty">还没有记录年份的城市</p>'; return; }
    const entries = [...map.entries()].sort((a, b) => (a[0] === '未记录' ? 1 : b[0] === '未记录' ? -1 : b[0] - a[0]));
    const max = Math.max(...entries.map((e) => e[1]));
    box.innerHTML = entries.map(([y, n]) =>
      `<div class="year-row"><span>${y}</span><span class="ybar" style="width:${(n / max) * 100}%"></span><span>${n} 城</span></div>`
    ).join('');
  }

  function renderVisitList() {
    const box = $('visitList');
    const groups = new Map();
    Object.keys(state.records).forEach((code) => {
      const c = byAdcode.get(code);
      if (!c) return;
      if (!groups.has(c.province)) groups.set(c.province, []);
      groups.get(c.province).push(c);
    });
    const total = [...groups.values()].reduce((a, v) => a + v.length, 0);
    $('listCount').textContent = total ? `${groups.size} 省 · ${total} 市` : '';
    if (!groups.size) { box.innerHTML = '<p class="empty">点击地图开始点亮吧 ✨</p>'; return; }
    const order = PROVINCES.map((p) => p.name).filter((n) => groups.has(n));
    box.innerHTML = order.map((pn) => {
      const list = groups.get(pn).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return `<div class="vp"><div class="vp-title"><span>${pn}</span><span>${list.length}</span></div>
        <div class="chips">${list.map((c) => {
          const st = STATUS[statusOf(c)];
          const r = recOf(c);
          return `<span class="chip" data-code="${c.adcode}" title="${st.name}${r.y ? ' · ' + r.y : ''}">
            <i class="dot" style="background:${st.color}"></i>${c.label}</span>`;
        }).join('')}</div></div>`;
    }).join('');
  }

  function renderBrush() {
    const box = $('brushRow');
    box.innerHTML = BRUSHES.map((k) => {
      if (k === 'erase') {
        return `<div class="brush ${state.settings.brush === 'erase' ? 'active' : ''}" data-brush="erase" style="color:var(--text-dim)">
          <i class="dot" style="background:transparent;border:1px solid currentColor"></i>擦除</div>`;
      }
      const s = STATUS[k];
      return `<div class="brush ${state.settings.brush === k ? 'active' : ''}" data-brush="${k}" style="color:${s.color}">
        <i class="dot" style="background:${s.color}"></i><span style="color:var(--text)">${s.name}</span></div>`;
    }).join('');
  }

  function renderLegend() {
    $('legend').innerHTML = ['lived', 'visited', 'transit', 'wish'].map((k) => {
      const s = STATUS[k];
      return `<span><i style="background:${s.color}"></i>${s.name}</span>`;
    }).join('') +
      (seasonLayer ? '<span><i style="background:#ffb648"></i>当季推荐</span>' : '') +
      '<span style="opacity:.6">滚轮缩放 · 拖拽平移</span>';
  }

  function renderAll(resetView) {
    refreshPanels(); renderBrush();
    renderMap(resetView);
  }

  /** 轻量刷新（不重置视角、不重建画笔） */
  function refreshPanels() {
    renderStats(); renderHome(); renderSeasonMini(); renderTagCloud(); renderRegions(); renderYears(); renderVisitList();
    if (!$('atlas').hidden) renderAtlas();
  }

  /* ---------------- 标签图鉴 ---------------- */
  let atlasTab = 'season';

  const starStr = (n) => '★'.repeat(n || 0) + '☆'.repeat(Math.max(0, 5 - (n || 0)));

  function cityCardHtml(c, opts) {
    const info = tipOf(c) || {};
    const st = STATUS[statusOf(c)];
    const o = opts || {};
    return `<div class="acard${st ? ' lit' : ''}" data-code="${c.adcode}">
      <div class="acard-top">
        <b>${c.label}</b>
        <span class="acard-prov">${shortProv(c.province)}</span>
        ${st ? `<i class="acard-dot" style="background:${st.color}" title="${st.name}"></i>` : ''}
        <span class="acard-star" title="推荐度 ${info.s || 0} / 5">${starStr(info.s)}</span>
      </div>
      ${o.dist != null ? `<p class="acard-dist">📍 距${homeShort()} ${distLabel(o.dist)}</p>` : ''}
      ${info.tip ? `<p class="acard-tip">${escapeHtml(info.tip)}</p>` : ''}
      <div class="acard-tags">${tagsOf(c).map((t) => (o.hl === t ? tagChipHtml(t, ' ✓') : tagChipHtml(t))).join('')}</div>
      ${info.b ? `<p class="acard-best">${o.season === false ? '' : seasonBadge(c, o.month)}<span>最佳：${escapeHtml(info.b)}</span></p>` : ''}
    </div>`;
  }

  function renderAtlas() {
    const { got, miss } = tagStats();
    const all = Object.keys(TAGDEF);
    const taggedCities = [...tagInfoOf.keys()].map((k) => byAdcode.get(k)).filter(Boolean);
    const visitedTagged = taggedCities.filter(isLit);

    $('atlasSub').textContent =
      `已集齐 ${got.length} / ${all.length} 种标签　·　打卡推荐城市 ${visitedTagged.length} / ${taggedCities.length} 座`;

    const body = $('atlasBody');

    if (atlasTab === 'season') { renderSeasonTab(body); return; }

    if (atlasTab === 'collected') {
      if (!got.length) {
        body.innerHTML = `<p class="empty-big">还没有收集到标签。<br/>点亮任意一座推荐城市，就能解锁它的标签。</p>`;
        return;
      }
      body.innerHTML = got.map((g) => `
        <section class="atag">
          <h3>${tagChipHtml(g.tag)}<span class="atag-count">我去过 ${g.mine.length} / 全国 ${g.total}</span></h3>
          <div class="acards">${g.mine.map((c) => cityCardHtml(c, { hl: g.tag })).join('')}</div>
        </section>`).join('') +
        (miss.length ? `<section class="atag muted">
          <h3>尚未解锁 <span class="atag-count">${miss.length} 种</span></h3>
          <div class="tag-cloud">${miss.map((m) => tagChipHtml(m.tag, ` <b>${m.total}</b>`)).join('')}</div>
          <p class="tiny">点上面任意标签可以查看对应的推荐城市</p>
        </section>` : '');
      return;
    }

    if (atlasTab === 'recommend') {
      // 未点亮的推荐城市，按推荐度 + 是否能解锁新标签排序
      const gotSet = new Set(got.map((g) => g.tag));
      const list = taggedCities.filter((c) => !isLit(c)).map((c) => {
        const info = tipOf(c);
        const fresh = tagsOf(c).filter((t) => !gotSet.has(t));
        return { c, info, fresh, score: (info.s || 1) * 10 + fresh.length * 3 };
      }).sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name, 'zh'));

      const freshOnes = list.filter((x) => x.fresh.length);
      const top = list.filter((x) => !x.fresh.length && (x.info.s || 0) >= 3);
      const rest = list.filter((x) => !x.fresh.length && (x.info.s || 0) < 3);

      const sec = (title, note, arr) => arr.length ? `<section class="atag">
        <h3>${title}<span class="atag-count">${note}</span></h3>
        <div class="acards">${arr.map((x) => cityCardHtml(x.c)).join('')}</div></section>` : '';

      body.innerHTML =
        (list.length ? '' : '<p class="empty-big">厉害，推荐城市全部打卡完了 🎉</p>') +
        sec('🆕 能解锁新标签', `${freshOnes.length} 座`, freshOnes.slice(0, 40)) +
        sec('⭐ 高推荐度去处', `${top.length} 座`, top.slice(0, 40)) +
        sec('📍 其他可以考虑', `${rest.length} 座`, rest.slice(0, 40));
      return;
    }

    // all：按分类列出全部标签
    body.innerHTML = TAGCATS.map((cat) => {
      const ts = all.filter((t) => TAGDEF[t].cat === cat);
      return `<section class="atag">
        <h3>${cat}<span class="atag-count">${ts.length} 种</span></h3>
        <div class="tag-grid">${ts.map((t) => {
          const list = citiesOfTag.get(t) || [];
          const mine = list.filter(isLit).length;
          const pct = list.length ? (mine / list.length) * 100 : 0;
          return `<div class="tag-cell${mine ? ' on' : ''}" data-tag="${t}" style="--tc:${TAGDEF[t].color}">
            <div class="tag-cell-top">${TAGDEF[t].icon} ${t}</div>
            <div class="tag-cell-bar"><i style="width:${pct}%"></i></div>
            <div class="tag-cell-num">${mine} / ${list.length}</div>
          </div>`;
        }).join('')}</div>
      </section>`;
    }).join('');
  }

  /** 当季推荐页 */
  function renderSeasonTab(body) {
    const m = seasonMonth;
    const home = homeCity();
    const pool = seasonPool(m, seasonTag);
    const wish = pool.filter((x) => x.wish);
    const rest = pool.filter((x) => !x.wish);

    const picker = `<div class="month-pick">${SEASON.ALL.map((x) => {
      const cls = [x === m ? 'on' : '', x === NOW_MONTH ? 'now' : ''].join(' ').trim();
      return `<button data-month="${x}" class="${cls}">${x}月</button>`;
    }).join('')}</div>`;

    // 标签筛选：只统计当月有当季城市的标签，单选
    const avail = new Map();
    seasonPool(m, null).forEach((x) => {
      tagsOf(x.c).forEach((t) => avail.set(t, (avail.get(t) || 0) + 1));
    });
    const tagBar = `<div class="tag-filter">
      <button data-ftag="" class="${seasonTag ? '' : 'on'}">全部</button>
      ${[...avail.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        `<button data-ftag="${t}" class="${seasonTag === t ? 'on' : ''}" style="--tc:${TAGDEF[t].color}">
          ${TAGDEF[t].icon} ${t} <i>${n}</i></button>`).join('')}
    </div>`;

    const sec = (title, note, arr, cls) => arr.length ? `<section class="atag${cls ? ' ' + cls : ''}">
      <h3>${title}<span class="atag-count">${note}</span></h3>
      <div class="acards">${arr.slice(0, 24).map((x) => cityCardHtml(x.c, { month: m, dist: x.dist })).join('')}</div>
      ${arr.length > 24 ? `<p class="tiny">仅显示前 24 座，共 ${arr.length} 座</p>` : ''}
    </section>` : '';

    const lead = m === NOW_MONTH
      ? `现在是 ${NOW_MONTH} 月，这些地方正当季`
      : `按 ${m} 月出行来看，这些地方正当季`;
    const sortNote = home
      ? `从 <b>${home.label}</b> 出发，由近到远`
      : '<span class="tiny">在左侧填写「我在哪儿」，就能按距离由近到远排序</span>';

    const tagNote = seasonTag ? `　·　已筛选 ${TAGDEF[seasonTag].icon}${seasonTag}` : '';

    body.innerHTML = `
      <p class="season-lead">🗓️ ${lead}${tagNote}</p>
      ${picker}
      ${tagBar}
      <p class="sort-note">📍 ${sortNote}</p>
      ${sec('💛 想去清单 · 可以出发了', `${wish.length} 座`, wish, 'hot')}
      ${sec(`🔥 ${m}月正当时`, `${rest.filter((x) => x.off === 0).length} 座`, rest.filter((x) => x.off === 0))}
      ${sec(`📅 ${SEASON.wrap(m + 1)}月适合去`, `${rest.filter((x) => x.off === 1).length} 座`, rest.filter((x) => x.off === 1))}
      ${sec(`⏳ ${SEASON.wrap(m + 2)}月适合去`, `${rest.filter((x) => x.off === 2).length} 座`, rest.filter((x) => x.off === 2))}
      ${pool.length ? '' : `<p class="empty-big">${seasonTag ? `这几个月没有「${seasonTag}」类的新去处了。<br/>换个标签或月份看看吧。` : '这几个月的推荐城市你都去过了 🎉<br/>换个月份看看吧。'}</p>`}`;
  }

  /** 查看单个标签下的全部城市 */
  function showTagDetail(tag) {
    if (!TAGDEF[tag]) return;
    const list = citiesOfTag.get(tag) || [];
    const mine = list.filter(isLit);
    const todo = list.filter((c) => !isLit(c));
    openAtlas();
    atlasTab = null;
    [...$('atlasTabs').children].forEach((b) => b.classList.remove('active'));
    $('atlasBody').innerHTML = `
      <section class="atag">
        <h3>${tagChipHtml(tag)}<span class="atag-count">我去过 ${mine.length} / 全国 ${list.length}</span></h3>
        ${mine.length ? `<h4 class="asub">✅ 已点亮</h4><div class="acards">${mine.map((c) => cityCardHtml(c, { hl: tag })).join('')}</div>` : ''}
        ${todo.length ? `<h4 class="asub">🎯 还没去</h4><div class="acards">${todo.map((c) => cityCardHtml(c)).join('')}</div>` : ''}
      </section>`;
  }

  function openAtlas() {
    $('atlas').hidden = false;
    if (atlasTab) renderAtlas();
  }
  function closeAtlas() { $('atlas').hidden = true; }

  /* ---------------- 操作 ---------------- */
  function setStatus(city, s) {
    const code = String(city.adcode);
    if (!s) delete state.records[code];
    else {
      const r = state.records[code] || {};
      r.s = s;
      state.records[code] = r;
    }
    save();
  }

  function applyBrush(city) {
    const brush = state.settings.brush;
    const cur = statusOf(city);
    if (brush === 'erase' || cur === brush) setStatus(city, null);
    else setStatus(city, brush);
    pending = null;
    refreshPanels(); renderMap(false);
    openDetail(city);
  }

  /** 选中城市：默认先进入「待确认」，开启即时模式才直接点亮 */
  function pickCity(city) {
    if (state.settings.instant) { applyBrush(city); refreshCitySelect(); return; }
    // 再点一次同一个城市 = 确认
    if (pending && pending.adcode === city.adcode) { confirmPending(); return; }
    pending = city;
    openDetail(city);
    renderMap(false);
  }

  function confirmPending() {
    if (!pending) return;
    const city = pending;
    applyBrush(city);
    refreshCitySelect();
    const t = STATUS[statusOf(city)];
    toast(t ? `已标记 ${city.label} 为「${t.name}」` : `已取消点亮 ${city.label}`);
  }

  function cancelPending() {
    if (!pending) return;
    pending = null;
    closeDetail();
    renderMap(false);
  }

  function enterProvince(pcode) {
    pending = null;
    view = { mode: 'single', pcode: String(pcode) };
    $('btnBack').hidden = false;
    setViewSwitch(null);
    renderMap(true);
  }
  function backToNation(mode) {
    pending = null;
    view = { mode: mode || 'city', pcode: null };
    $('btnBack').hidden = true;
    setViewSwitch(view.mode);
    closeDetail();
    renderMap(true);
  }
  function setViewSwitch(mode) {
    [...$('viewSwitch').children].forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  }

  function flyTo(city) {
    const inProv = view.mode === 'single' && String(view.pcode) === String(city.pcode);
    if (view.mode === 'province') { enterProvince(city.pcode); }
    // 面积越大缩放越小，避免大区域（如阿里、那曲）被放得只剩一角
    const base = Math.sqrt(12000 / Math.max(city.area, 1200));
    const zoom = inProv
      ? Math.min(4, Math.max(1.2, base * 2.6))
      : Math.min(8, Math.max(2.2, base * 6.5));
    chart.setOption({ series: [{ center: city.center, zoom }] });
    chart.dispatchAction({ type: 'highlight', seriesIndex: 0, name: city.name });
    setTimeout(() => chart.dispatchAction({ type: 'downplay', seriesIndex: 0, name: city.name }), 1600);
  }

  /* ---------------- 详情面板 ---------------- */
  function openDetail(city) {
    currentCity = city;
    const r = recOf(city) || {};
    const isPending = !!(pending && pending.adcode === city.adcode);

    $('dTitle').textContent = city.label;
    const km = distFromHome(city);
    $('dSub').textContent = `${city.province} · ${city.region} · ${city.area.toLocaleString()} km²` +
      (km != null ? ` · 距${homeShort()} ${distLabel(km)}` : '');

    const info = tipOf(city);
    const tags = tagsOf(city);
    $('dTags').innerHTML = tags.length
      ? `<div class="tag-cloud">${tags.map((t) => tagChipHtml(t)).join('')}</div>` +
        (info.tip ? `<p class="dtip">${escapeHtml(info.tip)}</p>` : '') +
        (info.b ? `<p class="dbest">${seasonBadge(city, NOW_MONTH)}<span>最佳 ${escapeHtml(info.b)}${info.s ? ' · 推荐度 ' + starStr(info.s) : ''}</span></p>` : '')
      : '';
    $('dStatus').innerHTML = ['visited', 'lived', 'transit', 'wish'].map((k) => {
      const s = STATUS[k];
      const on = r.s === k;
      return `<button data-s="${k}" class="${on ? 'active' : ''}" style="${on ? 'background:' + s.color : ''}">${s.name}</button>`;
    }).join('') + `<button data-s="" class="${r.s ? '' : 'active'}" style="${r.s ? '' : 'background:var(--text-dim)'}">未去</button>`;
    $('dYear').value = r.y || '';
    $('dNote').value = r.n || '';
    renderStars(r.r || 0);

    // 待确认条
    const bar = $('dConfirm');
    bar.hidden = !isPending;
    if (isPending) {
      const target = pendingTarget();
      $('dConfirmOk').textContent = target ? `确认点亮为「${target.name}」` : '确认取消点亮';
      $('dConfirmOk').style.background = target ? target.color : '';
      $('dConfirmOk').style.borderColor = target ? target.color : '';
      $('dConfirmOk').classList.toggle('danger-solid', !target);
      $('dConfirmTip').textContent = r.s
        ? `当前「${STATUS[r.s].name}」· 下方可直接改状态`
        : '下方可直接选状态 · Enter 确认 / Esc 取消';
    }
    // 未点亮且待确认时，先不显示明细编辑区
    $('dExtra').hidden = isPending && !r.s;
    $('dClear').hidden = !r.s;

    $('detail').hidden = false;
  }
  function closeDetail() { $('detail').hidden = true; currentCity = null; }
  function renderStars(n) {
    $('dStars').innerHTML = [1, 2, 3, 4, 5].map((i) => `<span data-v="${i}" class="${i <= n ? 'on' : ''}">★</span>`).join('');
  }
  function updateRec(fn) {
    if (!currentCity) return;
    const code = String(currentCity.adcode);
    const r = state.records[code] || { s: 'visited' };
    fn(r);
    state.records[code] = r;
    save();
    refreshPanels(); renderMap(false);
  }

  /* ---------------- 下拉框 ---------------- */
  function initSelectors() {
    const sp = $('selProvince');
    const groups = {};
    PROVINCES.forEach((p) => { (groups[p.region] = groups[p.region] || []).push(p); });
    REGIONS.forEach((rg) => {
      if (!groups[rg]) return;
      const og = document.createElement('optgroup');
      og.label = rg;
      groups[rg].forEach((p) => {
        const o = document.createElement('option');
        o.value = p.adcode; o.textContent = p.name;
        og.appendChild(o);
      });
      sp.appendChild(og);
    });

    $('cityOptions').innerHTML =
      CITIES.map((c) => `<option value="${c.label}">${c.province}</option>`).join('') +
      Object.keys(ALIAS).map((k) => `<option value="${k}">${ALIAS[k]}</option>`).join('');

    sp.addEventListener('change', () => {
      const sc = $('selCity');
      sc.innerHTML = '<option value="">选择城市…</option>';
      const list = citiesOfProv.get(sp.value) || [];
      list.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.adcode;
        const st = STATUS[statusOf(c)];
        const info = tipOf(c);
        o.textContent = (st ? '● ' : '○ ') + c.label +
          (info ? ' ' + starStr(info.s) : '') + (st ? ` (${st.name})` : '');
        sc.appendChild(o);
      });
      sc.disabled = !list.length;
    });

    $('selCity').addEventListener('change', () => {
      const c = byAdcode.get($('selCity').value);
      if (c) { pending = null; flyTo(c); openDetail(c); renderMap(false); }
    });
  }
  function refreshCitySelect() {
    const sp = $('selProvince');
    if (!sp.value) return;
    const keep = $('selCity').value;
    sp.dispatchEvent(new Event('change'));
    if (keep) $('selCity').value = keep;
  }

  /* ---------------- 名称匹配 ---------------- */
  // 多字民族名可不带「族」；单字民族名必须带「族」才剥离，
  // 否则「白城」「黎平」「水城」这类地名会被误伤（白城市 -> 城）
  const ETH_MULTI = /(维吾尔|哈萨克|柯尔克孜|塔吉克|蒙古|朝鲜|土家|布依|仡佬|傈僳|景颇|德昂|阿昌|普米|独龙|鄂温克|鄂伦春|达斡尔|锡伯|撒拉|东乡|保安|裕固|哈尼|纳西|拉祜|门巴|珞巴|基诺|布朗|毛南)族?/g;
  const ETH_ONE = /(彝|藏|苗|侗|白|傣|回|壮|羌|黎|瑶|满|佤|水|京|畲|土|怒)族/g;
  function norm(s) {
    return String(s).trim()
      .replace(/·.*$/, '')
      .replace(/(特别行政区|自治州|自治县|自治区|地区|盟|市|县|区|省)$/g, '')
      .replace(ETH_MULTI, '')
      .replace(ETH_ONE, '')
      .replace(/\s/g, '');
  }
  const normIndex = new Map();
  CITIES.forEach((c) => {
    [c.name, c.label, norm(c.name)].forEach((k) => { if (k && !normIndex.has(k)) normIndex.set(k, c); });
  });

  const ALIAS = (window.CITY_TAGS && window.CITY_TAGS.alias) || {};

  /**
   * @param {string} q 城市名 / 别名 / 景点名
   * @param {boolean} [strict] 为 true 时不做模糊兜底（用于出发地等精确输入）
   */
  function findCity(q, strict) {
    q = String(q || '').trim();
    if (!q) return null;
    if (byName.has(q)) return byName.get(q);
    if (normIndex.has(q)) return normIndex.get(q);
    const n = norm(q);
    if (normIndex.has(n)) return normIndex.get(n);
    // 别名 / 著名景点名
    const al = ALIAS[q] || ALIAS[n];
    if (al && byName.has(al)) return byName.get(al);
    if (strict) return null;
    let best = null;
    CITIES.forEach((c) => {
      const cn = norm(c.name);
      if (!cn) return;
      if (n.indexOf(cn) >= 0 || cn.indexOf(n) >= 0) {
        if (!best || cn.length < norm(best.name).length) best = c;
      }
    });
    return best;
  }

  /* ---------------- 标签索引 ---------------- */
  function buildTagIndex() {
    const src = (window.CITY_TAGS && window.CITY_TAGS.cities) || {};
    Object.keys(src).forEach((name) => {
      const c = findCity(name);
      if (!c) { console.warn('[tags] 未匹配城市：', name); return; }
      const info = src[name];
      tagInfoOf.set(String(c.adcode), info);
      const s = SEASON.parseMonths(info.b);
      if (s) seasonOf.set(String(c.adcode), s);
      info.t.forEach((t) => {
        if (!TAGDEF[t]) return;
        if (!citiesOfTag.has(t)) citiesOfTag.set(t, []);
        citiesOfTag.get(t).push(c);
      });
    });
    // 每个标签内按推荐度排序
    citiesOfTag.forEach((list) => list.sort((a, b) => {
      const d = (tagInfoOf.get(String(b.adcode)).s || 0) - (tagInfoOf.get(String(a.adcode)).s || 0);
      return d || a.name.localeCompare(b.name, 'zh');
    }));
  }
  const tagsOf = (city) => {
    const i = city && tagInfoOf.get(String(city.adcode));
    return i ? i.t.filter((t) => TAGDEF[t]) : [];
  };
  const tipOf = (city) => {
    const i = city && tagInfoOf.get(String(city.adcode));
    return i || null;
  };
  const isLit = (city) => LIT.indexOf(statusOf(city)) >= 0;

  /* ---- 季节 ---- */
  const seasonFor = (city) => (city ? seasonOf.get(String(city.adcode)) : null) || null;
  const offsetOf = (city, m) => SEASON.offsetFrom(seasonFor(city), m === undefined ? seasonMonth : m);
  const OFFSET_TEXT = ['正当时', '下个月', '两个月后'];

  function seasonBadge(city, m) {
    const s = seasonFor(city);
    if (!s) return '';
    const base = m === undefined ? seasonMonth : m;
    if (s.anytime) return '<span class="sbadge any">全年皆宜</span>';
    const off = SEASON.offsetFrom(s, base);
    if (off === 0) return `<span class="sbadge now">🔥 ${SEASON.wrap(base)}月正当时</span>`;
    if (off > 0) return `<span class="sbadge soon">📅 ${SEASON.wrap(base + off)}月可去</span>`;
    const next = SEASON.offsetFrom(s, base, 12);
    return `<span class="sbadge off">${next > 0 ? SEASON.wrap(base + next) + '月再来' : '错峰'}</span>`;
  }

  /* ---- 出发地与距离 ---- */
  const homeCity = () => (state.settings.home ? byAdcode.get(String(state.settings.home)) : null);

  /** 两点球面距离（km） */
  function distance(a, b) {
    if (!a || !b) return null;
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function distFromHome(city) {
    const h = homeCity();
    if (!h || !city || String(h.adcode) === String(city.adcode)) return null;
    return distance(h.center, city.center);
  }
  const distLabel = (km) => (km === null ? '' : `${km.toLocaleString()} km`);
  function homeShort() {
    const h = homeCity();
    return h ? h.label.replace(/(市|地区|自治州|盟|特别行政区|省)$/, '') : '';
  }

  /** 当季候选池：未点亮的推荐城市 */
  function seasonPool(m, tag) {
    const gotSet = new Set(tagStats().got.map((g) => g.tag));
    const home = homeCity();
    return [...tagInfoOf.keys()].map((k) => byAdcode.get(k)).filter(Boolean)
      .filter((c) => !isLit(c))
      .filter((c) => !tag || tagsOf(c).indexOf(tag) >= 0)
      .map((c) => {
        const info = tipOf(c);
        const s = seasonFor(c);
        const fresh = tagsOf(c).filter((t) => !gotSet.has(t));
        return {
          c, info, fresh, season: s,
          off: SEASON.offsetFrom(s, m),
          dist: distFromHome(c),
          wish: statusOf(c) === 'wish',
          // 推荐度为主，能解锁新标签为辅；「全年皆宜」的不占当季名额优先级
          score: (info.s || 1) * 10 + Math.min(fresh.length, 2) * 6 + (s && s.anytime ? -12 : 0),
        };
      })
      .filter((x) => x.off >= 0)
      .sort((a, b) => {
        if (a.off !== b.off) return a.off - b.off;
        // 设了出发地就按距离近优先，否则按推荐度
        if (home) {
          const da = a.dist === null ? 0 : a.dist;
          const db = b.dist === null ? 0 : b.dist;
          if (da !== db) return da - db;
        }
        return b.score - a.score || a.c.name.localeCompare(b.c.name, 'zh');
      });
  }

  function tagChipHtml(t, extra) {
    const d = TAGDEF[t];
    if (!d) return '';
    return `<span class="tagchip" data-tag="${t}" style="--tc:${d.color}">${d.icon} ${t}${extra || ''}</span>`;
  }

  /** 标签统计：已集齐 / 未集齐 */
  function tagStats() {
    const got = [], miss = [];
    Object.keys(TAGDEF).forEach((t) => {
      const list = citiesOfTag.get(t) || [];
      const mine = list.filter(isLit);
      (mine.length ? got : miss).push({ tag: t, total: list.length, mine });
    });
    got.sort((a, b) => b.mine.length - a.mine.length);
    miss.sort((a, b) => b.total - a.total);
    return { got, miss };
  }

  /* ---------------- 工具 ---------------- */
  let toastTimer;
  function toast(msg, undoFn) {
    const el = $('toast');
    el.innerHTML = escapeHtml(msg) + (undoFn ? ' <b style="margin-left:8px;cursor:pointer;color:#8ec5ff" id="toastUndo">撤销</b>' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, undoFn ? 6000 : 2200);
    if (undoFn) $('toastUndo').onclick = () => { undoFn(); el.hidden = true; };
  }
  function snapshot() { undoSnapshot = JSON.stringify(state.records); }
  function undo() {
    if (!undoSnapshot) return;
    state.records = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    save(); renderAll(false); refreshCitySelect(); toast('已撤销');
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------------- 事件绑定 ---------------- */
  chart.on('click', (p) => {
    const name = p.name || '';
    if (!name || name.indexOf('#界#') === 0 || name === '南海诸岛') return;
    if (view.mode === 'province') {
      const prov = provByName.get(name);
      if (prov) enterProvince(prov.adcode);
      return;
    }
    const c = byName.get(name);
    if (c) pickCity(c);
  });

  $('viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    backToNation(b.dataset.view);
  });
  $('btnBack').addEventListener('click', () => backToNation('city'));
  $('btnFit').addEventListener('click', () => renderMap(true));

  $('brushRow').addEventListener('click', (e) => {
    const b = e.target.closest('.brush');
    if (!b) return;
    state.settings.brush = b.dataset.brush;
    save(); renderBrush();
    // 待确认时实时更新确认按钮文案与预览色
    if (pending) { openDetail(pending); renderMap(false); }
  });

  $('chkInstant').addEventListener('change', (e) => {
    state.settings.instant = e.target.checked;
    save();
    if (e.target.checked) cancelPending();
    toast(e.target.checked ? '已开启：点地图直接点亮' : '已开启确认模式，点地图后需确认');
  });

  $('visitList').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const c = byAdcode.get(chip.dataset.code);
    if (c) { pending = null; flyTo(c); openDetail(c); renderMap(false); }
  });

  /* 我在哪儿 */
  function commitHome() {
    const v = $('homeInput').value.trim();
    if (!v) { setHome(null); return; }
    const c = findCity(v, true);
    if (!c) { toast(`没找到「${v}」，请输入地级市名`); renderHome(); return; }
    setHome(c);
    toast(`出发地已设为 ${c.label}`);
  }
  $('homeInput').addEventListener('change', commitHome);
  $('homeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitHome(); } });
  $('homeNow').addEventListener('click', (e) => {
    if (e.target.id === 'homeClear') { setHome(null); toast('已清除出发地'); }
  });

  /* 当季 */
  $('btnSeasonMore').addEventListener('click', () => { seasonMonth = NOW_MONTH; setAtlasTab('season'); });
  $('seasonMini').addEventListener('click', (e) => {
    const chip = e.target.closest('.seachip');
    if (!chip) return;
    const c = byAdcode.get(chip.dataset.code);
    if (c) { pending = null; $('sidebar').classList.remove('open'); flyTo(c); openDetail(c); renderMap(false); }
  });
  $('btnSeasonLayer').addEventListener('click', () => {
    seasonLayer = !seasonLayer;
    $('btnSeasonLayer').classList.toggle('on', seasonLayer);
    renderLegend();
    renderMap(false);
    if (seasonLayer) {
      const n = seasonPool(NOW_MONTH).filter((x) => x.off === 0).length;
      toast(`已高亮 ${NOW_MONTH} 月当季的 ${n} 个去处`);
    }
  });

  /* 标签图鉴 */
  $('btnAtlas').addEventListener('click', () => { atlasTab = atlasTab || 'season'; setAtlasTab(atlasTab); });
  $('btnOpenAtlas').addEventListener('click', () => setAtlasTab('collected'));
  $('atlasClose').addEventListener('click', closeAtlas);
  $('atlas').addEventListener('click', (e) => { if (e.target.id === 'atlas') closeAtlas(); });
  $('atlasTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setAtlasTab(b.dataset.tab);
  });
  function setAtlasTab(tab) {
    atlasTab = tab;
    [...$('atlasTabs').children].forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    openAtlas();
    $('atlasBody').scrollTop = 0;
  }

  // 月份选择器 / 标签筛选
  $('atlasBody').addEventListener('click', (e) => {
    const mb = e.target.closest('.month-pick button');
    if (mb) {
      seasonMonth = +mb.dataset.month;
      renderAtlas();
      $('atlasBody').scrollTop = 0;
      return;
    }
    const tb = e.target.closest('.tag-filter button');
    if (tb) {
      const t = tb.dataset.ftag || '';
      seasonTag = seasonTag === t ? '' : t;   // 再点一次取消筛选
      renderAtlas();
    }
  });

  // 点标签 → 查看该标签全部城市；点城市卡片 → 跳到地图
  document.addEventListener('click', (e) => {
    const cell = e.target.closest('.tag-cell');
    if (cell) { showTagDetail(cell.dataset.tag); return; }
    const chip = e.target.closest('.tagchip');
    if (chip) { showTagDetail(chip.dataset.tag); return; }
    const card = e.target.closest('.acard');
    if (card) {
      const c = byAdcode.get(card.dataset.code);
      if (!c) return;
      closeAtlas();
      $('sidebar').classList.remove('open');
      pending = null;
      flyTo(c); openDetail(c); renderMap(false);
    }
  });


  $('btnLightCity').addEventListener('click', () => {
    const c = byAdcode.get($('selCity').value);
    if (!c) return toast('请先选择城市');
    applyBrush(c); flyTo(c); refreshCitySelect();
  });
  $('btnZoomProvince').addEventListener('click', () => {
    const code = $('selProvince').value;
    if (!code) return toast('请先选择省份');
    enterProvince(code);
  });
  $('btnLightProvince').addEventListener('click', () => {
    const code = $('selProvince').value;
    if (!code) return toast('请先选择省份');
    snapshot();
    const brush = state.settings.brush === 'erase' ? 'visited' : state.settings.brush;
    (citiesOfProv.get(code) || []).forEach((c) => setStatus(c, brush));
    renderAll(false); refreshCitySelect();
    toast(`已点亮 ${provByCode.get(code).name} 全部城市`, undo);
  });
  $('btnClearProvince').addEventListener('click', () => {
    const code = $('selProvince').value;
    if (!code) return toast('请先选择省份');
    snapshot();
    (citiesOfProv.get(code) || []).forEach((c) => setStatus(c, null));
    renderAll(false); refreshCitySelect();
    toast(`已清空 ${provByCode.get(code).name}`, undo);
  });

  // 搜索
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const c = findCity(e.target.value);
    if (!c) return toast('没找到这个城市');
    flyTo(c); pickCity(c);
    e.target.value = '';
  });

  // 详情面板
  $('detailClose').addEventListener('click', () => { pending = null; closeDetail(); renderMap(false); });
  $('dConfirmOk').addEventListener('click', confirmPending);
  $('dConfirmCancel').addEventListener('click', cancelPending);
  $('dStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !currentCity) return;
    const city = currentCity;
    pending = null;
    setStatus(city, b.dataset.s || null);
    renderAll(false); refreshCitySelect(); openDetail(city);
  });
  $('dYear').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    updateRec((r) => { if (v) r.y = v; else delete r.y; });
  });
  $('dNote').addEventListener('change', (e) => updateRec((r) => { const v = e.target.value.trim(); if (v) r.n = v; else delete r.n; }));
  $('dStars').addEventListener('click', (e) => {
    const s = e.target.closest('span');
    if (!s) return;
    const v = +s.dataset.v;
    updateRec((r) => { r.r = r.r === v ? 0 : v; renderStars(r.r); });
  });
  $('dClear').addEventListener('click', () => {
    if (!currentCity) return;
    pending = null;
    setStatus(currentCity, null);
    renderAll(false); refreshCitySelect(); closeDetail();
  });

  // 主题
  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
    $('btnTheme').textContent = state.settings.theme === 'dark' ? '☀️' : '🌙';
  }
  $('btnTheme').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    save(); applyTheme(); renderMap(false);
  });

  // 导出图片
  $('btnShot').addEventListener('click', () => {
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme().mapBg });
    const a = document.createElement('a');
    a.href = url;
    a.download = `我的足迹_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    toast('图片已导出');
  });

  // 备份
  $('btnExportJSON').addEventListener('click', () => {
    const h = homeCity();
    const payload = {
      app: 'china-travel-map', version: 1, exportedAt: new Date().toISOString(),
      home: h ? { adcode: h.adcode, name: h.label, province: h.province } : null,
      records: state.records,
      readable: Object.keys(state.records).map((code) => {
        const c = byAdcode.get(code); const r = state.records[code];
        if (!c) return null;
        const info = tipOf(c);
        const km = distFromHome(c);
        return {
          city: c.label, province: c.province, status: STATUS[r.s].name,
          year: r.y || null, rating: r.r || null, note: r.n || '',
          tags: info ? info.t : [], bestSeason: info ? info.b : null,
          distanceFromHomeKm: km,
        };
      }).filter(Boolean),
    };
    download(`足迹备份_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    toast('备份已导出');
  });
  $('btnImportJSON').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        let recs = d.records;
        if (!recs && Array.isArray(d.readable)) {
          recs = {};
          d.readable.forEach((x) => {
            const c = findCity(x.city);
            if (c) recs[String(c.adcode)] = { s: 'visited', y: x.year || undefined };
          });
        }
        if (!recs) throw new Error('格式不正确');
        snapshot();
        state.records = recs;
        // 恢复出发地
        if (d.home) {
          const hc = (d.home.adcode && byAdcode.get(String(d.home.adcode))) || findCity(d.home.name || '');
          if (hc) state.settings.home = String(hc.adcode);
        }
        save(); renderAll(false); refreshCitySelect();
        toast(`已导入 ${Object.keys(recs).length} 条记录`, undo);
      } catch (err) { toast('导入失败：' + err.message); }
    };
    fr.readAsText(f);
    e.target.value = '';
  });

  // 批量录入
  $('btnBatch').addEventListener('click', () => {
    $('modal').hidden = false;
    $('modalText').value = '';
    $('modalStatus').textContent = '';
    $('modalText').focus();
  });
  $('modalCancel').addEventListener('click', () => { $('modal').hidden = true; });
  $('modalOk').addEventListener('click', () => {
    const text = $('modalText').value;
    const brush = state.settings.brush === 'erase' ? 'visited' : state.settings.brush;
    snapshot();
    let ok = 0; const fail = [];
    text.split(/\n/).forEach((line) => {
      let year = null;
      const ym = line.match(/(19|20)\d{2}/);
      if (ym && /^[\s]*(19|20)\d{2}/.test(line)) { year = +ym[0]; line = line.replace(ym[0], ''); }
      line.split(/[,，、;；\s]+/).forEach((tk) => {
        const t = tk.trim();
        if (!t) return;
        const c = findCity(t);
        if (!c) { fail.push(t); return; }
        const r = state.records[String(c.adcode)] || {};
        r.s = brush;
        if (year) r.y = year;
        state.records[String(c.adcode)] = r;
        ok++;
      });
    });
    save(); renderAll(false); refreshCitySelect();
    $('modal').hidden = true;
    toast(`成功点亮 ${ok} 个城市${fail.length ? '，未识别：' + fail.slice(0, 5).join('、') : ''}`, undo);
  });

  // 复制清单
  $('btnCopyText').addEventListener('click', () => {
    const s = stats();
    const groups = new Map();
    s.litCities.forEach((c) => {
      if (!groups.has(c.province)) groups.set(c.province, []);
      groups.get(c.province).push(c.label);
    });
    const h = homeCity();
    const text = `我的足迹：已点亮 ${s.provSet.size} 省 ${s.litCities.length} 市，约占国土面积 ${(s.areaPct * 100).toFixed(1)}%\n` +
      (h ? `出发地：${h.label}\n` : '') + '\n' +
      [...groups.entries()].map(([p, l]) => `${p}（${l.length}）：${l.join('、')}`).join('\n');
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('清单已复制到剪贴板'); }
    catch (e) { toast('复制失败，请手动选择'); }
    ta.remove();
  });

  $('btnReset').addEventListener('click', () => {
    if (!Object.keys(state.records).length) return toast('还没有任何记录');
    if (!confirm('确定清空全部足迹？可在提示条中撤销。')) return;
    snapshot();
    state.records = {};
    save(); renderAll(false); refreshCitySelect();
    toast('已清空全部足迹', undo);
  });

  // 移动端菜单
  $('btnMenu').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  chartEl.addEventListener('click', () => $('sidebar').classList.remove('open'));

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'Escape') {
      if (!$('atlas').hidden) { closeAtlas(); return; }
      if (pending) cancelPending(); else closeDetail();
      $('modal').hidden = true;
      return;
    }
    if (e.key === 't' || e.key === 'T') { $('atlas').hidden ? setAtlasTab(atlasTab || 'season') : closeAtlas(); return; }
    if (e.key === 'Enter' && pending) { e.preventDefault(); confirmPending(); return; }
    const idx = '12345'.indexOf(e.key);
    if (idx >= 0 && BRUSHES[idx]) {
      state.settings.brush = BRUSHES[idx];
      save(); renderBrush();
      if (pending) { openDetail(pending); renderMap(false); }
      toast('画笔：' + (STATUS[BRUSHES[idx]] ? STATUS[BRUSHES[idx]].name : '擦除'));
    }
  });

  window.addEventListener('resize', () => chart.resize());

  /* ---------------- 启动 ---------------- */
  load();
  applyTheme();
  $('chkInstant').checked = !!state.settings.instant;
  buildTagIndex();
  initSelectors();
  renderLegend();
  renderAll(true);
  window.__app = { state, stats, findCity };
})();
