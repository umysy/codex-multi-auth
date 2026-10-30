using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 页面级竖向滚动容器（用量页、账号详情、路由、策略页共用）。修三个 WinForms 默认行为：
    ///
    /// 1. 滚轮停在下拉框 / 数字框上时改的是它的值，不是滚页面——在策略页滚动时会悄悄改掉阈值、储备号，
    ///    在用量页会切换账号范围。现在这些控件只有在“下拉框展开”时才自己吃滚轮。
    /// 2. 滚轮停在列表 / 表格上、而它没有滚动条或已经滚到头时，页面纹丝不动。现在交给页面接着滚。
    /// 3. 点一下列表或下拉框，页面会跳一下（AutoScroll 把获得焦点的控件整个滚进视野）。现在保持原位。
    /// </summary>
    internal sealed class PageScroller : Panel, IMessageFilter
    {
        private const int WM_MOUSEWHEEL = 0x020A;
        private const int SB_VERT = 1;
        private const int SIF_ALL = 0x17;
        private bool _filtering;

        public PageScroller()
        {
            AutoScroll = true;
            // AutoScroll 的滚动范围只算到最后一个子控件的下沿，不算 Padding：
            // 页面最后一行（自动换行的说明文字）会被底边截掉一截。留出余量。
            AutoScrollMargin = new Size(0, 24);
        }

        // 3. 焦点变化时不自动滚动。
        protected override Point ScrollToControl(Control activeControl) => DisplayRectangle.Location;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!_filtering) { Application.AddMessageFilter(this); _filtering = true; }
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            if (_filtering) { Application.RemoveMessageFilter(this); _filtering = false; }
            base.OnHandleDestroyed(e);
        }

        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg != WM_MOUSEWHEEL || !Visible || !IsHandleCreated) return false;
            Point screen = new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16)));
            if (!RectangleToScreen(ClientRectangle).Contains(screen)) return false;
            int delta = unchecked((short)((long)m.WParam >> 16));
            Control target = Control.FromChildHandle(WindowFromPoint(screen)) ?? this;
            if (!ShouldScrollPage(target, delta)) return false;
            ScrollPage(delta);
            return true;
        }

        /// <summary>这次滚轮该不该滚页面（而不是交给鼠标下的控件）。</summary>
        internal static bool ShouldScrollPage(Control target, int delta)
        {
            for (Control c = target; c != null && !(c is PageScroller); c = c.Parent)
            {
                switch (c)
                {
                    case ComboBox combo:
                        return !combo.DroppedDown;
                    case NumericUpDown _:
                    case UpDownBase _:
                        return true;
                    case ListView _:
                    case DataGridView _:
                    case TextBoxBase _:
                        return !CanScroll(c, delta);
                }
            }
            return true;
        }

        /// <summary>控件自己在这个方向上还能不能滚（没有竖向滚动条，或已经到顶 / 到底，都算不能）。</summary>
        internal static bool CanScroll(Control c, int delta)
        {
            if (!c.IsHandleCreated) return false;
            var info = new SCROLLINFO { cbSize = (uint)Marshal.SizeOf<SCROLLINFO>(), fMask = SIF_ALL };
            if (!GetScrollInfo(c.Handle, SB_VERT, ref info)) return false;
            int max = info.nMax - Math.Max(0, (int)info.nPage - 1);
            if (info.nPage == 0 || max <= info.nMin) return false;
            return delta > 0 ? info.nPos > info.nMin : info.nPos < max;
        }

        internal void ScrollPage(int delta)
        {
            int line = Math.Max(16, Font.Height * 3);
            int step = (int)Math.Round(delta / 120.0 * line * Math.Max(1, SystemInformation.MouseWheelScrollLines) / 3.0);
            int current = -AutoScrollPosition.Y;
            int limit = Math.Max(0, DisplayRectangle.Height - ClientSize.Height);
            int next = Math.Max(0, Math.Min(limit, current - step));
            if (next != current) AutoScrollPosition = new Point(-AutoScrollPosition.X, next);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SCROLLINFO { public uint cbSize, fMask; public int nMin, nMax; public uint nPage; public int nPos, nTrackPos; }

        [DllImport("user32.dll")] private static extern bool GetScrollInfo(IntPtr hwnd, int bar, ref SCROLLINFO info);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point p);
    }
}
