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
    /// <summary>
    /// 原生 WinForms 主窗口：菜单栏 + 工具栏 + 账号列表 + 详情/日志/策略/路由四个页签 + 状态栏。
    /// 数据全部来自本地面板服务（127.0.0.1:8766），页面只是渲染层，网页版仍然独立可用。
    /// </summary>
    public sealed partial class NativeForm : Form
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "CodexQuotaPanel";
        private const string ProviderRole = "日常";
        private const string ReserveRole = "储备";

        private readonly AppConfig _cfg = AppConfig.Load();
        private readonly ApiClient _api;
        private readonly Icon _icon;
        private readonly NotifyIcon _tray = new NotifyIcon();
        private readonly Timer _timer = new Timer();

        // 托盘账号提示：tooltip 与菜单首行显示当前账号，切换时弹气泡。
        private ToolStripMenuItem _trayAccountItem;
        private int _lastTrayAccountN;
        private Form _accountToast;
        private Label _accountToastLabel;
        private Timer _accountToastTimer;

        private bool _exiting;
        private bool _trayDisposed;
        private bool _suppressScopeLink;
        private bool _busy;
        private bool _actionBusy;
        private bool _actionRefreshPending;
        private bool _actionRefreshRunning;
        private int _actionVersion;
        private float _scale = 1f;
        private PanelState _state;
        private string _lastRuntimeAlert;
        private readonly Font _listBoldFont;
        private string _accountsSignature;
        private string _logsSignature;
        private int _selectedN;

        // 菜单 / 工具栏
        private MenuStrip _menu;
        private ToolStrip _toolbar;
        private ToolStripButton _btnRefresh;
        private ToolStripButton _btnAdd;
        private ToolStripButton _btnRouterRestart;
        private ToolStripLabel _lblWho;

        // 账号列表
        private SplitContainer _split;
        private ListView _list;
        private Label _lblEmpty;

        // 详情页
        private TabControl _tabs;
        private UsageView _usageView;
        private AccountDetailView _detailView;

        // 日志页
        private ListView _logList;

        // 策略页
        private TabPage _policyTab;
        private PolicyView _policyView;

        // 路由页
        private RouterView _routerView;

        // 状态栏
        private StatusStrip _statusBar;
        private ToolStripStatusLabel _stService, _stAccount, _stWeek, _stRouter, _stUpdated;

        public NativeForm()
        {
            _icon = IconFactory.Create();
            _api = new ApiClient(_cfg.Url);
            _listBoldFont = new Font(Font, FontStyle.Bold);

            Text = "Codex 额度面板";
            Icon = _icon;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(760, 520);
            // 手动缩放：本机 168 DPI（175%），WinForms 自动缩放链路不可靠，统一在 OnLoad 里 Scale()。
            AutoScaleMode = AutoScaleMode.None;
            KeyPreview = true;

            Size = new Size(1150, 760);
            var wa = Screen.PrimaryScreen.WorkingArea;
            if (_cfg.X > -1 && _cfg.Y > -1 && _cfg.X < wa.Right && _cfg.Y < wa.Bottom)
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(_cfg.X, _cfg.Y);
            }
            if (_cfg.Maximized) WindowState = FormWindowState.Maximized;

            BuildMenu();
            BuildToolbar();
            BuildBody();
            BuildStatusBar();

            // 停靠顺序：先填满区，再底部/顶部，最后菜单（WinForms 按 z 序反向停靠）。
            Controls.Add(_split);
            Controls.Add(_statusBar);
            Controls.Add(_toolbar);
            Controls.Add(_menu);

            EnsureNoAutoStart();
            BuildTray();

            _timer.Interval = 15000;
            _timer.Tick += async (s, e) => { if (!_busy && !_actionBusy) await RefreshAsync(false); };
            _timer.Start();

            KeyDown += (s, e) => { if (e.KeyCode == Keys.F5) { e.Handled = true; _ = RefreshAsync(true); } };

            AppLog.Write("NativeForm ctor done");
        }
    }
}
