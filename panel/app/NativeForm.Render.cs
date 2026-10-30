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

        #region 渲染

        /// <summary>把一份状态画到界面上（供首次渲染、定时刷新、手动刷新共用）。</summary>
        private void ApplyState(PanelState st, string status)
        {
            if (Visible && WindowState != FormWindowState.Minimized && _tabs.SelectedTab?.Text == "用量")
                _usageView?.MaybeRefresh(false);
            if (st == null) return;
            _state = st;
            _timer.Interval = st.Meta?.Refreshing == true ? 1000 : 15000;
            status = TrackQuotaRefresh(st) ?? status;
            RenderAccounts(st);
            RenderDetail();
            RenderLogs(st);
            RenderPolicy(st);
            RenderRouter(st);
            RenderStatusBar(st);
            NotifyRuntimeIncident(st);
            UpdateTrayAccount(st);
            if (!string.IsNullOrEmpty(status)) SetStatus(status);
        }


        /// <summary>把当前账号显示到托盘 tooltip 与菜单首行；切号时弹一次气泡。
        /// 注意：NotifyIcon.Text 上限 63 个字符，超长要截断，否则 SetText 会抛异常。</summary>
        private void UpdateTrayAccount(PanelState st)
        {
            var cur = st.Current;
            var shown = InUseAccount(st);
            string label = shown == null
                ? "无当前账号"
                : (string.IsNullOrWhiteSpace(shown.Email) ? "账号 " + shown.N : "账号 " + shown.N + " · " + shown.Email);
            string tip = "Codex 额度面板 · " + label;
            if (tip.Length > 63) tip = tip.Substring(0, 60) + "…";
            try
            {
                if (_tray.Text != tip) _tray.Text = tip;
                if (_trayAccountItem != null) _trayAccountItem.Text = "使用中：" + label;
                bool switched = cur != null && _lastTrayAccountN != 0 && cur.N != _lastTrayAccountN;
                if (switched)
                {
                    _tray.BalloonTipTitle = "已切换到账号 " + cur.N;
                    _tray.BalloonTipText = label;
                    _tray.ShowBalloonTip(6000);
                    ShowAccountToast("已切换到账号 " + cur.N + "\n" + label);
                }
                if (cur != null) _lastTrayAccountN = cur.N;
            }
            catch { }
        }

        /// <summary>右下角自绘提示：系统气泡在“通知被关或图标被折叠”时不显示，所以自己画一个小窗，
        /// 贴工作区右下角，4.2 秒后自动隐藏，不抢焦点。</summary>
        private void ShowAccountToast(string text)
        {
            try
            {
                if (_accountToast == null)
                {
                    _accountToastLabel = new Label
                    {
                        Dock = DockStyle.Fill,
                        AutoSize = false,
                        ForeColor = Color.White,
                        TextAlign = ContentAlignment.MiddleLeft,
                        Padding = new Padding(16, 0, 16, 0),
                        Font = new Font("Microsoft YaHei UI", 10f * _scale, FontStyle.Regular),
                    };
                    _accountToast = new Form
                    {
                        FormBorderStyle = FormBorderStyle.None,
                        ShowInTaskbar = false,
                        TopMost = true,
                        StartPosition = FormStartPosition.Manual,
                        BackColor = Color.FromArgb(28, 28, 30),
                        Opacity = 0.96,
                    };
                    _accountToast.Controls.Add(_accountToastLabel);
                    _accountToastTimer = new Timer { Interval = 4200 };
                    _accountToastTimer.Tick += (s, e) => { _accountToastTimer.Stop(); _accountToast.Hide(); };
                }
                _accountToastLabel.Text = text;
                int w = (int)(400 * _scale);
                int h = (int)(76 * _scale);
                _accountToast.Size = new Size(w, h);
                var wa = Screen.PrimaryScreen.WorkingArea;
                _accountToast.Location = new Point(wa.Right - w - (int)(24 * _scale), wa.Bottom - h - (int)(24 * _scale));
                _accountToast.Show();
                TopMostWindow.Raise(_accountToast.Handle);
                AppLog.Write("account-toast: " + text.Replace("\n", " / "));
                _accountToast.BringToFront();
                _accountToastTimer.Stop();
                _accountToastTimer.Start();
            }
            catch (Exception ex) { AppLog.Write("account-toast failed: " + ex.Message); }
        }
        private void NotifyRuntimeIncident(PanelState st)
        {
            string incident = st.Runtime?.GlobalIncident;
            string policyError = st.Schedule?.ErrorCode;
            string alert = !string.IsNullOrEmpty(incident) ? "global:" + incident : policyError;
            if (string.IsNullOrEmpty(alert)) { _lastRuntimeAlert = null; return; }
            if (alert == _lastRuntimeAlert) return;
            _lastRuntimeAlert = alert;
            try
            {
                _tray.BalloonTipTitle = "Codex 多账号自动恢复";
                _tray.BalloonTipText = !string.IsNullOrEmpty(incident)
                    ? "检测到全局运行时故障：" + incident + "。系统正在等待恢复并保留诊断记录。"
                    : "策略出现错误：" + policyError + "。请查看事件记录。";
                _tray.ShowBalloonTip(8000);
            }
            catch { }
        }

        private void RenderAccounts(PanelState st)
        {
            if (st == null || st.Accounts == null) return;
            string signature = System.Text.Json.JsonSerializer.Serialize(new { st.Accounts, st.Selection });
            if (signature == _accountsSignature) return;
            int keep = _selectedN;
            _suppressScopeLink = true;
            _list.BeginUpdate();
            try
            {
                var existing = new Dictionary<int, ListViewItem>();
                foreach (ListViewItem row in _list.Items)
                    if (row.Tag is int n) existing[n] = row;
                var retained = new HashSet<int>();
                foreach (var a in st.Accounts)
                {
                    bool added = !existing.TryGetValue(a.N, out var item);
                    if (added)
                    {
                        item = new ListViewItem();
                        for (int i = 1; i < 8; i++) item.SubItems.Add("");
                    }
                    string[] values = { a.N.ToString(), a.Email ?? ("账号 " + a.N), RoleText(a),
                        QuotaText(a.H5), ClockOf(a.H5, false), QuotaText(a.H7), ClockOf(a.H7, true), StatusText(a) };
                    for (int i = 0; i < values.Length; i++)
                        if (item.SubItems[i].Text != values[i]) item.SubItems[i].Text = values[i];
                    item.Tag = a.N;
                    item.ToolTipText = (a.Note ?? "") + (string.IsNullOrEmpty(a.Reason) ? "" : "  " + a.Reason);
                    item.Font = a.InUse ? _listBoldFont : Font;
                    item.ForeColor = a.Paused ? SystemColors.GrayText : _list.ForeColor;
                    item.SubItems[4].ForeColor = a.InUse ? Color.FromArgb(0, 120, 60) : item.ForeColor;
                    if (added) _list.Items.Add(item);
                    retained.Add(a.N);
                    if (a.N == keep && !item.Selected) item.Selected = true;
                }
                foreach (var row in existing)
                    if (!retained.Contains(row.Key)) _list.Items.Remove(row.Value);
                if (_list.SelectedItems.Count == 0 && _list.Items.Count > 0) { _suppressScopeLink = true; _list.Items[0].Selected = true; _suppressScopeLink = false; }
            }
            finally
            {
                _list.EndUpdate();
                _suppressScopeLink = false;
            }
            _lblEmpty.Visible = _list.Items.Count == 0;
            _lblEmpty.Text = _list.Items.Count == 0 ? "没有读到账号（服务返回为空）" : "";
            _list.Visible = _list.Items.Count > 0;
            _accountsSignature = signature;
        }

        private static string RoleText(AccountState a)
        {
            if (a.Paused) return "暂停";
            if (a.EmergencyOnly || string.Equals(a.Role, "reserve", StringComparison.OrdinalIgnoreCase)) return ReserveRole;
            return ProviderRole;
        }

        private static string ClockOf(QuotaWindow w, bool weekly)
        {
            if (w == null || !w.Remaining.HasValue) return "—";
            double at = w.ResetAt ?? 0;
            if (at <= 0) return "—";
            return DateTimeOffset.FromUnixTimeMilliseconds((long)at).ToLocalTime().ToString(weekly ? "MM-dd HH:mm" : "HH:mm");
        }

        private static string QuotaText(QuotaWindow w)
        {
            if (w == null || !w.Remaining.HasValue) return "无限制";
            return ((int)Math.Round(w.Remaining.Value)) + "%";
        }

        private string StatusText(AccountState a)
        {
            bool pinned = _state != null && _state.Selection != null && _state.Selection.Pinned == a.N;
            // 使用中 = 路由实际在用的账号（会话亲和会让对话留在开局的账号上）；
            // 首选 = 策略选定的账号，新对话会从它开始。两者不同时分开显示，额度看“使用中”那一行。
            if (a.InUse) return pinned ? "使用中·已固定" : "使用中";
            if (a.Current) return pinned ? "首选·已固定" : "首选";
            if (pinned) return "已固定";
            if (a.Paused) return "已暂停";
            if (!a.Available) return "不可用";
            return "可用";
        }

        private AccountState SelectedAccount()
        {
            if (_state == null || _state.Accounts == null) return null;
            foreach (var a in _state.Accounts)
            {
                if (a.N == _selectedN) return a;
            }
            if (_state.Current != null) return _state.Current;
            return _state.Accounts.Count > 0 ? _state.Accounts[0] : null;
        }

        private void RenderDetail()
        {
            var a = SelectedAccount();
            if (a != null) _selectedN = a.N;
            _detailView.Render(a, _state);
        }

        private void RenderLogs(PanelState st)
        {
            string signature = System.Text.Json.JsonSerializer.Serialize(st?.Logs);
            if (signature == _logsSignature) return;
            _logList.BeginUpdate();
            try
            {
                _logList.Items.Clear();
                if (st != null && st.Logs != null)
                {
                    foreach (var log in st.Logs)
                    {
                        var item = new ListViewItem(log.At ?? "");
                        string kind = (log.Kind ?? "").Trim();
                        item.SubItems.Add(kind);
                        string msg = UiKit.CleanLogMessage(kind, log.Msg);
                        item.SubItems.Add(msg);
                        item.ToolTipText = msg;
                        item.ForeColor = KindColor(kind);
                        if (kind == "SWITCH" || kind == "ERROR" || kind == "DEAD") item.Font = _listBoldFont;
                        _logList.Items.Add(item);
                    }
                }
            }
            finally
            {
                _logList.EndUpdate();
            }
            _logsSignature = signature;
        }

        private static Color KindColor(string kind)
        {
            switch (kind)
            {
                case "OK": return Color.FromArgb(0, 120, 60);
                case "LIMIT": return Color.FromArgb(170, 95, 0);
                case "WAIT": return SystemColors.GrayText;
                case "SWITCH": return Color.FromArgb(0, 80, 160);
                case "DEAD":
                case "ERROR": return Color.FromArgb(180, 30, 30);
                case "ROUTER": return Color.FromArgb(110, 70, 180);
                case "GUARD": return Color.FromArgb(120, 90, 0);
                default: return SystemColors.ControlText;
            }
        }

        private void RenderPolicy(PanelState st)
        {
            _policyView?.Render(st);
        }

        private void RenderRouter(PanelState st)
        {
            _routerView.Render(st);
        }

        private void RenderStatusBar(PanelState st)
        {
            if (st == null) return;
            _stService.Text = "服务：已连接";
            string who = WhoText(st);
            // 状态栏只放在用的账号（首选已在工具栏），否则一行放不下，和右侧的路由/时间叠在一起。
            var used = InUseAccount(st);
            _stAccount.Text = "使用中：" + (used == null ? "—" : used.Email);
            if (st.Totals != null)
            {
                // weekRemaining 是各账号 7 天剩余百分比之和；消耗速度与预算的单位都是 %/小时。
                int n = st.Accounts?.Count ?? 0;
                _stWeek.Text = "7 天额度合计剩余 " + ((int)Math.Round(st.Totals.WeekRemaining ?? 0)) + "%（" + n + " 个号）"
                    + ((st.Totals.DarkAt ?? 0) > 0 ? " · 按当前速度 " + DateClock(st.Totals.DarkAt ?? 0) + " 用完" : "");
                _stWeek.ToolTipText = "每小时消耗 " + (st.Totals.DrainPerHour ?? 0) + "%，预算 " + (st.Totals.BudgetRate ?? 0) + "%/小时";
            }
            if (st.Router != null)
            {
                _stRouter.Text = "路由：" + (st.Router.Running ? "在线" : "离线") + " · " + st.Router.Requests + " 请求 · " + st.Router.Rotations + " 轮转";
            }
            _stUpdated.Text = "更新 " + DateTime.Now.ToString("HH:mm:ss");
            _lblWho.Text = who;
            var inUse = InUseAccount(st);
            Text = "Codex 额度面板 — " + (inUse == null ? "" : inUse.Email);
        }

        /// <summary>路由实际在用的账号；服务端没给 inUse 时退回策略首选。</summary>
        private static AccountState InUseAccount(PanelState st) => st?.Accounts?.Find(a => a.InUse) ?? st?.Current;

        /// <summary>“使用中：A”；策略首选是另一个账号时补一句“（首选：B）”，免得把首选当成在扣额度的号。</summary>
        private static string WhoText(PanelState st)
        {
            var inUse = InUseAccount(st);
            if (inUse == null) return "使用中：—";
            string text = "使用中：" + inUse.Email;
            if (st.Current != null && st.Current.N != inUse.N) text += "（首选：" + st.Current.Email + "）";
            return text;
        }

        #endregion
    }
}
