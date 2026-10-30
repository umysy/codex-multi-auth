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

        #region 数据刷新

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);

            // —— 手动 DPI 缩放（168 DPI = 1.75x）：控件与字体按 96 DPI 创建，这里统一放大一次。
            float s = Math.Max(1f, DeviceDpi / 96f);
            if (s > 1.01f)
            {
                SuspendLayout();
                Scale(new SizeF(s, s));
                ResumeLayout(true);
            }
            // 恢复上次窗口尺寸（缩放后物理像素）；过大的旧值（WebView2 时代）忽略
            if (_cfg.Width > 400 && _cfg.Height > 300 && _cfg.Width <= 2200 && _cfg.Height <= 1500)
                Size = new Size(_cfg.Width, _cfg.Height);
            var wa2 = Screen.FromHandle(Handle).WorkingArea;
            if (Width > wa2.Width - 40) Width = wa2.Width - 40;
            if (Height > wa2.Height - 40) Height = wa2.Height - 40;
            if (Left < 0 || Top < 0) { Left = 20; Top = 20; }

            // ListView 列宽按缩放系数重算（列宽不随 Scale() 自动放大）；日志内容列占满剩余宽度
            _scale = s;
            int[] cols = { 30, 124, 42, 50, 58, 50, 84, 54 };
            for (int i = 0; i < _list.Columns.Count && i < cols.Length; i++) _list.Columns[i].Width = (int)(cols[i] * s);
            FitLogColumns();
            AppLog.Write($"dpi={DeviceDpi} scale={s:F2} window={Width}x{Height} wa={wa2.Width}x{wa2.Height}");

            // 左右初始比例：左列表约 36%，两边都有最小宽度
            int want = (int)(ClientSize.Width * 0.44);
            _split.Panel1MinSize = 820;
            _split.Panel2MinSize = 560;
            try { _split.SplitterDistance = Math.Max(_split.Panel1MinSize, want); } catch { }

            // 窗口不允许窄到把右侧页签挤扁：最小宽度 = 左右最小宽度之和 + 边框/分隔条余量。
            // 高度不足不再需要改分辨率——策略页等内容会垂直滚动。
            MinimumSize = new Size(_split.Panel1MinSize + _split.Panel2MinSize + 80, 660);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            AppLog.Write("OnShown");
            await InitializeAsync();
        }

        private async Task InitializeAsync()
        {
            SetStatus("正在连接本地服务…");
            bool ok = await Server.EnsureUpAsync(_cfg, SetStatus);
            if (!ok)
            {
                SetStatus("本地服务没能启动");
                MessageBox.Show(this,
                    "本地服务没能启动。\n\n日志：" + Path.Combine(_cfg.PanelDir, "app-server.log") +
                    "\n\n可临时用网页版：" + _cfg.Url,
                    "Codex 额度面板", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            // 启动只读已有快照（缓存 + 路由按真实请求记下的实时额度），不做深度刷新：
            // limits --refresh 会给每个账号发一条真实请求（约 5k token），只在用户点「刷新额度」时才做。
            var sw = Stopwatch.StartNew();
            await RefreshAsync(false);
            AppLog.Write("first paint " + sw.ElapsedMilliseconds + " ms");
        }

        private async Task RefreshAsync(bool forceQuota, bool freshState = false, bool preserveStatus = false)
        {
            if (_actionBusy && !freshState) return;
            int version = _actionVersion;
            if (forceQuota)
            {
                // 深度刷新在服务端后台跑（10–20 秒）。界面全程可用：不占 _busy、不显示等待光标，
                // 只把刷新按钮置灰；进度和收尾交给定时轮询（刷新中每秒一次），见 TrackQuotaRefresh。
                if (_quotaRefreshStartedAt.HasValue)
                {
                    SetStatus("额度刷新进行中，完成后自动更新…");
                    return;
                }
                SetRefreshButtons(false);
                SetStatus("正在启动后台额度刷新…");
                try
                {
                    PanelState fresh = await _api.RefreshStateAsync();
                    if (IsDisposed || Disposing) return;
                    if (fresh.Meta?.Refreshing == true)
                    {
                        _quotaRefreshBaseline = fresh;
                        _quotaRefreshStartedAt = DateTime.Now;
                    }
                    else SetRefreshButtons(true);
                    if (version == _actionVersion && !_actionBusy)
                        ApplyState(fresh, fresh.Meta?.Refreshing == true ? "额度刷新已启动，正在后台获取…" : "额度已刷新 " + DateTime.Now.ToString("HH:mm:ss"));
                }
                catch (Exception ex)
                {
                    SetRefreshButtons(true);
                    AppLog.Write("refresh quota failed: " + ex.Message);
                    if (!IsDisposed && version == _actionVersion && !_actionBusy) SetStatus("刷新失败：" + ex.Message);
                    await RecoverServerIfDownAsync();
                }
                return;
            }

            if (_busy) return;
            _busy = true;
            try
            {
                PanelState st = await _api.GetStateAsync(freshState);
                if (IsDisposed || Disposing || version != _actionVersion || _actionBusy) return;
                var meta = st.Meta;
                var note = (meta != null && meta.Cached) ? "（缓存 " + Math.Round(meta.AgeMs / 1000.0) + " 秒前）" : "";
                string status = preserveStatus ? _stService.Text : "已刷新 " + DateTime.Now.ToString("HH:mm:ss") + note;
                ApplyState(st, status);
                AppLog.Write("render mode=" + (meta != null ? meta.Mode : "?") + " ageMs=" + (meta != null ? meta.AgeMs : -1) + " cached=" + (meta != null && meta.Cached));
            }
            catch (Exception ex)
            {
                AppLog.Write("state refresh failed: " + ex.Message);
                if (!IsDisposed && version == _actionVersion && !_actionBusy && !preserveStatus)
                    SetStatus("刷新失败：" + ex.Message);
                await RecoverServerIfDownAsync();
            }
            finally
            {
                _busy = false;
            }
        }

        private DateTime _lastServerRecoverAt = DateTime.MinValue;

        /// <summary>
        /// 本地服务进程没了（端口拒绝连接）就重新拉起，30 秒内最多一次。
        /// 以前只在启动时拉起服务：如果启动时服务已经在跑（别的进程起的），那个进程一退出，
        /// 面板就一直显示“刷新失败 … actively refused”（2026-10-29 05:48 起两个小时）。
        /// </summary>
        private async Task RecoverServerIfDownAsync()
        {
            if (IsDisposed || Disposing || Server.IsUp(_cfg)) return;
            if ((DateTime.Now - _lastServerRecoverAt).TotalSeconds < 30) return;
            _lastServerRecoverAt = DateTime.Now;
            AppLog.Write("server down -> restarting");
            bool ok = await Server.EnsureUpAsync(_cfg, SetStatus);
            AppLog.Write("server restart " + (ok ? "ok" : "failed"));
            if (!IsDisposed && ok) SetStatus("本地服务已自动重启 " + DateTime.Now.ToString("HH:mm:ss"));
        }

        private DateTime? _quotaRefreshStartedAt;
        private PanelState _quotaRefreshBaseline;

        private void SetRefreshButtons(bool enabled)
        {
            _btnRefresh.Enabled = enabled;
            _detailView.SetRefreshEnabled(enabled);
        }

        /// <summary>
        /// 手动深度刷新的进度与收尾：每次渲染新状态时调用。返回要显示的状态文字，没有进行中的刷新时返回 null。
        /// 以前是一个 60 秒的轮询循环占着 _busy 并显示等待光标，整段时间里看起来“卡住”，
        /// 切号后的界面更新也要排在它后面。
        /// </summary>
        private string TrackQuotaRefresh(PanelState st)
        {
            if (!_quotaRefreshStartedAt.HasValue) return null;
            int secs = (int)(DateTime.Now - _quotaRefreshStartedAt.Value).TotalSeconds;
            if (st.Meta?.Refreshing == true && secs < 120) return "额度刷新中… " + secs + " 秒";
            var baseline = _quotaRefreshBaseline;
            _quotaRefreshStartedAt = null;
            _quotaRefreshBaseline = null;
            SetRefreshButtons(true);
            if (st.Meta?.Refreshing == true) return "额度仍在后台刷新，稍后会自动更新";
            bool advanced = st.Accounts != null && baseline?.Accounts != null &&
                st.Accounts.Exists(a =>
                {
                    AccountState old = baseline.Accounts.Find(x => x.N == a.N);
                    return old != null && a.QuotaUpdatedAt.GetValueOrDefault() > old.QuotaUpdatedAt.GetValueOrDefault();
                });
            return advanced
                ? "额度已刷新 " + DateTime.Now.ToString("HH:mm:ss")
                : "刷新完成，但上游未返回新额度，暂保留旧快照";
        }

        #endregion
    }
}
