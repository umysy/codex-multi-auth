'use strict';
/**
 * 会话元数据（标题 / 项目 / 模型 / 更新时间）。
 *
 * 来源：`~/.codex/state_5.sqlite` 的 threads 表。数据库不可用时返回空 Map，
 * 调用方仍然可以从 rollout 文件统计 token（只是标题/项目为空）。
 */
const stateDbDefault = require('./paths').STATE_DB;

/**
 * @param {string} [stateDb] 覆盖数据库路径（测试用）
 * @returns {Map<string, {title:string, project:string, model:string, updatedAt:number}>}
 */
function loadThreads(stateDb) {
  const map = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(stateDb || stateDbDefault, { readOnly: true });
    const rows = db.prepare('SELECT id, title, cwd, model, updated_at, updated_at_ms FROM threads').all();
    for (const r of rows) {
      const parts = String(r.cwd || '').split(/[\\/]/).filter(Boolean);
      map.set(String(r.id || ''), {
        title: String(r.title || ''),
        project: parts.length ? parts[parts.length - 1] : '',
        model: String(r.model || ''),
        updatedAt: Number(r.updated_at_ms || 0) || Number(r.updated_at || 0) * 1000,
      });
    }
    db.close();
  } catch (e) { /* sqlite 不可用时只用 rollout 统计 */ }
  return map;
}

/** 从模型名/标题推断本次会话的“角色”。规则只有这一处。 */
function roleOf(model, title) {
  if (/auto-review/i.test(String(model || ''))) return '自动 review';
  // 只看标题第一行前 80 字：会话标题存的是整段首个提示词，
  // 长提示词里写到“交叉复核 / 评审记录”时不应把主开发会话算成审查。
  const head = String(title || '').split(/\r?\n/)[0].slice(0, 80);
  if (/审查|评审|复核|review|critic|审核|reviewer/i.test(head)) return '审查 reviewer';
  return '主开发';
}

module.exports = { loadThreads, roleOf };
