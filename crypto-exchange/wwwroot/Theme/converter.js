// ASP.NET Core CryptoController proxy
const API_BASE = '/api/crypto';
const API_CACHE_MS = 120_000;
const API_COOLDOWN_MS = 60_000;

// Localized texts injected by Converter.cshtml (window.I18N)
const L10N = window.I18N || {};

const apiCache = new Map();
const pendingRequests = new Map();

let apiBlockedUntil = 0;
const $ = s => document.querySelector(s);
const state = { from: 'bitcoin', to: 'ethereum', days: '1' };

let coins = [];
let series = [];
let chartRequestId = 0;
let convertRequestId = 0;

const fmt = n => {
    if (n == null || !Number.isFinite(Number(n))) return '—';

    const value = Number(n);
    const a = Math.abs(value);
    const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;

    return value.toLocaleString('en-US', {
        maximumFractionDigits: d
    });
};

const pct = n =>
    n == null || !Number.isFinite(Number(n))
        ? '—'
        : `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '▲ +' : '▼ '}${Number(n).toFixed(2)}%</span>`;

const by = id => coins.find(c => c.id === id);
const sym = id => (by(id)?.symbol || id).toUpperCase();

const showErr = m => {
    const el = $('#err');
    if (el) el.textContent = m || '';
};

// ---------- API ----------
async function api(path) {
    const now = Date.now();
    const cached = apiCache.get(path);

    // پاسخ موفق قبلی هنوز معتبر است.
    if (cached && now - cached.time < API_CACHE_MS) {
        return cached.data;
    }

    // اگر درخواست مشابهی در حال اجراست، همان را به اشتراک بگذار.
    if (pendingRequests.has(path)) {
        return pendingRequests.get(path);
    }

    // بعد از 429، درخواست جدیدی به سرور ارسال نکن.
    if (now < apiBlockedUntil) {
        const error = new Error('API error: 429');
        error.status = 429;
        throw error;
    }

    const request = (async () => {
        const response = await fetch(API_BASE + path);

        if (!response.ok) {
            if (response.status === 429) {
                apiBlockedUntil = Date.now() + API_COOLDOWN_MS;
            }

            const error = new Error(`API error: ${response.status}`);
            error.status = response.status;
            throw error;
        }

        const data = await response.json();

        apiCache.set(path, {
            data,
            time: Date.now()
        });

        return data;
    })();

    pendingRequests.set(path, request);

    try {
        return await request;
    } finally {
        pendingRequests.delete(path);
    }
}

// ---------- Initial data ----------
async function init() {
    try {
        coins = await api(
            '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&price_change_percentage=24h'
        );
    } catch (e) {
        console.error('Loading market coins failed:', e);

        showErr(
            e.message.includes('429')
                ? L10N.rateLimit
                : L10N.pricesFailed
        );

        return;
    }

    const from = $('#from');
    const to = $('#to');

    if (!from || !to) {
        console.error('عناصر from یا to در صفحه پیدا نشدند.');
        return;
    }

    const opts = coins.map(c => `
        <option value="${c.id}">
            ${c.symbol.toUpperCase()} — ${c.name}
        </option>
    `).join('');

    from.innerHTML = opts;
    to.innerHTML = opts;

    if (by(state.from)) {
        from.value = state.from;
    } else {
        state.from = from.value || coins[0]?.id;
    }

    if (by(state.to)) {
        to.value = state.to;
    } else {
        state.to = to.value || coins[1]?.id || coins[0]?.id;
    }

    renderTables();
    syncIcons();
    convert();
    loadChart();
    loadGlobal();
}

// ---------- Tables ----------
function renderTables(filter = '') {
    const q = filter.trim().toLowerCase();

    const list = coins.filter(c =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q)
    );

    const top = $('#top');

    if (top) {
        top.innerHTML = list.slice(0, 10).map(c => `
            <tr data-id="${c.id}">
                <td>
                    <div class="coin">
                        <img src="${c.image}" alt="">
                        <span>${c.symbol.toUpperCase()}</span>
                    </div>
                </td>
                <td class="n">${fmt(c.current_price)}</td>
                <td class="n">${pct(c.price_change_percentage_24h)}</td>
            </tr>
        `).join('') || `<tr><td colspan="3">${L10N.noCoin}</td></tr>`;
    }

    const pop = $('#pop');

    if (pop) {
        pop.innerHTML = coins.slice(0, 6).map(c => `
            <button data-id="${c.id}">
                <img src="${c.image}" alt="">
                <b>${c.symbol.toUpperCase()}</b>
                <small>${c.name}</small>
            </button>
        `).join('');
    }

    const btc = by('bitcoin');
    const recent = $('#recent');

    if (btc?.current_price && recent) {
        recent.innerHTML = coins
            .filter(c => c.id !== 'bitcoin')
            .slice(0, 5)
            .map(c => {
                const rate = c.current_price / btc.current_price;

                const ch =
                    (
                        (1 + (c.price_change_percentage_24h || 0) / 100) /
                        (1 + (btc.price_change_percentage_24h || 0) / 100) - 1
                    ) * 100;

                return `
                    <tr>
                        <td class="ltr">${c.symbol.toUpperCase()} / BTC</td>
                        <td class="n">${fmt(rate)}</td>
                        <td class="n">${pct(ch)}</td>
                    </tr>
                `;
            }).join('');
    }
}

