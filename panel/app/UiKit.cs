using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 各页共用的小部件与文案格式。页面都按 96 DPI 构建、由主窗口整体 Scale()，
    /// 所以这里只用 AutoSize 与相对边距，不写死会被放大字体撑破的行高。
    /// </summary>
    internal static class UiKit
    {
        public static readonly Color Good = Color.FromArgb(0, 128, 64);
        public static readonly Color Warn = Color.FromArgb(176, 100, 0);
        public static readonly Color Bad = Color.FromArgb(180, 30, 30);

        public static Label Heading(string text, int top = 18)
        {
            var label = new Label { Text = text, AutoSize = true, Margin = new Padding(0, top, 0, 6) };
            label.Font = new Font(label.Font.FontFamily, label.Font.Size + 1.5f, FontStyle.Bold);
            return label;
        }

        public static Label TextLabel(string text = "", bool gray = false) =>
            new Label { Text = text, AutoSize = true, Margin = new Padding(0, 3, 0, 3), ForeColor = gray ? SystemColors.GrayText : SystemColors.ControlText };

        /// <summary>两列表格：左边灰色标题，右边内容。</summary>
        public static TableLayoutPanel FieldTable()
        {
            var t = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, Margin = new Padding(0) };
            t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            return t;
        }

        public static void AddField(TableLayoutPanel table, string caption, Control value)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = caption, AutoSize = true, ForeColor = SystemColors.GrayText, Anchor = AnchorStyles.Left | AnchorStyles.Top, Margin = new Padding(0, 4, 18, 4) }, 0, row);
            value.Anchor = AnchorStyles.Left | AnchorStyles.Top;
            value.Margin = new Padding(0, 4, 0, 4);
            table.Controls.Add(value, 1, row);
        }

        public static FlowLayoutPanel ButtonRow() =>
            new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Margin = new Padding(0, 14, 0, 0) };

        public static Button MakeButton(string text, string name = null) =>
            new Button { Name = name, Text = text, AutoSize = true, MinimumSize = new Size(96, 30), Padding = new Padding(8, 0, 8, 0), Margin = new Padding(0, 0, 8, 8) };

        public static string UntilPast(long epochMs)
        {
            TimeSpan span = DateTimeOffset.Now - DateTimeOffset.FromUnixTimeMilliseconds(epochMs).ToLocalTime();
            if (span.TotalDays >= 1) return (int)span.TotalDays + " 天前";
            if (span.TotalHours >= 1) return (int)span.TotalHours + " 小时前";
            if (span.TotalMinutes >= 1) return (int)span.TotalMinutes + " 分钟前";
            return "刚刚";
        }

        public static string Clock(long epochMs) =>
            epochMs <= 0 ? "—" : DateTimeOffset.FromUnixTimeMilliseconds(epochMs).ToLocalTime().ToString("HH:mm:ss");

        /// <summary>重置时刻：“01:48（4 小时 48 分后）”；周窗口带日期。</summary>
        public static string ResetText(QuotaWindow w, bool weekly)
        {
            double at = w?.ResetAt ?? 0;
            if (at <= 0) return "";
            var when = DateTimeOffset.FromUnixTimeMilliseconds((long)at).ToLocalTime();
            string abs = when.ToString(weekly ? "MM-dd HH:mm" : "HH:mm");
            TimeSpan span = when - DateTimeOffset.Now;
            if (span.TotalSeconds <= 0) return abs + " 已重置";
            string rel = span.TotalDays >= 1 ? (int)span.TotalDays + " 天 " + span.Hours + " 小时"
                : span.TotalHours >= 1 ? (int)span.TotalHours + " 小时 " + span.Minutes + " 分"
                : Math.Max(1, span.Minutes) + " 分";
            return abs + " 重置（" + rel + "后）";
        }

        /// <summary>
        /// 运行时原因 → 人话。CLI 的 “primary/secondary quota N% used” 与额度条重复（而且常常是旧快照），不显示。
        /// </summary>
        public static string ReasonText(string reason)
        {
            string r = (reason ?? "").Trim().ToLowerInvariant();
            if (r.Length == 0 || r.Contains("quota") && r.Contains("% used")) return "";
            if (r == "rate-limited") return "被上游限流（429），窗口重置后自动恢复";
            if (r == "quota-exhausted") return "额度已用完，窗口重置后自动恢复";
            if (r.StartsWith("cooling-down")) return "网络抖动后短暂冷却，稍后自动恢复";
            if (r.Contains("capacity")) return "上游模型繁忙，路由会自动换号重试";
            if (r.Contains("auth") || r.Contains("token") || r.Contains("unauthori")) return "登录失效，需要重新登录这个账号";
            if (r.StartsWith("policy: paused") || r == "paused") return "已暂停";
            // 储备号的“policy: emergency backup reserved”与上面的“储备号”状态重复。
            if (r.StartsWith("policy:") && r.Contains("emergency")) return "";
            if (r == "model-not-supported") return "这个账号不支持当前模型";
            return reason.Trim();
        }

        /// <summary>日志行本身以类型开头（“RESUME 额度窗口…”），末尾带 run=id；类型已有单独一列，两样都去掉。</summary>
        public static string CleanLogMessage(string kind, string msg)
        {
            string m = (msg ?? "").Trim();
            if (!string.IsNullOrEmpty(kind) && m.StartsWith(kind + " ", StringComparison.Ordinal)) m = m.Substring(kind.Length).TrimStart();
            return System.Text.RegularExpressions.Regex.Replace(m, @"\s+run=[0-9a-f]+\s*$", "");
        }
    }

    /// <summary>扁平额度条：按剩余比例着色（≥30% 绿、10–30% 橙、<10% 红），过期或未知时为灰色。</summary>
    internal sealed class QuotaBar : Control
    {
        private double? _remaining;
        private bool _muted;

        public QuotaBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Size = new Size(220, 14);
            Margin = new Padding(0, 7, 12, 7);
        }

        public void SetValue(double? remaining, bool muted)
        {
            if (_remaining == remaining && _muted == muted) return;
            _remaining = remaining;
            _muted = muted;
            Invalidate();
        }

        public static Color ColorFor(double remaining) => remaining >= 30 ? UiKit.Good : remaining >= 10 ? UiKit.Warn : UiKit.Bad;

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            var r = ClientRectangle;
            using (var track = new SolidBrush(Color.FromArgb(226, 226, 226))) g.FillRectangle(track, r);
            if (_remaining.HasValue)
            {
                double v = Math.Max(0, Math.Min(100, _remaining.Value));
                int w = (int)Math.Round(r.Width * v / 100.0);
                Color c = _muted ? Color.FromArgb(170, 170, 170) : ColorFor(v);
                using (var fill = new SolidBrush(c)) g.FillRectangle(fill, new Rectangle(r.X, r.Y, w, r.Height));
            }
        }
    }
}
