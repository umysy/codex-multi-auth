using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 可竖向滚动的单列页面。内容表格不停靠：AutoScroll 面板里停靠的子控件会按内容撑宽，
    /// 标签不换行、右侧被裁掉；这里把内容宽度钉在可见宽度上，Wrap() 登记的标签按这个宽度换行。
    /// </summary>
    internal class ScrollPage : UserControl
    {
        protected readonly PageScroller Scroller;
        protected readonly TableLayoutPanel Content;
        private readonly List<Label> _wrapped = new List<Label>();

        public ScrollPage()
        {
            BackColor = SystemColors.Control;
            Scroller = new PageScroller { Name = Name + "-scroller", Dock = DockStyle.Fill };
            Content = new TableLayoutPanel { Location = new Point(16, 12), AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Margin = new Padding(0) };
            Content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Scroller.Controls.Add(Content);
            Controls.Add(Scroller);
        }

        protected void Add(Control c) => Content.Controls.Add(c);

        protected Label Wrap(Label label)
        {
            _wrapped.Add(label);
            return label;
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            int width = Math.Max(200, ClientSize.Width - 2 * Content.Left - SystemInformation.VerticalScrollBarWidth);
            if (Content.MinimumSize.Width != width)
            {
                Content.MinimumSize = new Size(width, 0);
                Content.MaximumSize = new Size(width, 0);
            }
            foreach (var label in _wrapped)
                if (label.MaximumSize.Width != width) label.MaximumSize = new Size(width, 0);
            base.OnLayout(e);
        }
    }
}