// ---------- Coin icons ----------
function syncIcons() {
    const icoFrom = $('#icoFrom');
    const icoTo = $('#icoTo');

    if (icoFrom) {
        icoFrom.src = by(state.from)?.image || '';
    }

    if (icoTo) {
        icoTo.src = by(state.to)?.image || '';
    }
}

// ---------- Converter ----------
async function convert() {
    showErr('');

    const requestId = ++convertRequestId;
    const amountEl = $('#amount');

    if (!amountEl) return;

    const amount = parseFloat(amountEl.value);

    if (!Number.isFinite(amount) || amount < 0) {
        showErr(L10N.invalidAmount);
        return;
    }

    try {
        const p = await api(
            `/simple/price?ids=${encodeURIComponent(state.from)},${encodeURIComponent(state.to)}&vs_currencies=usd`
        );

        if (requestId !== convertRequestId) return;

        const fromPrice = p?.[state.from]?.usd;
        const toPrice = p?.[state.to]?.usd;

        if (!(fromPrice > 0) || !(toPrice > 0)) {
            throw new Error('قیمت یکی از ارزها در پاسخ API وجود ندارد.');
        }

        const rate = fromPrice / toPrice;

        const result = $('#result');
        const rateTxt = $('#rateTxt');
        const updated = $('#updated');

        if (result) {
            result.value = fmt(amount * rate);
        }

        if (rateTxt) {
            rateTxt.textContent =
                `1 ${sym(state.from)} = ${fmt(rate)} ${sym(state.to)}`;
        }

        if (updated) {
            updated.textContent =
                new Date().toLocaleString('sv-SE').slice(0, 16);
        }
    } catch (e) {
        if (requestId !== convertRequestId) return;

        console.error('Conversion failed:', e);

        showErr(
            e.message.includes('429')
                ? L10N.rateLimit
                : L10N.convertFailed
        );
    }
}

// ---------- Chart ----------
async function loadChart() {
    const requestId = ++chartRequestId;
    const { from, to, days } = state;

    const chPair = $('#chPair');
    const chName = $('#chName');
    const chImg = $('#chImg');

    if (chPair) {
        chPair.textContent = `${sym(from)} / ${sym(to)}`;
    }

    if (chName) {
        chName.textContent =
            `${by(from)?.name || from} / ${by(to)?.name || to}`;
    }

    if (chImg) {
        chImg.src = by(from)?.image || '';
    }

    draw(L10N.chartLoading);

    try {
        const [a, b] = await Promise.all([
            api(
                `/coins/${encodeURIComponent(from)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`
            ),
            api(
                `/coins/${encodeURIComponent(to)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`
            )
        ]);

        if (requestId !== chartRequestId) return;

        if (!a.prices?.length || !b.prices?.length) {
            throw new Error('داده‌ای برای نمودار دریافت نشد.');
        }

        const result = [];
        let j = 0;

        for (const [t, valueA] of a.prices) {
            while (
                j < b.prices.length - 1 &&
                Math.abs(b.prices[j + 1][0] - t) <
                Math.abs(b.prices[j][0] - t)
            ) {
                j++;
            }

            const valueB = b.prices[j][1];

            if (valueB > 0) {
                result.push({
                    t,
                    v: valueA / valueB
                });
            }
        }

        if (requestId !== chartRequestId) return;

        if (result.length < 2) {
            throw new Error('تعداد داده‌های نمودار کافی نیست.');
        }

        series = result;

        const vals = series.map(s => s.v);
        const last = vals[vals.length - 1];
        const first = vals[0];
        const change = (last / first - 1) * 100;

        const chPrice = $('#chPrice');
        const chPct = $('#chPct');
        const hi = $('#hi');
        const lo = $('#lo');
        const chg = $('#chg');

        if (chPrice) chPrice.textContent = fmt(last);
        if (chPct) chPct.innerHTML = pct(change);
        if (hi) hi.textContent = fmt(Math.max(...vals));
        if (lo) lo.textContent = fmt(Math.min(...vals));
        if (chg) chg.innerHTML = pct(change);

        draw();
    } catch (e) {
        if (requestId !== chartRequestId) return;

        console.error('Chart loading failed:', e);

        series = [];

        draw(
            e.message.includes('429')
                ? L10N.rateLimit
                : L10N.chartFailed
        );
    }
}

