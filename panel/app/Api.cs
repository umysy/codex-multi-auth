using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace CodexQuota
{
    public sealed class PanelEnvelope
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("state")] public PanelState State { get; set; }
    }

    public sealed class PanelState
    {
        [JsonPropertyName("now")] public long Now { get; set; }
        [JsonPropertyName("router")] public RouterState Router { get; set; }
        [JsonPropertyName("accounts")] public List<AccountState> Accounts { get; set; } = new List<AccountState>();
        [JsonPropertyName("selection")] public SelectionState Selection { get; set; }
        [JsonPropertyName("totals")] public TotalsState Totals { get; set; }
        [JsonPropertyName("policy")] public PolicyState Policy { get; set; }
        [JsonPropertyName("current")] public AccountState Current { get; set; }
        [JsonPropertyName("logs")] public List<LogEntry> Logs { get; set; } = new List<LogEntry>();
        [JsonPropertyName("schedule")] public ScheduleState Schedule { get; set; }
        [JsonPropertyName("meta")] public StateMeta Meta { get; set; }
        [JsonPropertyName("runtime")] public RuntimeHealth Runtime { get; set; }
    }

    public sealed class RuntimeHealth
    {
        [JsonPropertyName("present")] public bool Present { get; set; }
        [JsonPropertyName("fresh")] public bool Fresh { get; set; }
        [JsonPropertyName("globalIncident")] public string GlobalIncident { get; set; }
        [JsonPropertyName("ageMs")] public long? AgeMs { get; set; }
    }

    /// <summary>服务端返回数据的缓存元信息：mode=cache/stale/fast/refresh，cached=true 表示不是刚拉取的。</summary>
    public sealed class StateMeta
    {
        [JsonPropertyName("fetchedAt")] public long FetchedAt { get; set; }
        [JsonPropertyName("ageMs")] public long AgeMs { get; set; }
        [JsonPropertyName("mode")] public string Mode { get; set; }
        [JsonPropertyName("cached")] public bool Cached { get; set; }
        [JsonPropertyName("refreshing")] public bool Refreshing { get; set; }
    }

    /// <summary>策略脚本（quota-policy.ps1）最近一次运行状态，用来暴露"自动切号是否还在工作"。</summary>
    public sealed class ScheduleState
    {
        [JsonPropertyName("lastStatus")] public string LastStatus { get; set; }
        [JsonPropertyName("lastStatusAtMs")] public long? LastStatusAtMs { get; set; }
        [JsonPropertyName("lastSwitchAtMs")] public long? LastSwitchAtMs { get; set; }
        [JsonPropertyName("from")] public int? From { get; set; }
        [JsonPropertyName("to")] public int? To { get; set; }
        [JsonPropertyName("policyPaused")] public System.Collections.Generic.List<int> PolicyPaused { get; set; }
        [JsonPropertyName("lastRunAtMs")] public long? LastRunAtMs { get; set; }
        [JsonPropertyName("tickCount")] public int? TickCount { get; set; }
        [JsonPropertyName("nextLogAtMs")] public long? NextLogAtMs { get; set; }
        [JsonPropertyName("errorCode")] public string ErrorCode { get; set; }
        [JsonPropertyName("runId")] public string RunId { get; set; }
    }

    // 注意：服务端会把"暂时拿不到"的值明确返回 null（见 server.js 的路由状态/额度缓存缺失分支），
    // 所以所有数值字段必须是可空类型，否则 System.Text.Json 会因一个 null 让整份 state 反序列化失败，
    // 桌面版会出现"全部账号都刷不出来"的假故障。使用处统一用 ?? 0 兜底。
    public sealed class AccountState
    {
        [JsonPropertyName("n")] public int N { get; set; }
        [JsonPropertyName("accountKey")] public string AccountKey { get; set; }
        [JsonPropertyName("email")] public string Email { get; set; }
        [JsonPropertyName("plan")] public string Plan { get; set; }
        [JsonPropertyName("planLabel")] public string PlanLabel { get; set; }
        [JsonPropertyName("role")] public string Role { get; set; }
        [JsonPropertyName("paused")] public bool Paused { get; set; }
        [JsonPropertyName("emergencyOnly")] public bool EmergencyOnly { get; set; }
        [JsonPropertyName("note")] public string Note { get; set; }
        [JsonPropertyName("current")] public bool Current { get; set; }
        /// <summary>路由实际在用的账号；未知时服务端回退为 current。</summary>
        [JsonPropertyName("inUse")] public bool InUse { get; set; }
        /// <summary>额度来源：live = 真实请求的响应头（几秒内更新），probe = 定时探测。</summary>
        [JsonPropertyName("quotaSource")] public string QuotaSource { get; set; }
        [JsonPropertyName("available")] public bool Available { get; set; }
        [JsonPropertyName("reason")] public string Reason { get; set; }
        [JsonPropertyName("quotaStatus")] public int? QuotaStatus { get; set; }
        // 额度快照的观测时间与陈旧标志：CLI 探测失败时会静默保留旧快照，
        // 桌面端据此避免把“上一个窗口的 0%”当成当前用量显示。
        [JsonPropertyName("quotaUpdatedAt")] public long? QuotaUpdatedAt { get; set; }
        [JsonPropertyName("quotaStale")] public bool QuotaStale { get; set; }
        [JsonPropertyName("drainPerHour")] public double? DrainPerHour { get; set; }
        [JsonPropertyName("h5")] public QuotaWindow H5 { get; set; }
        [JsonPropertyName("h7")] public QuotaWindow H7 { get; set; }
        [JsonPropertyName("lastUsed")] public long? LastUsed { get; set; }
    }

    public sealed class QuotaWindow
    {
        [JsonPropertyName("remaining")] public double? Remaining { get; set; }
        [JsonPropertyName("resetAt")] public long? ResetAt { get; set; }
        /// <summary>窗口重置时刻已过：remaining 属于上一个窗口，不能当作当前用量。</summary>
        [JsonPropertyName("expired")] public bool Expired { get; set; }
    }

    public sealed class RouterState
    {
        [JsonPropertyName("running")] public bool Running { get; set; }
        [JsonPropertyName("pid")] public int? Pid { get; set; }
        [JsonPropertyName("port")] public int? Port { get; set; }
        [JsonPropertyName("requests")] public int? Requests { get; set; }
        [JsonPropertyName("upstream")] public int? Upstream { get; set; }
        [JsonPropertyName("rotations")] public int? Rotations { get; set; }
        [JsonPropertyName("retries")] public int? Retries { get; set; }
        [JsonPropertyName("ws")] public int? Ws { get; set; }
        [JsonPropertyName("lastError")] public string LastError { get; set; }
        [JsonPropertyName("lastErrorAt")] public long? LastErrorAt { get; set; }
        [JsonPropertyName("requestsSinceError")] public int? RequestsSinceError { get; set; }
        [JsonPropertyName("errorRecovered")] public bool? ErrorRecovered { get; set; }
        [JsonPropertyName("lastAccountIndex")] public int? LastAccountIndex { get; set; }
    }

    public sealed class SelectionState
    {
        [JsonPropertyName("active")] public int? Active { get; set; }
        [JsonPropertyName("runtimeInUse")] public int? RuntimeInUse { get; set; }
        [JsonPropertyName("pinned")] public int? Pinned { get; set; }
        [JsonPropertyName("mode")] public string Mode { get; set; }
        [JsonPropertyName("available")] public int? Available { get; set; }
        [JsonPropertyName("total")] public int? Total { get; set; }
    }

    public sealed class TotalsState
    {
        [JsonPropertyName("weekRemaining")] public double? WeekRemaining { get; set; }
        [JsonPropertyName("drainPerHour")] public double? DrainPerHour { get; set; }
        [JsonPropertyName("hoursLeft")] public double? HoursLeft { get; set; }
        [JsonPropertyName("darkAt")] public double? DarkAt { get; set; }
        [JsonPropertyName("budgetRate")] public double? BudgetRate { get; set; }
        [JsonPropertyName("budgetHours")] public double? BudgetHours { get; set; }
        [JsonPropertyName("budgetDarkAt")] public double? BudgetDarkAt { get; set; }
        [JsonPropertyName("withinBudget")] public bool? WithinBudget { get; set; }
    }

    public sealed class PolicyState
    {
        [JsonPropertyName("autoSwitch")] public bool AutoSwitch { get; set; }
        [JsonPropertyName("minWaitMin")] public int? MinWaitMin { get; set; }
        [JsonPropertyName("reserveIndex")] public int? ReserveIndex { get; set; }
        [JsonPropertyName("maxMinWait")] public int? MaxMinWait { get; set; }
        [JsonPropertyName("minMinWait")] public int? MinMinWait { get; set; }
        [JsonPropertyName("rotation")] public RotationConfig Rotation { get; set; }
    }

    public sealed class AccountRotationRule
    {
        [JsonPropertyName("shortUsedPercent"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? ShortUsedPercent { get; set; }
        [JsonPropertyName("weeklyUsedPercent"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? WeeklyUsedPercent { get; set; }
        [JsonPropertyName("waitBeforeSwitchMin"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? WaitBeforeSwitchMin { get; set; }
    }

    public sealed class RotationConfig
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("mode")] public string Mode { get; set; } = "daily-reserve";
        [JsonPropertyName("daily")] public List<string> Daily { get; set; } = new List<string>();
        [JsonPropertyName("reserve")] public List<string> Reserve { get; set; } = new List<string>();
        [JsonPropertyName("dailySelection")] public string DailySelection { get; set; } = "cycle";
        [JsonPropertyName("shortUsedPercent")] public double ShortUsedPercent { get; set; } = 100;
        [JsonPropertyName("weeklyUsedPercent")] public double WeeklyUsedPercent { get; set; } = 100;
        [JsonPropertyName("waitBeforeSwitchMin"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? WaitBeforeSwitchMin { get; set; }
        [JsonPropertyName("minGapSec")] public double MinGapSec { get; set; } = 600;
        [JsonPropertyName("returnToDaily")] public bool ReturnToDaily { get; set; } = true;
        [JsonPropertyName("accountRules")] public Dictionary<string, AccountRotationRule> AccountRules { get; set; } = new Dictionary<string, AccountRotationRule>();
    }

    public sealed class LogEntry
    {
        [JsonPropertyName("at")] public string At { get; set; }
        [JsonPropertyName("msg")] public string Msg { get; set; }
        [JsonPropertyName("kind")] public string Kind { get; set; }
        [JsonPropertyName("src")] public string Src { get; set; }
    }

    /// <summary>访问本地面板服务（127.0.0.1:8766）的轻量客户端。仅本机、不走系统代理。</summary>
    public sealed class UsageEnvelope
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("usage")] public UsageState Usage { get; set; }
    }

    public sealed class UsageState
    {
        [JsonPropertyName("rangeDays")] public int? RangeDays { get; set; }
        [JsonPropertyName("totals")] public UsageTotals Totals { get; set; }
        [JsonPropertyName("today")] public UsageDay Today { get; set; }
        [JsonPropertyName("days")] public List<UsageDay> Days { get; set; } = new List<UsageDay>();
        [JsonPropertyName("hours")] public List<long> Hours { get; set; } = new List<long>();
        [JsonPropertyName("topSessions")] public List<UsageSession> TopSessions { get; set; } = new List<UsageSession>();
        [JsonPropertyName("byModel")] public List<UsageBucket> ByModel { get; set; } = new List<UsageBucket>();
        [JsonPropertyName("byProject")] public List<UsageProject> ByProject { get; set; } = new List<UsageProject>();
        /// <summary>单个账号：当前周窗口小结。</summary>
        [JsonPropertyName("window")] public UsageWindow Window { get; set; }
        /// <summary>单个账号：账本请求配对回会话记录的 token 占比（角色 / 会话排行只覆盖这部分）。</summary>
        [JsonPropertyName("matchedShare")] public double? MatchedShare { get; set; }
        /// <summary>顶层：每个账号的周窗口小结。</summary>
        [JsonPropertyName("windows")] public List<UsageWindow> Windows { get; set; } = new List<UsageWindow>();
        [JsonPropertyName("cacheHitRate")] public double? CacheHitRate { get; set; }
        [JsonPropertyName("current")] public UsageState Current { get; set; }
        [JsonPropertyName("byRole")] public List<UsageRole> ByRole { get; set; } = new List<UsageRole>();
        [JsonPropertyName("accounts")] public List<UsageState> Accounts { get; set; } = new List<UsageState>();
        [JsonPropertyName("key")] public string Key { get; set; }
        [JsonPropertyName("label")] public string Label { get; set; }
        [JsonPropertyName("scan")] public UsageScan Scan { get; set; }
    }

    public sealed class UsageRole
    {
        [JsonPropertyName("role")] public string Role { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("events")] public long? Events { get; set; }
    }

    public sealed class UsageTotals
    {
        [JsonPropertyName("input")] public long? Input { get; set; }
        [JsonPropertyName("cached")] public long? Cached { get; set; }
        [JsonPropertyName("output")] public long? Output { get; set; }
        [JsonPropertyName("reasoning")] public long? Reasoning { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("events")] public long? Events { get; set; }
    }

    public sealed class UsageDay
    {
        [JsonPropertyName("date")] public string Date { get; set; }
        [JsonPropertyName("input")] public long? Input { get; set; }
        [JsonPropertyName("cached")] public long? Cached { get; set; }
        [JsonPropertyName("output")] public long? Output { get; set; }
        [JsonPropertyName("reasoning")] public long? Reasoning { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("events")] public long? Events { get; set; }
    }

    public sealed class UsageSession
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        [JsonPropertyName("title")] public string Title { get; set; }
        [JsonPropertyName("project")] public string Project { get; set; }
        [JsonPropertyName("model")] public string Model { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("updatedAt")] public long? UpdatedAt { get; set; }
    }

    public sealed class UsageBucket
    {
        [JsonPropertyName("model")] public string Model { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("sessions")] public long? Sessions { get; set; }
    }

    public sealed class UsageProject
    {
        [JsonPropertyName("project")] public string Project { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("sessions")] public long? Sessions { get; set; }
    }

    /// <summary>某个账号当前周窗口：起止、已用百分比、窗口开始以来这个账号消耗的 token（来自路由账本）。</summary>
    public sealed class UsageWindow
    {
        [JsonPropertyName("key")] public string Key { get; set; }
        [JsonPropertyName("label")] public string Label { get; set; }
        [JsonPropertyName("startAt")] public long? StartAt { get; set; }
        [JsonPropertyName("resetAt")] public long? ResetAt { get; set; }
        [JsonPropertyName("usedPercent")] public double? UsedPercent { get; set; }
        [JsonPropertyName("tokens")] public long? Tokens { get; set; }
        [JsonPropertyName("input")] public long? Input { get; set; }
        [JsonPropertyName("cached")] public long? Cached { get; set; }
        [JsonPropertyName("output")] public long? Output { get; set; }
    }

    public sealed class UsageScan
    {
        [JsonPropertyName("files")] public long? Files { get; set; }
        [JsonPropertyName("mb")] public long? Mb { get; set; }
        [JsonPropertyName("ms")] public long? Ms { get; set; }
    }

    public sealed class ApiClient
    {
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(120),
        };

        private readonly string _base;
        private string _token;

        public ApiClient(string baseUrl)
        {
            _base = baseUrl.TrimEnd('/') + "/";
        }

        private async Task<string> TokenAsync()
        {
            if (!string.IsNullOrEmpty(_token)) return _token;
            string html = await Http.GetStringAsync(_base).ConfigureAwait(false);
            var m = Regex.Match(html, "name=\"panel-token\" content=\"([^\"]+)\"");
            _token = m.Success ? m.Groups[1].Value : string.Empty;
            return _token;
        }

        private async Task<HttpRequestMessage> RequestAsync(HttpMethod method, string path, object body)
        {
            string token = await TokenAsync().ConfigureAwait(false);
            var req = new HttpRequestMessage(method, new Uri(new Uri(_base), path));
            req.Headers.TryAddWithoutValidation("x-panel-token", token);
            if (body != null)
            {
                req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            }
            return req;
        }

        private async Task<string> SendAsync(HttpMethod method, string path, object body)
        {
            using (var req = await RequestAsync(method, path, body).ConfigureAwait(false))
            using (var resp = await Http.SendAsync(req).ConfigureAwait(false))
            {
                string text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                if ((int)resp.StatusCode == 401)
                {
                    _token = null; // token 可能因服务重启变化，下次重取
                }
                bool failedEnvelope = false;
                if (resp.IsSuccessStatusCode)
                {
                    using var doc = JsonDocument.Parse(text);
                    failedEnvelope = doc.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False;
                }
                if (!resp.IsSuccessStatusCode || failedEnvelope)
                {
                    // 服务端错误体是 {"ok":false,"error":"…"} 或 {"ok":false,"message":"…"}，
                    // 直接把裸 JSON 抛给用户看不懂，这里提取成人话。
                    string friendly = MessageOf(text);
                    if (string.IsNullOrWhiteSpace(friendly)) friendly = "服务返回 HTTP " + (int)resp.StatusCode;
                    throw new InvalidOperationException(friendly);
                }
                return text;
            }
        }

        public async Task<PanelState> GetStateAsync(bool force)
        {
            string path = force ? "api/state?force=1" : "api/state";
            string json = await SendAsync(HttpMethod.Get, path, null).ConfigureAwait(false);
            var env = JsonSerializer.Deserialize<PanelEnvelope>(json);
            if (env == null || env.State == null) throw new InvalidOperationException("服务返回了空状态");
            return env.State;
        }

        /// <summary>手动刷新额度：POST /api/refresh 的响应里已带 state，直接用它，避免再发一次 GET ?force=1（实测多 2.9 秒）。</summary>
        public async Task<PanelState> RefreshStateAsync()
        {
            string json = await SendAsync(HttpMethod.Post, "api/refresh", new { }).ConfigureAwait(false);
            var env = System.Text.Json.JsonSerializer.Deserialize<PanelEnvelope>(json);
            if (env == null || env.State == null) throw new InvalidOperationException("服务返回了空状态");
            return env.State;
        }

        public async Task<UsageState> GetUsageAsync(int days, bool force)
        {
            string path = "api/usage?days=" + days + (force ? "&force=1" : "");
            string json = await SendAsync(HttpMethod.Get, path, null).ConfigureAwait(false);
            var env = JsonSerializer.Deserialize<UsageEnvelope>(json);
            return env == null ? null : env.Usage;
        }

        public async Task<string> AccountActionAsync(int n, string action, string value = null)
        {
            object body = value == null ? (object)new { n, action } : new { n, action, value };
            return await SendAsync(HttpMethod.Post, "api/account", body).ConfigureAwait(false);
        }

        public async Task<PolicyState> SavePolicyAsync(bool autoSwitch, int minWaitMin, int reserveIndex, RotationConfig rotation)
        {
            string json = await SendAsync(HttpMethod.Post, "api/policy", new { autoSwitch, minWaitMin, reserveIndex, rotation }).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.GetProperty("policy").Deserialize<PolicyState>() ?? throw new InvalidOperationException("保存响应缺少策略配置");
        }

        public async Task<string> RouterAsync(string action)
        {
            return await SendAsync(HttpMethod.Post, "api/router", new { action, includeState = false }).ConfigureAwait(false);
        }

        public Task<string> LoginCancelAsync() => SendAsync(HttpMethod.Post, "/api/login/cancel", new { });

    public async Task<string> LoginAsync(bool dry)
        {
            return await SendAsync(HttpMethod.Post, "api/login", new { dry }).ConfigureAwait(false);
        }

        /// <summary>把返回 JSON 里的 message/error 字段挑出来给用户看。</summary>
        public static string MessageOf(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return "";
            try
            {
                using (var doc = JsonDocument.Parse(json))
                {
                    JsonElement el;
                    bool failed = doc.RootElement.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False;
                    if (doc.RootElement.TryGetProperty("message", out el) && el.ValueKind == JsonValueKind.String)
                    {
                        string s = el.GetString() ?? "";
                        if (!string.IsNullOrEmpty(s)) return failed ? "失败：" + s : s;
                    }
                    if (doc.RootElement.TryGetProperty("error", out el) && el.ValueKind == JsonValueKind.String)
                    {
                        string s = el.GetString() ?? "";
                        if (!string.IsNullOrEmpty(s)) return failed ? "失败：" + s : s;
                    }
                    if (failed) return "失败";
                }
            }
            catch { }
            return "";
        }
    }
}
