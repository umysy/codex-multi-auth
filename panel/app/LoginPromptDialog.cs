using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 添加账号前的风险确认框（自绘 Form，不用 MessageBox）。
    /// 第二道闸门：必须主动勾选复选框，「继续添加」才可用——防止辅助技术/自动化把确认框直接确认掉。
    /// 默认勾选「仅试运行」，避免误触真实登录。
    /// </summary>
    internal sealed class LoginPromptDialog : Form
    {
        private readonly CheckBox _ack;
        private readonly CheckBox _dry;
        private readonly Button _ok;

        public LoginPromptDialog(float scale)
        {
            float s = scale <= 0 ? 1f : scale;
            Text = "添加账号";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(250, 250, 252);
            ClientSize = new Size((int)(560 * s), (int)(374 * s));
            Font = new Font("Microsoft YaHei UI", 9F);

            var tip = new Label
            {
                AutoSize = false,
                Dock = DockStyle.Fill,
                Padding = new Padding((int)(18 * s), (int)(16 * s), (int)(18 * s), 0),
                Text = "将在桌面上打开一个命令行窗口（黑色窗口），由它完成账号登录。\r\n\r\n" +
                       "· 在浏览器里登录完成后，关掉那个命令行窗口\r\n" +
                       "· 回到面板点「刷新额度」，新账号就会出现在列表里\r\n\r\n" +
                       "同一时间只会打开一个登录窗口。\r\n\r\n" +
                       "建议先勾选下面的「仅试运行」验证一遍流程，确认无误后再取消勾选做真实登录。",
            };

            var bottom = new Panel { Dock = DockStyle.Bottom, Height = (int)(136 * s) };

            _dry = new CheckBox
            {
                Text = "仅试运行（不真正登录，只验证流程，约 2 分钟后自动关闭）",
                Checked = false,
                AutoSize = true,
                Location = new Point((int)(18 * s), (int)(6 * s)),
            };
            _dry.Click += (a, b) => AppLog.Write("LoginPrompt dry=" + _dry.Checked);

            _ack = new CheckBox
            {
                Text = "我已了解风险，继续打开登录窗口",
                AutoSize = true,
                Location = new Point((int)(18 * s), (int)(34 * s)),
            };
            _ack.CheckedChanged += (a, b) => { _ok.Enabled = _ack.Checked; };
            _ack.Click += (a, b) => AppLog.Write("LoginPrompt cb=" + _ack.Checked);

            _ok = new Button
            {
                Text = "继续添加",
                Enabled = false,
                Size = new Size((int)(110 * s), (int)(34 * s)),
                UseVisualStyleBackColor = true,
            };
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Size = new Size((int)(110 * s), (int)(34 * s)), UseVisualStyleBackColor = true };
            _ok.Location = new Point(ClientSize.Width - (int)(18 * s) - (int)(110 * s), (int)(80 * s));
            cancel.Location = new Point(_ok.Left - (int)(10 * s) - (int)(110 * s), (int)(80 * s));

            _ok.Click += (a, b) =>
            {
                try { AppLog.Write("LoginPrompt btn=ok stack=" + new StackTrace(true).ToString().Replace(Environment.NewLine, " | ")); } catch { }
                if (!_ack.Checked) { return; }
                DialogResult = DialogResult.OK;
            };
            cancel.Click += (a, b) => AppLog.Write("LoginPrompt btn=cancel");

            bottom.Controls.Add(_dry);
            bottom.Controls.Add(_ack);
            bottom.Controls.Add(cancel);
            bottom.Controls.Add(_ok);

            Controls.Add(tip);
            Controls.Add(bottom);
            AcceptButton = cancel;
            CancelButton = cancel;
            ActiveControl = cancel;
        }

        internal bool OkEnabled { get { return _ok.Enabled; } }
        internal bool AckChecked { get { return _ack.Checked; } }
        internal bool DryRun { get { return _dry.Checked; } }
        internal void SetAck(bool v) { _ack.Checked = v; }
        internal void SetDry(bool v) { _dry.Checked = v; }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            AppLog.Write("LoginPrompt shown ack=" + _ack.Checked + " okEnabled=" + _ok.Enabled + " dry=" + _dry.Checked);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            AppLog.Write("LoginPrompt closing reason=" + e.CloseReason + " result=" + DialogResult + " ack=" + _ack.Checked + " dry=" + _dry.Checked);
            base.OnFormClosing(e);
        }
    }
}