// ---------- Draw chart ----------
function draw(msg) {
    const cv = $('#cv');

    if (!cv) return;

    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;

    if (!W || !H) return;

    cv.width = W * dpr;
    cv.height = H * dpr;

    const g = cv.getContext('2d');

    if (!g) return;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    g.font = '11px Vazirmatn, sans-serif';
    g.fillStyle = '#8da0c9';

    if (msg || series.length < 2) {
        g.textAlign = 'center';
        g.fillText(msg || L10N.loading, W / 2, H / 2);
        return;
    }

    const L = 62;
    const B = 24;
    const T = 8;
    const R = 6;

    const w = W - L - R;
    const h = H - B - T;

    const vals = series.map(s => s.v);

    let min = Math.min(...vals);
    let max = Math.max(...vals);

    const pad =
        (max - min || Math.abs(max) * 0.01 || 0.01) * 0.08;

    min -= pad;
    max += pad;

    const x = i =>
        L + i / (series.length - 1) * w;

    const y = v =>
        T + (1 - (v - min) / (max - min)) * h;

    g.strokeStyle = '#1a2b57';
    g.textAlign = 'right';

    for (let k = 0; k <= 4; k++) {
        const yy = T + k / 4 * h;

        g.beginPath();
        g.moveTo(L, yy);
        g.lineTo(W - R, yy);
        g.stroke();

        g.fillText(
            fmt(max - k / 4 * (max - min)),
            L - 8,
            yy + 4
        );
    }

    g.textAlign = 'center';

    const long = state.days !== '1';

    for (let k = 0; k <= 4; k++) {
        const point =
            series[Math.round(k / 4 * (series.length - 1))];

        const d = new Date(point.t);

        g.fillText(
            long
                ? d.toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short'
                })
                : d.toTimeString().slice(0, 5),
            L + k / 4 * w,
            H - 6
        );
    }

    const grad = g.createLinearGradient(0, T, 0, T + h);

    grad.addColorStop(0, 'rgba(47,123,255,.35)');
    grad.addColorStop(1, 'rgba(47,123,255,0)');

    g.beginPath();

    series.forEach((s, i) => {
        if (i) {
            g.lineTo(x(i), y(s.v));
        } else {
            g.moveTo(x(i), y(s.v));
        }
    });

    g.strokeStyle = '#3d8bff';
    g.lineWidth = 2;
    g.stroke();

    g.lineTo(x(series.length - 1), T + h);
    g.lineTo(L, T + h);
    g.closePath();

    g.fillStyle = grad;
    g.fill();
}

// ---------- Global market ----------
async function loadGlobal() {
    const globalTxt = $('#globalTxt');

    try {
        const result = await api('/global');
        const data = result?.data;

        if (
            !data?.total_market_cap?.usd ||
            !data?.total_volume?.usd ||
            data?.market_cap_percentage?.btc == null
        ) {
            throw new Error('ساختار پاسخ API ناقص است.');
        }

        const cap = data.total_market_cap.usd / 1e12;
        const vol = data.total_volume.usd / 1e9;
        const btc = data.market_cap_percentage.btc;

        if (globalTxt) {
            globalTxt.innerHTML =
                `${L10N.totalCap}: <b class="ltr">$${cap.toFixed(2)}T</b><br>` +
                `${L10N.vol24}: <b class="ltr">$${vol.toFixed(0)}B</b><br>` +
                `${L10N.btcDom}: <b class="ltr">${btc.toFixed(1)}%</b>`;
        }
    } catch (e) {
        console.error('Loading global market failed:', e);

        if (globalTxt) {
            globalTxt.textContent = e.message.includes('429')
                ? L10N.rateLimit
                : L10N.marketUnavailable;
        }
    }
}

// ---------- Change currency pair ----------
function setPair(from, to) {
    state.from = from;
    state.to = to;

    const fromEl = $('#from');
    const toEl = $('#to');

    if (fromEl) fromEl.value = from;
    if (toEl) toEl.value = to;

    syncIcons();
    convert();
    loadChart();
}

// ---------- Events ----------
$('#from')?.addEventListener('change', e => {
    setPair(e.target.value, state.to);
});

$('#to')?.addEventListener('change', e => {
    setPair(state.from, e.target.value);
});

$('#swap')?.addEventListener('click', () => {
    setPair(state.to, state.from);
});

$('#go')?.addEventListener('click', convert);

$('#amount')?.addEventListener('input', convert);

$('#rng')?.addEventListener('click', e => {
    const button = e.target.closest('button[data-d]');

    if (!button) return;

    document.querySelectorAll('#rng button').forEach(x => {
        x.classList.toggle('on', x === button);
    });

    state.days = button.dataset.d;
    loadChart();
});

$('.chart-scroll-btn')?.addEventListener('click', () => {
    document.querySelector('.chart')?.scrollIntoView({
        behavior: 'smooth'
    });
});

const pick = e => {
    const el = e.target.closest('[data-id]');

    if (!el) return;

    const id = el.dataset.id;

    if (id === state.from) {
        setPair(state.to, id);
    } else {
        setPair(id, state.to);
    }

    $('#conv')?.scrollIntoView({
        behavior: 'smooth'
    });
};

$('#top')?.addEventListener('click', pick);
$('#pop')?.addEventListener('click', pick);

$('#search')?.addEventListener('input', e => {
    renderTables(e.target.value);
});

// ---------- Resize chart ----------
let resizeTimer;

window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(() => {
        draw();
    }, 100);
});

// ---------- Start ----------
init();
