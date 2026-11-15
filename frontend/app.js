const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const authHeader = tg?.initData ? "tma " + tg.initData : "";
const $ = id => document.getElementById(id);

let tasks = [];
let items = [];
let roulettes = [];
let activeMode = "classic";
let spinning = false;
let mstPerStar = 2;
let mineGame = null;
let mineBusy = false;
let mineFinishedMessage = "";

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Ошибка запроса");
    error.status = response.status;
    throw error;
  }
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function giftUrl(id) {
  return "/api/gift-art/" + encodeURIComponent(id);
}

function art(id, emoji = "🎁") {
  const src = giftUrl(id);
  return '<img src="' + src + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.hidden=false"><span class="gift-emoji" hidden aria-hidden="true">' + esc(emoji) + "</span>";
}

function starEquivalent(mst) {
  const value = Number(mst || 0) / mstPerStar;
  return Number.isInteger(value) ? String(value) : value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function costLabel(mst) {
  return Number(mst).toLocaleString("ru-RU") + " MST · ≈" + starEquivalent(mst) + "⭐";
}

function setBalance(value) {
  const html = Number(value).toLocaleString("ru-RU") + " <small>MST</small>";
  $("balance").innerHTML = html;
  $("homeBalance").innerHTML = html;
  $("spinBalance").textContent = Number(value).toLocaleString("ru-RU") + " MST";
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2600);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("active", screen.id === id));
  document.querySelectorAll(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.screen === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderGifts() {
  const gifts = roulettes.find(item => item.id === "classic")?.prizes || [];
  $("giftGrid").innerHTML = gifts.map(prize =>
    '<article class="gift-card"><div class="gift-art tg-gift-art">' + art(prize.id, prize.emoji) +
    '</div><div class="gift-meta"><div><strong>' + esc(prize.name) + '</strong><small>' +
    esc(prize.rarity) + " · " + Number(prize.star_count || 0) + " ⭐</small></div><i class=\"rarity-dot " +
    (prize.rarity === "Легендарный" ? "legendary" : prize.rarity === "Эпический" ? "epic" : prize.rarity === "Редкий" ? "rare" : "") +
    '"></i></div></article>'
  ).join("");
}

function renderReel(prizes, winner = null) {
  const reel = $("reel");
  const tiles = Array.from({ length: 22 }, (_, index) =>
    index === 17 && winner ? winner : prizes[(index * 3 + Math.floor(index / 2)) % prizes.length]
  );
  reel.innerHTML = tiles.map(prize =>
    '<div class="prize-tile"><div class="tile-art">' + art(prize.id, prize.emoji) +
    "</div><small>" + esc(prize.name) + "</small></div>"
  ).join("");
  reel.style.transition = "none";
  reel.style.transform = "translateX(0)";
  void reel.offsetWidth;
  reel.style.transition = "transform 3.2s cubic-bezier(.12,.72,.08,1)";
  return tiles;
}

function selectMode(id) {
  activeMode = id;
  const roulette = roulettes.find(item => item.id === id);
  if (!roulette) return;
  document.querySelectorAll(".roulette-mode").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === id);
    const mode = roulettes.find(item => item.id === button.dataset.mode);
    if (mode) button.querySelector("small").textContent = costLabel(mode.cost);
  });
  $("rouletteTitle").textContent = roulette.title.toUpperCase();
  $("spinCost").textContent = costLabel(roulette.cost);
  $("spinButton").innerHTML = 'КРУТИТЬ <span>✦</span>';
  renderReel(roulette.prizes);
}

function renderTasks() {
  const available = tasks.filter(task => !task.claimed).length;
  $("taskCount").textContent = available + " из " + tasks.length + " доступны";
  $("taskList").innerHTML = tasks.map(task =>
    '<article class="task-card ' + (task.claimed ? "task-complete" : "") + '">' +
    '<div class="task-card-icon">' + (task.id === "subscribe" ? "◉" : "☼") + '</div>' +
    '<div class="task-card-copy"><strong>' + esc(task.title) + '</strong><p>' + esc(task.description) + "</p>" +
    (task.id === "subscribe" ? '<a class="task-channel-link" href="https://t.me/MysticNftDrop" target="_blank" rel="noopener">Открыть канал ↗</a>' : "") +
    '<span class="task-reward">＋' + task.reward + " MST · ≈" + starEquivalent(task.reward) + "⭐</span></div>" +
    '<button class="task-claim" data-task="' + task.id + '" ' + (task.claimed ? "disabled" : "") + ">" +
    (task.claimed ? "Получено" : task.id === "subscribe" ? "Проверить" : "Забрать") + "</button></article>"
  ).join("");
  document.querySelectorAll(".task-claim:not(:disabled)").forEach(button => {
    button.addEventListener("click", () => claimTask(button.dataset.task, button));
  });
}

async function claimTask(id, button) {
  button.disabled = true;
  button.textContent = "…";
  try {
    const result = await api("/api/tasks/claim", {
      method: "POST",
      body: JSON.stringify({ task_id: id })
    });
    setBalance(result.balance);
    await loadTasks();
    toast("Получено +" + result.reward + " MST");
  } catch (error) {
    button.disabled = false;
    button.textContent = id === "subscribe" ? "Проверить" : "Забрать";
    toast(error.message);
  }
}

