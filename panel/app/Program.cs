using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CodexQuota
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            AppLog.Write("=== process start, args: " + string.Join(" ", Environment.GetCommandLineArgs()) + " ===");
            AppDomain.CurrentDomain.UnhandledException += (s, e) => AppLog.Write("UnhandledException: " + e.ExceptionObject);
            AppDomain.CurrentDomain.ProcessExit += (s, e) => AppLog.Write("ProcessExit");

            if (args != null && Array.IndexOf(args, "--selftest") >= 0)
            {
                SelfTest();
                return;
            }

            using (var mutex = new Mutex(true, "CodexQuotaPanel_SingleInstance_v1", out bool first))
            {
                if (!first)
                {
                    AppLog.Write("another instance already running, exit");
                    MessageBox.Show(
                        "「Codex 额度面板」已经在运行了。\n\n如果找不到窗口，请查看右下角托盘图标（双击可打开）。",
                        "Codex 额度面板",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }

                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (s, e) => AppLog.Write("ThreadException: " + e.Exception);
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                try
                {
                    AppLog.Write("Run(NativeForm)");
                    Application.Run(new NativeForm());
                    AppLog.Write("Application.Run returned");
                }
                catch (Exception ex)
                {
                    AppLog.Write("Fatal: " + ex);
                    MessageBox.Show(
                        "启动失败：\n\n" + ex,
                        "Codex 额度面板",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
            }
            AppLog.Write("=== process end ===");
        }

        /// <summary>无窗口自检：证明「添加账号」确认框在用户勾选前，确认按钮是禁用的。</summary>
        private static void SelfTest()
        {
            var lines = new List<string>();
            try
            {
                using (var dlg = new LoginPromptDialog(1f))
                {
                    lines.Add("initial  okEnabled=" + dlg.OkEnabled + " ack=" + dlg.AckChecked + " dry=" + dlg.DryRun);
                    dlg.SetDry(true); lines.Add("setDry(true) dry=" + dlg.DryRun);
                    dlg.SetDry(false); lines.Add("setDry(false) dry=" + dlg.DryRun);
                    dlg.SetAck(true);
                    lines.Add("ack=true okEnabled=" + dlg.OkEnabled);
                    dlg.SetAck(false);
                    lines.Add("ack=false okEnabled=" + dlg.OkEnabled);
                    bool ok = !dlg.OkEnabled && !dlg.AckChecked && !dlg.DryRun;
                    lines.Add(ok ? "LOGIN-GATE-SELFTEST OK" : "LOGIN-GATE-SELFTEST FAIL");
                }
            }
            catch (Exception ex)
            {
                lines.Add("SELFTEST EXCEPTION: " + ex);
                lines.Add("LOGIN-GATE-SELFTEST FAIL");
            }
            var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "selftest.txt");
            File.WriteAllLines(path, lines, new UTF8Encoding(true));
            AppLog.Write("SelfTest done -> " + path);
        }
    }
}