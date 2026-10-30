using CodexQuota;
using System.Drawing;
using System.Windows.Forms;

// 桌面端策略页规则测试：RotationEditorControl 的读写换算 + PolicyView 一次保存整页。
// 传一个目录参数时，另外把 175% 缩放下的策略页（基础 / 自定义两种）截图存进去，供人工检查布局。
internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        string Key(int n) => "sha256:" + new string((char)('0' + n), 64);
        var accounts = Enumerable.Range(1, 3).Select(n => new AccountState { N = n, Email = "sample" + n + "@example.com", AccountKey = Key(n) }).ToList();
        RotationConfig Saved() => new RotationConfig { Daily = new() { Key(2), Key(1) }, Reserve = new() { Key(3) }, ShortUsedPercent = 95, WaitBeforeSwitchMin = 45, DailySelection = "priority", ReturnToDaily = false, AccountRules = new() { [Key(1)] = new AccountRotationRule { ShortUsedPercent = 80, WaitBeforeSwitchMin = 0 } } };
        T Find<T>(Control root, string name) where T : Control => (T)root.Controls.Find(name, true).Single();
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

        Form Host(Control c) { var f = new Form { Size = new Size(900, 900) }; c.Dock = DockStyle.Fill; f.Controls.Add(c); f.Show(); Application.DoEvents(); return f; }

        // 1. 编辑器：保存的顺序、剩余/已用换算、单号覆盖、不改动传入的配置
        {
            var saved = Saved();
            var editor = new RotationEditorControl();
            using var f = Host(editor);
            editor.LoadConfig(accounts, saved, 1, 60);
            var grid = Find<DataGridView>(editor, "rotation-accounts");
            Check((string)grid.Rows[0].Tag == Key(2), "Saved order lost");
            Check(Convert.ToString(grid.Rows[1].Cells["short"].Value) == "20", "Account override not rendered as remaining");
            Check(Find<NumericUpDown>(editor, "rotation-short").Value == 5, "Legacy global not rendered as remaining");
            Find<NumericUpDown>(editor, "rotation-short").Value = 10;
            Find<NumericUpDown>(editor, "rotation-weekly").Value = 15;
            grid.Rows[0].Cells["weekly"].Value = "0.3";
            grid.Rows[0].Cells["wait"].Value = "0";
            var value = editor.Build();
            Check(value.WeeklyUsedPercent == 85 && value.AccountRules[Key(2)].WeeklyUsedPercent == 99.7, "Weekly remaining conversion lost");
            Check(value.ShortUsedPercent == 90 && value.Daily.SequenceEqual(saved.Daily), "Edited global or order lost");
            Check(value.AccountRules[Key(2)].WaitBeforeSwitchMin == 0 && value.AccountRules[Key(1)].ShortUsedPercent == 80, "Account edits lost");
            Check(saved.ShortUsedPercent == 95 && !saved.AccountRules.ContainsKey(Key(2)), "Editor mutated saved configuration");
            Check(grid.Height >= grid.ColumnHeadersHeight + grid.Rows.GetRowsHeight(DataGridViewElementStates.Visible), "Grid clips its rows");
        }
        // 2. 从基础规则迁移：储备号为备用，其余日常，等待沿用；默认“用完再换”
        {
            var editor = new RotationEditorControl();
            using var f = Host(editor);
            editor.LoadConfig(accounts, null, 3, 75);
            var value = editor.Build();
            Check(value.Daily.SequenceEqual(new[] { Key(1), Key(2) }) && value.Reserve.Single() == Key(3), "Basic configuration not migrated");
            Check(value.ShortUsedPercent == 100 && value.WeeklyUsedPercent == 100, "Zero remaining default lost");
            Check(value.WaitBeforeSwitchMin == 75, "Legacy wait not inherited");
        }
        // 3. 边界换算与非法输入
        {
            var editor = new RotationEditorControl();
            using var f = Host(editor);
            editor.LoadConfig(accounts, Saved(), 1, 60);
            Find<NumericUpDown>(editor, "rotation-short").Value = 99;
            Find<NumericUpDown>(editor, "rotation-weekly").Value = 0;
            var grid = Find<DataGridView>(editor, "rotation-accounts");
            grid.Rows[1].Cells["short"].Value = "0";
            grid.Rows[1].Cells["weekly"].Value = "99";
            var value = editor.Build();
            Check(value.ShortUsedPercent == 1 && value.WeeklyUsedPercent == 100, "Global boundary conversion lost");
            Check(value.AccountRules[Key(1)].ShortUsedPercent == 100 && value.AccountRules[Key(1)].WeeklyUsedPercent == 1, "Account boundary conversion lost");
            grid.Rows[1].Cells["short"].Value = "120";
            bool threw = false;
            try { editor.Build(); } catch (InvalidOperationException) { threw = true; }
            Check(threw, "Out-of-range override accepted");
            foreach (DataGridViewRow row in grid.Rows) row.Cells["role"].Value = "备用";
            grid.Rows[1].Cells["short"].Value = "";
            threw = false;
            try { editor.Build(); } catch (InvalidOperationException) { threw = true; }
            Check(threw, "Config without a daily account accepted");
        }
        // 4. 策略页：改了表格直接点保存就带上改动（以前要先点「应用到草稿」，否则改动丢失）
        {
            var view = new PolicyView();
            using var f = Host(view);
            view.Render(State(accounts, Saved()));
            Check(!view.Dirty, "Fresh render marked dirty");
            Check(Find<RadioButton>(view, "policy-mode-custom").Checked, "Custom mode not shown");
            Check(!Find<Button>(view, "policy-save").Enabled, "Save enabled without changes");
            Find<NumericUpDown>(view, "rotation-short").Value = 12;
            Find<DataGridView>(view, "rotation-accounts").Rows[2].Cells["role"].Value = "日常";
            Check(view.Dirty && Find<Button>(view, "policy-save").Enabled, "Edit did not mark the page dirty");
            var draft = view.BuildDraft();
            Check(draft.Rotation != null && draft.Rotation.ShortUsedPercent == 88, "Saved draft lost the edited threshold");
            Check(draft.Rotation.Reserve.Count == 0 && draft.Rotation.Daily.Count == 3, "Saved draft lost the role change");
            // 有未保存修改时，定时刷新不能覆盖它
            view.Render(State(accounts, Saved()));
            Check(Find<NumericUpDown>(view, "rotation-short").Value == 12, "Periodic render overwrote unsaved edits");
            view.MarkSaved();
            view.Render(State(accounts, Saved()));
            Check(!view.Dirty && Find<NumericUpDown>(view, "rotation-short").Value == 5, "Render after save did not reload");
        }
        // 5. 策略页：切回基础规则 → rotation=null，基础字段生效
        {
            var view = new PolicyView();
            using var f = Host(view);
            view.Render(State(accounts, Saved()));
            Find<RadioButton>(view, "policy-mode-basic").Checked = true;
            Find<NumericUpDown>(view, "policy-wait").Value = 90;
            Find<ComboBox>(view, "policy-reserve").SelectedIndex = 2;
            var draft = view.BuildDraft();
            Check(draft.Rotation == null && draft.MinWaitMin == 90 && draft.ReserveIndex == 3, "Basic mode draft wrong");
            Check(!Find<RotationEditorControl>(view, "policy-editor").Visible, "Custom editor visible in basic mode");
        }

        // 6. 策略页：控件第一次显示时补发的事件不能让页面变成“有未保存的修改”；改了再改回也不算
        {
            var view = new PolicyView { Visible = false };
            using var f = Host(view);
            view.Render(State(accounts, null));
            view.Visible = true; Application.DoEvents();
            Check(!view.Dirty, "Showing the page marked it dirty");
            var wait = Find<NumericUpDown>(view, "policy-wait");
            wait.Value = 61; Check(view.Dirty, "Edit not detected");
            wait.Value = 60; Check(!view.Dirty, "Reverting an edit still dirty");
        }
        // 7. 账号详情：在用 / 实时额度 / 不显示 CLI 的英文额度原因 / 窗口已重置
        {
            var view = new AccountDetailView();
            using var f = Host(view);
            var a = new AccountState { N = 3, Email = "c@example.com", InUse = true, Reason = "secondary quota 33% used", QuotaSource = "live",
                QuotaUpdatedAt = DateTimeOffset.UtcNow.AddMinutes(-2).ToUnixTimeMilliseconds(),
                H5 = new QuotaWindow { Remaining = 93, ResetAt = DateTimeOffset.UtcNow.AddHours(4).ToUnixTimeMilliseconds() },
                H7 = new QuotaWindow { Remaining = 60, ResetAt = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds(), Expired = true } };
            view.Render(a, State(accounts, null));
            Check(Find<Label>(view, "detail-state").Text.StartsWith("使用中"), "In-use state not shown");
            Check(!Find<Label>(view, "detail-reason").Visible, "CLI quota reason shown next to the bars");
            Check(Find<Label>(view, "detail-text5").Text.StartsWith("93% 剩余"), "5h text wrong");
            Check(Find<Label>(view, "detail-text7").Text.StartsWith("已重置"), "Expired window shown as current");
            Check(Find<Label>(view, "detail-source").Text.Contains("真实请求"), "Live quota source not explained");
            a.InUse = false; a.Current = true; a.Reason = "rate-limited";
            view.Render(a, State(accounts, null));
            Check(Find<Label>(view, "detail-state").Text.StartsWith("首选"), "Preferred state not shown");
            Check(Find<Label>(view, "detail-reason").Visible && Find<Label>(view, "detail-reason").Text.Contains("限流"), "Runtime reason not translated");
            Check(!Find<Button>(view, "detail-switch").Enabled, "Switch enabled for the preferred account");
        }
        // 8. 路由页：端口来自状态，不写死
        {
            var view = new RouterView();
            using var f = Host(view);
            var st = State(accounts, null);
            st.Router = new RouterState { Running = true, Port = 53742, Pid = 1, Requests = 5, LastError = "upstream-transport:econnreset", ErrorRecovered = true, RequestsSinceError = 3 };
            view.Render(st);
            Check(Find<Label>(view, "router-help").Text.Contains("127.0.0.1:53742"), "Router port not taken from state");
            Check(Find<Label>(view, "router-status").Text == "在线", "Router status wrong");
            Check(Find<Label>(view, "router-error").Text.Contains("已恢复"), "Recovered error not marked");
        }
        // 9. 事件文案：去掉重复的类型前缀和 run=id
        Check(UiKit.CleanLogMessage("RESUME", "RESUME 额度窗口已重置（账号3） run=1702483e2") == "额度窗口已重置（账号3）", "Log message not cleaned");
        Check(UiKit.CleanLogMessage("LABEL", "LABEL  Codex 侧栏") == "Codex 侧栏", "Log prefix not removed");

        // 10. 页面滚动：滚轮不改下拉框 / 数字框的值；列表滚到头或没有滚动条时交给页面；点控件不跳页
        {
            var scroller = new PageScroller { Dock = DockStyle.Fill };
            var stack = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
            combo.Items.AddRange(new object[] { "a", "b", "c" }); combo.SelectedIndex = 1;
            var number = new NumericUpDown { Value = 5 };
            var shortList = new ListView { View = View.Details, Height = 200, Width = 300 };
            shortList.Columns.Add("x", 100); shortList.Items.Add("one");
            var longList = new ListView { View = View.Details, Height = 80, Width = 300 };
            longList.Columns.Add("x", 100); for (int i = 0; i < 40; i++) longList.Items.Add("row " + i);
            var tall = new Panel { Height = 2000, Width = 10 };
            var bottomBox = new TextBox();
            stack.Controls.AddRange(new Control[] { combo, number, shortList, longList, tall, bottomBox });
            scroller.Controls.Add(stack);
            using var f = Host(scroller);
            f.Height = 500; Application.DoEvents();
            Check(PageScroller.ShouldScrollPage(combo, -120), "Wheel over a closed combo box should scroll the page");
            Check(PageScroller.ShouldScrollPage(number.Controls[1], -120) && PageScroller.ShouldScrollPage(number, 120), "Wheel over a number box should scroll the page");
            Check(PageScroller.ShouldScrollPage(shortList, -120), "Wheel over a list without its own scroll bar should scroll the page");
            Check(!PageScroller.ShouldScrollPage(longList, -120), "A long list should scroll itself first");
            Check(PageScroller.ShouldScrollPage(longList, 120), "A long list at its top should hand upward scrolling to the page");
            scroller.ScrollPage(-120);
            Check(-scroller.AutoScrollPosition.Y > 0, "ScrollPage did not move the page");
            Check(combo.SelectedIndex == 1 && number.Value == 5, "Scrolling changed a value");
            int before = -scroller.AutoScrollPosition.Y;
            bottomBox.Focus(); Application.DoEvents();
            Check(-scroller.AutoScrollPosition.Y == before, "Focusing a control made the page jump");
        }
        // 11. 用量页：列表按行数撑开，不出内部滚动条（指针停在列表上也能滚整页）
        {
            var usage = new UsageView(null);
            using var f = Host(usage);
            usage.ShowData(SampleUsage(DateTimeOffset.UtcNow));
            Application.DoEvents();
            foreach (var name in new[] { "usage-sessions", "usage-roles", "usage-models" })
                Check(!PageScroller.CanScroll(Find<ListView>(usage, name), -120), name + " still has its own scroll bar");
        }
        // 12. 用量页：两种范围下滚到底时最后一行说明都完整可见
        foreach (var account in new[] { false, true })
        {
            var usage = new UsageView(null);
            using var f = Host(usage);
            f.Size = new Size(620, 420);
            f.Scale(new SizeF(1.75f, 1.75f)); Application.DoEvents();
            usage.ShowData(SampleUsage(DateTimeOffset.UtcNow));
            if (account) usage.SelectAccount("a2");
            Application.DoEvents();
            var scroller = Find<PageScroller>(usage, "usage-scroller");
            for (int i = 0; i < 60; i++) scroller.ScrollPage(-120);
            Application.DoEvents();
            var foot = Find<Label>(usage, "usage-foot");
            var footBottom = scroller.PointToClient(foot.PointToScreen(new Point(0, foot.Height))).Y;
            Check(footBottom <= scroller.ClientSize.Height, (account ? "account" : "all") + " scope: footer clipped (" + footBottom + " > " + scroller.ClientSize.Height + ")");
        }

        if (args.Length > 0) Screenshots(args[0], accounts, Saved());
        Console.WriteLine("PASS desktop rules: editor order/conversion/validation, basic migration, policy page saves edits in one step, keeps unsaved edits, basic mode");
    }

    static PanelState State(List<AccountState> accounts, RotationConfig rotation) => new PanelState
    {
        Accounts = accounts,
        Policy = new PolicyState { AutoSwitch = true, MinWaitMin = 60, ReserveIndex = 1, MaxMinWait = 600, MinMinWait = 5, Rotation = rotation },
        Schedule = new ScheduleState { LastStatus = "OK", LastStatusAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), LastRunAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), TickCount = 1432 },
    };

    static UsageState SampleUsage(DateTimeOffset now)
    {
        var days = Enumerable.Range(0, 7).Select(i => new UsageDay { Date = now.AddDays(i - 6).ToString("yyyy-MM-dd"), Tokens = (i + 2) * 30_000_000L, Input = (i + 2) * 29_800_000L, Cached = (i + 2) * 29_000_000L, Output = (i + 2) * 180_000L, Events = 300 }).ToList();
        var win = new UsageWindow { Key = "a2", Label = "sample3@example.com", StartAt = now.AddDays(-1).ToUnixTimeMilliseconds(), ResetAt = now.AddDays(6).ToUnixTimeMilliseconds(), UsedPercent = 43, Tokens = 143_000_000, Input = 142_000_000, Cached = 136_500_000, Output = 340_000 };
        var acct = new UsageState { Key = "a2", Label = "sample3@example.com", Totals = new UsageTotals { Tokens = 836_000_000, Input = 834_000_000, Cached = 809_000_000, Output = 1_100_000 }, Today = days[6], Days = days, Hours = Enumerable.Range(0, 24).Select(h => (long)(h % 5) * 3_000_000).ToList(), CacheHitRate = 0.97, Window = win,
            ByModel = new List<UsageBucket> { new UsageBucket { Model = "gpt-6.1-sol", Tokens = 693_000_000 }, new UsageBucket { Model = "codex-auto-review", Tokens = 121_000_000 } } };
        return new UsageState
        {
            RangeDays = 7, Totals = new UsageTotals { Tokens = 2_186_000_000, Input = 2_182_000_000, Cached = 2_119_000_000, Output = 3_700_000 }, Today = days[6], Days = days,
            Hours = Enumerable.Range(0, 24).Select(h => (long)(h % 7) * 4_000_000).ToList(), CacheHitRate = 0.971, Windows = new List<UsageWindow> { win },
            ByRole = new List<UsageRole> { new UsageRole { Role = "主开发", Tokens = 1_706_000_000 }, new UsageRole { Role = "自动 review", Tokens = 288_000_000 }, new UsageRole { Role = "审查 reviewer", Tokens = 192_000_000 } },
            ByModel = new List<UsageBucket> { new UsageBucket { Model = "gpt-6.1-sol", Tokens = 1_660_000_000 }, new UsageBucket { Model = "codex-auto-review", Tokens = 288_000_000 }, new UsageBucket { Model = "gpt-6-sol", Tokens = 192_000_000 } },
            ByProject = new List<UsageProject> { new UsageProject { Project = "Trading", Tokens = 1_500_000_000 }, new UsageProject { Project = "CodexMultiAuth", Tokens = 300_000_000 } },
            TopSessions = Enumerable.Range(0, 10).Select(i => new UsageSession { Title = "继续 Trading 项目的交易训练软件，你负责第 3 部分 UI 与前端 #" + i, Project = i % 2 == 0 ? "Trading" : "CodexMultiAuth", Tokens = 1_307_000_000L / (i + 1), UpdatedAt = now.AddDays(-i % 3).ToUnixTimeMilliseconds() }).ToList(),
            Accounts = new List<UsageState> { acct },
            Scan = new UsageScan { Files = 241, Mb = 1255, Ms = 5166 },
        };
    }

    // 和桌面端一样：控件按 96 DPI 创建，再整体 Scale(1.75)；页面大小取真实窗口里右侧页签的尺寸。
    static void Screenshots(string dir, List<AccountState> accounts, RotationConfig saved)
    {
        Directory.CreateDirectory(dir);
        void Shot(string name, Control view, Action render)
        {
            view.Dock = DockStyle.Fill;
            using var f = new Form { AutoScaleMode = AutoScaleMode.None, FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, Location = new Point(-4000, 0), Size = new Size(620, name == "usage.png" ? 1100 : 600) };
            f.Controls.Add(view);
            f.Scale(new SizeF(1.75f, 1.75f));
            f.Show(); Application.DoEvents();
            render();
            Application.DoEvents();
            using var bmp = new Bitmap(f.Width, f.Height);
            f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
            bmp.Save(Path.Combine(dir, name));
        }
        foreach (var (name, rotation) in new[] { ("policy-custom.png", saved), ("policy-basic.png", (RotationConfig)null) })
        {
            var view = new PolicyView();
            Shot(name, view, () => view.Render(State(accounts, rotation)));
        }
        var now = DateTimeOffset.UtcNow;
        var detail = new AccountDetailView();
        var acct = new AccountState { N = 3, Email = "sample3@example.com", PlanLabel = "Plus", InUse = true, QuotaSource = "live",
            QuotaUpdatedAt = now.AddMinutes(-1).ToUnixTimeMilliseconds(), LastUsed = now.AddMinutes(-1).ToUnixTimeMilliseconds(),
            H5 = new QuotaWindow { Remaining = 23, ResetAt = now.AddHours(4).AddMinutes(48).ToUnixTimeMilliseconds() },
            H7 = new QuotaWindow { Remaining = 60, ResetAt = now.AddDays(5).AddHours(18).ToUnixTimeMilliseconds() } };
        Shot("detail.png", detail, () => detail.Render(acct, State(accounts, null)));
        var router = new RouterView();
        var st = State(accounts, null);
        st.Accounts[2].InUse = true;
        st.Selection = new SelectionState { Available = 3, Total = 3 };
        st.Router = new RouterState { Running = true, Port = 53742, Pid = 35496, Requests = 268, Upstream = 244, Rotations = 41, Retries = 41, LastError = "upstream-transport:econnreset", LastErrorAt = now.AddMinutes(-5).ToUnixTimeMilliseconds(), ErrorRecovered = true, RequestsSinceError = 12 };
        Shot("router.png", router, () => router.Render(st));
        var usage = new UsageView(null);
        Shot("usage.png", usage, () => usage.ShowData(SampleUsage(now)));
    }
}
