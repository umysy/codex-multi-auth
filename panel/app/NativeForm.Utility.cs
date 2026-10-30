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

        #region 时间与数字

        private static string Until(double epochMs)
        {
            if (epochMs <= 0) return "—";
            TimeSpan span = DateTimeOffset.FromUnixTimeMilliseconds((long)epochMs).ToLocalTime() - DateTimeOffset.Now;
            if (span.TotalSeconds <= 0) return "已重置";
            if (span.TotalDays >= 1) return (int)span.TotalDays + " 天 " + span.Hours + " 小时后重置";
            if (span.TotalHours >= 1) return (int)span.TotalHours + " 小时 " + span.Minutes + " 分后重置";
            return Math.Max(0, span.Minutes) + " 分后重置";
        }

        private static string DateClock(double epochMs)
        {
            if (epochMs <= 0) return "—";
            return DateTimeOffset.FromUnixTimeMilliseconds((long)epochMs).ToLocalTime().ToString("MM-dd HH:mm");
        }

        #endregion
    }
}
