const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname);
const TIMES_PER_DAY = 2;
const MAX_REQUESTS_PER_RUN = 14;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/results", (req, res) => {
  const file = path.join(ROOT, "results.json");
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "results.json not found. Run a search first." });
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Invalid results.json" });
  }
});

let currentScoutProcess = null;
let scoutProgress = {
  running: false,
  totalJobs: 0,
  doneJobs: 0,
  startedAt: null,
  finished: false,
  error: false,
  captchaRequired: false,
  captchaSince: null,
  runMode: null,
  lastEvent: null,
};

app.get("/api/progress", (req, res) => {
  const total = scoutProgress.totalJobs || 0;
  const done = Math.min(scoutProgress.doneJobs || 0, total || 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  let etaSec = null;
  if (scoutProgress.running && scoutProgress.startedAt && done > 0 && total > done) {
    const elapsedMs = Date.now() - scoutProgress.startedAt;
    etaSec = Math.round(((elapsedMs / done) * (total - done)) / 1000);
  }
  res.json({
    running: scoutProgress.running,
    totalJobs: total,
    doneJobs: done,
    percent,
    etaSec,
    finished: scoutProgress.finished,
    error: scoutProgress.error,
    captchaRequired: Boolean(scoutProgress.captchaRequired),
    captchaSince: scoutProgress.captchaSince || null,
    runMode: scoutProgress.runMode || null,
    lastEvent: scoutProgress.lastEvent || null,
  });
});

app.post("/api/run", async (req, res) => {
  if (currentScoutProcess && currentScoutProcess.kill) {
    try {
      currentScoutProcess.kill("SIGTERM");
      console.log("[scout] Предыдущий поиск отменён, жду закрытия браузера (2.5 сек)...");
      currentScoutProcess = null;
      await new Promise((r) => setTimeout(r, 2500));
    } catch (_) {
      currentScoutProcess = null;
    }
  }

  const { startDate, endDate, rentDays, pickupDates, pickupTimes } = req.body || {};
  const start = startDate || new Date().toISOString().slice(0, 10);
  const days = rentDays != null ? String(Math.min(7, Math.max(1, parseInt(rentDays, 10)))) : "2";
  const isFlex = Array.isArray(pickupDates) && pickupDates.length > 0;
  let normalizedPickupDates = null;
  if (isFlex) {
    normalizedPickupDates = Array.from(
      new Set(
        pickupDates
          .map((v) => String(v || "").trim())
          .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
      )
    ).sort();
    if (normalizedPickupDates.length === 0) {
      return res.status(400).json({ ok: false, error: "pickupDates is empty or invalid" });
    }
    if (normalizedPickupDates.length > 6) {
      return res.status(400).json({ ok: false, error: "pickupDates max is 6" });
    }
    const normalizedPickupTimes = Array.isArray(pickupTimes)
      ? Array.from(new Set(
          pickupTimes
            .map((v) => parseInt(v, 10))
            .filter((v) => Number.isFinite(v) && v >= 8 && v <= 18)
        )).sort((a, b) => a - b)
      : [];
    if (normalizedPickupTimes.length !== 2) {
      return res.status(400).json({ ok: false, error: "pickupTimes must contain 2 values (08..18)" });
    }
    req.normalizedPickupTimes = normalizedPickupTimes;
  }
  let horizon = 1;
  if (!isFlex && endDate) {
    const a = new Date(start + "T00:00:00");
    const b = new Date(endDate + "T00:00:00");
    horizon = Math.round((b - a) / (24 * 60 * 60 * 1000)) - parseInt(days, 10) + 1;
    if (horizon < 1) horizon = 1;
    if (horizon > 7) horizon = 7;
  }
  const estimatedTotalJobs = isFlex
    ? Math.min(MAX_REQUESTS_PER_RUN, Math.max(1, normalizedPickupDates.length * TIMES_PER_DAY))
    : Math.min(MAX_REQUESTS_PER_RUN, Math.max(1, horizon * TIMES_PER_DAY));
  scoutProgress = {
    running: true,
    totalJobs: estimatedTotalJobs,
    doneJobs: 0,
    startedAt: Date.now(),
    finished: false,
    error: false,
    captchaRequired: false,
    captchaSince: null,
    runMode: null,
    lastEvent: null,
  };
  const env = { ...process.env, WINDOW_DAYS: String(horizon), RUN_FROM_UI: "1", PARALLEL_TABS: process.env.PARALLEL_TABS || "4" };
  if (isFlex) {
    env.PICKUP_DATES = normalizedPickupDates.join(",");
    env.PICKUP_TIMES = (req.normalizedPickupTimes || []).join(",");
  } else {
    delete env.PICKUP_DATES;
    delete env.PICKUP_TIMES;
  }

  const scriptPath = path.join(ROOT, "set_location.js");
  const child = spawn(process.execPath, [scriptPath, start, days], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  currentScoutProcess = child;

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    const chunk = d.toString();
    stdout += chunk;
    console.log("[scout]", chunk.trim());
    const lines = chunk.split("\n");
    for (const line of lines) {
      const m = line.match(/Параллельный режим:.*?(\d+)\s+запросов/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) scoutProgress.totalJobs = n;
      }
      const doneMatch = line.match(/PROGRESS_JOB_DONE\s+(\d+)\/(\d+)/);
      if (doneMatch) {
        const done = parseInt(doneMatch[1], 10);
        const total = parseInt(doneMatch[2], 10);
        if (Number.isFinite(total) && total > 0) scoutProgress.totalJobs = total;
        if (Number.isFinite(done) && done >= 0) {
          scoutProgress.doneJobs = Math.min(done, scoutProgress.totalJobs || done);
        }
      }
      const eventPrefix = "SCOUT_EVENT ";
      const eventPos = line.indexOf(eventPrefix);
      if (eventPos >= 0) {
        const payloadText = line.slice(eventPos + eventPrefix.length).trim();
        try {
          const event = JSON.parse(payloadText);
          const eventName = event && event.name ? String(event.name) : null;
          if (eventName) {
            scoutProgress.lastEvent = eventName;
          }
          if (eventName === "RUN_MODE") {
            scoutProgress.runMode = event.mode || scoutProgress.runMode;
          } else if (eventName === "MODE_SWITCH") {
            scoutProgress.runMode = event.to || scoutProgress.runMode;
          } else if (eventName === "CAPTCHA_REQUIRED") {
            scoutProgress.captchaRequired = true;
            scoutProgress.captchaSince = Date.now();
          } else if (eventName === "CAPTCHA_RESOLVED") {
            scoutProgress.captchaRequired = false;
            scoutProgress.captchaSince = null;
          }
        } catch (_) {
          // ignore malformed event payload
        }
      }
    }
  });
  child.stderr.on("data", (d) => { stderr += d; console.error("[scout stderr]", d.toString().trim()); });

  child.on("close", (code) => {
    if (currentScoutProcess === child) currentScoutProcess = null;
    scoutProgress.running = false;
    scoutProgress.finished = true;
    scoutProgress.error = code !== 0;
    scoutProgress.captchaRequired = false;
    scoutProgress.captchaSince = null;
    if (code === 0 && scoutProgress.totalJobs > 0) {
      scoutProgress.doneJobs = scoutProgress.totalJobs;
    }
    if (code !== 0) {
      let errText = stderr.trim() || stdout.slice(-500).trim() || "No output";
      const hasLaunchFailed = /BROWSER_LAUNCH_FAILED|Подсказка:/.test(errText);
      const isChromeNoise = /--enable-automation|--remote-debugging-pipe|--user-data-dir|--no-sandbox|about:blank/.test(errText);
      if (hasLaunchFailed) {
        const hint = (errText.match(/Подсказка:[^\n]+/) || [])[0] || "";
        errText = (errText.replace(/BROWSER_LAUNCH_FAILED:\s*/, "").split("\n")[0] || "Не удалось запустить браузер.") + (hint ? " " + hint : "");
      } else if (isChromeNoise) {
        errText = "Не удалось запустить браузер. Закройте окно браузера от предыдущего поиска и нажмите «Запустить поиск» снова. Либо перезапустите сервер (npm run ui) и откройте ссылку заново.";
      }
      if (errText.length > 500) errText = errText.slice(-500);
      console.error("[scout] exit code", code, "\n", errText);
      return res.status(500).json({ ok: false, error: "Script failed", code, stderr: errText });
    }
    res.json({ ok: true });
  });

  child.on("error", (err) => {
    if (currentScoutProcess === child) currentScoutProcess = null;
    console.error("[scout] spawn error", err.message);
    res.status(500).json({ ok: false, error: err.message, stderr: err.message });
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Слушать только localhost — доступ только с этого компьютера (не из сети)
const HOST = process.env.HOST || "127.0.0.1";

function startServer(port) {
  const server = app.listen(port, HOST, () => {
    console.log("");
    console.log("  ================================");
    console.log("  Booking Car Scout UI запущен");
    console.log("  ================================");
    console.log("  Только локально: http://" + HOST + ":" + port);
    console.log("  ================================");
    console.log("");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < 3010) {
      console.warn("  Порт " + port + " занят (запущен другой процесс). Пробую " + (port + 1) + "...");
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

startServer(PORT);
