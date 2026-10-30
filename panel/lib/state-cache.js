'use strict';
/**
 * 面板快照缓存 + 失效标记。
 *
 * dashboard 负责构建；其它模块只调用 invalidate() 声明“数据已过期”。
 * 单独成文件是为了打破 router-control / account-actions / dashboard 之间的循环依赖。
 */
const FAST_TTL = 60000;

const cache = { at: 0, data: null, building: null, buildingMode: null, generation: 0 };

function invalidate() { cache.generation++; cache.at = cache.data ? Date.now() - FAST_TTL - 1000 : 0; }

module.exports = { cache, FAST_TTL, invalidate };
