using System;
using System.Drawing;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 「账号详情」页：这个账号现在是什么状态、额度还剩多少、数字有多新、能对它做什么。
    ///
    /// 以前的问题：“状态说明”直接显示 CLI 的英文原因（“secondary quota 33% used”），而且常常是旧快照，
    /// 和下面的额度条对不上；看不出账号是否正在被路由使用、额度是实时的还是几小时前的；
    /// 按钮固定宽度，最后一个被窗口裁掉。
    /// </summary>
    internal sealed class AccountDetailView : ScrollPage
    {
        private readonly Label _title = new Label { Name = "detail-title", AutoSize = true, Margin = new Padding(0, 0, 0, 4) };
        private readonly Label _state = new Label { Name = "detail-state", AutoSize = true, Margin = new Padding(0, 2, 0, 2) };
        private readonly Label _reason = new Label { Name = "detail-reason", AutoSize = true, ForeColor = UiKit.Warn, Margin = new Padding(0, 2, 0, 2) };
        private readonly QuotaBar _bar5 = new QuotaBar { Name = "detail-bar5" };
        private readonly QuotaBar _bar7 = new QuotaBar { Name = "detail-bar7" };
        private readonly Label _text5 = new Label { Name = "detail-text5", AutoSize = true, Margin = new Padding(0, 4, 0, 4) };
        private readonly Label _text7 = new Label { Name = "detail-text7", AutoSize = true, Margin = new Padding(0, 4, 0, 4) };
        private readonly Label _source = new Label { Name = "detail-source", AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 6, 0, 2) };
        private readonly Label _plan = UiKit.TextLabel();
        private readonly Label _role = UiKit.TextLabel();
        private readonly Label _pin = UiKit.TextLabel();
        private readonly Label _lastUsed = UiKit.TextLabel();
        private readonly Label _note = UiKit.TextLabel();
        private readonly Button _switch = UiKit.MakeButton("切换到此账号", "detail-switch");
        private readonly Button _pause = UiKit.MakeButton("暂停账号", "detail-pause");
        private readonly Button _reserve = UiKit.MakeButton("设为储备", "detail-reserve");
        private readonly Button _unpin = UiKit.MakeButton("解除固定", "detail-unpin");
        private readonly Button _noteBtn = UiKit.MakeButton("修改备注…", "detail-note");
        private readonly Button _refresh = UiKit.MakeButton("刷新额度", "detail-refresh");

        public event EventHandler SwitchClicked, PauseClicked, ReserveClicked, UnpinClicked, NoteClicked, RefreshClicked;

        public AccountDetailView()
        {
            _title.Font = new Font(_title.Font.FontFamily, _title.Font.Size + 3f, FontStyle.Bold);
            Add(_title);
            Add(_state);
            Add(Wrap(_reason));

            Add(UiKit.Heading("额度"));
            var quota = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 3, Margin = new Padding(0) };
            for (int i = 0; i < 3; i++) quota.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            AddQuotaRow(quota, "5 小时", _bar5, _text5);
            AddQuotaRow(quota, "7 天", _bar7, _text7);
            Add(quota);
            Add(Wrap(_source));

            Add(UiKit.Heading("账号"));
            var fields = UiKit.FieldTable();
            UiKit.AddField(fields, "计划", _plan);
            UiKit.AddField(fields, "角色", _role);
            UiKit.AddField(fields, "固定", _pin);
            UiKit.AddField(fields, "上次使用", _lastUsed);
            UiKit.AddField(fields, "备注", _note);
            Add(fields);

            var buttons = UiKit.ButtonRow();
            buttons.Controls.AddRange(new Control[] { _switch, _pause, _reserve, _unpin, _noteBtn, _refresh });
            Add(buttons);

            _switch.Click += (s, e) => SwitchClicked?.Invoke(this, EventArgs.Empty);
            _pause.Click += (s, e) => PauseClicked?.Invoke(this, EventArgs.Empty);
            _reserve.Click += (s, e) => ReserveClicked?.Invoke(this, EventArgs.Empty);
            _unpin.Click += (s, e) => UnpinClicked?.Invoke(this, EventArgs.Empty);
            _noteBtn.Click += (s, e) => NoteClicked?.Invoke(this, EventArgs.Empty);
            _refresh.Click += (s, e) => RefreshClicked?.Invoke(this, EventArgs.Empty);
        }

        public void SetRefreshEnabled(bool enabled) => _refresh.Enabled = enabled;

        public void Render(AccountState a, PanelState st)
        {
            if (a == null)
            {
                _title.Text = "没有选中账号";
                _state.Text = _reason.Text = _source.Text = "";
                return;
            }
            bool pinned = st?.Selection?.Pinned == a.N;
            bool custom = st?.Policy?.Rotation != null;
            bool reserve = a.EmergencyOnly || string.Equals(a.Role, "reserve", StringComparison.OrdinalIgnoreCase);

            _title.Text = "账号 " + a.N + " · " + (string.IsNullOrEmpty(a.Email) ? "—" : a.Email);
            if (a.Paused) SetState("已暂停 · 自动切号不会选它", UiKit.Warn);
            else if (a.InUse) SetState("使用中 · 路由正在用它，额度从它扣", UiKit.Good);
            else if (a.Current) SetState("首选 · 新对话从它开始；进行中的对话留在原来的账号上", SystemColors.ControlText);
            else if (reserve) SetState("储备号 · 日常号都用完才会用它", SystemColors.ControlText);
            else SetState("可用 · 自动切号可以选到它", SystemColors.GrayText);
            string reason = UiKit.ReasonText(a.Reason);
            _reason.Text = reason;
            _reason.Visible = reason.Length > 0 && !(a.Paused && reason == "已暂停");

            RenderWindow(_bar5, _text5, a.H5, false, a);
            RenderWindow(_bar7, _text7, a.H7, true, a);
            _source.Text = SourceText(a);

            _plan.Text = a.PlanLabel ?? a.Plan ?? "—";
            _role.Text = a.Paused ? "暂停" : reserve ? "储备" + (a.EmergencyOnly ? "（仅应急）" : "") : "日常";
            _pin.Text = pinned ? "已固定：只用这个账号；它限流时请求直接失败，点「解除固定」恢复自动轮转" : "未固定（由自动轮转决定）";
            _pin.ForeColor = pinned ? UiKit.Warn : SystemColors.ControlText;
            _lastUsed.Text = (a.LastUsed ?? 0) > 0 ? UiKit.UntilPast(a.LastUsed.Value) : "—";
            _note.Text = string.IsNullOrEmpty(a.Note) ? "（无）" : a.Note;

            _switch.Enabled = !a.Current && !a.Paused;
            _unpin.Enabled = pinned;
            _pause.Text = a.Paused ? "恢复账号" : "暂停账号";
            _reserve.Text = custom ? "编辑角色规则…" : a.EmergencyOnly ? "取消储备" : "设为储备";
        }

        private void SetState(string text, Color color)
        {
            _state.Text = text;
            _state.ForeColor = color;
        }

        private static void AddQuotaRow(TableLayoutPanel t, string caption, QuotaBar bar, Label text)
        {
            int row = t.RowCount++;
            t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            t.Controls.Add(new Label { Text = caption, AutoSize = true, ForeColor = SystemColors.GrayText, Anchor = AnchorStyles.Left, Margin = new Padding(0, 4, 18, 4) }, 0, row);
            bar.Anchor = AnchorStyles.Left;
            t.Controls.Add(bar, 1, row);
            text.Anchor = AnchorStyles.Left;
            t.Controls.Add(text, 2, row);
        }

        private static void RenderWindow(QuotaBar bar, Label text, QuotaWindow w, bool weekly, AccountState a)
        {
            if (w == null || !w.Remaining.HasValue)
            {
                bar.SetValue(null, true);
                bool failed = a.QuotaStatus >= 400 || (a.H5 == null && a.H7 == null);
                text.Text = failed ? "读不到（点「刷新额度」重试）" : "这个账号没有" + (weekly ? " 7 天" : " 5 小时") + "限制";
                text.ForeColor = SystemColors.GrayText;
                return;
            }
            int v = (int)Math.Round(w.Remaining.Value);
            if (w.Expired)
            {
                // 窗口已经重置：快照里的数字属于上一个窗口，置灰并说明，不能当成现在的用量。
                bar.SetValue(v, true);
                text.Text = "已重置，新窗口还没有数据（上个窗口剩 " + v + "%）";
                text.ForeColor = SystemColors.GrayText;
                return;
            }
            bar.SetValue(v, false);
            string reset = UiKit.ResetText(w, weekly);
            text.Text = v + "% 剩余" + (reset.Length > 0 ? " · " + reset : "");
            text.ForeColor = v < 10 ? UiKit.Bad : SystemColors.ControlText;
        }

        private static string SourceText(AccountState a)
        {
            if (!a.QuotaUpdatedAt.HasValue || a.QuotaUpdatedAt.Value <= 0)
                return "还没有额度数据。点「刷新额度」探测一次。";
            string age = UiKit.UntilPast(a.QuotaUpdatedAt.Value);
            if (a.QuotaSource == "live")
                return "额度来自 " + age + "的一次真实请求（路由在用的账号会随请求自动更新）。";
            if (a.QuotaStale)
                return "额度是 " + age + "探测的快照。没在用的账号不会自动探测（每次探测都要花额度），要看最新数字点「刷新额度」。";
            return "额度是 " + age + "探测的快照。";
        }
    }
}
