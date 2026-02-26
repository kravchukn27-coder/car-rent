const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ======================
// CONFIG
// ======================

// Сколько дней вперёд проверяем (можно переопределить через process.env.WINDOW_DAYS)
const WINDOW_DAYS = Math.max(1, parseInt(process.env.WINDOW_DAYS, 10) || 2);

// Длительность аренды
const RENT_DAYS = 2;

// Время выдачи/возврата
const TIMES = [10, 16];

function resolveTimesFromEnv() {
  const raw = (process.env.PICKUP_TIMES || "").trim();
  if (!raw) return TIMES;
  const parsed = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((v) => Number.isFinite(v) && v >= 8 && v <= 18)
    )
  ).sort((a, b) => a - b);
  return parsed.length === 2 ? parsed : TIMES;
}

// Возраст водителя
const DRIVER_AGE = 30;

// Фильтр поставщиков
const WANTED_SUPPLIERS = ["Avis", "Budget", "Enterprise"];

// Фильтр локаций (ключевые названия, без хвостов в UI)
const WANTED_PICKUP_LOCATIONS = [
  "Barcelona - Plaza Glories",
  "Barcelona - Centre Eixample",
  "Barcelona - Sants Train Station",
];

/** Нормализует и мапит сырой текст локации из Booking к одному из целевых ключей. */
function mapPickupLocation(raw) {
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  for (const key of WANTED_PICKUP_LOCATIONS) {
    if (normalized === key) return key;
    if (normalized.startsWith(key)) return key;
    if (normalized.includes(key)) return key;
  }
  return null;
}

// Базовый URL search-results (зафиксированный)
const BASE_RESULTS_URL =
  "https://cars.booking.com/search-results?adplat=cross_product_bar&cor=es&prefcurrency=EUR&preflang=en-gb&locationName=Barcelona%20City%20Centre&dropLocationName=Barcelona%20City%20Centre&coordinates=41.386539459228516%2C2.170856237411499&dropCoordinates=41.386539459228516%2C2.170856237411499&driversAge=30&ftsType=D&dropFtsType=D";

// На cars.booking.com часто триггерится анти-бот, поэтому делаем осторожнее
const WAIT_RESULTS_LOAD_MS = 15000;        // базовая подождать загрузку
const WAIT_BETWEEN_REQUESTS_MS = 8000;     // пауза между запросами (уменьшаем риск капчи)

// Макс. запросов за запуск: макс. окно 7 дней × 2 времени = 14 (0 = без ограничения)
const MAX_REQUESTS_PER_RUN = 14;

// Опционально: фильтровать поставщиков через левую панель (сильно уменьшает список)
const APPLY_SUPPLIER_FILTER_IN_UI = true;

// Опционально: сортировать по цене (дешевле → дороже), чтобы читать только верх списка
const APPLY_SORT_PRICE_ASC_IN_UI = true;

// Сколько верхних карточек читать после сортировки (ускоряет, не надо скроллить до конца)
const MAX_CARDS_TO_PARSE = 80;

// Берём максимум 1 машину на каждую локацию
const MAX_PER_LOCATION = 1;

// Сколько максимум ждать появления результатов (агрегация иногда 30–60 сек)
const WAIT_FOR_RESULTS_MS = 60000;
const NAVIGATION_TIMEOUT_MS = 25000;

// Параллельные вкладки: сколько окон обрабатывать одновременно (1 = поочерёдно, 3–4 ускоряет)
const PARALLEL_TABS = Math.max(1, parseInt(process.env.PARALLEL_TABS || "4", 10));
// Стартовый stagger между воркерами пула (мс). Меняем отдельно в рамках R5a.
const POOL_THROTTLE_MS = parseInt(process.env.POOL_THROTTLE_MS || "900", 10);

// ======================
// Helpers
// ======================

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateParts(d) {
  return {
    day: d.getDate(),
    month: d.getMonth() + 1,
    year: d.getFullYear(),
  };
}

