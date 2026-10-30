using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>策略页要保存的内容（对应 POST /api/policy）。</summary>
    public sealed class PolicyDraft
    {
        public bool AutoSwitch { get; set; }
        public int MinWaitMin { get; set; }
        public int ReserveIndex { get; set; }
        /// <summary>null = 基础规则。</summary>
        public RotationConfig Rotation { get; set; }
    }

    /// <summary>
    /// 「策略」页：运行状态、基础 / 自定义两种规则、一个保存按钮。
    ///
    /// 以前的问题：自定义规则要先点「应用到草稿」再点「保存策略」，只点保存会把表格里的改动丢掉；
    /// 底部六个按钮（保存策略 / 放弃草稿 / 上移 / 下移 / 应用到草稿 / 取消）里有两对意思重复；
    /// 编辑器每次刷新都重建、没经过 DPI 缩放，175% 下文字被裁；规则编辑对话框没有确定按钮。
    /// 现在改动直接进草稿，「保存策略」一次读完整个页面。
    /// </summary>
    public sealed class PolicyView : UserControl
    {
        private readonly Label _health = WrapLabel();
        private readonly CheckBox _auto = new CheckBox { Name = "policy-auto", Text = "自动切号（策略每 5 分钟检查一次）", AutoSize = true, Margin = new Padding(0, 8, 0, 0) };
        private readonly RadioButton _modeBasic = new RadioButton { Name = "policy-mode-basic", Text = "基础规则", AutoSize = true, Margin = new Padding(0, 4, 24, 4) };
        private readonly RadioButton _modeCustom = new RadioButton { Name = "policy-mode-custom", Text = "自定义账户规则", AutoSize = true, Margin = new Padding(0, 4, 0, 4) };
        private readonly Label _modeHint = WrapLabel();
        private readonly NumericUpDown _wait = new NumericUpDown { Name = "policy-wait", Minimum = 5, Maximum = 600, Value = 60, Width = 90, TextAlign = HorizontalAlignment.Right };
        private readonly ComboBox _reserve = new ComboBox { Name = "policy-reserve", DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
        private readonly TableLayoutPanel _basicPanel;
        private readonly RotationEditorControl _editor = new RotationEditorControl { Name = "policy-editor", Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, Margin = new Padding(0) };
        private readonly Button _save = new Button { Name = "policy-save", Text = "保存策略", AutoSize = true, MinimumSize = new Size(110, 30), Margin = new Padding(0, 0, 10, 0) };
        private readonly Button _discard = new Button { Name = "policy-discard", Text = "放弃修改", AutoSize = true, MinimumSize = new Size(110, 30), Margin = new Padding(0, 0, 16, 0) };
        private readonly Label _dirtyLabel = new Label { Name = "policy-dirty", AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 7, 0, 0) };
        private readonly PageScroller _scroll;
        private readonly TableLayoutPanel _content;
        private readonly List<Label> _wrapped = new List<Label>();
        private PanelState _state;
        private string _loadedSignature;
        // 载入时各输入的值。是否“有未保存的修改”按值比较：控件在第一次显示时会补发
        // SelectedIndexChanged 等事件，只看事件会在用户什么都没改时就报“有未保存的修改”。
        private string _baseline;
        private string _note;
        private bool _loading;
        private bool _busy;

        public bool Dirty { get; private set; }
        public event EventHandler SaveRequested;

        public PolicyView()
        {
            BackColor = SystemColors.Control;
            var outer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0) };
            outer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            outer.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            _scroll = new PageScroller { Dock = DockStyle.Fill, Padding = new Padding(0, 0, 0, 12), Margin = new Padding(0) };
            // 不停靠：AutoScroll 面板里停靠的子控件会按内容撑宽（标签不换行、右侧被裁），宽度由 FitWidth 钉死。
            var content = _content = new TableLayoutPanel { Location = new Point(16, 12), AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Margin = new Padding(0) };
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            content.Controls.Add(Heading("运行状态", 0));
            content.Controls.Add(Track(_health));
            content.Controls.Add(_auto);

            content.Controls.Add(Heading("切换规则", 18));
            var modes = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            modes.Controls.Add(_modeBasic);
            modes.Controls.Add(_modeCustom);
            content.Controls.Add(modes);
            _modeHint.ForeColor = SystemColors.GrayText;
            _modeHint.Margin = new Padding(0, 2, 0, 10);
            content.Controls.Add(Track(_modeHint));

            _basicPanel = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, Margin = new Padding(0) };
            for (int i = 0; i < 2; i++) _basicPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            AddRow(_basicPanel, "5 小时额度用完、距重置不到", _wait, "分钟时等它重置；更久就换到另一个日常号");
            AddRow(_basicPanel, "储备号", _reserve, "日常号都用完才用");
            content.Controls.Add(_basicPanel);
            content.Controls.Add(_editor);

            _scroll.Controls.Add(content);
            _scroll.ClientSizeChanged += (s, e) => FitWidth();

            var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = false, Padding = new Padding(16, 8, 16, 10), Margin = new Padding(0) };
            footer.Controls.Add(_save);
            footer.Controls.Add(_discard);
            footer.Controls.Add(_dirtyLabel);
            var line = new Label { Dock = DockStyle.Top, Height = 1, BackColor = SystemColors.ControlDark };

            outer.Controls.Add(_scroll, 0, 0);
            outer.Controls.Add(footer, 0, 1);
            Controls.Add(outer);
            Controls.Add(line);
            line.BringToFront();
            outer.BringToFront();

            _save.Click += (s, e) => SaveRequested?.Invoke(this, EventArgs.Empty);
            _discard.Click += (s, e) => Discard();
            EventHandler changed = (s, e) => MarkDirty();
            _auto.CheckedChanged += changed;
            _wait.ValueChanged += changed;
            _reserve.SelectedIndexChanged += changed;
            _editor.Changed += changed;
            _modeCustom.CheckedChanged += (s, e) => { ShowMode(); MarkDirty(); };
            UpdateFooter();
            ShowMode();
        }

        /// <summary>刷新显示。运行状态每次都更新；规则区有未保存的修改时不动，没有时只在配置真的变了才重填（不抢焦点）。</summary>
        public void Render(PanelState st)
        {
            if (st == null || st.Policy == null) return;
            _state = st;
            RenderHealth(st.Schedule, st.Accounts);
            if (Dirty) return;
            string signature = System.Text.Json.JsonSerializer.Serialize(new
            {
                st.Policy,
                accounts = (st.Accounts ?? new List<AccountState>()).ConvertAll(a => new { a.N, a.AccountKey, a.Email, a.Paused }),
            });
            if (signature == _loadedSignature) return;
            LoadPolicy(st);
            _loadedSignature = signature;
        }

        /// <summary>读整个页面生成要保存的内容。不合法时抛 InvalidOperationException；用户取消时返回 null。</summary>
        public PolicyDraft BuildDraft()
        {
            RotationConfig rotation = null;
            if (_modeCustom.Checked)
            {
                rotation = _editor.Build();
                if (_editor.DropsSavedAccounts(rotation) &&
                    MessageBox.Show(FindForm(), "有账号已经不在账号池里，保存后会去掉它们的规则。继续？", "账号池有变化", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                    return null;
            }
            return new PolicyDraft
            {
                AutoSwitch = _auto.Checked,
                MinWaitMin = (int)_wait.Value,
                ReserveIndex = _reserve.SelectedIndex >= 0 ? _reserve.SelectedIndex + 1 : 1,
                Rotation = rotation,
            };
        }

        /// <summary>保存成功后调用：清掉修改标记，下一次 Render 按服务端返回的配置重填。</summary>
        public void MarkSaved()
        {
            Dirty = false;
            _loadedSignature = null;
            _note = "已保存，下一轮检查（最多 5 分钟）生效";
            UpdateFooter();
        }

        public void SetBusy(bool busy)
        {
            _busy = busy;
            UpdateFooter();
        }

        private void LoadPolicy(PanelState st)
        {
            _loading = true;
            try
            {
                var p = st.Policy;
                _auto.Checked = p.AutoSwitch;
                int maxWait = p.MaxMinWait is int mw && mw > 5 ? mw : 600;
                int minWait = p.MinMinWait is int mn && mn > 0 ? mn : 5;
                _wait.Minimum = minWait;
                _wait.Maximum = maxWait;
                _wait.Value = Math.Max(_wait.Minimum, Math.Min(_wait.Maximum, p.MinWaitMin ?? 60));
                var accounts = st.Accounts ?? new List<AccountState>();
                _reserve.BeginUpdate();
                _reserve.Items.Clear();
                foreach (var a in accounts) _reserve.Items.Add("账号 " + a.N + " · " + (string.IsNullOrEmpty(a.Email) ? "—" : a.Email));
                int idx = (p.ReserveIndex ?? 1) - 1;
                _reserve.SelectedIndex = idx >= 0 && idx < _reserve.Items.Count ? idx : (_reserve.Items.Count > 0 ? 0 : -1);
                _reserve.EndUpdate();
                _editor.LoadConfig(accounts, p.Rotation, p.ReserveIndex ?? 1, (int)_wait.Value);
                _modeCustom.Checked = p.Rotation != null;
                _modeBasic.Checked = p.Rotation == null;
                ShowMode();
            }
            finally { _loading = false; }
            _baseline = Snapshot();
            Dirty = false;
            UpdateFooter();
        }

        private void Discard()
        {
            if (!Dirty) return;
            if (MessageBox.Show(FindForm(), "放弃策略页上未保存的修改？", "放弃修改", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            Dirty = false;
            _loadedSignature = null;
            _note = "已恢复为保存的策略";
            if (_state != null) Render(_state);
            UpdateFooter();
        }

        private void MarkDirty()
        {
            if (_loading) return;
            bool dirty = _baseline == null || Snapshot() != _baseline;
            if (dirty == Dirty) return;
            Dirty = dirty;
            _note = null;
            UpdateFooter();
        }

        private string Snapshot() => string.Join("|", _auto.Checked, _wait.Value, _reserve.SelectedIndex, _modeCustom.Checked, _editor.Snapshot());

        private void ShowMode()
        {
            bool custom = _modeCustom.Checked;
            _basicPanel.Visible = !custom;
            _editor.Visible = custom;
            _modeHint.Text = custom
                ? "按下面的阈值和顺序在日常号之间轮换；日常号都不可用时才用备用号。"
                : "当前号快用完时换到另一个日常号，日常号都用完才动用储备号。账号的角色、顺序和单号阈值要在「自定义账户规则」里设置。";
        }

        private void UpdateFooter()
        {
            _save.Enabled = Dirty && !_busy;
            _discard.Enabled = Dirty && !_busy;
            if (Dirty)
            {
                _dirtyLabel.Text = "有未保存的修改";
                _dirtyLabel.ForeColor = Color.FromArgb(170, 95, 0);
            }
            else
            {
                _dirtyLabel.Text = _note ?? "修改后点「保存策略」，下一轮检查（最多 5 分钟）生效";
                _dirtyLabel.ForeColor = SystemColors.GrayText;
            }
        }

        /// <summary>策略脚本最近一次运行的状态——否则“自动切号停摆”在界面上完全看不出来。</summary>
        private void RenderHealth(ScheduleState sc, List<AccountState> accounts)
        {
            if (sc == null)
            {
                _health.Text = "策略还没运行过（每 5 分钟一次）。";
                _health.ForeColor = SystemColors.GrayText;
                return;
            }
            string when = sc.LastStatusAtMs > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)sc.LastStatusAtMs).LocalDateTime.ToString("MM-dd HH:mm:ss")
                : "—";
            string status = string.IsNullOrEmpty(sc.LastStatus) ? "未知" : sc.LastStatus;
            long ageMin = sc.LastRunAtMs > 0
                ? (long)(DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds((long)sc.LastRunAtMs)).TotalMinutes
                : -1;
            bool stale = ageMin > 20;
            bool failed = status == "ERROR" || status == "SWITCH-FAILED";
            var parts = new List<string> { "上次运行 " + when + "，结果 " + status };
            if (failed) parts.Add("需要处理：" + (string.IsNullOrEmpty(sc.ErrorCode) ? "看「事件」页最新记录" : sc.ErrorCode));
            else if (stale) parts.Add("超过 20 分钟没运行，计划任务可能停了");
            else if (status == "SWITCH" && sc.From > 0 && sc.To > 0) parts.Add("刚从账号 " + sc.From + " 切到账号 " + sc.To);
            // 只列真的处于暂停状态的账号：state 里的 policyPaused 是“策略暂停过谁”的记账，可能已经过期。
            var paused = (accounts ?? new List<AccountState>()).Where(a => a.Paused).Select(a => a.N).ToList();
            if (paused.Count > 0) parts.Add("已暂停账号 " + string.Join("、", paused));
            if (sc.TickCount > 0) parts.Add("累计运行 " + sc.TickCount + " 次");
            _health.Text = string.Join("  ·  ", parts);
            _health.ForeColor = failed || stale ? Color.FromArgb(180, 30, 30) : SystemColors.ControlText;
        }

        private void FitWidth()
        {
            if (_content == null) return;
            // 按整个控件的宽度算（布局时 _scroll 可能还没更新），预留竖向滚动条。
            int width = Math.Max(200, ClientSize.Width - 2 * _content.Left - SystemInformation.VerticalScrollBarWidth);
            if (_content.MinimumSize.Width != width) { _content.MinimumSize = new Size(width, 0); _content.MaximumSize = new Size(width, 0); }
            foreach (var label in _wrapped)
                if (label.MaximumSize.Width != width) label.MaximumSize = new Size(width, 0);
        }

        // 换行宽度必须在布局前就定好：标签没有上限时会把整页撑得比窗口还宽，右侧被裁掉。
        protected override void OnLayout(LayoutEventArgs e)
        {
            FitWidth();
            base.OnLayout(e);
        }

        private Label Track(Label label) { _wrapped.Add(label); return label; }

        private static Label WrapLabel() => new Label { AutoSize = true, Margin = new Padding(0, 2, 0, 2) };

        private static Label Heading(string text, int top)
        {
            var label = new Label { Text = text, AutoSize = true, Margin = new Padding(0, top, 0, 6) };
            label.Font = new Font(label.Font.FontFamily, label.Font.Size + 1.5f, FontStyle.Bold);
            return label;
        }

        private static void AddRow(TableLayoutPanel table, string caption, Control input, string after) =>
            RotationEditorControl.AddRow(table, caption, input, after);
    }
}
