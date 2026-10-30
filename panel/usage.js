'use strict';
/**
 * 用量分析（兼容入口）。
 *
 * 实现在 `panel/lib/usage/`：
 * - paths.js    默认会话目录 / SQLite 路径
 * - threads.js  会话元数据（标题/项目/模型）
 * - accounts.js 账号清单与窗口重置时刻查找表
 * - sessions.js rollout 文件解析（token_count / 账号归属）
 * - buckets.js  纯聚合（按天/小时/角色/模型/项目/窗口）
 * - collect.js  装配（扫描 → 归属 → 聚合 → /api/usage 响应）
 * - index.js    结果级缓存 get()
 *
 * 这个文件只保留原来的 require 路径，调用方无需改动。
 */
module.exports = require('./lib/usage');