/** Дата в локальной зоне как YYYY-MM-DD (не UTC), чтобы окна не съезжали на день. */
function toLocalDateString(d) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function parseEuroPrice(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\u00A0/g, " ")
    .replace(/[^\d,.\s]/g, "")
    .trim();

  if (!cleaned) return null;

  let normalized = cleaned;
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && !hasDot) {
    normalized = normalized.replace(",", ".");
  } else if (hasComma && hasDot) {
    normalized = normalized.replace(/,/g, "");
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function extractEuroPricesFromText(text) {
  if (!text) return [];
  const matches = text.match(/€\s*[\d.,]+/g) || [];
  const values = [];
  for (const m of matches) {
    const v = parseEuroPrice(m);
    if (v) values.push(v);
  }
  return values;
}

function buildSearchUrl(pickupDate, dropoffDate, time) {
  const pu = formatDateParts(pickupDate);
  const dd = formatDateParts(dropoffDate);

  const url = new URL(BASE_RESULTS_URL);

  url.searchParams.set("puDay", pu.day);
  url.searchParams.set("puMonth", pu.month);
  url.searchParams.set("puYear", pu.year);
  url.searchParams.set("puHour", String(time));
  url.searchParams.set("puMinute", "0");

  url.searchParams.set("doDay", dd.day);
  url.searchParams.set("doMonth", dd.month);
  url.searchParams.set("doYear", dd.year);
  url.searchParams.set("doHour", String(time));
  url.searchParams.set("doMinute", "0");

  return url.toString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitScoutEvent(name, data = {}) {
  console.log(`SCOUT_EVENT ${JSON.stringify({ name, ...data })}`);
}

/** Результат: самое дешёвое окно, локация, комбо, глобальный минимум. */
function analyzeMatches(matches) {
  if (!matches.length) return null;
  const byWindow = new Map(); // "pickup|dropoff|time" -> min price
  const byLocation = new Map(); // location -> min price
  let globalMin = matches[0];
  for (const m of matches) {
    if (m.priceValue < globalMin.priceValue) globalMin = m;
    const wk = `${m.pickup}|${m.dropoff}|${m.time}`;
    if (!byWindow.has(wk) || m.priceValue < byWindow.get(wk)) byWindow.set(wk, m.priceValue);
    if (!byLocation.has(m.location) || m.priceValue < byLocation.get(m.location)) byLocation.set(m.location, m.priceValue);
  }
  let cheapestWindowKey = null;
  let cheapestWindowPrice = Infinity;
  for (const [k, p] of byWindow) {
    if (p < cheapestWindowPrice) {
      cheapestWindowPrice = p;
      cheapestWindowKey = k;
    }
  }
  let cheapestLocationName = null;
  let cheapestLocationPrice = Infinity;
  for (const [loc, p] of byLocation) {
    if (p < cheapestLocationPrice) {
      cheapestLocationPrice = p;
      cheapestLocationName = loc;
    }
  }
  return {
    globalMin: { ...globalMin },
    cheapestWindow: cheapestWindowKey ? { key: cheapestWindowKey, price: cheapestWindowPrice } : null,
    cheapestLocation: cheapestLocationName ? { location: cheapestLocationName, price: cheapestLocationPrice } : null,
  };
}

function askEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function isCaptchaPage(html, title) {
  const t = (title || "").toLowerCase();
  return (
    t.includes("human verification") ||
    /confirm you are human/i.test(html || "") ||
    /security check/i.test(html || "") ||
    /Let&apos;s confirm you are human/i.test(html || "")
  );
}

function isOopsPage(html) {
  return /Oops\s*-\s*something went wrong/i.test(html || "") || /Please refresh the page/i.test(html || "");
}

async function ensureNotBlocked(page) {
  const title = await page.title().catch(() => "");
  const html = await page.content().catch(() => "");

  if (isCaptchaPage(html, title)) {
    return { blocked: true, oops: false };
  }
  if (isOopsPage(html)) {
    console.log("\n⚠️ Booking показал 'Oops - something went wrong'. Пробую обновить страницу один раз...");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(5000);
    return { blocked: false, oops: true };
  }
  return { blocked: false, oops: false };
}

const CAPTCHA_WAIT_TIMEOUT_MS = process.env.RUN_FROM_UI === "1" ? 90 * 1000 : 5 * 60 * 1000;
const CAPTCHA_POLL_MS = 3000;

/** После появления капчи ждём: один раз просим Enter (если есть терминал), затем каждые 3 сек проверяем страницу — продолжаем, когда капча исчезнет. */
async function waitForCaptchaResolved(page) {
  if (process.stdin.isTTY) {
    await askEnter("Пройди проверку в браузере. Когда закончишь — нажми Enter в терминале...");
  } else {
    console.log("Жду до 5 минут, пока страница перестанет быть капчей...");
  }

  const start = Date.now();
  while (Date.now() - start < CAPTCHA_WAIT_TIMEOUT_MS) {
    await sleep(CAPTCHA_POLL_MS);
    const html = await page.content().catch(() => "");
    const title = await page.title().catch(() => "");

    if (isOopsPage(html)) {
      console.log("\n⚠️ После капчи страница 'Oops'. Обновляю...");
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(5000);
      continue;
    }

    if (!isCaptchaPage(html, title)) {
      console.log("✓ Проверка пройдена, продолжаю.\n");
      return true;
    }
  }

  console.log("\n⏱️ Таймаут ожидания капчи. Пропускаю этот запрос.");
  return false;
}

// ======================
// New helpers for filtering, sorting, and waiting for results
// ======================

async function waitForResultsOrNoCars(page, maxWaitMs = WAIT_FOR_RESULTS_MS) {
  // Ждём либо карточки результатов, либо явный "No cars available"
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const cardsCount = await page.locator('[role="group"]').count().catch(() => 0);
    if (cardsCount > 0) return { ok: true, reason: "cards", cardsCount };

    const html = await page.content().catch(() => "");
    // Иногда фраза "No cars available" присутствует в скрытом/служебном блоке.
    // Считаем "no-cars" только если в HTML нет ценовых маркеров.
    if (/No cars available/i.test(html) && !/€\s*\d/.test(html)) {
      return { ok: false, reason: "no-cars" };
    }

    // иногда страница ещё догружается
    await page.waitForTimeout(1500).catch(() => {});
  }
  return { ok: false, reason: "timeout" };
}

async function applySupplierFilter(page, suppliers) {
  // Ищем блок Supplier слева и кликаем чекбоксы по тексту
  try {
    // Иногда список скрыт — сначала раскрываем "Show all"
    const showAll = page.locator('text=/Show all\\s+\\d+/i').first();
    if (await showAll.count().catch(() => 0)) {
      await showAll.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
    }

    let appliedAny = false;
    for (const s of suppliers) {
      const option = page.locator(`label:has-text("${s}")`).first();
      if (await option.count().catch(() => 0)) {
        // кликаем по label — это безопаснее, чем по самому input
        await option.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(600).catch(() => {});
        appliedAny = true;
      }
    }
    return appliedAny;
  } catch (_) {
    // ничего, фильтр просто не применится
    return false;
  }
}

/** Прогрессивная прокрутка вниз, чтобы React отрисовал ленивые карточки (cards found = 0 при большом HTML). */
async function scrollToRevealCards(page) {
  const steps = 5;
  const stepPx = 600;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepPx).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
  }
  await page.waitForTimeout(800).catch(() => {});
}

