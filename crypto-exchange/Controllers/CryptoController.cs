using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;

[Route("api/crypto")]
public class CryptoController : Controller
{
    private readonly IHttpClientFactory _http;
    private readonly IMemoryCache _cache;

    private static readonly ConcurrentDictionary<string, SemaphoreSlim>
        RequestLocks = new();

    private const string RateLimitKey = "coingecko:rate-limit-until";

    // مدت نگهداری پاسخ تازه و آخرین پاسخ موفق
    private static readonly TimeSpan FreshCacheDuration =
        TimeSpan.FromMinutes(5);

    private static readonly TimeSpan StaleCacheDuration =
        TimeSpan.FromHours(24);

    public CryptoController(
        IHttpClientFactory http,
        IMemoryCache cache)
    {
        _http = http;
        _cache = cache;
    }

    [HttpGet("{**path}")]
    public async Task<IActionResult> Proxy(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return NotFound();

        // فقط مسیرهای موردنیاز برنامه مجاز هستند.
        var allowed =
            path == "coins/markets" ||
            path == "simple/price" ||
            path == "global";

        var segments = path.Split(
            '/',
            StringSplitOptions.RemoveEmptyEntries);

        var isMarketChart =
            segments.Length == 3 &&
            segments[0] == "coins" &&
            segments[1].Length > 0 &&
            segments[1].All(c =>
                char.IsAsciiLetterOrDigit(c) || c == '-') &&
            segments[2] == "market_chart";

        if (!allowed && !isMarketChart)
            return NotFound();

        var key = $"coingecko:data:{path}{Request.QueryString}";
        var staleKey = key + ":stale";

        // 1. اگر پاسخ تازه داریم، اصلاً API را صدا نزن.
        if (_cache.TryGetValue<string>(key, out var cached) &&
            cached is not null)
        {
            return Content(cached, "application/json");
        }

        // 2. برای درخواست یکسان فقط یک فراخوانی انجام شود.
        var gate = RequestLocks.GetOrAdd(
            key,
            _ => new SemaphoreSlim(1, 1));

        await gate.WaitAsync(HttpContext.RequestAborted);

        try
        {
            // شاید درخواست دیگری در همین فاصله پاسخ را کش کرده باشد.
            if (_cache.TryGetValue<string>(key, out cached) &&
                cached is not null)
            {
                return Content(cached, "application/json");
            }

            // آخرین پاسخ موفق، حتی اگر منقضی شده باشد.
            var hasStale =
                _cache.TryGetValue<string>(
                    staleKey,
                    out var staleBody) &&
                staleBody is not null;

            // 3. هنگام محدودیت API، از داده قبلی استفاده کن.
            if (_cache.TryGetValue<DateTimeOffset>(
                    RateLimitKey, out var blockedUntil) &&
                blockedUntil > DateTimeOffset.UtcNow)
            {
                if (hasStale)
                    return ReturnStale(staleBody!);

                return RateLimitResponse(blockedUntil);
            }

            try
            {
                var client = _http.CreateClient("coingecko");

                using var response = await client.GetAsync(
                    path + Request.QueryString,
                    HttpCompletionOption.ResponseHeadersRead,
                    HttpContext.RequestAborted);

                var body = await response.Content.ReadAsStringAsync(
                    HttpContext.RequestAborted);

                // 4. محدودیت نرخ را با توجه به Retry-After رعایت کن.
                if ((int)response.StatusCode == 429)
                {
                    var retryAt = GetRetryTime(response);

                    var duration = retryAt - DateTimeOffset.UtcNow;

                    if (duration <= TimeSpan.Zero)
                        duration = TimeSpan.FromSeconds(60);

                    _cache.Set(
                        RateLimitKey,
                        DateTimeOffset.UtcNow.Add(duration),
                        duration);

                    if (hasStale)
                        return ReturnStale(staleBody!);

                    return RateLimitResponse(
                        DateTimeOffset.UtcNow.Add(duration));
                }

                // 5. اگر API خطا داد، پاسخ موفق قبلی را بده.
                if (!response.IsSuccessStatusCode)
                {
                    if (hasStale)
                        return ReturnStale(staleBody!);

                    return StatusCode(
                        (int)response.StatusCode,
                        body);
                }

                // 6. پاسخ موفق را هم برای استفاده تازه
                // و هم برای مواقع قطعی نگه دار.
                _cache.Set(
                    key,
                    body,
                    FreshCacheDuration);

                _cache.Set(
                    staleKey,
                    body,
                    StaleCacheDuration);

                Response.Headers["X-Crypto-Data-Stale"] = "false";

                return Content(body, "application/json");
            }
            catch (OperationCanceledException)
                when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                if (hasStale)
                    return ReturnStale(staleBody!);

                return StatusCode(
                    504,
                    new { error = "CoinGecko request timed out." });
            }
            catch (HttpRequestException)
            {
                if (hasStale)
                    return ReturnStale(staleBody!);

                return StatusCode(
                    503,
                    new { error = "CoinGecko is temporarily unavailable." });
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private IActionResult ReturnStale(string body)
    {
        Response.Headers["X-Crypto-Data-Stale"] = "true";
        Response.Headers["X-Crypto-Data-Source"] = "cache";

        return Content(body, "application/json");
    }

    private IActionResult RateLimitResponse(
        DateTimeOffset retryAt)
    {
        var seconds = Math.Max(
            1,
            (int)Math.Ceiling(
                (retryAt - DateTimeOffset.UtcNow).TotalSeconds));

        Response.Headers["Retry-After"] =
            seconds.ToString(CultureInfo.InvariantCulture);

        Response.StatusCode = StatusCodes.Status429TooManyRequests;

        return Content(
            "{\"error\":\"CoinGecko rate limit. Please retry later.\"}",
            "application/json");
    }

    private static DateTimeOffset GetRetryTime(
        HttpResponseMessage response)
    {
        var now = DateTimeOffset.UtcNow;
        var retryAfter = response.Headers.RetryAfter;

        if (retryAfter?.Date is DateTimeOffset retryDate &&
            retryDate > now)
        {
            return retryDate;
        }

        if (retryAfter?.Delta is TimeSpan delta &&
            delta > TimeSpan.Zero)
        {
            return now.Add(delta);
        }

        // اگر API زمان انتظار را مشخص نکرد.
        return now.AddSeconds(60);
    }
}