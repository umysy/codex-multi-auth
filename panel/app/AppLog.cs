using System;
using System.IO;

namespace CodexQuota
{
    /// <summary>极简文件日志，方便排查启动/关闭问题。</summary>
    public static class AppLog
    {
        private static readonly object Gate = new object();
        public static string PathFile = System.IO.Path.Combine(AppContext.BaseDirectory, "app.log");

        public static void Write(string message)
        {
            try
            {
                lock (Gate)
                {
                    File.AppendAllText(PathFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + Environment.NewLine);
                }
            }
            catch { }
        }
    }
}