async function applySortPriceAsc(page) {
  // Пытаемся открыть сортировку и выбрать "Price (lowest first)" / "Lowest price"
  try {
    let clicked = false;
    // Кнопка/селект "Sort by"
    const sortBtn = page.locator('text=/Sort by/i').first();
    if (await sortBtn.count().catch(() => 0)) {
      await sortBtn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(600).catch(() => {});
      clicked = true;
    }

    const priceAsc = page.locator('text=/Price.*lowest|Lowest price|Cheapest|Price \\(lowest/i').first();
    if (await priceAsc.count().catch(() => 0)) {
      await priceAsc.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1200).catch(() => {});
      return true;
    } else {
      // иногда это <select>
      const select = page.locator('select').first();
      if (await select.count().catch(() => 0)) {
        await select.selectOption({ label: /Price/i }).catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});
        return true;
      }
    }
    return clicked;
  } catch (_) {
    // ignore
    return false;
  }
}

/** Один запрос: открыть URL, дождаться результатов, распарсить, вернуть массив матчей для этого окна. */
async function runOneJob(page, pickupDate, dropoffDate, time, options = {}) {
  const runMode = options.runMode || "headed";
  const url = buildSearchUrl(pickupDate, dropoffDate, time);
  console.log("Запрос:", url);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    console.log(`Навигация не удалась (${runMode}): ${errMsg}`);
    return { matches: [], captchaRequired: false };
  }
  await page.waitForTimeout(WAIT_RESULTS_LOAD_MS);

  const status1 = await ensureNotBlocked(page);
  if (status1.blocked) {
    if (runMode === "headless") {
      return { matches: [], captchaRequired: true };
    }
    emitScoutEvent("CAPTCHA_REQUIRED", { source: "runOneJob" });
    console.log("\n🧍‍♂️ Капча в одной из вкладок. Пройди проверку в браузере.");
    const captchaResolved = await waitForCaptchaResolved(page);
    await page.waitForTimeout(2000);
    const statusAfterCaptcha = await ensureNotBlocked(page);
    if (!captchaResolved || statusAfterCaptcha.blocked) {
      console.log("Капча не снята вовремя, пропускаю это окно.");
      return { matches: [], captchaRequired: false };
    }
    emitScoutEvent("CAPTCHA_RESOLVED", { source: "runOneJob" });
  }
  if (status1.oops) {
    await page.waitForTimeout(3000);
  }

  let res = await waitForResultsOrNoCars(page);
  if (!res.ok && res.reason === "timeout") {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(4000).catch(() => {});
    // Второй проход короче, чтобы не держать вкладку слишком долго.
    const prevWait = WAIT_FOR_RESULTS_MS;
    const shortWait = Math.min(25000, prevWait);
    res = await waitForResultsOrNoCars(page, shortWait);
  }
  if (!res.ok && res.reason === "no-cars") {
    console.log(`Job empty/failed: ${toLocalDateString(pickupDate)} ${time}:00 reason=${res.reason}`);
    return { matches: [], captchaRequired: false };
  }
  if (!res.ok && res.reason === "timeout") {
    console.log(`Job soft-timeout: ${toLocalDateString(pickupDate)} ${time}:00, продолжаю best-effort парсинг`);
  } else if (!res.ok) {
    console.log(`Job empty/failed: ${toLocalDateString(pickupDate)} ${time}:00 reason=${res.reason}`);
    return { matches: [], captchaRequired: false };
  }

  let supplierFiltered = false;
  let priceSorted = false;

  if (APPLY_SUPPLIER_FILTER_IN_UI) {
    supplierFiltered = await applySupplierFilter(page, WANTED_SUPPLIERS);
    console.log("UI supplier filter applied:", supplierFiltered);
    await page.waitForTimeout(1200).catch(() => {});
  }
  if (APPLY_SORT_PRICE_ASC_IN_UI) {
    priceSorted = await applySortPriceAsc(page);
    console.log("UI price sort applied:", priceSorted);
    await page.waitForTimeout(1200).catch(() => {});
  }
  await page.mouse.wheel(0, 900).catch(() => {});
  await page.waitForTimeout(600).catch(() => {});
  await scrollToRevealCards(page);

  let cards = page.locator('[role="group"]');
  let cardsCount = await cards.count();
  if (cardsCount === 0) {
    await scrollToRevealCards(page);
    await page.waitForTimeout(1500).catch(() => {});
    cardsCount = await cards.count();
  }

  const buckets = new Map();
  for (const loc of WANTED_PICKUP_LOCATIONS) buckets.set(loc, new Map());
  function addToBucket(match) {
    const bySupplier = buckets.get(match.location);
    if (!bySupplier) return;
    const prev = bySupplier.get(match.supplier);
    if (!prev || match.priceValue < prev.priceValue) bySupplier.set(match.supplier, match);
  }

  // Если сортировка цены не сработала, читаем чуть больше карточек (мягкий fallback).
  const effectiveMaxCards =
    APPLY_SORT_PRICE_ASC_IN_UI && !priceSorted
      ? Math.min(160, MAX_CARDS_TO_PARSE * 2)
      : MAX_CARDS_TO_PARSE;
  // Если UI-фильтр поставщиков не сработал, не режем выдачу слишком агрессивно по supplier.
  const enforceSupplierFilter = !(APPLY_SUPPLIER_FILTER_IN_UI && !supplierFiltered);
  const toParse = Math.min(cardsCount, effectiveMaxCards);
  const pickupStr = toLocalDateString(pickupDate);
  const dropoffStr = toLocalDateString(dropoffDate);

  for (let i = 0; i < toParse; i++) {
    const card = cards.nth(i);
    try {
      const cardText = await card.innerText().catch(() => "");
      if (!/€\s*\d/.test(cardText)) continue;
      const model = (await card.locator("h2").first().innerText().catch(() => "")).trim();
      const supplierAlt = (await card.locator('img[alt^="Supplied by"]').first().getAttribute("alt").catch(() => "")) || "";
      const supplier = supplierAlt.replace(/^Supplied by\s*/i, "").trim();
      // Локация: Booking может использовать разные символы дефиса и разные контейнеры,
      // поэтому берём первую строку с "Barcelona" из полного текста карточки.
      const locationMatch = cardText.match(/Barcelona[^\n]+/);
      const location = locationMatch ? locationMatch[0].trim() : "";
      const euroValues = extractEuroPricesFromText(cardText);
      if (!euroValues.length) continue;
      const priceValue = Math.min(...euroValues);
      const priceText = `€ ${priceValue}`;
      const mappedLocation = mapPickupLocation(location);
      if (!supplier || !mappedLocation) continue;
      if (enforceSupplierFilter && WANTED_SUPPLIERS.length && !WANTED_SUPPLIERS.includes(supplier)) continue;
      addToBucket({
        pickup: pickupStr,
        dropoff: dropoffStr,
        time,
        supplier,
        location: mappedLocation,
        model,
        priceText,
        priceValue,
        searchUrl: buildSearchUrl(pickupDate, dropoffDate, time),
      });
    } catch (_) {}
  }

  const out = [];
  for (const loc of WANTED_PICKUP_LOCATIONS) {
    const bySupplier = buckets.get(loc) || new Map();
    const arr = Array.from(bySupplier.values()).sort((a, b) => a.priceValue - b.priceValue);
    for (const m of arr.slice(0, MAX_PER_LOCATION)) out.push(m);
  }
  return { matches: out, captchaRequired: false };
}

