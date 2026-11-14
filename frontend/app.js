const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const authHeader = tg?.initData ? "tma " + tg.initData : "";
const $ = (id) => document.getElementById(id);
let spinBusy = false;
let roulette = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Ошибка запроса");
  return data;
}
function renderBalance(value) { $("balance").textContent = Number(value).toLocaleString("ru-RU"); }
function renderInventory(items) {
  $("itemCount").textContent = items.length;
  $("inventory").innerHTML = items.length ? items.map(item =>
    `<div class="inventory-item"><span class="item-emoji">${item.emoji}</span><div><strong>${item.prize_name}</strong><small>${item.rarity} · ${new Date(item.created_at + "Z").toLocaleDateString("ru-RU")}</small></div></div>`
  ).join("") : '<div class="empty-state">Здесь появятся твои подарки ✨</div>';
}
async function load() {
  try {
    const [me, inv, cfg] = await Promise.all([api("/api/me"), api("/api/inventory"), api("/api/roulette")]);
    renderBalance(me.balance);
    $("avatar").textContent = (me.name || "M").slice(0, 1).toUpperCase();
    renderInventory(inv.items);
    roulette = cfg;
  } catch (error) {
    $("hint").textContent = error.message + (tg ? "" : " · Для локального просмотра включи DEV_MODE=true");
    $("spinBtn").disabled = true;
  }
}
function showResult(prize) {
  $("resultEmoji").textContent = prize.emoji;
  $("resultName").textContent = prize.name;
  $("resultRarity").textContent = prize.rarity;
  $("resultModal").classList.remove("hidden");
}
async function spin() {
  if (spinBusy || !roulette) return;
  spinBusy = true;
  $("spinBtn").disabled = true;
  $("hint").textContent = "Рулетка вращается…";
  const reel = $("reel");
  reel.style.transition = "none";
  reel.style.transform = "translateX(0)";
  const filler = Array.from({length: 30}, (_, i) => roulette.prizes[i % roulette.prizes.length]);
  reel.innerHTML = filler.map(p => `<div class="prize-tile"><span>${p.emoji}</span><small>${p.name}</small></div>`).join("");
  void reel.offsetWidth;
  const requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  try {
    const result = await api("/api/spin", { method: "POST", body: JSON.stringify({ request_id: requestId }) });
    const target = result.prize;
    const tileWidth = 97;
    const finalIndex = 25;
    const winningTile = document.createElement("div");
    winningTile.className = "prize-tile";
    winningTile.innerHTML = `<span>${target.emoji}</span><small>${target.name}</small>`;
    reel.replaceChild(winningTile, reel.children[finalIndex]);
    void reel.offsetWidth;
    reel.style.transition = "transform 3.2s cubic-bezier(.12,.72,.08,1)";
    const viewportCenter = $("reel").parentElement.clientWidth / 2;
    reel.style.transform = `translateX(${viewportCenter - (finalIndex * tileWidth + 44)}px)`;
    setTimeout(async () => {
      renderBalance(result.balance);
      showResult(target);
      const inv = await api("/api/inventory");
      renderInventory(inv.items);
      $("hint").textContent = "Результат определён сервером. Удачи в следующем раунде!";
      $("spinBtn").disabled = false;
      spinBusy = false;
    }, 3300);
  } catch (error) {
    $("hint").textContent = error.message;
    $("spinBtn").disabled = false;
    spinBusy = false;
    await load();
  }
}
$("spinBtn").addEventListener("click", spin);
$("closeModal").addEventListener("click", () => $("resultModal").classList.add("hidden"));
$("inventoryNav").addEventListener("click", () => $("inventory").scrollIntoView({behavior:"smooth", block:"center"}));
load();
