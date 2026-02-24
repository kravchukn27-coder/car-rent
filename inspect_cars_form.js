const { chromium } = require('playwright');

async function safeClick(page, selector) {
  const el = page.locator(selector);
  if (await el.count()) {
    try { await el.first().click({ timeout: 1500 }); } catch (_) {}
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50, // чтобы ты видел, что делает бот
  });

  const page = await browser.newPage();

  console.log("Открываем Booking Cars...");
  await page.goto("https://www.booking.com/cars/", { waitUntil: "domcontentloaded" });

  // Часто выскакивает баннер cookies (не всегда).
  // Пытаемся нажать "Accept" по нескольким типичным селекторам — если нет, просто идём дальше.
  await safeClick(page, "#onetrust-accept-btn-handler");
  await safeClick(page, "button:has-text('Accept')");
  await safeClick(page, "button:has-text('I agree')");
  await safeClick(page, "button:has-text('Принять')");
  await safeClick(page, "button:has-text('Согласен')");

  // Дадим странице дорисоваться
  await page.waitForTimeout(1500);

  console.log("\n=== НАЙДЕННЫЕ INPUT'Ы НА СТРАНИЦЕ ===");
  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({
      id: e.id || "",
      name: e.getAttribute("name") || "",
      type: e.getAttribute("type") || "",
      placeholder: e.getAttribute("placeholder") || "",
      ariaLabel: e.getAttribute("aria-label") || "",
      autoComplete: e.getAttribute("autocomplete") || "",
    }))
  );

  // Отфильтруем пустые “мусорные” поля и красиво выведем
  const useful = inputs.filter((x) =>
    (x.id || x.name || x.placeholder || x.ariaLabel) &&
    x.type !== "hidden"
  );

  useful.forEach((x, i) => {
    console.log(
      `${i + 1}. id="${x.id}" name="${x.name}" type="${x.type}" placeholder="${x.placeholder}" aria-label="${x.ariaLabel}" autocomplete="${x.autoComplete}"`
    );
  });

  console.log("\nОставляю браузер открытым на 20 секунд, чтобы ты посмотрел страницу.");
  await page.waitForTimeout(20000);

  await browser.close();
  console.log("Готово.");
})();