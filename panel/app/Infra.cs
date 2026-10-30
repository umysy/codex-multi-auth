using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Tasks;

namespace CodexQuota
{
    /// <summary>exe 同目录的 app-config.json：记录路径、窗口位置与开机自启状态。</summary>
    public sealed class AppConfig
    {
        public string NodeExe { get; set; } = "node.exe";
        public string PanelDir { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "multi-auth", "panel");
        public string Url { get; set; } = "http://127.0.0.1:8766/";
        public string CliCmd { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "codex-multi-auth.cmd");
        public int Width { get; set; } = 1500;
        public int Height { get; set; } = 980;
        public int X { get; set; } = -1;
        public int Y { get; set; } = -1;
        public bool Maximized { get; set; }

        public static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "app-config.json");

        public static AppConfig Load()
        {
            try
            {
                if (File.Exists(ConfigPath))
                {
                    var cfg = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath));
                    if (cfg != null) return cfg;
                }
            }
            catch { /* 配置损坏时用默认值 */ }
            return new AppConfig();
        }

        public void Save()
        {
            try
            {
                File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch { /* 只读目录时忽略 */ }
        }
    }

    /// <summary>管理面板 Node 服务：探测端口、必要时后台拉起、等待就绪。</summary>
    public static class Server
    {
        private static Process _owned;

        /// <summary>退出时停掉本程序拉起的面板服务；若上次退出残留了 node server.js，也一并清掉，避免端口常驻。</summary>
        public static void StopOwned(AppConfig cfg)
        {
            try
            {
                if (_owned != null && !_owned.HasExited) { _owned.Kill(true); _owned.WaitForExit(3000); }
            }
            catch { }
            try
            {
                var uri = new Uri(cfg.Url);
                foreach (var pid in FindListeners(uri.Port))
                {
                    try
                    {
                        var proc = Process.GetProcessById(pid);
                        if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) continue;
                        proc.Kill(true);
                        proc.WaitForExit(3000);
                    }
                    catch { }
                }
            }
            catch { }
        }

        private static System.Collections.Generic.List<int> FindListeners(int port)
        {
            var list = new System.Collections.Generic.List<int>();
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano -p tcp")
                { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true };
                var p = Process.Start(psi);
                string text = p.StandardOutput.ReadToEnd();
                p.WaitForExit(3000);
                foreach (var raw in text.Split('\n'))
                {
                    var line = raw.Trim();
                    if (line.Length == 0) continue;
                    if (line.IndexOf("127.0.0.1:" + port, StringComparison.Ordinal) < 0) continue;
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid)) list.Add(pid);
                }
            }
            catch { }
            return list;
        }

        public static bool IsUp(AppConfig cfg, int timeoutMs = 700)
        {
            try
            {
                var uri = new Uri(cfg.Url);
                using (var tcp = new TcpClient())
                {
                    var ar = tcp.BeginConnect(uri.Host, uri.Port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                    tcp.EndConnect(ar);
                    return tcp.Connected;
                }
            }
            catch { return false; }
        }

        public static Process Start(AppConfig cfg)
        {
            string logPath = Path.Combine(cfg.PanelDir, "app-server.log");
            var psi = new ProcessStartInfo
            {
                FileName = cfg.NodeExe,
                Arguments = "server.js",
                WorkingDirectory = cfg.PanelDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var p = Process.Start(psi);
            if (p == null) throw new InvalidOperationException("无法启动 node 进程");
            _owned = p;
            p.OutputDataReceived += (s, e) => { if (e.Data != null) Append(logPath, e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) Append(logPath, e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        private static void Append(string path, string line)
        {
            try { File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine); }
            catch { }
        }

        public static async Task<bool> EnsureUpAsync(AppConfig cfg, Action<string> status)
        {
            if (IsUp(cfg)) return true;

            status("正在启动本地服务…");
            try
            {
                Start(cfg);
            }
            catch (Exception ex)
            {
                status("本地服务启动失败：" + ex.Message);
                return false;
            }

            for (int i = 0; i < 80; i++)
            {
                await Task.Delay(250);
                if (IsUp(cfg)) return true;
            }
            return false;
        }
    }
}
