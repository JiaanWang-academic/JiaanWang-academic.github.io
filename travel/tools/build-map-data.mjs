/**
 * 构建离线地图数据
 * 数据源：阿里 DataV.GeoAtlas（高德）行政区划边界
 * 输出：data/china-geo.js  （挂载到 window.CHINA_GEO，可直接 file:// 打开）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache-geo');

const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

/** 这些行政区不再下钻，直接以整体作为一个「市」 */
const ATOMIC = new Set([110000, 120000, 310000, 500000, 710000, 810000, 820000]);

/** 七大地理分区 */
const REGION_OF = {
  北京市: '华北', 天津市: '华北', 河北省: '华北', 山西省: '华北', 内蒙古自治区: '华北',
  辽宁省: '东北', 吉林省: '东北', 黑龙江省: '东北',
  上海市: '华东', 江苏省: '华东', 浙江省: '华东', 安徽省: '华东', 福建省: '华东', 江西省: '华东', 山东省: '华东', 台湾省: '华东',
  河南省: '华中', 湖北省: '华中', 湖南省: '华中',
  广东省: '华南', 广西壮族自治区: '华南', 海南省: '华南', 香港特别行政区: '华南', 澳门特别行政区: '华南',
  重庆市: '西南', 四川省: '西南', 贵州省: '西南', 云南省: '西南', 西藏自治区: '西南',
  陕西省: '西北', 甘肃省: '西北', 青海省: '西北', 宁夏回族自治区: '西北', 新疆维吾尔自治区: '西北',
};

