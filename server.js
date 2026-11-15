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
function rateLimit({ windowMs = 60_000, max = 300, message = "Слишком много запросов. Попробуй позже." } = {}) {
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
const CHANNEL = process.env.REQUIRED_CHANNEL || "@MysticNftDrop";
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
CREATE TABLE IF NOT EXISTS admin_balance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_telegram_id TEXT NOT NULL,
  target_telegram_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount INTEGER NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(telegram_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_mines_user ON mines_games(telegram_id, status);
`);

const MST_PER_STAR = 2; // Informational reference rate only; MST is not Telegram Stars.
const parsedMinesRtp = Number(process.env.MINES_RTP ?? 0.96);
const MINES_RTP = Number.isFinite(parsedMinesRtp) ? Math.min(0.99, Math.max(0.5, parsedMinesRtp)) : 0.96;
const parsedMinesMaxBet = Number(process.env.MINES_MAX_BET ?? 10000);
const MINES_MAX_BET = Number.isSafeInteger(parsedMinesMaxBet) ? Math.min(1000000, Math.max(1, parsedMinesMaxBet)) : 10000;
const parsedMinesMaxPayout = Number(process.env.MINES_MAX_PAYOUT ?? 1000000);
const MINES_MAX_PAYOUT = Number.isSafeInteger(parsedMinesMaxPayout) ? Math.min(1000000000, Math.max(1, parsedMinesMaxPayout)) : 1000000;
const ROULETTE_MODES = {
  classic: { id: "classic", title: "Mini Case", cost: 100, exponent: 2.1 },
  premium: { id: "premium", title: "Mystic Case", cost: 250, exponent: 1.25 },
  legendary: { id: "legendary", title: "NFT Case", cost: 500, exponent: 0.72 }
};
let ROULETTES = {};
let giftsCache = { at: 0, gifts: [] };
const giftArtCache = new Map();

async function getAvailableTelegramGifts() {
  if (!BOT_TOKEN) throw Object.assign(new Error("На сервере не настроен BOT_TOKEN"), { status: 503 });
  if (giftsCache.gifts.length && Date.now() - giftsCache.at < 60_000) return giftsCache.gifts;
  const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/getAvailableGifts");
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    console.error("Telegram getAvailableGifts failed:", data.description || response.status);
    throw Object.assign(new Error("Telegram не вернул список подарков. Проверь BOT_TOKEN и доступность Bot API."), { status: 502 });
  }
  const gifts = (data.result?.gifts || []).filter(g => g && g.id && g.sticker);
  if (!gifts.length) throw Object.assign(new Error("Сейчас Telegram не вернул доступные подарки для бота."), { status: 503 });
  giftsCache = { at: Date.now(), gifts };
  return gifts;
}

app.get("/api/gift-art/:giftId", async (req,res) => {
  try {
    const giftId = String(req.params.giftId || "").slice(0, 128);
    const cached = giftArtCache.get(giftId);
    if (cached && Date.now() - cached.at < 3_600_000) {
      res.set("Cache-Control", "public, max-age=3600").type(cached.type).send(cached.bytes);
      return;
    }
    const gifts = await getAvailableTelegramGifts();
    const gift = gifts.find(item => String(item.id) === giftId);
    if (!gift) return res.sendStatus(404);
    const fileId = gift.sticker?.thumbnail?.file_id || gift.sticker?.file_id;
    if (!fileId) return res.sendStatus(404);
    const file = await telegramApi("getFile", { file_id: fileId });
    const filePath = String(file.file_path || "");
    const ext = filePath.split(".").pop().toLowerCase();
    const type = ({ webp:"image/webp", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg" })[ext];
    if (!type) return res.sendStatus(415);
    const imageResponse = await fetch("https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + filePath);
    if (!imageResponse.ok) return res.sendStatus(404);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length > 2_000_000) return res.sendStatus(413);
    giftArtCache.set(giftId, { at: Date.now(), type, bytes });
    res.set("Cache-Control", "public, max-age=3600").type(type).send(bytes);
  } catch (err) {
    console.warn("Telegram gift artwork unavailable:", err.message);
    res.sendStatus(404);
  }
});

function buildRoulettes(gifts) {
  const sorted = [...gifts].sort((a,b) => Number(a.star_count || 0) - Number(b.star_count || 0));
  const count = sorted.length;
  const take = (fraction) => sorted.slice(0, Math.max(1, Math.ceil(count * fraction)));
  const limited = sorted.filter(g => Number.isFinite(g.limited_count) && g.limited_count > 0);
  const limitedSorted = [...limited].sort((a,b) => Number(a.star_count || 0) - Number(b.star_count || 0));

  const premiumPool = take(0.72);

  // The 500 MST / ≈250 Stars NFT case uses collectible limited gifts.
  // Its two cheapest NFT entries are deliberately assigned very low weights;
  // the remaining, more expensive collectibles form the rare prize pool.
  const nftPool = limitedSorted.length >= 3
    ? limitedSorted
    : sorted.slice(Math.max(0, Math.floor(count * 0.55)));
  const cheapNftIds = new Set(nftPool.slice(0, 2).map(g => String(g.id)));

  const pools = {
    classic: take(0.4),
    premium: premiumPool,
    legendary: nftPool.length ? nftPool : sorted.slice(-1)
  };
  const result = {};
  for (const mode of Object.values(ROULETTE_MODES)) {
    const pool = pools[mode.id] || sorted;
    const prizes = pool.map((gift, index) => {
      const emoji = gift.sticker?.emoji || "🎁";
      const stars = Number(gift.star_count || 0);
      const percentile = pool.length <= 1 ? 0 : index / (pool.length - 1);
      let rarity = percentile >= .9 ? "Легендарный" : percentile >= .7 ? "Эпический" : percentile >= .4 ? "Редкий" : "Обычный";
      let weight = Math.max(1, Math.round(10000 / Math.pow(index + 1, mode.exponent)));

      if (mode.id === "legendary") {
        const isCheapNft = cheapNftIds.has(String(gift.id));
        const isLimitedGift = Number.isFinite(gift.limited_count) && gift.limited_count > 0;
        rarity = isLimitedGift
          ? (isCheapNft ? "Редкий NFT" : "Легендарный NFT")
          : (isCheapNft ? "Редкий подарок" : "Легендарный подарок");
        // The two cheapest NFT prizes have reduced odds. Higher-value items
        // receive the main share of the NFT case's draw weight.
        weight = isCheapNft ? 1 : Math.max(4, Math.round(90 / Math.pow(Math.max(1, index - 1), 1.15)));
      }

      return {
        id: String(gift.id),
        gift_id: String(gift.id),
        name: emoji + " Telegram Gift",
        emoji,
        rarity,
        star_count: stars,
        limited: Number.isFinite(gift.remaining_count) ? gift.remaining_count : null,
        weight
      };
    });
    result[mode.id] = { id: mode.id, title: mode.title, cost: mode.cost, prizes };
  }
  ROULETTES = result;
  return result;
}
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
  if (!response.ok || !data.ok) {
    console.error("Telegram getChatMember failed:", data.description || response.status);
    throw Object.assign(new Error("Telegram не дал проверить подписку. Добавь бота администратором канала @MysticNftDrop и попробуй снова."), { status: 502 });
  }
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
    { id:"subscribe", title:"Подписаться на канал", description:"Подпишись на @MysticNftDrop и забери награду один раз.", reward:10, claimed:has("subscribe","once"), repeat:"once" },
    { id:"daily", title:"Ежедневный вход", description:"Заходи в Mystic Drop каждый день.", reward:5, claimed:has("daily",today), repeat:"daily" }
  ]});
});
app.post("/api/tasks/claim", auth, async (req,res) => {
  try {
    const taskId = req.body?.task_id;
    if (!["subscribe","daily"].includes(taskId)) return res.status(400).json({error:"Неизвестное задание"});
    if (taskId === "subscribe") {
      const membership = await telegramMember(req.user.id, isLocalDev(req));
      if (!membership.subscribed) return res.status(403).json({error:"Сначала подпишись на @MysticNftDrop, затем нажми «Проверить»."});
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

app.get("/api/roulette", auth, async (req,res) => {
  try {
    const gifts = await getAvailableTelegramGifts();
    const liveRoulettes = buildRoulettes(gifts);
    const rouletteList = Object.values(liveRoulettes).map(r => ({
      id:r.id, title:r.title, cost:r.cost,
      prizes:r.prizes.map(p => safePrize(p))
    }));
    res.json({
      roulettes: rouletteList,
      ...rouletteList[0],
      gift_count: gifts.length,
      mst_per_star: MST_PER_STAR,
      notice: "Каталог загружается из Telegram Bot API. Выигрыш пока сохраняется в виртуальном инвентаре приложения."
    });
  } catch(err) { apiError(res,err); }
});

app.post("/api/spin", auth, requireSubscription, async (req,res) => {
  try {
    const { request_id, roulette_id = "classic" } = req.body || {};
    if (!requireBodyString(request_id)) return res.status(400).json({ error: "Некорректный request_id" });
    if (typeof roulette_id !== "string" || !ROULETTE_MODES[roulette_id]) return res.status(400).json({ error: "Неизвестная рулетка" });
    const gifts = await getAvailableTelegramGifts();
    const roulette = buildRoulettes(gifts)[roulette_id];
    const perform = db.transaction(() => {
      createUser.run(req.user.id, req.user.first_name, req.user.username);
      const existing = db.prepare("SELECT roulette_id, prize_id FROM spins WHERE telegram_id=? AND request_id=?").get(req.user.id, request_id);
      if (existing) {
        const owned = db.prepare("SELECT prize_id, prize_name, emoji, rarity FROM inventory WHERE telegram_id=? AND prize_id=? AND source='roulette' ORDER BY id DESC LIMIT 1").get(req.user.id, existing.prize_id);
        if (!owned) throw new Error("Не удалось восстановить результат предыдущего запроса");
        const prize = { id:owned.prize_id, gift_id:owned.prize_id, name:owned.prize_name, emoji:owned.emoji, rarity:owned.rarity };
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

app.get("/api/mines/active", auth, requireSubscription, (req,res) => {
  const row = db.prepare("SELECT id, bet, revealed_json, multiplier FROM mines_games WHERE telegram_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(req.user.id);
  if (!row) return res.json({ active:false, min_bet:1, max_bet:MINES_MAX_BET, max_payout:MINES_MAX_PAYOUT });
  res.json({
    active:true,
    game_id:row.id,
    bet:row.bet,
    revealed:JSON.parse(row.revealed_json),
    multiplier:Number(row.multiplier),
    bombs_count:4,
    grid_size:25,
    min_bet:1,
    max_bet:MINES_MAX_BET,
    max_payout:MINES_MAX_PAYOUT
  });
});

app.post("/api/mines/start", auth, requireSubscription, (req,res) => {
  try {
    const bet = Number(req.body?.bet);
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > MINES_MAX_BET) return res.status(400).json({ error:"Ставка должна быть от 1 до " + MINES_MAX_BET + " MST" });
    const id = crypto.randomUUID();
    const bombs = new Set();
    while (bombs.size < 4) bombs.add(crypto.randomInt(0,25));
    const run = db.transaction(() => {
      createUser.run(req.user.id,req.user.first_name,req.user.username);
      const active = db.prepare("SELECT id FROM mines_games WHERE telegram_id=? AND status='active' LIMIT 1").get(req.user.id);
      if (active) throw Object.assign(new Error("У тебя уже есть активная игра. Продолжи её или забери выигрыш."), { status:409 });
      const user = getUser.get(req.user.id);
      if (user.balance < bet) throw Object.assign(new Error("Недостаточно MST"), { status:400 });
      db.prepare("UPDATE users SET balance=balance-? WHERE telegram_id=?").run(bet,req.user.id);
      db.prepare("INSERT INTO mines_games(id,telegram_id,bet,bombs_json,revealed_json) VALUES(?,?,?,?,?)").run(id,req.user.id,bet,JSON.stringify([...bombs]),"[]");
      return getUser.get(req.user.id).balance;
    });
    const balance = run.immediate();
    res.json({ game_id:id, bet, bombs_count:4, balance, grid_size:25, min_bet:1, max_bet:MINES_MAX_BET, max_payout:MINES_MAX_PAYOUT });
  } catch(err) { apiError(res,err); }
});

app.post("/api/mines/reveal", auth, requireSubscription, (req,res) => {
  try {
    const { game_id, cell } = req.body || {};
    if (typeof game_id !== "string" || game_id.length > 64 || !Number.isInteger(cell) || cell < 0 || cell > 24) return res.status(400).json({ error:"Некорректная клетка" });
    const result = db.transaction(() => {
      const row = db.prepare("SELECT * FROM mines_games WHERE id=? AND telegram_id=?").get(game_id,req.user.id);
      if (!row || row.status !== "active") throw Object.assign(new Error("Активная игра не найдена"), { status:404 });
      let bombs = JSON.parse(row.bombs_json);
      const revealed = JSON.parse(row.revealed_json);
      if (revealed.includes(cell)) throw Object.assign(new Error("Эта клетка уже открыта"), { status:409 });

      // The first pick is protected so a new player can actually start the round.
      // If it lands on a bomb, move that bomb to a random untouched safe position.
      if (revealed.length === 0 && bombs.includes(cell)) {
        const candidates = Array.from({length:25},(_,i)=>i).filter(i => i !== cell && !bombs.includes(i));
        const replacement = candidates[crypto.randomInt(0,candidates.length)];
        bombs = bombs.filter(i => i !== cell).concat(replacement);
        db.prepare("UPDATE mines_games SET bombs_json=? WHERE id=? AND status='active'").run(JSON.stringify(bombs),game_id);
      }

      if (bombs.includes(cell)) {
        const next = [...revealed,cell];
        db.prepare("UPDATE mines_games SET revealed_json=?, status='lost', multiplier=0, payout=0, finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").run(JSON.stringify(next),game_id);
        return { hit:true, cell, bombs, revealed:next, multiplier:0, payout:0 };
      }
      const next = [...revealed,cell];
      let safeProbability = 1;
      for (let i=0;i<next.length-1;i++) safeProbability *= (20-i)/(24-i);
      const multiplier = next.length === 1 ? 1 : Number((MINES_RTP / safeProbability).toFixed(4));
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
      const payout = Math.min(MINES_MAX_PAYOUT, Math.floor(row.bet * multiplier));
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
  const senderId = message?.from?.id ? String(message.from.id) : "";
  const text = String(message?.text || "").trim();
  if (!chatId || !text) return;

  const reply = (body) => telegramApi("sendMessage", { chat_id: chatId, text: body });
  const giveMatch = text.match(/^\/give(?:@\w+)?\\s+(\\d{1,20})\\s+(\\d{1,9})$/i);
  const balanceMatch = text.match(/^\/balance(?:@\w+)?\\s+(\\d{1,20})$/i);

  try {
    if (/^\/start(?:@\\w+)?(?:\\s|$)/i.test(text)) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "Добро пожаловать в MYSTIC NFT DROP! Нажми кнопку ниже, чтобы открыть приложение.",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✦ Открыть MYSTIC DROP", web_app: { url: PUBLIC_URL } }]
          ]
        }
      });
      return;
    }

    if (giveMatch) {
      if (!ADMIN_IDS.has(senderId)) {
        await reply("⛔ Команда доступна только администратору.");
        return;
      }
      const targetId = giveMatch[1];
      const amount = Number(giveMatch[2]);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
        await reply("Укажи сумму от 1 до 1 000 000 MST.");
        return;
      }
      const run = db.transaction(() => {
        createUser.run(targetId, "Игрок", "");
        db.prepare("UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(amount, targetId);
        db.prepare("INSERT INTO admin_balance_logs(admin_telegram_id,target_telegram_id,amount) VALUES(?,?,?)").run(senderId,targetId,amount);
        return getUser.get(targetId).balance;
      });
      const newBalance = run.immediate();
      await reply("✅ Начислено " + amount.toLocaleString("ru-RU") + " MST пользователю " + targetId + ". Новый баланс: " + newBalance.toLocaleString("ru-RU") + " MST.");
      return;
    }

    if (balanceMatch) {
      if (!ADMIN_IDS.has(senderId)) {
        await reply("⛔ Команда доступна только администратору.");
        return;
      }
      const targetId = balanceMatch[1];
      const user = getUser.get(targetId);
      await reply(user
        ? "Баланс пользователя " + targetId + ": " + user.balance.toLocaleString("ru-RU") + " MST."
        : "Пользователь " + targetId + " ещё не зарегистрирован.");
      return;
    }
  } catch (err) {
    console.error("Telegram command failed:", err.message);
    try { await reply("Не удалось выполнить команду. Проверь данные и попробуй ещё раз."); } catch {}
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
