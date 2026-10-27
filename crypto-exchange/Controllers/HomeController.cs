using System.Diagnostics;
using crypto_exchange.Models;
using Microsoft.AspNetCore.Localization;
using Microsoft.AspNetCore.Mvc;

namespace crypto_exchange.Controllers
{
    public class HomeController : Controller
    {
        private readonly ILogger<HomeController> _logger;
        private readonly IHttpClientFactory _http;

        public HomeController(
            ILogger<HomeController> logger,
            IHttpClientFactory http)
        {
            _logger = logger;
            _http = http;
        }

        public async Task<IActionResult> Index()
        {
            try
            {
                var client = _http.CreateClient("coingecko");

                var coins = await client.GetFromJsonAsync<List<CoinDto>>(
                    "coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h"
                );

                return View(coins ?? new List<CoinDto>());
            }
            catch (HttpRequestException ex)
            {
                _logger.LogError(ex, "Error fetching cryptocurrency data");

                return View(new List<CoinDto>());
            }
        }

        public IActionResult Privacy()
        {
            return View();
        }

        [ResponseCache(
            Duration = 0,
            Location = ResponseCacheLocation.None,
            NoStore = true)]
        public IActionResult Error()
        {
            return View(new ErrorViewModel
            {
                RequestId = Activity.Current?.Id
                    ?? HttpContext.TraceIdentifier
            });
        }


        [HttpGet]
        public IActionResult SetLanguage(string culture, string returnUrl = "/")
        {
            if (culture != "fa" && culture != "en")
                culture = "fa";

            Response.Cookies.Append(
                CookieRequestCultureProvider.DefaultCookieName,
                CookieRequestCultureProvider.MakeCookieValue(new RequestCulture(culture)),
                new CookieOptions { Expires = DateTimeOffset.UtcNow.AddYears(1), IsEssential = true });

            if (!Url.IsLocalUrl(returnUrl))
                returnUrl = "/";

            return LocalRedirect(returnUrl);
        }

    }
}