async function loadTasks() {
  const result = await api("/api/tasks");
  tasks = result.tasks || [];
  renderTasks();
}

function renderInventory() {
  const html = items.length ? items.map(item =>
    '<div class="inventory-item"><div class="item-art tg-gift-art">' + art(item.prize_id, item.emoji) +
    '</div><div><strong>' + esc(item.prize_name) + '</strong><small>' + esc(item.rarity) + "</small></div></div>"
  ).join("") : '<div class="empty-state">Пока здесь пусто</div>';
  $("inventoryFull").innerHTML = html;
  $("homeInventory").innerHTML = items.slice(0, 3).map(item =>
    '<div class="inventory-item"><div class="item-art tg-gift-art">' + art(item.prize_id, item.emoji) +
    '</div><div><strong>' + esc(item.prize_name) + '</strong><small>' + esc(item.rarity) + "</small></div></div>"
  ).join("") || '<div class="empty-state">Пока нет выигрышей</div>';
  $("itemCount").textContent = items.length + " подарков";
  $("profileItemCount").textContent = items.length;
}

async function spin() {
  if (spinning) return;
  const roulette = roulettes.find(item => item.id === activeMode);
  if (!roulette) return;
  spinning = true;
  $("spinButton").disabled = true;
  $("spinButton").textContent = "РУЛЕТКА КРУТИТСЯ…";
  try {
    const result = await api("/api/spin", {
      method: "POST",
      body: JSON.stringify({ request_id: crypto.randomUUID(), roulette_id: activeMode })
    });
    renderReel(roulette.prizes, result.prize);
    const reel = $("reel");
    const target = Math.max(0, 17 * 90 + 41 - $("reel").parentElement.clientWidth / 2);
    requestAnimationFrame(() => { reel.style.transform = "translateX(-" + target + "px)"; });
    setTimeout(() => showResult(result.prize), 3300);
    setBalance(result.balance);
    const inventory = await api("/api/inventory");
    items = inventory.items || [];
    renderInventory();
  } catch (error) {
    toast(error.message);
    spinning = false;
    $("spinButton").disabled = false;
    $("spinButton").innerHTML = 'КРУТИТЬ <span>✦</span>';
  }
}

function showResult(prize) {
  $("resultArt").innerHTML = art(prize.id, prize.emoji);
  $("resultName").textContent = prize.name;
  $("resultRarity").textContent = prize.rarity;
  $("resultModal").classList.remove("hidden");
  spinning = false;
  $("spinButton").disabled = false;
  $("spinButton").innerHTML = 'КРУТИТЬ <span>✦</span>';
}

function renderMines() {
  const revealed = new Set(mineGame?.revealed || []);
  const bombs = new Set(mineGame?.bombs || []);
  const lost = mineGame?.status === "lost";
  const cells = Array.from({ length: 25 }, (_, index) => {
    const isOpen = revealed.has(index);
    const isBomb = bombs.has(index);
    const safe = isOpen && !isBomb;
    const hit = isOpen && isBomb;
    const showBomb = lost && isBomb;
    const classes = ["mine-cell", safe ? "mine-safe" : "", hit || showBomb ? "mine-bomb" : ""].filter(Boolean).join(" ");
    const symbol = showBomb ? "✹" : hit ? "💣" : safe ? "✦" : "◆";
    const disabled = mineBusy || !mineGame || mineGame.status !== "active" || isOpen || showBomb;
    return '<button class="' + classes + '" data-cell="' + index + '" ' + (disabled ? "disabled" : "") +
      ' aria-label="Клетка ' + (index + 1) + '">' + symbol + "</button>";
  }).join("");
  $("mineGrid").innerHTML = cells;
  $("mineGrid").querySelectorAll(".mine-cell:not(:disabled)").forEach(button => {
    button.addEventListener("click", () => revealMine(Number(button.dataset.cell)));
  });

  const active = mineGame && mineGame.status === "active";
  $("mineMultiplier").textContent = active ? "×" + Number(mineGame.multiplier || 1).toFixed(2) : "×1.00";
  $("mineBetLabel").textContent = mineGame ? Number(mineGame.bet).toLocaleString("ru-RU") + " MST" : "Ставка не сделана";
  $("mineCashout").disabled = !active || !(mineGame.revealed || []).length || mineBusy;
  $("mineStart").disabled = mineBusy || !!active;
  $("mineStart").textContent = active ? "ИГРА ИДЁТ" : "НАЧАТЬ ИГРУ";
  if (active) {
    $("mineStatus").textContent = (mineGame.revealed || []).length
      ? "Безопасно! Продолжай открывать клетки или забери выигрыш."
      : "Первый ход безопасен. Выбери любую клетку.";
  } else {
    $("mineStatus").textContent = mineFinishedMessage || "Выбери ставку и начни игру. Первый ход безопасен.";
  }
}

