import { esc } from './format.mjs';

const keyPattern = /^sha256:[a-f0-9]{64}$/;
const fields = [
  ['shortUsedPercent', '5H 剩余 ≤ %', 0, 99],
  ['weeklyUsedPercent', '7 天剩余 ≤ %', 0, 99],
  ['waitBeforeSwitchMin', '等待分钟', 0, 600],
];

// Keep the persisted used-percent schema compatible with existing policies.
const complement = value => Math.round((100 - value) * 1e10) / 1e10;
const isQuota = name => name === 'shortUsedPercent' || name === 'weeklyUsedPercent';
const displayed = (name, value) => value == null ? '' : isQuota(name) ? complement(value) : value;

export function rotationEditorHtml(state) {
  const policy = state.policy || {}, config = policy.rotation;
  const accounts = state.accounts || [];
  const order = [...(config?.daily || []), ...(config?.reserve || [])];
  const sorted = [...accounts].sort((a, b) => {
    const rank = key => order.includes(key) ? order.indexOf(key) : order.length;
    return rank(a.accountKey) - rank(b.accountKey);
  });
  const missing = order.filter(key => !accounts.some(a => a.accountKey === key)).length;
  const rows = sorted.map(a => {
    const reserve = config ? config.reserve.includes(a.accountKey) : accounts.length > 1 && a.n === Number(policy.reserveIndex);
    const overrides = config?.accountRules?.[a.accountKey] || {};
    return `<tr data-rule-key="${esc(a.accountKey || '')}"><td>${esc(a.email || '账户 ' + a.n)}${a.paused ? '（已暂停）' : ''}</td>
      <td><select data-rule-role aria-label="账户角色"><option value="daily" ${reserve ? '' : 'selected'}>日常</option><option value="reserve" ${reserve ? 'selected' : ''}>备用</option></select></td>
      ${fields.map(([name, label, min, max]) => `<td><input type="number" data-rule-field="${name}" aria-label="${label}" min="${min}" max="${max}" step="0.1" placeholder="继承" value="${displayed(name, overrides[name])}"></td>`).join('')}
      <td><button type="button" class="btn" data-rule-move="-1" aria-label="上移账户">↑</button><button type="button" class="btn" data-rule-move="1" aria-label="下移账户">↓</button></td></tr>`;
  }).join('');
  return `<div class="row"><label><input type="checkbox" id="rotation-enabled" ${config ? 'checked' : ''}> 启用自定义账户规则</label></div>
    <p class="row-hint">按各组列表顺序选账户，至少保留一个日常号。单号阈值留空继承全局值。5H 或 7 天剩余额度 ≤ 阈值时进入切换判断；0% 表示用完再切，范围 0–99%。等待刷新和最短切换间隔仍然生效。</p>
    ${missing ? '<p class="rule-warning">有 ' + missing + ' 个旧账户已移除。保存后会重新绑定下方账户，请检查角色与顺序。</p>' : ''}
    <fieldset id="rotation-settings" class="rotation-settings" ${config ? '' : 'disabled'}>
      <div class="rule-settings">
        <label>日常号选择 <select id="rotation-selection"><option value="cycle">按顺序循环</option><option value="priority" ${config?.dailySelection === 'priority' ? 'selected' : ''}>优先选靠前的健康号</option></select></label>
        <label>全局 5H 剩余 ≤ % <input id="rotation-short" type="number" min="0" max="99" step="0.1" value="${complement(config?.shortUsedPercent ?? 100)}"></label>
        <label>全局 7 天剩余 ≤ % <input id="rotation-weekly" type="number" min="0" max="99" step="0.1" value="${complement(config?.weeklyUsedPercent ?? 100)}"></label>
        <label>距刷新小于多少分钟则等待 <input id="rotation-wait" type="number" min="0" max="600" step="0.1" value="${config?.waitBeforeSwitchMin ?? policy.minWaitMin ?? 60}"></label>
        <label>最短切换间隔（秒） <input id="rotation-gap" type="number" min="0" max="3600" step="0.1" value="${config?.minGapSec ?? 600}"></label>
      </div>
      <label><input id="rotation-return" type="checkbox" ${config?.returnToDaily !== false ? 'checked' : ''}> 日常号恢复后，从备用号自动回切</label>
      <div class="rule-table-wrap"><table class="rule-table"><thead><tr><th>账户</th><th>角色</th><th>单号 5H 剩余 ≤ %</th><th>单号 7 天剩余 ≤ %</th><th>单号等待</th><th>顺序</th></tr></thead><tbody id="rotation-accounts">${rows}</tbody></table></div>
      <p class="row-hint">等待设为 0 表示不等待。周额度不足、手动暂停、认证失效及运行时故障不会被等待规则掩盖。优先选择只在需要切号或从备用回切时生效，健康的当前日常号保持使用。</p>
    </fieldset>`;
}

function number(value, label, min, max) {
  if (String(value).trim() === '') throw new Error(label + '不能为空');
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(label + '必须在 ' + min + ' 到 ' + max + ' 之间');
  return n;
}

export function collectRotation(query, accounts) {
  const enabled = query('#rotation-enabled');
  if (!enabled) return undefined;
  if (!enabled.checked) return null;
  const config = {
    version: 1, mode: 'daily-reserve', daily: [], reserve: [], accountRules: {},
    dailySelection: query('#rotation-selection').value,
    shortUsedPercent: complement(number(query('#rotation-short').value, '5H 剩余阈值', 0, 99)),
    weeklyUsedPercent: complement(number(query('#rotation-weekly').value, '7 天剩余阈值', 0, 99)),
    waitBeforeSwitchMin: number(query('#rotation-wait').value, '等待时间', 0, 600),
    minGapSec: number(query('#rotation-gap').value, '切换间隔', 0, 3600),
    returnToDaily: query('#rotation-return').checked,
  };
  for (const row of query('#rotation-accounts').querySelectorAll('[data-rule-key]')) {
    const key = row.dataset.ruleKey;
    if (!keyPattern.test(key)) throw new Error('账户绑定尚未获取，请刷新后重试');
    const role = row.querySelector('[data-rule-role]').value;
    if (!['daily', 'reserve'].includes(role)) throw new Error('请选择账户角色');
    config[role].push(key);
    const rule = {};
    for (const [name, label, min, max] of fields) {
      const value = row.querySelector('[data-rule-field="' + name + '"]').value.trim();
      if (value) {
        const n = number(value, label, min, max);
        rule[name] = isQuota(name) ? complement(n) : n;
      }
    }
    if (Object.keys(rule).length) config.accountRules[key] = rule;
  }
  if (!config.daily.length) throw new Error('至少需要一个日常账户');
  const keys = [...config.daily, ...config.reserve];
  if (new Set(keys).size !== keys.length || accounts.length !== keys.length || accounts.some(a => !keys.includes(a.accountKey))) throw new Error('账户池已变化，请放弃草稿并刷新后重新设置规则');
  return config;
}

export function toggleRotation(query) {
  const enabled = query('#rotation-enabled').checked;
  query('#rotation-settings').disabled = !enabled;
  query('#pol-wait').disabled = enabled;
  query('#pol-reserve').disabled = enabled;
}

export function moveRule(button) {
  const row = button.closest('[data-rule-key]');
  const delta = Number(button.dataset.ruleMove);
  const sibling = delta < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return false;
  if (delta < 0) row.parentNode.insertBefore(row, sibling);
  else row.parentNode.insertBefore(sibling, row);
  return true;
}
