using crypto_exchange.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllersWithViews();

builder.Services.AddMemoryCache();

var apiKey = builder.Configuration["CoinGecko:ApiKey"];

builder.Services.AddHttpClient("coingecko", client =>
{
    client.BaseAddress = new Uri("https://api.coingecko.com/api/v3/");

    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "crypto_exchange/1.0 (ASP.NET Core MVC)"
    );

    client.DefaultRequestHeaders.Accept.ParseAdd(
        "application/json"
    );

    if (!string.IsNullOrWhiteSpace(apiKey))
        client.DefaultRequestHeaders.Add("x-cg-demo-api-key", apiKey);
});

builder.Services.AddScoped<IConverterService, ConverterService>();
var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();
    
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}")
    .WithStaticAssets();


app.Run();
