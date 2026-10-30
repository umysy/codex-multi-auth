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

        #region 托盘与窗口生命周期

        private void ShowPanel()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        private void OpenWebFallback()
        {
            try { Process.Start(new ProcessStartInfo(_cfg.Url) { UseShellExecute = true }); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "打开网页版", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        private static void OpenFolder(string path)
        {
            try { Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"") { UseShellExecute = true }); }
            catch { }
        }

        private static void OpenText(string path)
        {
            try
            {
                if (!File.Exists(path)) { MessageBox.Show("找不到文件：\n" + path, "提示", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch { }
        }

        /// <summary>统一托盘清理：先隐���再从通知区删除，然后释放 Icon（含 HICON），重复调用安全。</summary>
        private void DisposeTray()
        {
            if (_trayDisposed) return;
            _trayDisposed = true;
            try { _tray.Visible = false; _tray.ContextMenuStrip = null; } catch { }
            try { _tray.Icon = null; } catch { }
            try { _tray.Dispose(); } catch { }
            try { _accountToastTimer?.Stop(); _accountToast?.Hide(); _accountToast?.Dispose(); } catch { }
            try { if (_icon != null) _icon.Dispose(); } catch { }
        }

        private void ExitApp()
        {
            _exiting = true;
            _timer.Stop();
            SaveBounds();
            DisposeTray();
            try { Server.StopOwned(_cfg); AppLog.Write("stopped panel server on exit, tray disposed"); }
            catch (Exception ex) { AppLog.Write("stop server failed: " + ex.Message); }
            Application.Exit();
        }

        // 用户明确不需要开机自启：启动时顺手清掉旧版本可能写入的 Run 项。
        private static void EnsureNoAutoStart()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (key?.GetValue(RunValue) != null) key.DeleteValue(RunValue, false);
                }
            }
            catch { }
        }

        private void SaveBounds()
        {
            try
            {
                _cfg.Maximized = WindowState == FormWindowState.Maximized;
                if (WindowState == FormWindowState.Normal)
                {
                    _cfg.Width = Width;
                    _cfg.Height = Height;
                    _cfg.X = Location.X;
                    _cfg.Y = Location.Y;
                }
                _cfg.Save();
            }
            catch { }
        }

        protected override void OnResizeEnd(EventArgs e)
        {
            base.OnResizeEnd(e);
            SaveBounds();
            FitLogColumns();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            AppLog.Write("OnFormClosing reason=" + e.CloseReason + " exiting=" + _exiting);
            if (_exiting || e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
            {
                base.OnFormClosing(e);
                return;
            }
            // 用户点 X = 真正退出：释放 8766 端口、移除托盘图标，下次打开再重新拉起服务。
            e.Cancel = true;
            ExitApp();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            // 无论走哪条关闭路径（用户点 X / 任务管理器 / 系统注销），都要停掉面板服务并移除托盘图标。
            try
            {
                SaveBounds();
                DisposeTray();
                Server.StopOwned(_cfg);
                AppLog.Write("OnFormClosed: server stopped, tray disposed");
            }
            catch (Exception ex) { AppLog.Write("OnFormClosed error: " + ex.Message); }
            base.OnFormClosed(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer.Stop();
                _timer.Dispose();
                DisposeTray();
            }
            base.Dispose(disposing);
            if (disposing) _listBoldFont.Dispose();
        }

        #endregion
    }
}
