import hashlib
import hmac
import json
import os
import random
import time
from pathlib import Path
from urllib.parse import parse_qsl

import aiosqlite
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()
ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DB_PATH = os.getenv("DB_PATH", str(ROOT / "mystic.sqlite3"))
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
app = FastAPI(title="Mystic NFT Drop", version="0.1.0")
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

PRIZES = [
    {"id": "moon", "name": "Moon", "emoji": "🌙", "rarity": "Обычный", "weight": 48},
    {"id": "star", "name": "Star", "emoji": "⭐", "rarity": "Обычный", "weight": 30},
    {"id": "crystal", "name": "Crystal", "emoji": "💎", "rarity": "Редкий", "weight": 15},
    {"id": "crown", "name": "Crown", "emoji": "👑", "rarity": "Эпический", "weight": 6},
    {"id": "dragon", "name": "Mystic Dragon", "emoji": "🐉", "rarity": "Легендарный", "weight": 1},
]
SPIN_COST = 100


class SpinRequest(BaseModel):
    request_id: str = Field(min_length=8, max_length=80)


def validate_init_data(init_data: str) -> dict:
    if not BOT_TOKEN:
        raise HTTPException(503, "Telegram bot token is not configured")
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = pairs.pop("hash")
        auth_date = int(pairs.get("auth_date", "0"))
        if time.time() - auth_date > 86400 or auth_date > time.time() + 60:
            raise ValueError("Expired initData")
        check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated, received_hash):
            raise ValueError("Invalid signature")
        user = json.loads(pairs["user"])
        return {"id": int(user["id"]), "first_name": user.get("first_name", "Игрок"),
                "username": user.get("username", "")}
    except Exception:
        raise HTTPException(401, "Telegram authorization failed")


async def current_user(authorization: str | None) -> dict:
    if DEV_MODE:
        return {"id": 1, "first_name": "Игрок", "username": "demo"}
    if not authorization or not authorization.startswith("tma "):
        raise HTTPException(401, "Open this app through Telegram")
    return validate_init_data(authorization[4:])


async def db_connect():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


@app.on_event("startup")
async def startup():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY, first_name TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL DEFAULT 1000,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        await db.execute("""CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL,
            prize_id TEXT NOT NULL, prize_name TEXT NOT NULL, emoji TEXT NOT NULL,
            rarity TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        await db.execute("""CREATE TABLE IF NOT EXISTS spins (
            id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL,
            request_id TEXT NOT NULL, prize_id TEXT NOT NULL, cost INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(telegram_id, request_id))""")
        await db.commit()


@app.get("/")
async def home():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/health")
async def health():
    return {"ok": True, "app": "Mystic NFT Drop"}


@app.get("/api/me")
async def me(authorization: str | None = Header(default=None)):
    user = await current_user(authorization)
    async with await db_connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO users(telegram_id, first_name, username) VALUES(?,?,?)",
            (user["id"], user["first_name"], user["username"]))
        await db.execute("UPDATE users SET first_name=?, username=? WHERE telegram_id=?",
                         (user["first_name"], user["username"], user["id"]))
        await db.commit()
        row = await (await db.execute("SELECT * FROM users WHERE telegram_id=?", (user["id"],))).fetchone()
        items = await (await db.execute(
            "SELECT COUNT(*) AS total FROM inventory WHERE telegram_id=?", (user["id"],))).fetchone()
        spins = await (await db.execute(
            "SELECT COUNT(*) AS total FROM spins WHERE telegram_id=?", (user["id"],))).fetchone()
    return {"id": user["id"], "name": row["first_name"], "username": row["username"],
            "balance": row["balance"], "inventory_count": items["total"], "spin_count": spins["total"]}


@app.get("/api/roulette")
async def roulette():
    return {"cost": SPIN_COST, "prizes": [
        {k: v for k, v in p.items() if k != "weight"} for p in PRIZES
    ], "odds": {p["name"]: p["weight"] for p in PRIZES},
       "notice": "Все предметы и монеты виртуальные."}


@app.post("/api/spin")
async def spin(payload: SpinRequest, authorization: str | None = Header(default=None)):
    user = await current_user(authorization)
    async with await db_connect() as db:
        await db.execute("BEGIN IMMEDIATE")
        previous = await (await db.execute(
            "SELECT prize_id FROM spins WHERE telegram_id=? AND request_id=?",
            (user["id"], payload.request_id))).fetchone()
        if previous:
            await db.rollback()
            prize = next(p for p in PRIZES if p["id"] == previous["prize_id"])
            balance = await (await db.execute(
                "SELECT balance FROM users WHERE telegram_id=?", (user["id"],))).fetchone()
            return {"prize": {k: v for k, v in prize.items() if k != "weight"},
                    "balance": balance["balance"], "replayed": True}
        await db.execute(
            "INSERT OR IGNORE INTO users(telegram_id, first_name, username) VALUES(?,?,?)",
            (user["id"], user["first_name"], user["username"]))
        row = await (await db.execute(
            "SELECT balance FROM users WHERE telegram_id=?", (user["id"],))).fetchone()
        if row["balance"] < SPIN_COST:
            await db.rollback()
            raise HTTPException(400, "Недостаточно монет")
        prize = random.choices(PRIZES, weights=[p["weight"] for p in PRIZES], k=1)[0]
        await db.execute("UPDATE users SET balance=balance-? WHERE telegram_id=?",
                         (SPIN_COST, user["id"]))
        await db.execute(
            "INSERT INTO inventory(telegram_id, prize_id, prize_name, emoji, rarity) VALUES(?,?,?,?,?)",
            (user["id"], prize["id"], prize["name"], prize["emoji"], prize["rarity"]))
        await db.execute(
            "INSERT INTO spins(telegram_id, request_id, prize_id, cost) VALUES(?,?,?,?)",
            (user["id"], payload.request_id, prize["id"], SPIN_COST))
        await db.commit()
        balance = await (await db.execute(
            "SELECT balance FROM users WHERE telegram_id=?", (user["id"],))).fetchone()
    return {"prize": {k: v for k, v in prize.items() if k != "weight"},
            "balance": balance["balance"], "replayed": False}


@app.get("/api/inventory")
async def inventory(authorization: str | None = Header(default=None)):
    user = await current_user(authorization)
    async with await db_connect() as db:
        rows = await (await db.execute(
            "SELECT prize_id, prize_name, emoji, rarity, created_at FROM inventory "
            "WHERE telegram_id=? ORDER BY id DESC LIMIT 50", (user["id"],))).fetchall()
    return {"items": [dict(r) for r in rows]}
