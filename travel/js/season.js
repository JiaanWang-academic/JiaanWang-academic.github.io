/**
 * 季节工具：把标签库里的「最佳季节」文本解析成月份集合
 * 支持：「6-9月」「4-5月 / 9-10月」「11-4月」（跨年）「9月下旬-10月」「10月」「全年」
 */
(function (root) {
  'use strict';

  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const RE = /(\d{1,2})\s*月?\s*(?:上旬|中旬|下旬)?\s*[-–—~～至]\s*(\d{1,2})\s*月|(\d{1,2})\s*月/g;

  /** @returns {{months:number[], anytime:boolean}|null} */
  function parseMonths(text) {
    if (!text) return null;
    const set = new Set();
    const anytime = /全年|四季/.test(text);
    if (anytime) ALL.forEach((m) => set.add(m));

    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(text))) {
      if (m[3] !== undefined) {
        const v = +m[3];
        if (v >= 1 && v <= 12) set.add(v);
        continue;
      }
      const a = +m[1], b = +m[2];
      if (a < 1 || a > 12 || b < 1 || b > 12) continue;
      for (let i = 0; i < 12; i++) {
        const v = ((a - 1 + i) % 12) + 1;
        set.add(v);
        if (v === b) break;
      }
    }
    if (!set.size) return null;
    return { months: ALL.filter((x) => set.has(x)), anytime };
  }

  const wrap = (m) => ((m - 1 + 1200) % 12) + 1;

  /**
   * 距离「适合出发」还有几个月
   * @returns 0=本月正当时 1=下月 2=两月后 -1=近三个月都不是好时候
   */
  function offsetFrom(season, month, span) {
    if (!season) return -1;
    const n = span === undefined ? 3 : span;
    for (let i = 0; i < n; i++) {
      if (season.months.indexOf(wrap(month + i)) >= 0) return i;
    }
    return -1;
  }

  const inSeason = (season, month) => !!season && season.months.indexOf(wrap(month)) >= 0;

  /** 把月份数组压成「4-6月 / 9-11月」这样的短文本 */
  function monthsLabel(season) {
    if (!season) return '';
    if (season.anytime) return '全年';
    const ms = season.months;
    if (ms.length === 12) return '全年';
    const has = (m) => ms.indexOf(m) >= 0;
    // 找所有连续段（考虑跨年首尾相接）
    const segs = [];
    let i = 0;
    while (i < ms.length) {
      let j = i;
      while (j + 1 < ms.length && ms[j + 1] === ms[j] + 1) j++;
      segs.push([ms[i], ms[j]]);
      i = j + 1;
    }
    if (segs.length > 1 && has(1) && has(12)) {
      const first = segs.shift();
      const last = segs.pop();
      segs.push([last[0], first[1]]);
    }
    return segs.map(([a, b]) => (a === b ? `${a}月` : `${a}-${b}月`)).join(' / ');
  }

  root.SEASON = { parseMonths, offsetFrom, inSeason, monthsLabel, wrap, ALL };
})(typeof window !== 'undefined' ? window : globalThis);