/** Запуск задач с ограничением числа одновременных вкладок (пул). */
async function runWithPool(jobs, context, concurrency, onJobDone) {
  const pool = [];
  for (let i = 0; i < concurrency; i++) {
    pool.push(await context.newPage());
  }
  const results = Array(jobs.length).fill(null);
  let index = 0;

  async function runNext(page) {
    const j = index++;
    if (j >= jobs.length) return;
    const job = jobs[j];
    try {
      const result = await runOneJob(page, job.pickupDate, job.dropoffDate, job.time, { runMode: "headed" });
      results[j] = result.matches || [];
    } catch (e) {
      console.error("Ошибка в задаче", j, e.message);
      results[j] = [];
    }
    if (typeof onJobDone === "function") onJobDone();
    await runNext(page);
  }

  await Promise.all(
    pool.map((p, i) => (i === 0 ? runNext(p) : sleep(POOL_THROTTLE_MS * i).then(() => runNext(p))))
  );
  for (const p of pool) await p.close().catch(() => {});
  return results.map((r) => r || []).flat();
}

// ======================
// MAIN
// ======================

let scoutBrowserContext = null;

function onCancel() {
  if (scoutBrowserContext) {
    const ctx = scoutBrowserContext;
    scoutBrowserContext = null;
    ctx.close().then(() => process.exit(0)).catch(() => process.exit(0));
    return;
  }
  process.exit(0);
}