async function fetchJSON(code) {
  const file = path.join(CACHE_DIR, `${code}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const url = `${BASE}/${code}_full.json`;
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = await res.text();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, text);
  return JSON.parse(text);
}

/* ---------------- 几何简化 ---------------- */

function sqSegDist(p, a, b) {
  let x = a[0], y = a[1];
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

function rdp(points, sqTol) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxSq) { maxSq = d; idx = i; }
    }
    if (maxSq > sqTol && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (p, d = 4) => [+p[0].toFixed(d), +p[1].toFixed(d)];

function simplifyRing(ring, tol) {
  let out = rdp(ring, tol * tol).map((p) => round(p));
  // 去掉相邻重复点
  out = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  if (out.length < 4) out = ring.map((p) => round(p));
  if (out.length < 4) return null;
  const f = out[0], l = out[out.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  return out;
}

function simplifyGeometry(geom, tol) {
  const mapPoly = (poly) => poly.map((r) => simplifyRing(r, tol)).filter(Boolean);
  if (geom.type === 'Polygon') {
    const p = mapPoly(geom.coordinates);
    return p.length ? { type: 'Polygon', coordinates: p } : null;
  }
  if (geom.type === 'MultiPolygon') {
    const ps = geom.coordinates.map(mapPoly).filter((p) => p.length);
    return ps.length ? { type: 'MultiPolygon', coordinates: ps } : null;
  }
  return null;
}

/* ---------------- 面积（球面近似，km²） ---------------- */

const R = 6371.0087714;
const rad = (d) => (d * Math.PI) / 180;

function ringArea(ring) {
  let total = 0;
  for (let i = 0, len = ring.length - 1; i < len; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    total += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((total * R * R) / 2);
}

function geomArea(geom) {
  const polyArea = (poly) =>
    poly.reduce((acc, ring, i) => acc + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0);
  if (!geom) return 0;
  if (geom.type === 'Polygon') return polyArea(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((a, p) => a + polyArea(p), 0);
  return 0;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('→ 拉取全国省级边界…');
  const cn = await fetchJSON(100000);

  const provinces = [];
  const cities = [];
  const nameCount = new Map();

  let nanhai = null;

  for (const pf of cn.features) {
    const pp = pf.properties;
    const pname = pp.name;
    const pcode = pp.adcode;

    // 南海诸岛（十段线）：仅作装饰线，不参与点亮
    if (!pname || String(pcode).includes('_')) {
      nanhai = { type: 'Feature', properties: { name: '南海诸岛', decorative: true }, geometry: pf.geometry };
      continue;
    }
    const region = REGION_OF[pname] || '其他';

    const pGeom = simplifyGeometry(pf.geometry, 0.01);
    provinces.push({
      type: 'Feature',
      properties: { name: pname, adcode: pcode, region, center: round(pp.center || pp.centroid, 3) },
      geometry: pGeom,
    });

    let cityFeatures;
    if (ATOMIC.has(pcode)) {
      cityFeatures = [{ properties: { name: pname, adcode: pcode, center: pp.center, centroid: pp.centroid }, geometry: pf.geometry }];
    } else {
      const sub = await fetchJSON(pcode);
      cityFeatures = sub.features;
    }

    for (const cf of cityFeatures) {
      const cp = cf.properties;
      let name = cp.name;
      if (!name || name === '市辖区') name = pname;
      nameCount.set(name, (nameCount.get(name) || 0) + 1);
      const geom = simplifyGeometry(cf.geometry, 0.004);
      if (!geom) continue;
      cities.push({
        type: 'Feature',
        properties: {
          name,
          adcode: cp.adcode,
          province: pname,
          pcode,
          region,
          center: round(cp.center || cp.centroid || pp.center, 3),
          area: Math.round(geomArea(geom)),
        },
        geometry: geom,
      });
    }
    process.stdout.write(`  ✓ ${pname} (${cityFeatures.length})\n`);
  }

  // 处理重名：加省份前缀
  const dup = new Set([...nameCount].filter(([, n]) => n > 1).map(([n]) => n));
  for (const c of cities) {
    if (dup.has(c.properties.name)) {
      c.properties.label = c.properties.name;
      c.properties.name = `${c.properties.name}·${c.properties.province.replace(/(省|市|自治区|特别行政区|维吾尔|回族|壮族)/g, '')}`;
    }
  }

  const stat = {
    cityCount: cities.length,
    provinceCount: provinces.length,
    totalArea: Math.round(cities.reduce((a, c) => a + c.properties.area, 0)),
  };

  // 索引：下拉框 / 统计用
  const cityList = cities.map((c) => ({
    name: c.properties.name,
    label: c.properties.label || c.properties.name,
    adcode: c.properties.adcode,
    province: c.properties.province,
    pcode: c.properties.pcode,
    region: c.properties.region,
    center: c.properties.center,
    area: c.properties.area,
  }));
  const provinceList = provinces.map((p) => {
    const own = cityList.filter((c) => c.pcode === p.properties.adcode);
    return {
      name: p.properties.name,
      adcode: p.properties.adcode,
      region: p.properties.region,
      center: p.properties.center,
      cityCount: own.length,
      area: own.reduce((a, c) => a + c.area, 0),
    };
  });

  // 省界线（LineString）：叠加在市级地图上，但不响应点击
  const borderFeatures = provinces.map((p) => {
    const lines = [];
    const push = (poly) => poly.forEach((ring) => lines.push(ring));
    if (p.geometry.type === 'Polygon') push(p.geometry.coordinates);
    else if (p.geometry.type === 'MultiPolygon') p.geometry.coordinates.forEach(push);
    return {
      type: 'Feature',
      properties: { name: `#界#${p.properties.name}`, border: true },
      geometry: { type: 'MultiLineString', coordinates: lines },
    };
  });

  if (nanhai) {
    provinces.push(nanhai);
    cities.push(nanhai);
  }
  cities.push(...borderFeatures);

  const payload = {
    provinces: { type: 'FeatureCollection', features: provinces },
    cities: { type: 'FeatureCollection', features: cities },
    list: { provinces: provinceList, cities: cityList },
    meta: {
      ...stat,
      source: 'DataV.GeoAtlas',
      builtAt: new Date().toISOString().slice(0, 10),
    },
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'china-geo.js');
  await fs.writeFile(out, `window.CHINA_GEO=${JSON.stringify(payload)};`);
  const { size } = await fs.stat(out);
  console.log(`\n✓ 输出 ${out}`);
  console.log(`  省级 ${provinces.length} / 市级 ${cities.length} / 体积 ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  重名已加后缀：${[...dup].join('、') || '无'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
