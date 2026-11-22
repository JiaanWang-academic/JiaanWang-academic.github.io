/** 校验 data/city-tags.js 里的城市名能否在 data/china-geo.js 中找到，以及标签是否都已定义 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = { window: {} };
new Function('window', fs.readFileSync(path.join(ROOT, 'data/china-geo.js'), 'utf8'))(g.window);
new Function('window', fs.readFileSync(path.join(ROOT, 'data/city-tags.js'), 'utf8'))(g.window);
new Function('window', fs.readFileSync(path.join(ROOT, 'js/season.js'), 'utf8'))(g.window);
const SEASON = g.window.SEASON;

const CITIES = g.window.CHINA_GEO.list.cities;
const TAGS = g.window.CITY_TAGS;

const ETH_MULTI = /(维吾尔|哈萨克|柯尔克孜|塔吉克|蒙古|朝鲜|土家|布依|仡佬|傈僳|景颇|德昂|阿昌|普米|独龙|鄂温克|鄂伦春|达斡尔|锡伯|撒拉|东乡|保安|裕固|哈尼|纳西|拉祜|门巴|珞巴|基诺|布朗|毛南)族?/g;
const ETH_ONE = /(彝|藏|苗|侗|白|傣|回|壮|羌|黎|瑶|满|佤|水|京|畲|土|怒)族/g;
const norm = (s) => String(s).trim().replace(/·.*$/, '')
  .replace(/(特别行政区|自治州|自治县|自治区|地区|盟|市|县|区|省)$/g, '')
  .replace(ETH_MULTI, '').replace(ETH_ONE, '').replace(/\s/g, '');

const byName = new Map(CITIES.map((c) => [c.name, c]));
const normIndex = new Map();
CITIES.forEach((c) => [c.name, c.label, norm(c.name)].forEach((k) => { if (k && !normIndex.has(k)) normIndex.set(k, c); }));

const ALIAS = TAGS.alias || {};

function findCity(q) {
  if (byName.has(q)) return byName.get(q);
  if (normIndex.has(q)) return normIndex.get(q);
  const n = norm(q);
  if (normIndex.has(n)) return normIndex.get(n);
  const al = ALIAS[q] || ALIAS[n];
  if (al && byName.has(al)) return byName.get(al);
  let best = null;
  CITIES.forEach((c) => {
    const cn = norm(c.name);
    if (cn && (n.includes(cn) || cn.includes(n)) && (!best || cn.length < norm(best.name).length)) best = c;
  });
  return best;
}

const bad = [], fuzzy = [], unknownTags = new Set();
const used = new Set();
let n = 0;
for (const [name, info] of Object.entries(TAGS.cities)) {
  n++;
  const c = findCity(name);
  if (!c) bad.push(name);
  else {
    if (c.name !== name) fuzzy.push(`${name} -> ${c.name}`);
    if (used.has(c.adcode)) bad.push(`${name} 重复映射到 ${c.name}`);
    used.add(c.adcode);
  }
  info.t.forEach((t) => { if (!TAGS.tags[t]) unknownTags.add(t); });
}

const tagCount = {};
Object.values(TAGS.cities).forEach((i) => i.t.forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
const emptyTags = Object.keys(TAGS.tags).filter((t) => !tagCount[t]);

// 别名校验：目标必须是存在的地级市，且别名本身不能和真实城市名冲突
const aliasBad = [], aliasNoTag = [];
for (const [k, v] of Object.entries(ALIAS)) {
  if (!byName.has(v)) aliasBad.push(`${k} -> ${v} (目标不存在)`);
  else if (!TAGS.cities[v]) aliasNoTag.push(`${k} -> ${v}`);
  if (byName.has(k)) aliasBad.push(`${k} 与真实城市名冲突`);
}

console.log(`收录城市 ${n} / 全国 ${CITIES.length}，标签 ${Object.keys(TAGS.tags).length} 个，别名 ${Object.keys(ALIAS).length} 条`);
console.log('别名异常：', aliasBad.length ? aliasBad : '无');
console.log('别名指向未收录城市：', aliasNoTag.length ? aliasNoTag : '无');
console.log('未匹配：', bad.length ? bad : '无');
console.log('模糊匹配：', fuzzy.length ? fuzzy : '无');
console.log('未定义标签：', unknownTags.size ? [...unknownTags] : '无');
console.log('没有城市的标签：', emptyTags.length ? emptyTags : '无');
console.log('标签分布：', Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join(' '));

/* ---- 最佳季节解析校验 ---- */
const noBest = [], badBest = [];
const perMonth = Object.fromEntries(SEASON.ALL.map((m) => [m, 0]));
for (const [name, info] of Object.entries(TAGS.cities)) {
  if (!info.b) { noBest.push(name); continue; }
  const s = SEASON.parseMonths(info.b);
  if (!s) { badBest.push(`${name}: "${info.b}"`); continue; }
  s.months.forEach((m) => perMonth[m]++);
}
console.log('\n缺最佳季节：', noBest.length ? noBest : '无');
console.log('季节无法解析：', badBest.length ? badBest : '无');
console.log('各月当季城市数：', SEASON.ALL.map((m) => `${m}月:${perMonth[m]}`).join(' '));
const thin = SEASON.ALL.filter((m) => perMonth[m] < 20);
console.log('当季城市偏少的月份：', thin.length ? thin.map((m) => `${m}月(${perMonth[m]})`).join(' ') : '无');
if (badBest.length) process.exit(1);
if (bad.length || unknownTags.size || aliasBad.length) process.exit(1);
