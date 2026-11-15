const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const authHeader = tg?.initData ? "tma " + tg.initData : "";
const $ = (id) => document.getElementById(id);
let spinBusy = false;
let roulette = null;
let currentBalance = 0;
let currentItems = [];
let spinCount = 0;
let minesGameId = null;
let minesActive = false;
let minesRevealed = 0;

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
  if (!response.ok) throw new Error(data.error || data.detail || "Ошибка запроса");
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
    const [me, inv, cfg, daily, history] = await Promise.all([api("/api/me"), api("/api/inventory"), api("/api/roulette"), api("/api/daily"), api("/api/history")]);
    setBalance(me.balance);
    $("avatar").textContent = (me.name || "M").slice(0,1).toUpperCase();
    $("profileAvatar").textContent = (me.name || "M").slice(0,1).toUpperCase();
    $("profileName").textContent = me.name || "Игрок Mystic";
    $("profileUsername").textContent = me.username ? "@" + me.username : "Telegram account";
    $("spinCount").textContent = me.spin_count ?? "—";
    renderInventory(inv.items);
    roulette = cfg;
    buildReel();
    renderDaily(daily);
    renderHistory(history);
  } catch (error) {
    $("hint").textContent = error.message + (tg ? "" : " · Для локального просмотра включи DEV_MODE=true");
    $("spinBtn").disabled = true;
  }
}
function renderDaily(data) {
  $("dailyStatus").textContent = data.claimed ? "Бонус уже получен. Возвращайся завтра!" : "Забирай 100 MST каждый день · 7-й день +100";
  $("dailyClaim").textContent = data.claimed ? "ПОЛУЧЕНО" : "ЗАБРАТЬ";
  $("dailyClaim").disabled = !!data.claimed;
  $("dailyCard").classList.toggle("claimed",!!data.claimed);
}
function renderHistory(data) {
  const host = $("historyList"); if (!host) return;
  const rows = (data.spins || []).map(x => ({title:"Рулетка · "+x.prize_id,detail:"-"+x.cost+" MST",date:x.created_at}));
  const mines = (data.mines || []).map(x => ({title:"MINES · "+x.status,detail:x.status==="cashed_out"?"+"+x.payout+" MST":"Ставка "+x.bet+" MST",date:x.created_at}));
  const all = [...rows,...mines].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8);
  host.innerHTML = all.length ? all.map(x=>"<div class=\"history-row\"><div><strong>"+escapeHtml(x.title)+"</strong><small>"+escapeHtml(new Date(x.date+"Z").toLocaleString("ru-RU"))+"</small></div><b>"+escapeHtml(x.detail)+"</b></div>").join("") : "<div class=\"empty-state\">История пока пуста</div>";
}
async function claimDaily() {
  $("dailyClaim").disabled=true;
  try { const r=await api("/api/daily/claim",{method:"POST",body:"{}"}); setBalance(r.balance); renderDaily({claimed:true}); $("dailyStatus").textContent="Получено +"+r.reward+" MST · серия "+r.streak+" дн."; toast("Ежедневный бонус +"+r.reward+" MST"); }
  catch(e) { $("dailyStatus").textContent=e.message; $("dailyClaim").disabled=false; }
}
async function startMines() {
  const bet=Number($("minesBet").value); if(!Number.isSafeInteger(bet)||bet<1||bet>10000){$("minesHint").textContent="Укажи ставку от 1 до 10000 MST.";return;}
  $("minesStart").disabled=true;
  try { const r=await api("/api/mines/start",{method:"POST",body:JSON.stringify({bet})}); minesGameId=r.game_id; minesActive=true; minesRevealed=0; setBalance(r.balance); document.querySelectorAll(".mine-cell").forEach(b=>{b.disabled=false;b.className="mine-cell";b.textContent="✦";}); $("minesStart").textContent="ИГРА ИДЁТ"; $("minesCashout").disabled=true; $("minesMultiplier").textContent="×1.00"; $("minesHint").textContent="Открой безопасную клетку, чтобы продолжить."; }
  catch(e){$("minesHint").textContent=e.message;} $("minesStart").disabled=false;
}
async function revealMine(i,b) {
  if(!minesActive||b.disabled)return; b.disabled=true;
  try { const r=await api("/api/mines/reveal",{method:"POST",body:JSON.stringify({game_id:minesGameId,cell:i})});
    if(r.hit){b.classList.add("mine-hit");b.textContent="✹";r.bombs.forEach(n=>{const x=document.querySelector(".mine-cell[data-cell=\""+n+"\"]");if(x){x.classList.add("mine-bomb");x.textContent="✹";x.disabled=true;}});minesActive=false;$("minesCashout").disabled=true;$("minesStart").textContent="ИГРАТЬ СНОВА";$("minesHint").textContent="Мина! Раунд завершён.";}
    else {minesRevealed=r.safe_count;b.classList.add("mine-safe");b.textContent="◆";$("minesMultiplier").textContent="×"+Number(r.multiplier).toFixed(2);$("minesCashout").disabled=false;$("minesHint").textContent="Безопасно! Можешь продолжить или забрать выигрыш.";}
  } catch(e){b.disabled=false;$("minesHint").textContent=e.message;}
}
async function cashoutMines(){
  if(!minesActive||!minesGameId)return;$("minesCashout").disabled=true;
  try{const r=await api("/api/mines/cashout",{method:"POST",body:JSON.stringify({game_id:minesGameId})});minesActive=false;setBalance(r.balance);$("minesStart").textContent="ИГРАТЬ СНОВА";$("minesHint").textContent="Забрано "+r.payout+" MST · множитель ×"+Number(r.multiplier).toFixed(2);toast("Зачислено "+r.payout+" MST");api("/api/history").then(renderHistory).catch(()=>{});}
  catch(e){$("minesHint").textContent=e.message;$("minesCashout").disabled=false;}
}
function toast(message){let el=$("toast");if(!el){el=document.createElement("div");el.id="toast";el.className="toast";document.body.appendChild(el);}el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2300);}
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
$("dailyClaim").addEventListener("click",claimDaily);
$("minesShortcut").addEventListener("click",()=>showScreen("minesScreen"));
$("minesStart").addEventListener("click",startMines);
$("minesCashout").addEventListener("click",cashoutMines);
document.querySelectorAll(".mine-cell").forEach(b=>b.addEventListener("click",()=>revealMine(Number(b.dataset.cell),b)));
const starsBotLink = "https://t.me/Starbuy1bot";
$("openStarsBot").addEventListener("click", (event) => {
  event.preventDefault();
  if (tg?.openTelegramLink) tg.openTelegramLink(starsBotLink);
  else window.open(starsBotLink, "_blank", "noopener,noreferrer");
});
load();