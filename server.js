const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

// Lightweight per-IP limits; protects public API routes from accidental/request floods.
const requestBuckets = new Map();
function rateLimit({ windowMs = 60_000, max = 120, message = "Слишком много запросов. Попробуй позже." } = {}) {
  return (req, res, next) => {
    const key = req.ip + ":" + (req.path.startsWith("/api/") ? req.path.split("/").slice(0, 3).join("/") : "global");
    const now = Date.now();
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      requestBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
app.use("/api", rateLimit());
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return rateLimit({ max: 25, message: "Слишком много изменений подряд. Подожди минуту." })(req, res, next);
  }
  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of requestBuckets) if (now - bucket.startedAt > 120_000) requestBuckets.delete(key);
}, 120_000).unref();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL = process.env.REQUIRED_CHANNEL || "@MysticDropNFT";
const DEV_MODE = process.env.DEV_MODE === "true";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const DB_PATH = process.env.DB_PATH || (fs.existsSync("/var/data") ? "/var/data/mystic.sqlite3" : path.join(ROOT, "data", "mystic.sqlite3"));
function isLocalDev(req) { return DEV_MODE && ["localhost", "127.0.0.1"].includes(req.hostname); }

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  prize_id TEXT NOT NULL,
  prize_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  rarity TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'roulette',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  request_id TEXT NOT NULL,
  roulette_id TEXT NOT NULL DEFAULT 'classic',
  prize_id TEXT NOT NULL,
  cost INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_id, request_id)
);
CREATE TABLE IF NOT EXISTS mines_games (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  bet INTEGER NOT NULL,
  bombs_json TEXT NOT NULL,
  revealed_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  multiplier REAL NOT NULL DEFAULT 1,
  payout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS task_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  task_id TEXT NOT NULL,
  claim_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_id, task_id, claim_day)
);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(telegram_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_mines_user ON mines_games(telegram_id, status);
`);

const ROULETTES = {
  classic: {
    id: "classic", title: "Mystic Classic", cost: 100,
    prizes: [
      { id: "teddy_bear", name: "Teddy Bear", emoji: "🧸", rarity: "Обычный", gift_id: "5170233102089322756", weight: 48 },
      { id: "red_rose", name: "Red Rose", emoji: "🌹", rarity: "Обычный", gift_id: "5168103777563050263", weight: 30 },
      { id: "gift_box", name: "Gift Box", emoji: "🎁", rarity: "Редкий", gift_id: "5170250947678437525", weight: 15 },
      { id: "rocket", name: "Rocket", emoji: "🚀", rarity: "Эпический", gift_id: "5170564780938756245", weight: 6 },
      { id: "diamond_ring", name: "Diamond Ring", emoji: "💍", rarity: "Легендарный", gift_id: "5170690322832818290", weight: 1 }
    ]
  },
  premium: {
    id: "premium", title: "Mystic Premium", cost: 250,
    prizes: [
      { id: "teddy_bear", name: "Teddy Bear", emoji: "🧸", rarity: "Обычный", gift_id: "5170233102089322756", weight: 35 },
      { id: "red_rose", name: "Red Rose", emoji: "🌹", rarity: "Обычный", gift_id: "5168103777563050263", weight: 30 },
      { id: "gift_box", name: "Gift Box", emoji: "🎁", rarity: "Редкий", gift_id: "5170250947678437525", weight: 22 },
      { id: "rocket", name: "Rocket", emoji: "🚀", rarity: "Эпический", gift_id: "5170564780938756245", weight: 10 },
      { id: "diamond_ring", name: "Diamond Ring", emoji: "💍", rarity: "Легендарный", gift_id: "5170690322832818290", weight: 3 }
    ]
  },
  legendary: {
    id: "legendary", title: "Mystic Legend", cost: 500,
    prizes: [
      { id: "teddy_bear", name: "Teddy Bear", emoji: "🧸", rarity: "Обычный", gift_id: "5170233102089322756", weight: 20 },
      { id: "red_rose", name: "Red Rose", emoji: "🌹", rarity: "Обычный", gift_id: "5168103777563050263", weight: 25 },
      { id: "gift_box", name: "Gift Box", emoji: "🎁", rarity: "Редкий", gift_id: "5170250947678437525", weight: 30 },
      { id: "rocket", name: "Rocket", emoji: "🚀", rarity: "Эпический", gift_id: "5170564780938756245", weight: 18 },
      { id: "diamond_ring", name: "Diamond Ring", emoji: "💍", rarity: "Легендарный", gift_id: "5170690322832818290", weight: 7 }
    ]
  }};
const SPIN_STMT = db.prepare("INSERT INTO spins(telegram_id, request_id, roulette_id, prize_id, cost) VALUES(?,?,?,?,?)");
const getUser = db.prepare("SELECT * FROM users WHERE telegram_id = ?");
const createUser = db.prepare("INSERT OR IGNORE INTO users(telegram_id, first_name, username, balance) VALUES(?,?,?,0)");

function validateInitData(initData) {
  if (typeof initData !== "string" || initData.length > 8192) throw Object.assign(new Error("Некорректные данные авторизации Telegram"), { status: 401 });
  if (!BOT_TOKEN) throw Object.assign(new Error("На сервере не настроен BOT_TOKEN"), { status: 503 });
  const params = new URLSearchParams(initData || "");
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!receivedHash || !authDate) throw Object.assign(new Error("Нет данных авторизации Telegram"), { status: 401 });
  if (Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) {
    throw Object.assign(new Error("Сессия Telegram устарела. Перезапусти Mini App."), { status: 401 });
  }
  params.delete("hash");
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Не удалось подтвердить Telegram-сессию"), { status: 401 });
  }
  let tgUser;
  try { tgUser = JSON.parse(params.get("user") || "{}"); } catch {
    throw Object.assign(new Error("Некорректные данные пользователя"), { status: 401 });
  }
  if (!tgUser.id) throw Object.assign(new Error("Telegram не передал ID пользователя"), { status: 401 });
  return { id: String(tgUser.id), first_name: String(tgUser.first_name || "Игрок").slice(0,64), username: String(tgUser.username || "").slice(0,64) };
}

function auth(req, res, next) {
  try {
    if (isLocalDev(req)) {
      req.user = { id: "1", first_name: "Тестовый игрок", username: "demo" };
    } else {
      const header = req.get("authorization") || "";
      if (!header.startsWith("tma ")) throw Object.assign(new Error("Открой приложение через Telegram"), { status: 401 });
      req.user = validateInitData(header.slice(4));
    }
    next();
  } catch (err) { res.status(err.status || 401).json({ error: err.message }); }
}

async function telegramMember(userId, allowLocalDev = false) {
  if (allowLocalDev && DEV_MODE) return { subscribed: true, status: "member", demo: true };
  if (!BOT_TOKEN) throw Object.assign(new Error("Администратор ещё не настроил Telegram-бота"), { status: 503 });
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/getChatMember";
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL, user_id: Number(userId) })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw Object.assign(new Error("Не удалось проверить подписку. Попробуй позже."), { status: 502 });
  const status = data.result?.status || "left";
  return { subscribed: ["creator", "administrator", "member"].includes(status) || (status === "restricted" && data.result?.is_member === true), status };
}

function requireSubscription(req, res, next) {
  telegramMember(req.user.id, isLocalDev(req)).then(result => {
    if (!result.subscribed) return res.status(403).json({ error: "Сначала подпишись на канал " + CHANNEL, subscription_required: true, channel: CHANNEL });
    req.subscription = result;
    next();
  }).catch(err => res.status(err.status || 502).json({ error: err.message }));
}
function safePrize(p) { const { weight, ...rest } = p; return rest; }
function weightedPrize(prizes) {
  const total = prizes.reduce((s,p) => s + p.weight, 0);
  let roll = crypto.randomInt(0, total);
  for (const p of prizes) { if (roll < p.weight) return p; roll -= p.weight; }
  return prizes[0];
}
function requireBodyString(value, min=8, max=80) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
function apiError(res, err) { const constraint = String(err.code || "").startsWith("SQLITE_CONSTRAINT"); const status = err.status || (constraint ? 409 : 500); return res.status(status).json({ error: constraint ? "Эта операция уже выполнена или данные конфликтуют." : (err.message || "Внутренняя ошибка сервера") }); }

app.get("/api/health", (req,res) => res.json({ ok: true, app: "Mystic NFT Drop", runtime: "node" }));
app.get("/api/access", auth, requireSubscription, (req,res) => res.json({ ok: true, subscribed: true, channel: CHANNEL, demo: !!req.subscription.demo }));

app.get("/api/me", auth, (req,res) => {
  const u = req.user;
  createUser.run(u.id, u.first_name, u.username);
  db.prepare("UPDATE users SET first_name=?, username=?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(u.first_name,u.username,u.id);
  const row = getUser.get(u.id);
  const inventoryCount = db.prepare("SELECT COUNT(*) AS total FROM inventory WHERE telegram_id=?").get(u.id).total;
  const spinCount = db.prepare("SELECT COUNT(*) AS total FROM spins WHERE telegram_id=?").get(u.id).total;
  res.json({ id: u.id, name: row.first_name, username: row.username, balance: row.balance, inventory_count: inventoryCount, spin_count: spinCount });
});

app.get("/api/daily", auth, requireSubscription, (req,res) => {
  const today = new Date().toISOString().slice(0,10);
  const claim = db.prepare("SELECT id FROM task_claims WHERE telegram_id=? AND task_id='daily' AND claim_day=?").get(req.user.id,today);
  res.json({ claimed: !!claim, reward: 5 });
});
app.post("/api/daily/claim", auth, requireSubscription, (req,res) => {
  try {
    createUser.run(req.user.id,req.user.first_name,req.user.username);
    const today = new Date().toISOString().slice(0,10);
    const run = db.transaction(() => {
      db.prepare("INSERT INTO task_claims(telegram_id,task_id,claim_day) VALUES(?,'daily',?)").run(req.user.id,today);
      db.prepare("UPDATE users SET balance=balance+5, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(req.user.id);
      return { reward:5, balance:getUser.get(req.user.id).balance };
    });
    res.json(run.immediate());
  } catch(err) {
    if (String(err.code || "").includes("CONSTRAINT")) return res.status(409).json({error:"Ежедневный бонус уже получен. Загляни завтра!"});
    apiError(res,err);
  }
});

app.get("/api/tasks", auth, (req,res) => {
  createUser.run(req.user.id, req.user.first_name, req.user.username);
  const today = new Date().toISOString().slice(0,10);
  const claimed = db.prepare("SELECT task_id, claim_day FROM task_claims WHERE telegram_id=?").all(req.user.id);
  const has = (id, day) => claimed.some(x => x.task_id === id && x.claim_day === day);
  res.json({ tasks: [
    { id:"subscribe", title:"Подписаться на канал", description:"Подпишись на @MysticDropNFT и забери награду один раз.", reward:10, claimed:has("subscribe","once"), repeat:"once" },
    { id:"daily", title:"Ежедневный вход", description:"Заходи в Mystic Drop каждый день.", reward:5, claimed:has("daily",today), repeat:"daily" }
  ]});
});
app.post("/api/tasks/claim", auth, async (req,res) => {
  try {
    const taskId = req.body?.task_id;
    if (!["subscribe","daily"].includes(taskId)) return res.status(400).json({error:"Неизвестное задание"});
    if (taskId === "subscribe") {
      const membership = await telegramMember(req.user.id, isLocalDev(req));
      if (!membership.subscribed) return res.status(403).json({error:"Сначала подпишись на @MysticDropNFT, затем нажми «Проверить»."});
    }
    const claimDay = taskId === "subscribe" ? "once" : new Date().toISOString().slice(0,10);
    const reward = taskId === "subscribe" ? 10 : 5;
    const run = db.transaction(() => {
      createUser.run(req.user.id, req.user.first_name, req.user.username);
      db.prepare("INSERT INTO task_claims(telegram_id,task_id,claim_day) VALUES(?,?,?)").run(req.user.id,taskId,claimDay);
      db.prepare("UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(reward,req.user.id);
      return getUser.get(req.user.id).balance;
    });
    const balance = run.immediate();
    res.json({ok:true,reward,balance,task_id:taskId});
  } catch(err) { apiError(res,err); }
});

app.get("/api/roulette", auth, requireSubscription, (req,res) => {
  const rouletteList = Object.values(ROULETTES).map(r => ({
    id:r.id, title:r.title, cost:r.cost, prizes:r.prizes.map(safePrize),
    odds:Object.fromEntries(r.prizes.map(p => [p.name, p.weight]))
  }));
  res.json({ roulettes: rouletteList, ...rouletteList[0], notice: "Только виртуальные предметы и баллы. Вероятности указаны открыто." });
});

app.post("/api/spin", auth, requireSubscription, (req,res) => {
  try {
    const { request_id, roulette_id = "classic" } = req.body || {};
    if (!requireBodyString(request_id)) return res.status(400).json({ error: "Некорректный request_id" });
    if (typeof roulette_id !== "string" || !ROULETTES[roulette_id]) return res.status(400).json({ error: "Неизвестная рулетка" });
    const roulette = ROULETTES[roulette_id];
    const perform = db.transaction(() => {
      createUser.run(req.user.id, req.user.first_name, req.user.username);
      const existing = db.prepare("SELECT roulette_id, prize_id FROM spins WHERE telegram_id=? AND request_id=?").get(req.user.id, request_id);
      if (existing) {
        const originalRoulette = ROULETTES[existing.roulette_id];
        const prize = originalRoulette?.prizes.find(p => p.id === existing.prize_id);
        if (!prize) throw new Error("Не удалось восстановить результат предыдущего запроса");
        return { prize, balance: getUser.get(req.user.id).balance, replayed: true };
      }
      const user = getUser.get(req.user.id);
      if (user.balance < roulette.cost) throw Object.assign(new Error("Недостаточно MST"), { status:400 });
      const prize = weightedPrize(roulette.prizes);
      db.prepare("UPDATE users SET balance=balance-?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(roulette.cost,req.user.id);
      db.prepare("INSERT INTO inventory(telegram_id,prize_id,prize_name,emoji,rarity,source) VALUES(?,?,?,?,?,'roulette')").run(req.user.id,prize.id,prize.name,prize.emoji,prize.rarity);
      SPIN_STMT.run(req.user.id,request_id,roulette.id,prize.id,roulette.cost);
      return { prize, balance: getUser.get(req.user.id).balance, replayed: false };
    }).immediate();
    res.json({ prize:safePrize(perform.prize), balance:perform.balance, replayed:perform.replayed });
  } catch(err) { apiError(res,err); }
});

app.get("/api/inventory", auth, (req,res) => {
  const rows = db.prepare("SELECT prize_id, prize_name, emoji, rarity, source, created_at FROM inventory WHERE telegram_id=? ORDER BY id DESC LIMIT 100").all(req.user.id);
  res.json({ items: rows });
});

app.get("/api/history", auth, requireSubscription, (req,res) => {
  const spins = db.prepare("SELECT roulette_id, prize_id, cost, created_at FROM spins WHERE telegram_id=? ORDER BY id DESC LIMIT 50").all(req.user.id);
  const mines = db.prepare("SELECT id, bet, status, multiplier, payout, created_at, finished_at FROM mines_games WHERE telegram_id=? ORDER BY created_at DESC LIMIT 50").all(req.user.id);
  res.json({ spins, mines });
});

app.post("/api/mines/start", auth, requireSubscription, (req,res) => {
  try {
    const bet = Number(req.body?.bet);
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > 10000) return res.status(400).json({ error:"Ставка должна быть от 1 до 10000 MST" });
    const id = crypto.randomUUID();
    const bombs = new Set();
    while (bombs.size < 4) bombs.add(crypto.randomInt(0,25));
    const run = db.transaction(() => {
      createUser.run(req.user.id,req.user.first_name,req.user.username);
      const user = getUser.get(req.user.id);
      if (user.balance < bet) throw Object.assign(new Error("Недостаточно MST"), { status:400 });
      db.prepare("UPDATE users SET balance=balance-? WHERE telegram_id=?").run(bet,req.user.id);
      db.prepare("INSERT INTO mines_games(id,telegram_id,bet,bombs_json,revealed_json) VALUES(?,?,?,?,?)").run(id,req.user.id,bet,JSON.stringify([...bombs]),"[]");
      return getUser.get(req.user.id).balance;
    });
    const balance = run.immediate();
    res.json({ game_id:id, bet, bombs_count:4, balance, grid_size:25 });
  } catch(err) { apiError(res,err); }
});

app.post("/api/mines/reveal", auth, requireSubscription, (req,res) => {
  try {
    const { game_id, cell } = req.body || {};
    if (typeof game_id !== "string" || game_id.length > 64 || !Number.isInteger(cell) || cell < 0 || cell > 24) return res.status(400).json({ error:"Некорректная клетка" });
    const result = db.transaction(() => {
      const row = db.prepare("SELECT * FROM mines_games WHERE id=? AND telegram_id=?").get(game_id,req.user.id);
      if (!row || row.status !== "active") throw Object.assign(new Error("Активная игра не найдена"), { status:404 });
      const bombs = JSON.parse(row.bombs_json);
      const revealed = JSON.parse(row.revealed_json);
      if (revealed.includes(cell)) throw Object.assign(new Error("Эта клетка уже открыта"), { status:409 });
      if (bombs.includes(cell)) {
        const next = [...revealed,cell];
        db.prepare("UPDATE mines_games SET revealed_json=?, status='lost', multiplier=0, payout=0, finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(JSON.stringify(next),game_id);
        return { hit:true, cell, bombs, revealed:next, multiplier:0, payout:0 };
      }
      const next = [...revealed,cell];
      let safeProbability = 1;
      for (let i=0;i<next.length;i++) safeProbability *= (21-i)/(25-i);
      const multiplier = Number((0.96 / safeProbability).toFixed(4));
      db.prepare("UPDATE mines_games SET revealed_json=?, multiplier=? WHERE id=? AND status='active'").run(JSON.stringify(next),multiplier,game_id);
      return { hit:false, cell, revealed:next, multiplier, safe_count:next.length };
    }).immediate();
    res.json(result);
  } catch(err) { apiError(res,err); }
});

app.post("/api/mines/cashout", auth, requireSubscription, (req,res) => {
  try {
    const { game_id } = req.body || {};
    if (typeof game_id !== "string") return res.status(400).json({ error:"Некорректная игра" });
    const run = db.transaction(() => {
      const row = db.prepare("SELECT * FROM mines_games WHERE id=? AND telegram_id=?").get(game_id,req.user.id);
      if (!row || row.status !== "active") throw Object.assign(new Error("Активная игра не найдена"), { status:400 });
      const revealed = JSON.parse(row.revealed_json);
      if (!revealed.length) throw Object.assign(new Error("Сначала открой хотя бы одну клетку"), { status:400 });
      const multiplier = Number(row.multiplier);
      const payout = Math.floor(row.bet * multiplier);
      db.prepare("UPDATE mines_games SET status='cashed_out', payout=?, finished_at=CURRENT_TIMESTAMP WHERE id=?").run(payout,game_id);
      db.prepare("UPDATE users SET balance=balance+? WHERE telegram_id=?").run(payout,req.user.id);
      return { payout, multiplier, balance:getUser.get(req.user.id).balance };
    });
    res.json(run.immediate());
  } catch(err) { apiError(res,err); }
});

app.get("/api/admin/summary", auth, (req,res) => {
  if (!ADMIN_IDS.has(req.user.id)) return res.status(403).json({ error:"Нет доступа" });
  res.json({
    users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    spins: db.prepare("SELECT COUNT(*) AS n FROM spins").get().n,
    inventory: db.prepare("SELECT COUNT(*) AS n FROM inventory").get().n,
    active_mines: db.prepare("SELECT COUNT(*) AS n FROM mines_games WHERE status='active'").get().n
  });
});

app.use("/static", express.static(path.join(ROOT,"frontend"), { etag:true, maxAge:"1h" }));
app.get("/", (req,res) => res.sendFile(path.join(ROOT,"frontend","index.html")));

// Telegram bot webhook: /start opens the Mini App.
const PUBLIC_URL = process.env.PUBLIC_URL || "https://mystic-nft-drop.onrender.com";
const WEBHOOK_SECRET = BOT_TOKEN ? crypto.createHash("sha256").update("mystic-webhook:" + BOT_TOKEN).digest("hex") : "";
async function telegramApi(method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + " failed: " + (data.description || response.status));
  return data.result;
}
app.post("/telegram/webhook", async (req, res) => {
  if (!WEBHOOK_SECRET || req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const message = req.body?.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text || "").trim();
  if (!chatId || !/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return;
  try {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "Добро пожаловать в MYSTIC NFT DROP! Нажми кнопку ниже, чтобы открыть приложение.",
      reply_markup: {
        inline_keyboard: [[{ text: "✦ Открыть MYSTIC DROP", web_app: { url: PUBLIC_URL } }]]
      }
    });
  } catch (err) {
    console.error("Telegram /start reply failed:", err.message);
  }
});
async function configureTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn("BOT_TOKEN is missing; Telegram /start webhook is disabled.");
    return;
  }
  try {
    await telegramApi("setWebhook", {
      url: PUBLIC_URL + "/telegram/webhook",
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Открыть Mystic Drop",
        web_app: { url: PUBLIC_URL }
      }
    });
    console.log("Telegram webhook and Mini App menu button configured.");
  } catch (err) {
    console.error("Telegram bot configuration failed:", err.message);
  }
}

app.use((req,res) => res.status(404).json({ error:"Not found" }));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({ error:"Внутренняя ошибка сервера" }); });

app.listen(PORT, () => { console.log("Mystic NFT Drop listening on " + PORT); configureTelegramBot(); });
