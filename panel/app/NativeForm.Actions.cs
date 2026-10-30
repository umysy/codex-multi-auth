using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

namespace CodexQuota
{
    public sealed partial class NativeForm
    {

        #region 操作

        private bool BeginAction(string label)
        {
            if (_actionBusy) return false;
            _actionBusy = true;
            _actionVersion++;
            UseWaitCursor = true;
            _toolbar.Enabled = false;
            _tabs.Enabled = false;
            SetStatus(label + "…");
            return true;
        }

        private Task EndActionAsync()
        {
            _actionBusy = false;
            UseWaitCursor = false;
            _toolbar.Enabled = true;
            _tabs.Enabled = true;
            _actionRefreshPending = true;
            if (!_actionRefreshRunning) _ = RefreshAfterActionAsync();
            return Task.CompletedTask;
        }

        private async Task RefreshAfterActionAsync()
        {
            _actionRefreshRunning = true;
            try
            {
                while (_actionRefreshPending && !IsDisposed && !Disposing)
                {
                    if (_busy || _actionBusy) { await Task.Delay(50); continue; }
                    _actionRefreshPending = false;
                    await RefreshAsync(false, true, true);
                }
            }
            finally { _actionRefreshRunning = false; }
        }

        private async Task DoAccount(string action, string label)
        {
            var a = SelectedAccount();
            if (a == null) { MessageBox.Show(this, "还没有选中账号。", label, MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            if (!BeginAction(label)) return;
            try
            {
                UseWaitCursor = true;
                SetStatus(label + "…");
                string json = await _api.AccountActionAsync(a.N, action);
                string msg = ApiClient.MessageOf(json);
                SetStatus(string.IsNullOrEmpty(msg) ? label + "完成" : msg);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, label, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { await EndActionAsync(); }
        }

        private async Task UnpinAsync()
        {
            var a = SelectedAccount();
            if (a == null) return;
            bool pinned = _state != null && _state.Selection != null && _state.Selection.Pinned == a.N;
            if (!pinned) return;
            var ok = MessageBox.Show(this,
                "解除账号 " + a.N + " 的固定，恢复自动轮转？" + Environment.NewLine + Environment.NewLine +
                "被固定的账号一旦限流，Codex 的请求会直接 503。",
                "解除固定", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (ok != DialogResult.Yes) return;
            await DoAccount("unpin", "解除固定");
        }

        private async Task TogglePauseAsync()
        {
            var a = SelectedAccount();
            if (a == null) return;
            await DoAccount(a.Paused ? "unpause" : "pause", a.Paused ? "恢复账号" : "暂停账号");
        }

        private async Task ToggleReserveAsync()
        {
            // 自定义规则下账号角色在「策略」页的表格里改。
            if (_state?.Policy?.Rotation != null) { _tabs.SelectedTab = _policyTab; return; }
            var a = SelectedAccount();
            if (a == null) return;
            await DoAccount(a.EmergencyOnly ? "unreserve" : "reserve", a.EmergencyOnly ? "取消储备" : "设为储备");
        }

        private async Task EditNoteAsync()
        {
            if (_actionBusy) return;
            var a = SelectedAccount();
            if (a == null) return;
            using (var dlg = new NoteDialog("备注 · 账号 " + a.N, a.Note))
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                if (!BeginAction("保存备注")) return;
                try
                {
                    UseWaitCursor = true;
                    await _api.AccountActionAsync(a.N, "note", dlg.Value);
                    SetStatus("备注已保存");
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, ex.Message, "修改备注", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                finally { await EndActionAsync(); }
            }
        }

        private async Task SavePolicyAsync()
        {
            PolicyDraft draft;
            try { draft = _policyView.BuildDraft(); }
            catch (InvalidOperationException ex)
            {
                MessageBox.Show(this, ex.Message, "策略还不能保存", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (draft == null || !BeginAction("保存策略")) return;
            _policyView.SetBusy(true);
            try
            {
                _state.Policy = await _api.SavePolicyAsync(draft.AutoSwitch, draft.MinWaitMin, draft.ReserveIndex, draft.Rotation);
                _policyView.MarkSaved();
                _policyView.Render(_state);
                SetStatus("策略已保存，下一轮检查生效");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "保存策略", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                _policyView.SetBusy(false);
                await EndActionAsync();
            }
        }

        private async Task RouterActionAsync(string action)
        {
            if (_actionBusy) return;
            string label = action == "restart" ? "重启路由" : "重新绑定";
            string ask = action == "restart"
                ? "重启本地转发路由？\n\n正在跑的 Codex 任务可能被中断几秒。"
                : "重新绑定 Codex 桌面版？\n\n只把 ~/.codex/config.toml 里指向本机路由的地址和密钥改回当前路由的值（改前自动备份）。\n不改账号、策略、额度、启动项、端口和其它 Codex 设置，也不生成新密钥。\n配置被整段删掉时会拒绝并说明如何手动恢复。\n\n完成后需要完全退出并重新打开 Codex。";
            var answer = MessageBox.Show(this, ask, label, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            if (!BeginAction(label)) return;
            try
            {
                UseWaitCursor = true;
                SetStatus("正在" + label + "…");
                string json = await _api.RouterAsync(action);
                string msg = ApiClient.MessageOf(json);
                if (string.IsNullOrEmpty(msg))
                {
                    MessageBox.Show(this, label + "完成。", label, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show(this, msg, label, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                // 失败必须弹框，不能被 100ms 后的"已刷新"覆盖掉
                MessageBox.Show(this, label + "失败：\n\n" + ex.Message, label, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { await EndActionAsync(); }
        }

        private Task AddAccountAsync() { return AddAccountCore(false); }
        private Task AddAccountDryAsync() { return AddAccountCore(true); }

    private async Task CancelLoginAsync()
    {
        if (!BeginAction("取消登录")) return;
        try { SetStatus(ApiClient.MessageOf(await _api.LoginCancelAsync())); }
        catch (Exception ex) { SetStatus("取消失败：" + ex.Message); }
        finally { await EndActionAsync(); }
    }

        private async Task AddAccountCore(bool dry)
        {
            if (!BeginAction("打开登录窗口")) return;
            AppLog.Write("AddAccount direct dry=" + dry);
            string msg = "已打开登录窗口。";
            try
            {
                UseWaitCursor = true;
                string raw = await _api.LoginAsync(dry);
                string m = ApiClient.MessageOf(raw);
                if (!string.IsNullOrEmpty(m)) msg = m;
                SetStatus(msg);
            }
            catch (Exception ex)
            {
                msg = "添加账号失败：" + ex.Message;
                MessageBox.Show(this, msg, "添加账号", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { await EndActionAsync(); }
            // 刷新会用"已刷新 hh:mm:ss"覆盖状态栏，所以刷新后再把登录结果写回去
            SetStatus(msg);
        }

        /// <summary>事件页：内容列吃满剩余宽度，避免正文要横向滚动。</summary>
        private void FitLogColumns()
        {
            if (_logList == null || _logList.Columns.Count < 3) return;
            int w0 = (int)(140 * _scale);
            int w1 = (int)(70 * _scale);
            int total = Math.Max(360, _logList.ClientSize.Width);
            _logList.Columns[0].Width = w0;
            _logList.Columns[1].Width = w1;
            _logList.Columns[2].Width = Math.Max((int)(200 * _scale), total - w0 - w1 - 6);
        }
        private void SetStatus(string text)
        {
            _stService.Text = text;
        }

        #endregion
    }
}