async function restoreMines() {
  try {
    const result = await api("/api/mines/active");
    if (result.active) {
      mineGame = {
        game_id: result.game_id,
        bet: result.bet,
        revealed: result.revealed || [],
        multiplier: result.multiplier || 1,
        bombs: [],
        status: "active"
      };
      mineFinishedMessage = "Найден незавершённый раунд — продолжай игру.";
    }
  } catch (error) {
    if (error.status !== 403) $("mineStatus").textContent = error.message;
  }
  renderMines();
}

async function startMines() {
  if (mineBusy || mineGame?.status === "active") return;
  const bet = Number($("mineBet").value);
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > 10000) {
    toast("Ставка должна быть от 1 до 10000 MST");
    return;
  }
  mineBusy = true;
  renderMines();
  try {
    const result = await api("/api/mines/start", {
      method: "POST",
      body: JSON.stringify({ bet })
    });
    setBalance(result.balance);
    mineGame = {
      game_id: result.game_id,
      bet: result.bet,
      revealed: [],
      multiplier: 1,
      bombs: [],
      status: "active"
    };
    mineFinishedMessage = "";
    toast("Игра началась. Первый ход безопасен!");
  } catch (error) {
    toast(error.message);
    if (error.status === 409) await restoreMines();
  } finally {
    mineBusy = false;
    renderMines();
  }
}

async function revealMine(cell) {
  if (mineBusy || !mineGame || mineGame.status !== "active") return;
  mineBusy = true;
  renderMines();
  try {
    const result = await api("/api/mines/reveal", {
      method: "POST",
      body: JSON.stringify({ game_id: mineGame.game_id, cell })
    });
    mineGame.revealed = result.revealed || [];
    mineGame.multiplier = result.multiplier || 0;
    if (result.hit) {
      mineGame.bombs = result.bombs || [];
      mineGame.status = "lost";
      mineFinishedMessage = "Бомба! Раунд завершён. Попробуй ещё раз.";
      toast("Бомба! Ставка проиграна.");
    } else {
      toast("Безопасно · множитель ×" + Number(result.multiplier).toFixed(2));
    }
  } catch (error) {
    toast(error.message);
  } finally {
    mineBusy = false;
    renderMines();
  }
}

async function cashoutMines() {
  if (mineBusy || !mineGame || mineGame.status !== "active") return;
  mineBusy = true;
  renderMines();
  try {
    const result = await api("/api/mines/cashout", {
      method: "POST",
      body: JSON.stringify({ game_id: mineGame.game_id })
    });
    setBalance(result.balance);
    mineGame.status = "cashed_out";
    mineFinishedMessage = "Ты забрал " + Number(result.payout).toLocaleString("ru-RU") +
      " MST · множитель ×" + Number(result.multiplier).toFixed(2);
    toast("Выигрыш зачислен: +" + result.payout + " MST");
    mineGame = null;
  } catch (error) {
    toast(error.message);
  } finally {
    mineBusy = false;
    renderMines();
  }
}

function loadError(error) {
  $("giftGrid").innerHTML = '<div class="setup-message"><strong>Не удалось открыть магазин</strong><p>' +
    esc(error.message) + '</p><button class="task-claim" onclick="location.reload()">Повторить</button></div>';
}

async function load() {
  try {
    const [me, inventory, rouletteData] = await Promise.all([
      api("/api/me"), api("/api/inventory"), api("/api/roulette")
    ]);
    setBalance(me.balance);
    const initial = (me.name || "M").slice(0, 1).toUpperCase();
    $("avatar").textContent = initial;
    $("profileAvatar").textContent = initial;
    $("profileName").textContent = me.name || "Игрок Mystic";
    $("profileUsername").textContent = me.username ? "@" + me.username : "Telegram account";
    $("spinCount").textContent = me.spin_count || 0;
    items = inventory.items || [];
    renderInventory();
    roulettes = rouletteData.roulettes || [];
    mstPerStar = Number(rouletteData.mst_per_star) || 2;
    renderGifts();
    selectMode("classic");
    await loadTasks();
    await restoreMines();
  } catch (error) {
    loadError(error);
    $("taskList").innerHTML = '<div class="setup-message"><strong>Задания недоступны</strong><p>' +
      esc(error.message) + "</p></div>";
  }
}

document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
});
$("profileShortcut").addEventListener("click", () => showScreen("profileScreen"));
$("homeBrand").addEventListener("click", event => {
  event.preventDefault();
  showScreen("homeScreen");
});
$("goRoulette").addEventListener("click", () => $("rouletteSection").scrollIntoView({ behavior: "smooth" }));
$("openInventory").addEventListener("click", () => showScreen("inventoryScreen"));
document.querySelectorAll(".roulette-mode").forEach(button => {
  button.addEventListener("click", () => selectMode(button.dataset.mode));
});
$("spinButton").addEventListener("click", spin);
$("mineStart").addEventListener("click", startMines);
$("mineCashout").addEventListener("click", cashoutMines);
$("closeResult").addEventListener("click", () => $("resultModal").classList.add("hidden"));
$("resultModal").addEventListener("click", event => {
  if (event.target.id === "resultModal") $("resultModal").classList.add("hidden");
});
renderMines();
load();
