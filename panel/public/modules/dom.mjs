'use strict';
/**
 * DOM 外壳：元素表、toast、忙碌态、弹窗。
 * 这一层只做"显示"，业务动作在 actions.mjs，数据在 app.mjs。
 */
import { esc } from './format.mjs';
import { $ } from './api.mjs';

export const els = {
  status: $('#topbar-status'),
  refresh: $('#btn-refresh'),
  auto: $('#auto-refresh'),
  kpis: $('#kpis'),
  accounts: $('#accounts'),
  timeline: $('#timeline'),
  policy: $('#policy-body'),
  router: $('#router-body'),
  routerHint: $('#router-hint'),
  routerActions: $('#router-actions'),
  foot: $('#foot-text'),
  modal: $('#modal'),
  modalContent: $('#modal-content'),
  toasts: $('#toasts'),
};

let busy = false;

export function isBusy() { return busy; }

export function setBusy(flag) {
  busy = flag;
  document.body.style.cursor = flag ? 'progress' : '';
  if (flag && els.foot) els.foot.textContent = '正在处理操作，请稍候…';
  syncBusyButtons();
  if (els.refresh) els.refresh.classList.toggle('loading', flag);
}

export function syncBusyButtons() {
  els.policy?.querySelectorAll('input,select,textarea').forEach(input => {
    if (busy) {
      if (!input.hasAttribute('data-busy-disabled')) input.dataset.busyDisabled = String(input.disabled);
      input.disabled = true;
    } else if (input.hasAttribute('data-busy-disabled')) {
      input.disabled = input.dataset.busyDisabled === 'true';
      delete input.dataset.busyDisabled;
    }
  });
  document.querySelectorAll('[data-act],[data-router],[data-app-login-sync],[data-rule-move],#btn-discard-policy,#btn-save-policy,#btn-refresh').forEach(button => {
    if (busy) {
      if (!button.hasAttribute('data-busy-disabled')) button.dataset.busyDisabled = String(button.disabled);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else if (button.hasAttribute('data-busy-disabled')) {
      button.disabled = button.dataset.busyDisabled === 'true';
      delete button.dataset.busyDisabled;
      button.removeAttribute('aria-busy');
    }
  });
}

export function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 220); }, 3600);
}

export function openModal(html) {
  els.modalContent.innerHTML = html;
  els.modal.hidden = false;
  const focus = els.modalContent.querySelector('textarea,input,button');
  if (focus) setTimeout(() => focus.focus(), 30);
}

export function closeModal() {
  els.modal.hidden = true;
  els.modalContent.innerHTML = '';
  document.onkeydown = null;
  els.modal.onclick = null;
}

export function confirmModal(title, desc, primary = true) {
  return new Promise((resolve) => {
    openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">取消</button>
        <button class="btn ${primary ? 'btn-primary' : 'btn-danger'}" id="m-ok">确定</button>
      </div>`);
    const done = (val) => { closeModal(); resolve(val); };
    $('#m-cancel').onclick = () => done(false);
    $('#m-ok').onclick = () => done(true);
    els.modal.onclick = (e) => { if (e.target === els.modal) done(false); };
    document.onkeydown = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
  });
}

export function promptModal(title, desc, value) {
  return new Promise((resolve) => {
    openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      <div class="field"><textarea id="m-text" maxlength="200">${esc(value || '')}</textarea></div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">取消</button>
        <button class="btn btn-primary" id="m-ok">保存</button>
      </div>`);
    const done = (val) => { closeModal(); document.onkeydown = null; resolve(val); };
    $('#m-cancel').onclick = () => done(null);
    $('#m-ok').onclick = () => done($('#m-text').value);
    els.modal.onclick = (e) => { if (e.target === els.modal) done(null); };
    document.onkeydown = (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done($('#m-text').value);
    };
  });
}
