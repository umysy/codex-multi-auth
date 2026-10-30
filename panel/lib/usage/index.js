'use strict';
/**
 * 用量模块入口：带 3 分钟缓存的 get()，以及无缓存的 collect()。
 *
 * 缓存是“结果级”缓存（整个 /api/usage 响应），并发请求共享同一个 building Promise，
 * 避免面板刷新时同时扫两遍 sessions 目录。
 */
const { TTL } = require('./paths');
const { collect } = require('./collect');

/** rangeDays → {data, at, building}；不同天数不能共用一份缓存。 */
const caches = new Map();

function entry(rangeDays) {
  const key = Math.max(1, Math.min(14, Math.trunc(Number(rangeDays)) || 7));
  let c = caches.get(key);
  if (!c) {
    c = { data: null, at: 0, building: null };
    caches.set(key, c);
  }
  return c;
}

/**
 * @param {number} rangeDays
 * @param {boolean} force 忽略缓存（面板上点“刷新”）
 * @param {object} deps 见 collect()
 */
function get(rangeDays, force, deps) {
  rangeDays = Math.max(1, Math.min(14, Math.trunc(Number(rangeDays)) || 7));
  const c = entry(rangeDays);
  if (!force && c.data && Date.now() - c.at < TTL) return Promise.resolve(c.data);
  if (c.building) return c.building;
  c.building = collect(rangeDays, deps || {})
    .then((data) => {
      c.data = data;
      c.at = Date.now();
      c.building = null;
      return data;
    })
    .catch((e) => {
      c.building = null;
      throw e;
    });
  return c.building;
}

/** 清空缓存（测试用）。 */
function clear() {
  caches.clear();
}

module.exports = { get, collect, clear };
