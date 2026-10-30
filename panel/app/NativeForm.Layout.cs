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

        #region 构建界面

        private void BuildMenu()
        {
            _menu = new MenuStrip();

            var file = new ToolStripMenuItem("文件(&F)");
            file.DropDownItems.Add(Item("刷新额度(&R)\tF5", (s, e) => { }));
            file.DropDownItems[0].Click += async (s, e) => await RefreshAsync(true);
            file.DropDownItems.Add(Item("打开日志目录(&L)", (s, e) => OpenFolder(_cfg.PanelDir)));
            file.DropDownItems.Add(new ToolStripSeparator());
            file.DropDownItems.Add(Item("退出(&X)", (s, e) => ExitApp()));

            var account = new ToolStripMenuItem("账号(&A)");
            account.DropDownItems.Add(ItemAsync("添加账号（浏览器授权，推荐）", AddAccountAsync));
            account.DropDownItems.Add(ItemAsync("添加账号（试运行，不真登录）", AddAccountDryAsync));
    account.DropDownItems.Add(ItemAsync("取消登录窗口（清理残留）", CancelLoginAsync));
            account.DropDownItems.Add(new ToolStripSeparator());
            account.DropDownItems.Add(ItemAsync("切换到此账号", () => DoAccount("switch", "切换账号")));
            account.DropDownItems.Add(ItemAsync("暂停 / 恢复", TogglePauseAsync));
            account.DropDownItems.Add(ItemAsync("设为 / 取消储备", ToggleReserveAsync));
            account.DropDownItems.Add(ItemAsync("修改备注…", EditNoteAsync));

            var router = new ToolStripMenuItem("路由(&R)");
            router.DropDownItems.Add(ItemAsync("重启路由", () => RouterActionAsync("restart")));
            router.DropDownItems.Add(ItemAsync("重新绑定桌面版", () => RouterActionAsync("rebind")));

            var help = new ToolStripMenuItem("帮助(&H)");
            help.DropDownItems.Add(Item("打开网页版", (s, e) => OpenWebFallback()));
            help.DropDownItems.Add(Item("使用说明", (s, e) => OpenText(Path.Combine(AppContext.BaseDirectory, "使用说明.txt"))));
            help.DropDownItems.Add(new ToolStripSeparator());
            help.DropDownItems.Add(Item("关于", (s, e) => MessageBox.Show(this,
                "Codex 额度面板（桌面版）v2.0\n\n原生 WinForms 界面：账号池 / 额度 / 轮转 / 路由控制台。\n数据来自本地面板服务与 codex-multi-auth。",
                "关于", MessageBoxButtons.OK, MessageBoxIcon.Information)));

            _menu.Items.AddRange(new ToolStripItem[] { file, account, router, help });
            MainMenuStrip = _menu;
        }

        private static ToolStripMenuItem Item(string text, EventHandler handler)
        {
            var it = new ToolStripMenuItem(text);
            it.Click += handler;
            return it;
        }

        private static ToolStripMenuItem ItemAsync(string text, Func<Task> action)
        {
            var it = new ToolStripMenuItem(text);
            it.Click += async (s, e) => await action();
            return it;
        }

        private void BuildToolbar()
        {
            _toolbar = new ToolStrip
            {
                GripStyle = ToolStripGripStyle.Hidden,
                Padding = new Padding(6, 3, 6, 3),
                RenderMode = ToolStripRenderMode.System,
            };

            _btnRefresh = new ToolStripButton("刷新额度") { ToolTipText = "重新读取三个账号的实时额度（F5）" };
            _btnRefresh.Click += async (s, e) => await RefreshAsync(true);

            _btnAdd = new ToolStripButton("添加账号") { ToolTipText = "打开浏览器完成 OAuth 授权，把新账号加入池" };
            _btnAdd.Click += async (s, e) => await AddAccountAsync();

            _btnRouterRestart = new ToolStripButton("重启路由") { ToolTipText = "重启本地转发路由（清除最近错误）" };
            _btnRouterRestart.Click += async (s, e) => await RouterActionAsync("restart");

            _lblWho = new ToolStripLabel("当前：—");

            _toolbar.Items.Add(_btnRefresh);
            _toolbar.Items.Add(_btnAdd);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_btnRouterRestart);
            _toolbar.Items.Add(new ToolStripSeparator());
            _toolbar.Items.Add(_lblWho);
        }

        private void BuildBody()
        {
            _split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Vertical,
                FixedPanel = FixedPanel.Panel1,
                SplitterWidth = 6,
                BorderStyle = BorderStyle.None,
            };

            // ---- 左：账号列表 ----
            var left = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8, 6, 4, 6) };
            var leftTitle = new Label
            {
                Text = "账号池",
                Dock = DockStyle.Top,
                Height = 24,
                Font = new Font(Font, FontStyle.Bold),
            };
            _list = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                FullRowSelect = true,
                HideSelection = false,
                MultiSelect = false,
                BorderStyle = BorderStyle.FixedSingle,
                HeaderStyle = ColumnHeaderStyle.Nonclickable,
                ShowItemToolTips = true,
            };
            _list.Columns.Add("号", 30, HorizontalAlignment.Center);
            _list.Columns.Add("账号", 124);
            _list.Columns.Add("角色", 42);
            _list.Columns.Add("5 小时", 50, HorizontalAlignment.Right);
            _list.Columns.Add("5h 重置", 58, HorizontalAlignment.Center);
            _list.Columns.Add("7 天", 50, HorizontalAlignment.Right);
            _list.Columns.Add("7d 重置", 84, HorizontalAlignment.Center);
            _list.Columns.Add("状态", 54);
            _list.SelectedIndexChanged += (s, e) =>
            {
                if (_suppressScopeLink) return;
                if (_list.SelectedItems.Count > 0 && _list.SelectedItems[0].Tag is int n) _selectedN = n;
                RenderDetail();
                if (!_suppressScopeLink && _list.SelectedItems.Count > 0 && _list.SelectedItems[0].Tag is int sn) _usageView?.SelectAccount("a" + (sn - 1));
            };

            _lblEmpty = new Label
            {
                Text = "正在读取账号…",
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = SystemColors.GrayText,
            };

            left.Controls.Add(_list);
            left.Controls.Add(_lblEmpty);
            left.Controls.Add(leftTitle);
            _split.Panel1.Controls.Add(left);

            // ---- 右：页签 ----
            _tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(14, 5) };
            _tabs.TabPages.Add(BuildDetailTab());
            _tabs.TabPages.Add(BuildLogTab());
            _tabs.TabPages.Add(BuildPolicyTab());
            _tabs.TabPages.Add(BuildRouterTab());
            _tabs.TabPages.Add(BuildUsageTab());
            _tabs.SelectedIndexChanged += (s, e) => { if (_tabs.SelectedTab != null && _tabs.SelectedTab.Text == "用量") _usageView?.MaybeRefresh(false); };
            _split.Panel2.Controls.Add(_tabs);
        }

        private TabPage BuildDetailTab()
        {
            var page = new TabPage("账号详情") { Padding = new Padding(0), BackColor = SystemColors.Control };
            _detailView = new AccountDetailView { Dock = DockStyle.Fill };
            _detailView.SwitchClicked += async (s, e) => await DoAccount("switch", "切换账号");
            _detailView.PauseClicked += async (s, e) => await TogglePauseAsync();
            _detailView.ReserveClicked += async (s, e) => await ToggleReserveAsync();
            _detailView.UnpinClicked += async (s, e) => await UnpinAsync();
            _detailView.NoteClicked += async (s, e) => await EditNoteAsync();
            _detailView.RefreshClicked += async (s, e) => await RefreshAsync(true);
            page.Controls.Add(_detailView);
            return page;
        }

        private TabPage BuildLogTab()
        {
            var page = new TabPage("事件") { Padding = new Padding(10, 8, 10, 8), BackColor = SystemColors.Control };
            _logList = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                FullRowSelect = true,
                HideSelection = true,
                MultiSelect = false,
                BorderStyle = BorderStyle.FixedSingle,
                HeaderStyle = ColumnHeaderStyle.Nonclickable,
                ShowItemToolTips = true,
            };
            _logList.Columns.Add("时间", 140);
            _logList.Columns.Add("类型", 70);
            _logList.Columns.Add("内容", 640);
            page.Controls.Add(_logList);
            return page;
        }

        private TabPage BuildPolicyTab()
        {
            _policyTab = new TabPage("策略") { Padding = new Padding(0), BackColor = SystemColors.Control };
            _policyView = new PolicyView { Dock = DockStyle.Fill };
            _policyView.SaveRequested += async (s, e) => await SavePolicyAsync();
            _policyTab.Controls.Add(_policyView);
            return _policyTab;
        }
        private TabPage BuildUsageTab()
        {
            var page = new TabPage("用量") { Padding = new Padding(10, 8, 10, 8), BackColor = SystemColors.Control };
            _usageView = new UsageView(_api) { Dock = DockStyle.Fill };
            page.Controls.Add(_usageView);
            return page;
        }

        private TabPage BuildRouterTab()
        {
            var page = new TabPage("路由") { Padding = new Padding(0), BackColor = SystemColors.Control };
            _routerView = new RouterView { Dock = DockStyle.Fill };
            _routerView.RestartClicked += async (s, e) => await RouterActionAsync("restart");
            _routerView.RebindClicked += async (s, e) => await RouterActionAsync("rebind");
            _routerView.AddAccountClicked += async (s, e) => await AddAccountAsync();
            page.Controls.Add(_routerView);
            return page;
        }

        private void BuildStatusBar()
        {
            _statusBar = new StatusStrip { SizingGrip = true };
            _stService = new ToolStripStatusLabel("服务：连接中…");
            _stAccount = new ToolStripStatusLabel("当前：—");
            _stWeek = new ToolStripStatusLabel("本周剩余：—");
            _stRouter = new ToolStripStatusLabel("路由：—") { Spring = true, TextAlign = ContentAlignment.MiddleRight };
            _stUpdated = new ToolStripStatusLabel("—");
            _statusBar.Items.AddRange(new ToolStripItem[] { _stService, _stAccount, _stWeek, _stRouter, _stUpdated });
            _statusBar.ShowItemToolTips = true;
        }

        private void BuildTray()
        {
            _tray.Icon = _icon;
            _tray.Text = "Codex 额度面板";
            _tray.Visible = true;

            _trayAccountItem = new ToolStripMenuItem("当前账号：加载中…") { Enabled = false };

            var menu = new ContextMenuStrip();
            menu.Items.Add(_trayAccountItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开面板", null, (s, e) => ShowPanel());
            menu.Items.Add("刷新额度", null, async (s, e) => await RefreshAsync(true));
            menu.Items.Add("添加账号（浏览器授权）", null, async (s, e) => await AddAccountAsync());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开网页版", null, (s, e) => OpenWebFallback());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) => ExitApp());

            _tray.ContextMenuStrip = menu;
            _tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    try { BeginInvoke(new Action(ShowPanel)); } catch { ShowPanel(); }
                }
            };
        }

        #endregion
    }
}
