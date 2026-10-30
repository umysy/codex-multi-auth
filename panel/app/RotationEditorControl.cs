using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace CodexQuota
{
    /// <summary>
    /// 自定义账户规则编辑器：默认阈值 + 每个账号的角色、顺序与单号覆盖。
    /// 只负责“显示 / 读回”一份 RotationConfig，不保存、不带操作按钮——保存由策略页统一做。
    /// 控件只构建一次，换数据用 Load()；以前每次刷新都重建，重建出来的控件没经过窗口的 DPI 缩放，文字被裁掉。
    /// 界面上的阈值都是“剩余 %”，配置里存的是“已用 %”，两边在这里互相换算。
    /// </summary>
    public sealed class RotationEditorControl : UserControl
    {
        private readonly ComboBox _selection = new ComboBox { Name = "rotation-selection", DropDownStyle = ComboBoxStyle.DropDownList, Width = 230 };
        private readonly NumericUpDown _short = Number("rotation-short", 0, 99);
        private readonly NumericUpDown _weekly = Number("rotation-weekly", 0, 99);
        private readonly NumericUpDown _wait = Number("rotation-wait", 0, 600, 0);
        private readonly NumericUpDown _gap = Number("rotation-gap", 0, 3600, 0);
        private readonly CheckBox _return = new CheckBox { Name = "rotation-return", Text = "使用备用号期间，日常号恢复后自动切回", AutoSize = true, Margin = new Padding(0, 6, 0, 2) };
        private readonly DataGridView _accounts = new DataGridView { Name = "rotation-accounts" };
        private List<AccountState> _source = new List<AccountState>();
        private RotationConfig _existing;
        private bool _loading;

        public event EventHandler Changed;

        public RotationEditorControl()
        {
            _selection.Items.AddRange(new object[] { "按顺序循环轮换", "优先用列表靠前的健康号" });
            _selection.SelectedIndex = 0;

            var root = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Margin = new Padding(0) };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            var defaults = new TableLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, Margin = new Padding(0, 0, 0, 6) };
            defaults.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            defaults.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            AddRow(defaults, "日常号选择", _selection, "");
            AddRow(defaults, "5 小时额度剩余 ≤", _short, "% 时换号（0 = 用完再换）");
            AddRow(defaults, "7 天额度剩余 ≤", _weekly, "% 时换号（0 = 用完再换）");
            AddRow(defaults, "5 小时额度在", _wait, "分钟内重置的，先等它重置");
            AddRow(defaults, "两次换号至少间隔", _gap, "秒");
            root.Controls.Add(defaults);
            root.Controls.Add(_return);

            root.Controls.Add(new Label
            {
                Text = "账号角色与顺序",
                AutoSize = true,
                Font = new Font(Font, FontStyle.Bold),
                Margin = new Padding(0, 14, 0, 2),
            });
            root.Controls.Add(new Label
            {
                Text = "至少保留一个日常号。表格里的数值只改这一个账号，留空就用上面的默认值。",
                AutoSize = true,
                ForeColor = SystemColors.GrayText,
                Margin = new Padding(0, 0, 0, 6),
            });

            _accounts.AllowUserToAddRows = false;
            _accounts.AllowUserToDeleteRows = false;
            _accounts.AllowUserToOrderColumns = false;
            _accounts.AllowUserToResizeRows = false;
            _accounts.RowHeadersVisible = false;
            _accounts.MultiSelect = false;
            _accounts.ScrollBars = ScrollBars.None;
            _accounts.BackgroundColor = SystemColors.Window;
            // 选中行用浅色：表格里的选中只用于上移/下移，不该像“已勾选”那样醒目。
            _accounts.DefaultCellStyle.SelectionBackColor = Color.FromArgb(204, 228, 247);
            _accounts.DefaultCellStyle.SelectionForeColor = SystemColors.ControlText;
            _accounts.EnableHeadersVisualStyles = false;
            _accounts.ColumnHeadersDefaultCellStyle.BackColor = SystemColors.Control;
            _accounts.ColumnHeadersDefaultCellStyle.SelectionBackColor = SystemColors.Control;
            _accounts.ColumnHeadersDefaultCellStyle.SelectionForeColor = SystemColors.ControlText;
            _accounts.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            _accounts.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            _accounts.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
            _accounts.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
            _accounts.ColumnHeadersDefaultCellStyle.WrapMode = DataGridViewTriState.True;
            _accounts.EditMode = DataGridViewEditMode.EditOnEnter;
            _accounts.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top;
            _accounts.Margin = new Padding(0);
            _accounts.Columns.Add(new DataGridViewTextBoxColumn { Name = "account", HeaderText = "账号", ReadOnly = true, FillWeight = 200 });
            _accounts.Columns.Add(new DataGridViewComboBoxColumn { Name = "role", HeaderText = "角色", DataSource = new[] { "日常", "备用" }, FillWeight = 60, FlatStyle = FlatStyle.Flat });
            _accounts.Columns.Add(new DataGridViewTextBoxColumn { Name = "short", HeaderText = "5 小时剩余 ≤ %", FillWeight = 80 });
            _accounts.Columns.Add(new DataGridViewTextBoxColumn { Name = "weekly", HeaderText = "7 天剩余 ≤ %", FillWeight = 80 });
            _accounts.Columns.Add(new DataGridViewTextBoxColumn { Name = "wait", HeaderText = "等重置（分）", FillWeight = 80 });
            foreach (DataGridViewColumn column in _accounts.Columns) column.SortMode = DataGridViewColumnSortMode.NotSortable;

            var gridRow = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 2, Margin = new Padding(0) };
            gridRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            gridRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var moves = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = new Padding(8, 0, 0, 0) };
            var up = new Button { Name = "rotation-up", Text = "上移", AutoSize = true, Margin = new Padding(0, 0, 0, 6) };
            var down = new Button { Name = "rotation-down", Text = "下移", AutoSize = true, Margin = new Padding(0) };
            up.Click += (s, e) => MoveSelected(-1);
            down.Click += (s, e) => MoveSelected(1);
            moves.Controls.Add(up);
            moves.Controls.Add(down);
            gridRow.Controls.Add(_accounts, 0, 0);
            gridRow.Controls.Add(moves, 1, 0);
            root.Controls.Add(gridRow);
            Controls.Add(root);
            // 宽度跟随宿主，高度跟随内容（root 停靠在顶部、自动长高）。
            root.SizeChanged += (s, e) => { if (Height != root.Height) Height = root.Height; };

            // 表格按行数撑开高度，不出现内部滚动条（整页由策略页统一滚动）。
            _accounts.RowsAdded += (s, e) => FitGrid();
            _accounts.RowsRemoved += (s, e) => FitGrid();
            _accounts.ColumnHeadersHeightChanged += (s, e) => FitGrid();
            _accounts.RowHeightChanged += (s, e) => FitGrid();
            _accounts.SizeChanged += (s, e) => FitGrid();

            EventHandler changed = (s, e) => { if (!_loading) Changed?.Invoke(this, EventArgs.Empty); };
            _selection.SelectedIndexChanged += changed;
            _short.ValueChanged += changed;
            _weekly.ValueChanged += changed;
            _wait.ValueChanged += changed;
            _gap.ValueChanged += changed;
            _return.CheckedChanged += changed;
            _accounts.CellValueChanged += (s, e) => changed(s, e);
            // 下拉框改角色要立刻提交，否则 CellValueChanged 要等焦点离开才触发。
            _accounts.CurrentCellDirtyStateChanged += (s, e) => { if (_accounts.IsCurrentCellDirty && _accounts.CurrentCell is DataGridViewComboBoxCell) _accounts.CommitEdit(DataGridViewDataErrorContexts.Commit); };
        }

        /// <summary>
        /// 填入一份配置。existing 为 null 时从基础规则迁移：储备号设为备用，其余为日常，等待时间沿用基础规则。
        /// </summary>
        public void LoadConfig(List<AccountState> accounts, RotationConfig existing, int reserveIndex, int waitMin)
        {
            _loading = true;
            try
            {
                _source = accounts ?? new List<AccountState>();
                _existing = existing;
                _selection.SelectedIndex = existing?.DailySelection == "priority" ? 1 : 0;
                _short.Value = Clamp(_short, 100m - (decimal)(existing?.ShortUsedPercent ?? 100));
                _weekly.Value = Clamp(_weekly, 100m - (decimal)(existing?.WeeklyUsedPercent ?? 100));
                _wait.Value = Clamp(_wait, (decimal)(existing?.WaitBeforeSwitchMin ?? waitMin));
                _gap.Value = Clamp(_gap, (decimal)(existing?.MinGapSec ?? 600));
                _return.Checked = existing?.ReturnToDaily ?? true;

                _accounts.Rows.Clear();
                var configured = (existing?.Daily ?? new List<string>()).Concat(existing?.Reserve ?? new List<string>()).ToList();
                var ordered = _source.OrderBy(a => { int i = configured.IndexOf(a.AccountKey); return i < 0 ? int.MaxValue : i; }).ThenBy(a => a.N);
                foreach (var a in ordered)
                {
                    bool reserve = existing != null ? existing.Reserve.Contains(a.AccountKey) : a.N == reserveIndex && _source.Count > 1;
                    AccountRotationRule rule = null;
                    existing?.AccountRules?.TryGetValue(a.AccountKey ?? "", out rule);
                    string label = "账号 " + a.N + " · " + (string.IsNullOrEmpty(a.Email) ? "—" : a.Email) + (a.Paused ? "（已暂停）" : "");
                    int index = _accounts.Rows.Add(label, reserve ? "备用" : "日常",
                        TextOf(Complement(rule?.ShortUsedPercent)), TextOf(Complement(rule?.WeeklyUsedPercent)), TextOf(rule?.WaitBeforeSwitchMin));
                    _accounts.Rows[index].Tag = a.AccountKey;
                }
            }
            finally { _loading = false; }
            _accounts.ClearSelection();
            _accounts.CurrentCell = null;
            FitGrid();
        }

        /// <summary>按当前界面生成配置；不合法时抛 InvalidOperationException（文案直接给用户看）。</summary>
        public RotationConfig Build()
        {
            if (!_accounts.EndEdit()) throw new InvalidOperationException("表格里还有没填完的单元格。");
            if (_source.Count == 0 || _source.Any(a => !System.Text.RegularExpressions.Regex.IsMatch(a.AccountKey ?? "", "^sha256:[a-f0-9]{64}$")))
                throw new InvalidOperationException("账号绑定还没读到，请先刷新再保存。");
            var config = new RotationConfig
            {
                DailySelection = _selection.SelectedIndex == 1 ? "priority" : "cycle",
                ShortUsedPercent = (double)(100m - _short.Value),
                WeeklyUsedPercent = (double)(100m - _weekly.Value),
                WaitBeforeSwitchMin = (double)_wait.Value,
                MinGapSec = (double)_gap.Value,
                ReturnToDaily = _return.Checked,
            };
            foreach (DataGridViewRow row in _accounts.Rows)
            {
                string key = (string)row.Tag;
                (Convert.ToString(row.Cells["role"].Value) == "备用" ? config.Reserve : config.Daily).Add(key);
                var rule = new AccountRotationRule
                {
                    ShortUsedPercent = Complement(Override(row, "short", 0, 99)),
                    WeeklyUsedPercent = Complement(Override(row, "weekly", 0, 99)),
                    WaitBeforeSwitchMin = Override(row, "wait", 0, 600),
                };
                if (rule.ShortUsedPercent.HasValue || rule.WeeklyUsedPercent.HasValue || rule.WaitBeforeSwitchMin.HasValue) config.AccountRules.Add(key, rule);
            }
            if (config.Daily.Count == 0) throw new InvalidOperationException("至少需要一个日常号。");
            return config;
        }

        /// <summary>界面上所有输入的原样快照（不校验），用来判断“和载入时比有没有改动”。</summary>
        public string Snapshot()
        {
            var parts = new List<string> { _selection.SelectedIndex.ToString(CultureInfo.InvariantCulture), _short.Value.ToString(CultureInfo.InvariantCulture),
                _weekly.Value.ToString(CultureInfo.InvariantCulture), _wait.Value.ToString(CultureInfo.InvariantCulture), _gap.Value.ToString(CultureInfo.InvariantCulture), _return.Checked.ToString() };
            foreach (DataGridViewRow row in _accounts.Rows)
                foreach (string c in new[] { "role", "short", "weekly", "wait" })
                    parts.Add((string)row.Tag + ":" + Convert.ToString(row.Cells[c].Value)?.Trim());
            return string.Join("|", parts);
        }

        /// <summary>上次保存的配置里有、这次界面里没有的账号（账号被删掉了）。</summary>
        public bool DropsSavedAccounts(RotationConfig next)
        {
            var before = (_existing?.Daily ?? new List<string>()).Concat(_existing?.Reserve ?? new List<string>());
            return before.Except(next.Daily.Concat(next.Reserve)).Any();
        }

        public void MoveSelected(int delta)
        {
            if (_accounts.CurrentRow == null || !_accounts.EndEdit()) return;
            int from = _accounts.CurrentRow.Index, to = from + delta;
            if (to < 0 || to >= _accounts.Rows.Count) return;
            var row = _accounts.Rows[from];
            _accounts.Rows.RemoveAt(from);
            _accounts.Rows.Insert(to, row);
            _accounts.CurrentCell = row.Cells[0];
            row.Selected = true;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        private void FitGrid()
        {
            int h = _accounts.ColumnHeadersHeight + _accounts.Rows.GetRowsHeight(DataGridViewElementStates.Visible) + 2;
            if (_accounts.Height != h) _accounts.Height = h;
            _accounts.MinimumSize = new Size(0, h);
        }

        /// <summary>一行：左列标题，右列“输入框 + 紧跟着的灰色说明”。说明不单独成列，免得被最宽的输入框推到远处。</summary>
        internal static void AddRow(TableLayoutPanel table, string caption, Control input, string after)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = caption, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 4, 12, 4) }, 0, row);
            var cell = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Anchor = AnchorStyles.Left, Margin = new Padding(0) };
            input.Margin = new Padding(0, 3, 8, 3);
            cell.Controls.Add(input);
            if (!string.IsNullOrEmpty(after))
                cell.Controls.Add(new Label { Text = after, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(0, 7, 0, 4) });
            table.Controls.Add(cell, 1, row);
        }

        private static NumericUpDown Number(string name, int min, int max, int decimals = 1) =>
            new NumericUpDown { Name = name, Minimum = min, Maximum = max, DecimalPlaces = decimals, Width = 90, TextAlign = HorizontalAlignment.Right };
        private static decimal Clamp(NumericUpDown n, decimal v) => Math.Max(n.Minimum, Math.Min(n.Maximum, v));
        private static double? Complement(double? value) => value.HasValue ? (double)(100m - (decimal)value.Value) : null;
        private static string TextOf(double? value) => value?.ToString(CultureInfo.CurrentCulture) ?? "";

        private static double? Override(DataGridViewRow row, string column, double min, double max)
        {
            string text = Convert.ToString(row.Cells[column].Value)?.Trim();
            if (string.IsNullOrEmpty(text)) return null;
            if (!double.TryParse(text, NumberStyles.Float, CultureInfo.CurrentCulture, out double value) || !double.IsFinite(value) || value < min || value > max)
                throw new InvalidOperationException("「" + row.Cells["account"].Value + "」的单号数值要在 " + min + " 到 " + max + " 之间，或者留空用默认值。");
            return value;
        }
    }
}
