const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const authHeader = tg?.initData ? "tma " + tg.initData : "";
const $ = (id) => document.getElementById(id);
let spinBusy = false;
let roulette = null;
let currentBalance = 0;
let currentItems = [];
let spinCount = 0;

const prizeById = {
  moon: {name:"Moon", rarity:"Обычный", art:"moon-art"},
  star: {name:"Star", rarity:"Обычный", art:"star-art"},
  crystal: {name:"Crystal", rarity:"Редкий", art:"crystal-art"},
  crown: {name:"Crown", rarity:"Эпический", art:"crown-art"},
  dragon: {name:"Mystic Dragon", rarity:"Легендарный", art:"dragon-art"}
};
function artClass(prize) {
  const known = prizeById[prize.id];
  if (known) return known.art;
  const byName = Object.values(prizeById).find(p => p.name === prize.name);
  return byName?.art || "crystal-art";
}
function artMarkup(prize, extraClass="") {
  return `<div class="tile-art ${extraClass}"><div class="artifact ${artClass(prize)}"></div></div>`;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : (!tg ? { "x-dev-mode": "true" } : {})), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Ошибка запроса");
  return data;
}
function setBalance(value) {
  currentBalance = Number(value);
  $("balance").innerHTML = `${currentBalance.toLocaleString("ru-RU")} <small>MST</small>`;
}
function renderInventory(items) {
  currentItems = items || [];
  const markup = currentItems.length ? currentItems.map(item => {
    const prize = {id:item.prize_id, name:item.prize_name};
    return `<div class="inventory-item"><div class="item-art"><div class="artifact ${artClass(prize)}"></div></div><div><strong>${escapeHtml(item.prize_name)}</strong><small>${escapeHtml(item.rarity)} · ${new Date(item.created_at + "Z").toLocaleDateString("ru-RU")}</small></div></div>`;
  }).join("") : '<div class="empty-state">Твои находки появятся здесь</div>';
  $("inventory").innerHTML = markup;
  $("inventoryFull").innerHTML = markup;
  $("itemCount").textContent = currentItems.length + " предметов";
  $("profileItemCount").textContent = currentItems.length;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === screenId));
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.screen === screenId));
  window.scrollTo({top:0,behavior:"smooth"});
}
function buildReel() {
  if (!roulette) return;
  $("reel").innerHTML = roulette.prizes.map(p => `<div class="prize-tile">${artMarkup(p)}<small>${escapeHtml(p.name)}</small></div>`).join("");
}
async function load() {
  try {
    const [me, inv, cfg] = await Promise.all([api("/api/me"), api("/api/inventory"), api("/api/roulette")]);
    setBalance(me.balance);
    $("avatar").textContent = (me.name || "M").slice(0,1).toUpperCase();
    $("profileAvatar").textContent = (me.name || "M").slice(0,1).toUpperCase();
    $("profileName").textContent = me.name || "Игрок Mystic";
    $("profileUsername").textContent = me.username ? "@" + me.username : "Telegram account";
    $("spinCount").textContent = me.spin_count ?? "—";
    renderInventory(inv.items);
    roulette = cfg;
    buildReel();
  } catch (error) {
    $("hint").textContent = error.message + (tg ? "" : " · Для локального просмотра включи DEV_MODE=true");
    $("spinBtn").disabled = true;
  }
}
function showResult(prize) {
  $("resultArt").innerHTML = `<div class="artifact ${artClass(prize)}"></div>`;
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
  const filler = Array.from({length:30}, (_,i) => roulette.prizes[i % roulette.prizes.length]);
  reel.innerHTML = filler.map(p => `<div class="prize-tile">${artMarkup(p)}<small>${escapeHtml(p.name)}</small></div>`).join("");
  void reel.offsetWidth;
  const requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  try {
    const result = await api("/api/spin", {method:"POST",body:JSON.stringify({request_id:requestId})});
    const target = result.prize;
    const tileWidth = 90;
    const finalIndex = 25;
    const winningTile = document.createElement("div");
    winningTile.className = "prize-tile";
    winningTile.innerHTML = `${artMarkup(target)}<small>${escapeHtml(target.name)}</small>`;
    reel.replaceChild(winningTile, reel.children[finalIndex]);
    void reel.offsetWidth;
    reel.style.transition = "transform 3.2s cubic-bezier(.12,.72,.08,1)";
    const viewportCenter = reel.parentElement.clientWidth / 2;
    reel.style.transform = `translateX(${viewportCenter - (finalIndex * tileWidth + 41)}px)`;
    setTimeout(async () => {
      setBalance(result.balance);
      showResult(target);
      try {
        const inv = await api("/api/inventory");
        renderInventory(inv.items);
        $("hint").textContent = "Результат определён сервером.";
      } catch (e) {
        $("hint").textContent = "Подарок получен. Не удалось обновить список.";
      }
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
document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => showScreen(button.dataset.screen)));
$("profileShortcut").addEventListener("click", () => showScreen("profileScreen"));
$("homeBrand").addEventListener("click", e => {e.preventDefault();showScreen("homeScreen");});
$("heroSpin").addEventListener("click", () => $("rouletteSection").scrollIntoView({behavior:"smooth"}));
$("seeInventory").addEventListener("click", () => showScreen("inventoryScreen"));
$("spinBtn").addEventListener("click", spin);
$("closeModal").addEventListener("click", () => $("resultModal").classList.add("hidden"));
const starsBotLink = "https://t.me/Starbuy1bot";
$("openStarsBot").addEventListener("click", (event) => {
  event.preventDefault();
  if (tg?.openTelegramLink) tg.openTelegramLink(starsBotLink);
  else window.open(starsBotLink, "_blank", "noopener,noreferrer");
});
load();