process.on("SIGTERM", onCancel);
process.on("SIGINT", onCancel);

const BROWSER_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
];

/** Путь к Google Chrome на macOS — при запуске из UI дочерний процесс может не находить Chrome по channel. */
function getChromeExecutablePath() {
  if (process.platform !== "darwin") return null;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

async function launchScoutContext(userDataDir, runMode, useChrome = false) {
  const options = {
    headless: false,
    slowMo: 150,
    viewport: { width: 1280, height: 800 },
    locale: "en-GB",
    args: BROWSER_LAUNCH_ARGS,
  };
  if (useChrome) {
    const chromePath = getChromeExecutablePath();
    if (chromePath) {
      options.executablePath = chromePath;
    } else {
      options.channel = "chrome";
    }
  }
  const context = await chromium.launchPersistentContext(userDataDir, options);
  emitScoutEvent("RUN_MODE", { mode: "headed" });
  return context;
}

(async () => {
  const argStart = process.argv[2];
  const argDuration = process.argv[3];

  // Если дата передана аргументом — используем её.
  // Иначе стартуем с сегодняшнего дня (а не с зашитой даты в прошлом).
  const startDate = argStart
    ? new Date(`${argStart}T00:00:00`)
    : (() => {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        return now;
      })();

  const durationDays = argDuration
    ? Math.max(1, parseInt(argDuration, 10))
    : RENT_DAYS;

  const profileDir = process.env.RUN_FROM_UI ? ".pw-profile-ui" : ".pw-profile";
  const userDataDir = path.join(__dirname, profileDir);
  const currentRunMode = "headed";

  let context;
  // 1) Пытаемся запустить через системный Google Chrome.
  try {
    context = await launchScoutContext(userDataDir, currentRunMode, true);
  } catch (chromeErr) {
    const msg = chromeErr && chromeErr.message ? chromeErr.message : String(chromeErr);
    console.error("Запуск через Chrome не удался: " + msg);
    // 2) Фолбэк на Chromium с тем же профилем.
    try {
      context = await launchScoutContext(userDataDir, currentRunMode, false);
    } catch (launchErr) {
      const errMsg = launchErr && launchErr.message ? launchErr.message : String(launchErr);
      console.error("BROWSER_LAUNCH_FAILED: " + errMsg);
      // 3) Последняя попытка — временный профиль.
      const fallbackDir = path.join(os.tmpdir(), "pw-profile-scout-" + Date.now());
      try {
        console.error("Повторный запуск с временным профилем (Chromium)...");
        context = await launchScoutContext(fallbackDir, currentRunMode, false);
      } catch (retryErr) {
        const retryMsg = retryErr && retryErr.message ? retryErr.message : String(retryErr);
        console.error("Повторный запуск не удался: " + retryMsg);
        console.error("");
        console.error("Подсказки:");
        console.error("  1. Установите Google Chrome — скрипт будет использовать его вместо Chromium.");
        console.error("  2. Удалите папки профиля: rm -rf .pw-profile .pw-profile-ui");
        console.error("  3. Переустановите браузеры Playwright: npm run install-browsers");
        process.exit(1);
      }
    }
  }

  scoutBrowserContext = context;
  const activeTimes = resolveTimesFromEnv();

  const jobs = [];
  const pickupDatesEnv = (process.env.PICKUP_DATES || "").trim();
  const flexPickupDates = pickupDatesEnv
    ? pickupDatesEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    : [];
  if (flexPickupDates.length > 0) {
    for (const iso of flexPickupDates.slice(0, 6)) {
      const pickupDate = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(pickupDate.getTime())) continue;
      const dropoffDate = new Date(pickupDate);
      dropoffDate.setDate(dropoffDate.getDate() + durationDays);
      for (const time of activeTimes) {
        if (MAX_REQUESTS_PER_RUN > 0 && jobs.length >= MAX_REQUESTS_PER_RUN) break;
        jobs.push({
          pickupDate: new Date(pickupDate.getTime()),
          dropoffDate: new Date(dropoffDate.getTime()),
          time,
        });
      }
    }
  } else {
    for (let offset = 0; offset < WINDOW_DAYS; offset++) {
      const pickupDate = new Date(startDate);
      pickupDate.setDate(pickupDate.getDate() + offset);
      const dropoffDate = new Date(pickupDate);
      dropoffDate.setDate(dropoffDate.getDate() + durationDays);
      for (const time of activeTimes) {
        if (MAX_REQUESTS_PER_RUN > 0 && jobs.length >= MAX_REQUESTS_PER_RUN) break;
        jobs.push({
          pickupDate: new Date(pickupDate.getTime()),
          dropoffDate: new Date(dropoffDate.getTime()),
          time,
        });
      }
    }
  }
  const totalJobs = jobs.length;
  let completedJobs = 0;
  const runStartedAt = Date.now();
  function logJobDone() {
    completedJobs += 1;
    const elapsedMs = Date.now() - runStartedAt;
    console.log(`PROGRESS_JOB_DONE ${completedJobs}/${totalJobs} elapsed_ms=${elapsedMs}`);
  }

  let allMatches = [];
  if (PARALLEL_TABS > 1 && jobs.length > 1) {
    console.log("\nПараллельный режим: " + PARALLEL_TABS + " вкладок, " + jobs.length + " запросов.\n");
    allMatches = await runWithPool(jobs, context, Math.min(PARALLEL_TABS, jobs.length), logJobDone);
    console.log("\nВсего матчей:", allMatches.length);
  } else {
    const page = await context.newPage();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const result = await runOneJob(page, job.pickupDate, job.dropoffDate, job.time, { runMode: currentRunMode });
      allMatches = allMatches.concat(result.matches || []);
      logJobDone();
      console.log("matches total so far:", allMatches.length);
      if (i < jobs.length - 1) {
        await page.waitForTimeout(WAIT_BETWEEN_REQUESTS_MS).catch(() => {});
      }
    }
    await page.close().catch(() => {});
  }

  if (allMatches.length === 0) {
    console.log("\n❌ Ничего не найдено.");
    fs.writeFileSync(
      "results.json",
      JSON.stringify({ matches: [], analysis: undefined }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      "results.csv",
      "pickup,dropoff,time,supplier,location,model,priceText,priceValue",
      "utf-8"
    );
    console.log("\nСохранено (пустые): results.json, results.csv");
  } else {
    allMatches.sort((a, b) => a.priceValue - b.priceValue);

    // Ограничиваем количество машин на каждую локацию (и на каждое окно)
    const locationCounts = new Map();
    const filteredMatches = [];
    for (const match of allMatches) {
      const key = `${match.location}|${match.pickup}|${match.dropoff}|${match.time}`;
      const count = locationCounts.get(key) || 0;
      if (count < MAX_PER_LOCATION) {
        filteredMatches.push(match);
        locationCounts.set(key, count + 1);
      }
    }
    allMatches.length = 0;
    allMatches.push(...filteredMatches);

    const analysis = analyzeMatches(allMatches);

    console.log("\nТОП-10:");
    allMatches.slice(0, 10).forEach((r, i) => {
      console.log(
        `${i + 1}) ${r.priceText} | ${r.supplier} | ${r.location} | ${r.pickup} ${r.time}`
      );
    });

    if (analysis) {
      console.log("\n--- Результат ---");
      console.log("Глобальный минимум:", analysis.globalMin.priceText, "|", analysis.globalMin.supplier, "|", analysis.globalMin.location, "|", analysis.globalMin.pickup, analysis.globalMin.time);
      if (analysis.cheapestWindow) {
        console.log("Самое дешёвое окно аренды:", analysis.cheapestWindow.key, "→ €" + analysis.cheapestWindow.price);
      }
      if (analysis.cheapestLocation) {
        console.log("Самая дешёвая локация:", analysis.cheapestLocation.location, "→ €" + analysis.cheapestLocation.price);
      }
    }

    const output = { matches: allMatches, analysis: analysis || undefined };
    fs.writeFileSync(
      "results.json",
      JSON.stringify(output, null, 2),
      "utf-8"
    );

    const csvRows = ["pickup,dropoff,time,supplier,location,model,priceText,priceValue"];
    for (const r of allMatches) {
      csvRows.push([r.pickup, r.dropoff, r.time, r.supplier, r.location, r.model, r.priceText, r.priceValue].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
    }
    fs.writeFileSync("results.csv", csvRows.join("\n"), "utf-8");

    console.log("\nСохранено: results.json, results.csv");
  }

  await context.close();
  scoutBrowserContext = null;
})().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});