const { chromium } = require('playwright');

(async () => {
  console.log("Запускаем браузер...");

  const browser = await chromium.launch({
    headless: false
  });

  const page = await browser.newPage();

  console.log("Открываем booking.com...");
  await page.goto('https://www.booking.com');

  console.log("Ждем 5 секунд...");
  await page.waitForTimeout(5000);

  console.log("Закрываем браузер...");
  await browser.close();

  console.log("Готово.");
})();