using System.Net;
using System.Net.Sockets;
using System.Text;
using CodexQuota;
using System.Text.Json;

using var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
string url = $"http://127.0.0.1:{port}/";
var replies = new Queue<(int Status, string Body)>(new[] {
    (200, "{\"ok\":false,\"message\":\"binding rejected\"}"),
    (200, "{\"ok\":true,\"policy\":{\"autoSwitch\":true,\"minWaitMin\":60,\"reserveIndex\":1,\"rotation\":{\"mode\":\"daily-reserve\",\"daily\":[],\"reserve\":[],\"shortUsedPercent\":95}}}"),
    (500, "{\"ok\":false,\"error\":\"server unavailable\"}"),
    (200, "invalid json"),
    (200, "{\"ok\":true,\"policy\":{\"autoSwitch\":false,\"rotation\":null}}")
});
var bodies = new List<string>();
Task server = Task.Run(async () => {
    // One token request followed by five API requests.
    for (int i = 0; i < 6; i++) {
        using var client = await listener.AcceptTcpClientAsync();
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true);
        string request = await reader.ReadLineAsync();
        int contentLength = 0;
        string header;
        while (!string.IsNullOrEmpty(header = await reader.ReadLineAsync())) {
            if (header.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                contentLength = int.Parse(header.Split(':')[1].Trim());
        }
        if (contentLength > 0) {
            var body = new char[contentLength];
            await reader.ReadBlockAsync(body, 0, body.Length);
            bodies.Add(new string(body));
        }
        var reply = request.StartsWith("GET / HTTP/")
            ? (Status: 200, Body: "<meta name=\"panel-token\" content=\"test-only\">")
            : replies.Dequeue();
        byte[] bytes = Encoding.UTF8.GetBytes(reply.Body);
        byte[] headers = Encoding.ASCII.GetBytes($"HTTP/1.1 {reply.Status} Response\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(headers);
        await stream.WriteAsync(bytes);
    }
});
var api = new ApiClient(url);
async Task MustFail(Func<Task<string>> action, string message) {
    try { await action(); }
    catch (InvalidOperationException ex) when (ex.Message.Contains(message)) { return; }
    throw new Exception("Expected failure: " + message);
}
await MustFail(() => api.RouterAsync("rebind"), "binding rejected");
var rotation = new RotationConfig { Daily = new List<string> { "sha256:" + new string('1', 64) }, ShortUsedPercent = 95, WaitBeforeSwitchMin = 0, ReturnToDaily = false, AccountRules = new Dictionary<string, AccountRotationRule> { ["sha256:" + new string('1', 64)] = new AccountRotationRule { WaitBeforeSwitchMin = 0 } } };
PolicyState saved = await api.SavePolicyAsync(true, 60, 1, rotation);
if (saved.Rotation?.ShortUsedPercent != 95) throw new Exception("Saved policy was not applied from response");
await MustFail(() => api.AccountActionAsync(1, "pause"), "server unavailable");
bool malformedRejected = false;
try { await api.LoginCancelAsync(); }
catch (System.Text.Json.JsonException) { malformedRejected = true; }
if (!malformedRejected) throw new Exception("Malformed response was accepted");
var disabled = await api.SavePolicyAsync(false, 60, 1, null);
if (disabled.Rotation != null) throw new Exception("Explicitly disabled rotation was retained");
await server.WaitAsync(TimeSpan.FromSeconds(10));
using var sent = JsonDocument.Parse(bodies[1]);
var sentRotation = sent.RootElement.GetProperty("rotation");
if (sentRotation.GetProperty("waitBeforeSwitchMin").GetDouble() != 0 || sentRotation.GetProperty("returnToDaily").GetBoolean()) throw new Exception("Zero/false settings were lost");
var rule = sentRotation.GetProperty("accountRules").EnumerateObject().First().Value;
if (rule.TryGetProperty("shortUsedPercent", out _) || rule.GetProperty("waitBeforeSwitchMin").GetDouble() != 0) throw new Exception("Inherited per-account settings were serialized as null");
using var cleared = JsonDocument.Parse(bodies.Last());
if (cleared.RootElement.GetProperty("rotation").ValueKind != JsonValueKind.Null) throw new Exception("Disable did not send explicit null");
Console.WriteLine("PASS desktop API: response failures, full saved policy, account rule inheritance, explicit disable");
