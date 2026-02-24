# Booking Car Scout

Сервис для поиска выгодной аренды авто на cars.booking.com по заданному диапазону дат и длительности аренды. Результаты выводятся в UI и в файлы `results.json`, `results.csv`.

Подробная логика и API описаны в [SPECIFICATION.md](./SPECIFICATION.md).

---

## Что нужно для разработки

- **Node.js** 18+ (рекомендуется LTS)
- **npm** (идёт с Node.js)
- **Git**

---

## Подключение к проекту (второй разработчик)

### 1. Репозиторий в облаке

Чтобы расшарить проект, нужен удалённый репозиторий:

- **GitHub**: создай репозиторий (например `booking-car-scout`), затем в корне проекта выполни:
  ```bash
  git remote add origin https://github.com/<твой-username>/booking-car-scout.git
  git push -u origin main
  ```
  (или `master`, если у тебя такая ветка)

- **GitLab / Bitbucket**: то же самое — создай проект, добавь `remote` и сделай первый `git push`.

Второй разработчик тогда клонирует репозиторий:
```bash
git clone https://github.com/<username>/booking-car-scout.git
cd booking-car-scout
```

### 2. Установка зависимостей

После клонирования (или после `git pull`):

```bash
npm install
npm run install-browsers
```

`install-browsers` один раз скачивает Chromium для Playwright — без этого поиск не запустится.

### 3. Запуск

- **UI (основной способ):**
  ```bash
  npm run ui
  ```
  Открыть в браузере ссылку из терминала (обычно `http://127.0.0.1:3000`).

- **CLI:**
  ```bash
  npm run run
  # или с параметрами:
  node set_location.js 2026-03-18 2
  ```

---

## Скрипты

| Команда | Описание |
|--------|----------|
| `npm run ui` / `npm start` | Запуск локального сервера с UI |
| `npm run run` | Запуск поиска из терминала |
| `npm run dev` | Запуск скрипта поиска с автоперезапуском (nodemon) |
| `npm run install-browsers` | Установка Chromium для Playwright (один раз) |

---

## Структура проекта

- `set_location.js` — скрипт поиска (Playwright)
- `server.js` — HTTP-сервер и API
- `public/index.html`, `public/styles.css` — клиентский UI
- `results.json` / `results.csv` — результаты (создаются после поиска, в `.gitignore`)

---

## Совместная работа

- Держи код в одном удалённом репозитории; оба разработчика делают `git pull` перед работой и `git push` после изменений.
- Не коммить `node_modules/`, `results.json`, `results.csv`, `.env` — они уже в `.gitignore`.
- Общую логику и контракты смотри в [SPECIFICATION.md](./SPECIFICATION.md).
