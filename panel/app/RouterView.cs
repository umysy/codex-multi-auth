using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 「路由」页：本机路由是否在线、正在用哪个账号、最近有没有出错，以及三个维护操作。
    ///
    /// 以前的问题：说明里写死了旧端口 56014（实际是 app-bind 里的端口）和一条过时的策略说明；
    /// 按钮固定宽度，「重新绑定桌面版」被截断；最近错误只有一行，长了就看不全。
    /// </summary>
    internal sealed class RouterView : ScrollPage
    {
        private readonly Label _status = UiKit.TextLabel();
        private readonly Label _address = UiKit.TextLabel();
        private readonly Label _account = UiKit.TextLabel();
        private readonly Label _traffic = UiKit.TextLabel();
        private readonly Label _error = new Label { Name = "router-error", AutoSize = true, Margin = new Padding(0, 2, 0, 2) };
        private readonly Label _help = new Label { Name = "router-help", AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 2, 0, 2) };
        private readonly Button _restart = UiKit.MakeButton("重启路由", "router-restart");
        private readonly Button _rebind = UiKit.MakeButton("重新绑定桌面版", "router-rebind");
        private readonly Button _login = UiKit.MakeButton("添加账号", "router-login");

        public event EventHandler RestartClicked, RebindClicked, AddAccountClicked;

        public RouterView()
        {
            _status.Name = "router-status";
            _status.Font = new Font(_status.Font, FontStyle.Bold);
            Add(UiKit.Heading("运行状态", 0));
            var fields = UiKit.FieldTable();
            UiKit.AddField(fields, "状态", _status);
            UiKit.AddField(fields, "地址", _address);
            UiKit.AddField(fields, "正在使用", _account);
            UiKit.AddField(fields, "请求", _traffic);
            Add(fields);

            Add(UiKit.Heading("最近错误"));
            Add(Wrap(_error));

            var buttons = UiKit.ButtonRow();
            buttons.Controls.AddRange(new Control[] { _restart, _rebind, _login });
            Add(buttons);

            Add(UiKit.Heading("说明"));
            Add(Wrap(_help));

            _restart.Click += (s, e) => RestartClicked?.Invoke(this, EventArgs.Empty);
            _rebind.Click += (s, e) => RebindClicked?.Invoke(this, EventArgs.Empty);
            _login.Click += (s, e) => AddAccountClicked?.Invoke(this, EventArgs.Empty);
            Render(null);
        }

        public void Render(PanelState st)
        {
            var r = st?.Router;
            if (r == null)
            {
                _status.Text = "未知（还没读到路由状态）";
                _status.ForeColor = SystemColors.GrayText;
                _address.Text = _account.Text = _traffic.Text = "—";
                _error.Text = "—";
                _help.Text = HelpText(null);
                return;
            }
            _status.Text = r.Running ? "在线" : "离线（看门狗会在 1 分钟内自动拉起）";
            _status.ForeColor = r.Running ? UiKit.Good : UiKit.Bad;
            _address.Text = "127.0.0.1:" + (r.Port?.ToString() ?? "—") + (r.Pid.HasValue ? " · 进程 " + r.Pid : "");

            var inUse = st.Accounts?.FirstOrDefault(a => a.InUse);
            int? n = inUse?.N ?? st.Selection?.RuntimeInUse ?? r.LastAccountIndex;
            var acct = n.HasValue ? st.Accounts?.FirstOrDefault(a => a.N == n.Value) : null;
            string available = st.Selection != null ? "（可用 " + st.Selection.Available + " / " + st.Selection.Total + " 个）" : "";
            _account.Text = n.HasValue ? "账号 " + n + (acct != null && !string.IsNullOrEmpty(acct.Email) ? " · " + acct.Email : "") + available : "—" + available;

            _traffic.Text = (r.Requests ?? 0) + " 次（发往上游 " + (r.Upstream ?? 0) + "）· 换号 " + (r.Rotations ?? 0) + " · 重试 " + (r.Retries ?? 0);

            if (string.IsNullOrWhiteSpace(r.LastError))
            {
                _error.Text = "没有错误。";
                _error.ForeColor = SystemColors.GrayText;
            }
            else if (r.ErrorRecovered == true)
            {
                _error.Text = r.LastError + "（" + UiKit.Clock(r.LastErrorAt ?? 0) + "）——之后已成功处理 " + (r.RequestsSinceError ?? 0) + " 个请求，已恢复。";
                _error.ForeColor = SystemColors.GrayText;
            }
            else
            {
                _error.Text = r.LastError + "（" + UiKit.Clock(r.LastErrorAt ?? 0) + "）——还没有恢复。";
                _error.ForeColor = UiKit.Bad;
            }
            _help.Text = HelpText(r.Port);
        }

        private static string HelpText(int? port) =>
            "Codex 桌面版的请求先到本机路由（127.0.0.1:" + (port?.ToString() ?? "端口") + "），路由按账号池注入凭据再发往上游；遇到限流或模型繁忙会自动换号重试。\n" +
            "路由进程停了会被自动拉起（计划任务每 5 分钟检查，面板看门狗每分钟检查）。\n" +
            "「重新绑定桌面版」：Codex 的配置被别的工具改掉、不再经过本机路由时使用。只把 config.toml 里指向路由的地址和密钥改回来（先备份），不动账号、策略、启动项和其它设置；完成后要完全退出并重新打开 Codex。\n" +
            "Codex 提示额度不足、但这里还有可用账号：在 Codex 里点 Resume，或完全退出 Codex 再打开（它会缓存上一次的额度）。";
    }
}
