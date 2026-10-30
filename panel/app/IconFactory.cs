using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>程序图标：圆角渐变块 + 内圈 + 圆点，运行时绘制，不依赖外部资源。</summary>
        /// <summary>Win32 置顶辅助：让提示窗压在其他 TopMost 窗口之上。</summary>
    internal static class TopMostWindow
    {
        private static readonly IntPtr HwndTopMost = new IntPtr(-1);
        private const uint SwpNoMove = 0x0002;
        private const uint SwpNoSize = 0x0001;
        private const uint SwpNoActivate = 0x0010;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

        internal static void Raise(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return;
            SetWindowPos(handle, HwndTopMost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
        }
    }

internal static class IconFactory
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr hIcon);


        public static Icon Create()
        {
            using (var bmp = new Bitmap(64, 64))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                var r = new Rectangle(2, 2, 60, 60);
                using (var path = Rounded(r, 16))
                using (var brush = new LinearGradientBrush(r, Color.FromArgb(124, 92, 255), Color.FromArgb(55, 214, 196), 45f))
                {
                    g.FillPath(brush, path);
                }
                using (var pen = new Pen(Color.FromArgb(235, 240, 255), 3.2f))
                using (var path = Rounded(new Rectangle(14, 14, 36, 36), 12))
                {
                    g.DrawPath(pen, path);
                }
                using (var dot = new SolidBrush(Color.FromArgb(235, 240, 255)))
                {
                    g.FillEllipse(dot, 26, 26, 12, 12);
                }

                IntPtr h = bmp.GetHicon();
                try
                {
                    using (var tmp = Icon.FromHandle(h))
                    {
                        return (Icon)tmp.Clone();
                    }
                }
                finally
                {
                    DestroyIcon(h);
                }
            }
        }

        private static GraphicsPath Rounded(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    /// <summary>单行文本输入对话框（备注用）。</summary>
    internal sealed class NoteDialog : Form
    {
        private readonly TextBox _box = new TextBox();

        public string Value { get { return _box.Text; } }

        public NoteDialog(string title, string initial)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(460, 132);
            Font = new Font("Microsoft YaHei UI", 9F);

            var tip = new Label
            {
                Text = "备注只保存在本地账号策略里，用来提醒自己这个号的用途。",
                AutoSize = false,
                Location = new Point(14, 12),
                Size = new Size(432, 20),
                ForeColor = SystemColors.GrayText,
            };
            _box.Location = new Point(14, 38);
            _box.Size = new Size(432, 24);
            _box.Text = initial ?? "";
            _box.MaxLength = 200;

            var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Location = new Point(280, 78), Size = new Size(80, 28) };
            var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(366, 78), Size = new Size(80, 28) };

            Controls.Add(tip);
            Controls.Add(_box);
            Controls.Add(ok);
            Controls.Add(cancel);
            AcceptButton = ok;
            CancelButton = cancel;
        }
    }
}
