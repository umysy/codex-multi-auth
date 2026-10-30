using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 「用量」页：token 消耗统计与分析，可按账号切换 / 全部合计。
    /// “全部账号”来自 Codex 会话文件；单个账号来自路由账本（每个请求实际用的账号）。
    /// token 里绝大部分是缓存输入（实测约 97%），它占的额度远少于新输入和输出，所以每个数字下面都拆开显示。
    /// </summary>
    internal sealed class UsageView : ScrollPage
    {
        private readonly ApiClient _api;
        private readonly Label _lblToday, _lblWeek, _lblCache, _lblWindow, _lblFoot, _lblQuota, _lblScope;
        private readonly Label _subToday, _subWeek, _subCache, _subWindow, _capWeek;
        private readonly ChartPanel _chart;
        private readonly ListView _sessions, _roles, _models;
        private readonly ComboBox _scope;
        private readonly TableLayoutPanel _pair;

        private UsageState _all;
        private bool _busy;
        private DateTime _lastFetch = DateTime.MinValue;
        private bool _scopeInited;

        // 整页竖向滚动、每块占满宽度。以前四块（数字 / 图 / 三个表并排）挤在一屏里，
        // 下面三个表各只有三分之一宽，列全被截成“gpt-6.1-...”“13.07...”。
        public UsageView(ApiClient api)
        {
            _api = api;

            var bar = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            bar.Controls.Add(new Label { Text = "账号范围", AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 6, 10, 0) });
            _scope = new ComboBox { Name = "usage-scope", Width = 340, DropDownStyle = ComboBoxStyle.DropDownList, Margin = new Padding(0, 2, 0, 0) };
            _scope.SelectedIndexChanged += (s, e) => Render();
            bar.Controls.Add(_scope);
            Add(bar);
            _lblScope = Wrap(new Label { AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 6, 0, 10),
                Text = "全部账号 = Codex 会话记录；单个账号 = 路由账本（每个请求实际用的账号）。" });
            Add(_lblScope);

            var stats = new TableLayoutPanel { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, Height = 118, ColumnCount = 4, RowCount = 1, Margin = new Padding(0) };
            for (int i = 0; i < 4; i++) stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
            _lblToday = Stat(stats, 0, "今日 token", out _subToday, out _);
            _lblWeek = Stat(stats, 1, "近 7 天 token", out _subWeek, out _capWeek);
            _lblCache = Stat(stats, 2, "缓存命中率", out _subCache, out _);
            _lblWindow = Stat(stats, 3, "本周额度窗口", out _subWindow, out _);
            Add(stats);

            _chart = new ChartPanel { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, Height = 210, Margin = new Padding(0, 8, 0, 6) };
            Add(_chart);
            _lblQuota = Wrap(new Label { Name = "usage-windows", AutoSize = true, ForeColor = Color.FromArgb(60, 66, 78), Margin = new Padding(0, 2, 0, 0), Text = "周额度窗口：统计中…" });
            Add(_lblQuota);

            Scroller.Name = "usage-scroller";
            Add(UiKit.Heading("会话排行（按 token）"));
            _sessions = List("usage-sessions", new[] { "日期", "项目", "会话", "token" }, 270);
            Add(_sessions);

            var pair = _pair = new TableLayoutPanel { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, ColumnCount = 2, RowCount = 2, Height = 240, Margin = new Padding(0) };
            pair.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            pair.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
            pair.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            pair.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
            _roles = List("usage-roles", new[] { "角色", "token", "占比" }, 0);
            _models = List("usage-models", new[] { "名称", "token", "占比" }, 0);
            _roles.Dock = _models.Dock = DockStyle.Fill;
            _roles.Margin = new Padding(0, 0, 8, 0);
            pair.Controls.Add(UiKit.Heading("角色分布（谁在烧 token）"), 0, 0);
            pair.Controls.Add(UiKit.Heading("模型 / 项目"), 1, 0);
            pair.Controls.Add(_roles, 0, 1);
            pair.Controls.Add(_models, 1, 1);
            Add(pair);

            _lblFoot = Wrap(new Label { Name = "usage-foot", AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 10, 0, 0), Text = "统计中…" });
            Add(_lblFoot);
        }

        private ListView List(string name, string[] cols, int height)
        {
            var lv = new ListView { Name = name, View = View.Details, FullRowSelect = true, HideSelection = true, ShowItemToolTips = true, Margin = new Padding(0) };
            if (height > 0) { lv.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top; lv.Height = height; }
            foreach (var c in cols) lv.Columns.Add(c, 80);
            lv.ClientSizeChanged += (s, e) => FitColumns();
            return lv;
        }

        private Label Stat(TableLayoutPanel host, int col, string caption, out Label sub, out Label cap)
        {
            var box = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 2, 10, 2), Margin = new Padding(0) };
            var value = new Label { Text = "—", Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
            sub = new Label { Text = "", Dock = DockStyle.Bottom, Height = 38, ForeColor = SystemColors.GrayText, TextAlign = ContentAlignment.TopLeft, AutoEllipsis = true };
            cap = new Label { Text = caption, Dock = DockStyle.Top, Height = 20, ForeColor = SystemColors.GrayText, TextAlign = ContentAlignment.MiddleLeft };
            box.Controls.Add(value);
            box.Controls.Add(sub);
            box.Controls.Add(cap);
            host.Controls.Add(box, col, 0);
            return value;
        }

        /// <summary>“新输入 X · 输出 Y”：缓存输入单独不列（它就是总量里减掉的那部分）。</summary>
        private static string Split(long input, long cached, long output) =>
            "新输入 " + Fmt(Math.Max(0, input - cached)) + " · 输出 " + Fmt(output);

        /// <summary>数字下面的两行小字版本。</summary>
        private static string SplitLines(long input, long cached, long output) =>
            "新输入 " + Fmt(Math.Max(0, input - cached)) + "\n输出 " + Fmt(output);

        private static string AccountNo(string key) =>
            key != null && key.StartsWith("a") && int.TryParse(key.Substring(1), out int i) ? (i + 1).ToString() : "?";

        private static string AccountName(string key, string label)
        {
            string n = key != null && key.StartsWith("a") && int.TryParse(key.Substring(1), out int i) ? "账号 " + (i + 1) : "账号";
            if (string.IsNullOrEmpty(label)) return n;
            int at = label.IndexOf('@');
            return n + " · " + (at > 0 ? label.Substring(0, at) : label);
        }

        public async void MaybeRefresh(bool force)
        {
            if (!Visible) return;
            if (_busy) return;
            if (!force && _all != null && (DateTime.Now - _lastFetch).TotalSeconds < 180) return;
            _busy = true;
            _lblFoot.Text = "统计中（扫描 session 文件，约 3 秒）…";
            try
            {
                UsageState u = await _api.GetUsageAsync(7, force);
                _lastFetch = DateTime.Now;
                if (u != null) ShowData(u);
            }
            catch (Exception ex) { _lblFoot.Text = "用量统计失败：" + ex.Message; }
            finally { _busy = false; }
        }

        /// <summary>直接显示一份数据（MaybeRefresh 拿到数据后、以及桌面规则测试用）。</summary>
        internal void ShowData(UsageState u)
        {
            _all = u;
            BuildScopeItems();
            Render();
        }

        private void BuildScopeItems()
        {
            int keep = _scope.SelectedIndex;
            _scope.BeginUpdate();
            _scope.Items.Clear();
            _scope.Items.Add("全部账号（合计）");
            if (_all != null && _all.Accounts != null)
            {
                foreach (var a in _all.Accounts)
                    _scope.Items.Add(AccountName(a.Key, a.Label) + "（" + Fmt(a.Totals == null ? 0 : (a.Totals.Tokens ?? 0)) + " token）");
            }
            _scope.EndUpdate();
            int want = 0;
            if (keep > 0 && keep < _scope.Items.Count) want = keep;
            else if (!_scopeInited && _all != null && _all.Current != null)
            {
                for (int i = 0; i < _all.Accounts.Count; i++) { if (_all.Accounts[i].Key == _all.Current.Key) { want = i + 1; break; } }
            }
            _scope.SelectedIndex = want;
            _scopeInited = true;
        }

        public void SelectAccount(string key)
        {
            if (_all == null || _all.Accounts == null || _scope == null) return;
            for (int i = 0; i < _all.Accounts.Count; i++)
            {
                if (string.Equals(_all.Accounts[i].Key, key, StringComparison.OrdinalIgnoreCase))
                {
                    if (_scope.SelectedIndex != i + 1) _scope.SelectedIndex = i + 1;
                    _scopeInited = true;
                    return;
                }
            }
        }

        private void FitColumns()
        {
            Fit(_roles, new[] { 0.44f, 0.32f, 0.20f });
            Fit(_sessions, new[] { 0.10f, 0.21f, 0.52f, 0.14f });
            Fit(_models, new[] { 0.52f, 0.26f, 0.18f });
        }

        /// <summary>
        /// 列表高度按行数撑开，不出内部滚动条：鼠标停在任何一个列表上，滚轮都滚整页
        /// （以前列表有自己的滚动条，指针在列表里时页面不动）。
        /// </summary>
        private void FitHeights()
        {
            int sessions = ContentHeight(_sessions);
            if (_sessions.Height != sessions) _sessions.Height = sessions;
            int lists = Math.Max(_roles.Visible ? ContentHeight(_roles) : 0, ContentHeight(_models));
            int heading = _pair.GetRowHeights().Length > 0 ? _pair.GetRowHeights()[0] : 0;
            int pair = heading + lists + 2;
            if (_pair.Height != pair) _pair.Height = pair;
            // 分组标题的高度量不准：还能滚就再加一行，直到三个列表都不出滚动条（最多 8 次）。
            for (int i = 0; i < 8 && _sessions.Visible && PageScroller.CanScroll(_sessions, -120); i++) _sessions.Height += _sessions.Font.Height * 2;
            for (int i = 0; i < 8 && ((_roles.Visible && PageScroller.CanScroll(_roles, -120)) || PageScroller.CanScroll(_models, -120)); i++)
            {
                _pair.Height += _models.Font.Height * 2;
                _pair.PerformLayout();
            }
        }

        private static int ContentHeight(ListView lv)
        {
            if (!lv.IsHandleCreated || lv.Items.Count == 0) return lv.Font.Height * 4;
            // 先滚回顶部，最后一行的下沿（含表头、分组标题）就是内容高度；再加边框和半行余量。
            // 行高跟着字体和 DPI 走，不写死像素。
            lv.EnsureVisible(0);
            var last = lv.Items[lv.Items.Count - 1].Bounds;
            return last.Bottom + last.Height / 2 + (lv.Height - lv.ClientSize.Height);
        }

        private static void Fit(ListView lv, float[] fractions)
        {
            if (lv == null) return;
            int total = lv.ClientSize.Width - 4;
            if (total <= 80) return;
            for (int i = 0; i < fractions.Length && i < lv.Columns.Count; i++)
                lv.Columns[i].Width = Math.Max(34, (int)(total * fractions[i]));
        }


        private UsageState Current
        {
            get
            {
                if (_all == null) return null;
                int i = _scope == null ? 0 : _scope.SelectedIndex;
                if (i <= 0 || _all.Accounts == null || i - 1 >= _all.Accounts.Count) return _all;
                return _all.Accounts[i - 1];
            }
        }

        private static string Fmt(long n)
        {
            if (n >= 100000000) return (n / 1e8).ToString("0.00") + " 亿";
            if (n >= 10000) return (n / 1e4).ToString("0.0") + " 万";
            return n.ToString("N0");
        }

        private void Render()
        {
            var u = Current;
            if (u == null) return;
            bool account = !ReferenceEquals(u, _all);
            int days = _all.RangeDays ?? 7;
            long today = u.Today == null ? 0 : (u.Today.Tokens ?? 0);
            long total = u.Totals == null ? 0 : (u.Totals.Tokens ?? 0);
            _lblToday.Text = Fmt(today);
            _subToday.Text = u.Today == null ? "" : SplitLines(u.Today.Input ?? 0, u.Today.Cached ?? 0, u.Today.Output ?? 0);
            _capWeek.Text = "近 " + days + " 天 token";
            _lblWeek.Text = Fmt(total);
            _subWeek.Text = u.Totals == null ? "" : SplitLines(u.Totals.Input ?? 0, u.Totals.Cached ?? 0, u.Totals.Output ?? 0);
            _lblCache.Text = ((u.CacheHitRate ?? 0) * 100).ToString("0.0") + "%";
            _subCache.Text = "缓存几乎不占额度\n越高越省";

            var wins = account ? (u.Window == null ? new List<UsageWindow>() : new List<UsageWindow> { u.Window }) : (_all.Windows ?? new List<UsageWindow>());
            wins = wins.Where(w => w.ResetAt.HasValue).ToList();
            if (account && u.Window != null && u.Window.UsedPercent.HasValue)
            {
                _lblWindow.Text = "已用 " + u.Window.UsedPercent.Value.ToString("0") + "%";
                _subWindow.Text = "本窗口 " + Fmt(u.Window.Tokens ?? 0) + "\n" +DateTimeOffset.FromUnixTimeMilliseconds(u.Window.ResetAt ?? 0).ToLocalTime().ToString("MM-dd HH:mm") + " 重置";
            }
            else if (!account && wins.Count > 0)
            {
                _lblWindow.Text = Fmt(wins.Sum(w => w.Tokens ?? 0));
                _subWindow.Text = string.Join("/", wins.Select(w => AccountNo(w.Key))) + " 号本窗口已用\n"
                    + string.Join(" / ", wins.Select(w => w.UsedPercent.HasValue ? w.UsedPercent.Value.ToString("0") + "%" : "—"));
            }
            else { _lblWindow.Text = "—"; _subWindow.Text = "没有周窗口数据"; }

            _chart.SetData(u, days);

            _lblQuota.Text = wins.Count == 0 ? "周额度窗口：没有数据（读不到账号清单或路由账本）"
                : string.Join("\n", wins.Select(w => string.Format("账号 {0} 本周窗口：已用 {1}，消耗 {2} token（{3}）",
                    AccountNo(w.Key),
                    w.UsedPercent.HasValue ? w.UsedPercent.Value.ToString("0") + "%" : "—",
                    Fmt(w.Tokens ?? 0), Split(w.Input ?? 0, w.Cached ?? 0, w.Output ?? 0))));

            _roles.BeginUpdate(); _roles.Items.Clear();
            // 账本没有会话标题：单个账号不拆角色和会话（一个会话也可能跨好几个账号）。
            foreach (var r in u.ByRole ?? new List<UsageRole>())
            {
                long t = r.Tokens ?? 0;
                var it = new ListViewItem(r.Role ?? "?");
                it.SubItems.Add(Fmt(t));
                it.SubItems.Add(total > 0 ? (t * 100.0 / total).ToString("0.0") + "%" : "—");
                _roles.Items.Add(it);
            }
            _roles.EndUpdate();

            _sessions.BeginUpdate(); _sessions.Items.Clear();
            foreach (var s in u.TopSessions ?? new List<UsageSession>())
            {
                var it = new ListViewItem(s.UpdatedAt.HasValue ? DateTimeOffset.FromUnixTimeMilliseconds(s.UpdatedAt.Value).ToLocalTime().ToString("MM-dd") : "—") { ToolTipText = s.Title ?? "" };
                it.SubItems.Add(s.Project ?? "");
                it.SubItems.Add((s.Title ?? "").Replace("\r", " ").Replace("\n", " "));
                it.SubItems.Add(Fmt(s.Tokens ?? 0));
                _sessions.Items.Add(it);
            }
            _sessions.EndUpdate();

            _models.BeginUpdate(); _models.Items.Clear(); _models.Groups.Clear();
            var gModel = _models.Groups.Add("model", "模型");
            var gProject = _models.Groups.Add("project", "项目");
            foreach (var m in (u.ByModel ?? new List<UsageBucket>()).Take(6))
            {
                long t = m.Tokens ?? 0;
                var it = new ListViewItem(m.Model ?? "", gModel);
                it.SubItems.Add(Fmt(t));
                it.SubItems.Add(total > 0 ? (t * 100.0 / total).ToString("0.0") + "%" : "—");
                _models.Items.Add(it);
            }
            foreach (var p in (u.ByProject ?? new List<UsageProject>()).Take(6))
            {
                long t = p.Tokens ?? 0;
                var it = new ListViewItem(p.Project ?? "", gProject);
                it.SubItems.Add(Fmt(t));
                it.SubItems.Add(total > 0 ? (t * 100.0 / total).ToString("0.0") + "%" : "—");
                _models.Items.Add(it);
            }
            _models.EndUpdate();

            FitColumns();
            FitHeights();
            var scan = _all.Scan;
            _lblFoot.Text = (account
                    ? "来源：路由账本（每个请求实际用的账号）" + (u.MatchedShare.HasValue ? "；角色和会话按 token 数配对回会话记录，配上 " + (u.MatchedShare.Value * 100).ToString("0.0") + "%" : "")
                    : "来源：Codex 会话记录")
                + string.Format(" · 近 {0} 天输入 {1}（其中缓存 {2}）/ 输出 {3} · 扫描 {4} 个会话文件 {5} MB，用时 {6} ms",
                days, Fmt(u.Totals?.Input ?? 0), Fmt(u.Totals?.Cached ?? 0), Fmt(u.Totals?.Output ?? 0),
                scan == null ? 0 : (scan.Files ?? 0), scan == null ? 0 : (scan.Mb ?? 0), scan == null ? 0 : (scan.Ms ?? 0));
        }

        /// <summary>每日柱状图 + 今日 24 小时柱状图，鼠标悬停显示数值。</summary>
        private sealed class ChartPanel : Panel
        {
            private UsageState _d;
            private int _days = 7;
            private readonly ToolTip _tip = new ToolTip { InitialDelay = 80, ReshowDelay = 40, AutoPopDelay = 8000 };
            private readonly List<Tuple<Rectangle, string>> _bars = new List<Tuple<Rectangle, string>>();
            public ChartPanel() { DoubleBuffered = true; BackColor = SystemColors.Window; BorderStyle = BorderStyle.FixedSingle; }
            public void SetData(UsageState d, int days) { _d = d; _days = days; Invalidate(); }
            protected override void OnMouseMove(MouseEventArgs e)
            {
                base.OnMouseMove(e);
                foreach (var b in _bars)
                {
                    if (b.Item1.Contains(e.Location)) { if (_tip.GetToolTip(this) != b.Item2) _tip.SetToolTip(this, b.Item2); return; }
                }
                _tip.SetToolTip(this, "");
            }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                var g = e.Graphics;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                var r = ClientRectangle;
                using (var br = new SolidBrush(SystemColors.GrayText))
                using (var f = new Font("Microsoft YaHei UI", 9F))
                {
                    g.DrawString("每日 token（近 " + _days + " 天，悬停看数值）", f, br, r.Left + 10, r.Top + 6);
                    g.DrawString("今日 24 小时分布", f, br, r.Left + (int)(r.Width * 0.62), r.Top + 6);
                }
                _bars.Clear();
                if (_d == null) return;
                var days = (_d.Days ?? new List<UsageDay>()).ToList();
                DrawBars(g, new Rectangle(r.Left + 12, r.Top + 30, (int)(r.Width * 0.58), r.Height - 56),
                    days.Select(x => (double)(x.Tokens ?? 0)).ToArray(),
                    days.Select(x => (x.Date ?? "").Substring(Math.Max(0, (x.Date ?? "").Length - 5))).ToArray(),
                    days.Select(x => string.Format("{0}：{1} token（{2}）· {3} 次请求", x.Date, Fmt(x.Tokens ?? 0), Split(x.Input ?? 0, x.Cached ?? 0, x.Output ?? 0), x.Events ?? 0)).ToArray(),
                    false);
                var hours = (_d.Hours ?? new List<long>()).ToArray();
                DrawBars(g, new Rectangle(r.Left + (int)(r.Width * 0.63), r.Top + 30, (int)(r.Width * 0.34), r.Height - 56),
                    hours.Select(x => (double)x).ToArray(),
                    Enumerable.Range(0, 24).Select(h => h.ToString("00")).ToArray(),
                    Enumerable.Range(0, 24).Select(h => string.Format("今日 {0}:00 - {1}:59：{2} token", h.ToString("00"), h.ToString("00"), Fmt(hours.Length > h ? (long)hours[h] : 0))).ToArray(),
                    true);
            }
            private void DrawBars(Graphics g, Rectangle area, double[] values, string[] labels, string[] tips, bool dense)
            {
                if (values == null || values.Length == 0) return;
                double max = values.Max(); if (max <= 0) max = 1;
                int n = values.Length;
                float gap = dense ? 1f : 3f;
                float w = Math.Max(1f, (area.Width - gap * (n + 1)) / n);
                using (var axis = new Pen(SystemColors.ControlDark))
                using (var bar = new SolidBrush(Color.FromArgb(0, 120, 212)))
                using (var bar2 = new SolidBrush(Color.FromArgb(120, 170, 240)))
                using (var text = new SolidBrush(SystemColors.GrayText))
                using (var font = new Font("Microsoft YaHei UI", 7.5F))
                {
                    g.DrawLine(axis, area.Left, area.Bottom, area.Right, area.Bottom);
                    for (int i = 0; i < n; i++)
                    {
                        double v = values[i];
                        int h = (int)Math.Round((area.Height - 20) * (v / max));
                        if (v > 0 && h < 2) h = 2;
                        var rect = new RectangleF(area.Left + gap + i * (w + gap), area.Bottom - 16 - h, w, h);
                        g.FillRectangle(i == n - 1 ? bar : bar2, rect);
                        if (!dense && i < labels.Length) g.DrawString(labels[i], font, text, rect.Left - 4, area.Bottom - 14);
                        _bars.Add(Tuple.Create(Rectangle.Round(new RectangleF(rect.X, area.Top, Math.Max(3f, rect.Width), area.Height)), tips != null && i < tips.Length ? tips[i] : ""));
                    }
                }
            }
            protected override void Dispose(bool disposing) { if (disposing) _tip.Dispose(); base.Dispose(disposing); }
        }
    }
}
