const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const authHeader = tg?.initData ? "tma " + tg.initData : "";
const $ = id => document.getElementById(id);
let tasks = [];
let currentItems = [];

async function api(path, options = {}) {
  const headers = { "Content-Type":"application/json", ...(authHeader ? {Authorization:authHeader} : {}), ...(options.headers || {}) };
  const response = await fetch(path, {...options, headers});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    const error = new Error(data.error || "Ошибка запроса");
    error.status = response.status;
    throw error;
  }
  return data;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function setBalance(value) {
  const html = Number(value).toLocaleString("ru-RU")+" <small>MST</small>";
  $("balance").innerHTML = html;
  $("homeBalance").innerHTML = html;
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("active",s.id===id));
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.screen===id));
  window.scrollTo({top:0,behavior:"smooth"});
}
function toast(message) {
  const el=$("toast"); el.textContent=message; el.classList.add("show");
  setTimeout(()=>el.classList.remove("show"),2400);
}
function renderLoadError(error) {
  const isAuth = error.status === 401 || /Открой приложение через Telegram|авторизац/i.test(error.message);
  $("taskList").innerHTML = isAuth
    ? '<div class="setup-message"><div class="setup-icon">↗</div><strong>Открой Mystic Drop через Telegram</strong><p>Авторизация доступна только при запуске Mini App из Telegram. Открой чат своего бота и нажми кнопку приложения.</p><small>Если ты уже открыл его через Telegram — закрой Mini App и запусти заново.</small></div>'
    : '<div class="setup-message"><div class="setup-icon">!</div><strong>Не удалось загрузить приложение</strong><p>'+escapeHtml(error.message)+'</p><button class="task-claim" id="retryLoad">Повторить</button></div>';
  const retry=$("retryLoad");
  if(retry) retry.addEventListener("click",load);
  $("taskCount").textContent="Не удалось загрузить";
}
function renderTasks() {
  const available=tasks.filter(t=>!t.claimed).length;
  $("taskCount").textContent=available+" из "+tasks.length+" доступны";
  $("taskDone").textContent=tasks.filter(t=>t.claimed).length;
  $("taskList").innerHTML=tasks.map(task=>`
    <article class="task-card ${task.claimed?"task-complete":""}">
      <div class="task-card-icon">${task.id==="subscribe"?"◉":"☀"}</div>
      <div class="task-card-copy">
        <strong>${escapeHtml(task.title)}</strong>
        <p>${escapeHtml(task.description)}</p>
        ${task.id==="subscribe"?'<a class="task-channel-link" href="https://t.me/MysticDropNFT">Открыть канал ↗</a>':""}
        <span class="task-reward">＋${task.reward} MST</span>
      </div>
      <button class="task-claim" data-task="${task.id}" ${task.claimed?"disabled":""}>${task.claimed?"Получено":(task.id==="subscribe"?"Проверить":"Забрать")}</button>
    </article>`).join("");
  document.querySelectorAll(".task-claim:not(:disabled)").forEach(button=>button.addEventListener("click",()=>claimTask(button.dataset.task,button)));
}
async function claimTask(id,button) {
  const originalText=id==="subscribe"?"Проверить":"Забрать";
  button.disabled=true; button.textContent="…";
  try {
    const result=await api("/api/tasks/claim",{method:"POST",body:JSON.stringify({task_id:id})});
    setBalance(result.balance);
    await loadTasks();
    toast("Получено +"+result.reward+" MST");
  } catch(error) {
    button.disabled=false; button.textContent=originalText;
    toast(error.message);
  }
}
async function loadTasks() {
  const data=await api("/api/tasks");
  tasks=data.tasks||[];
  renderTasks();
}
function giftImage(id) {
  const ids={teddy_bear:"5170233102089322756",red_rose:"5168103777563050263",gift_box:"5170250947678437525",rocket:"5170564780938756245",diamond_ring:"5170690322832818290"};
  const gift=ids[id];
  return gift?"https://denzyve.github.io/cdn-telegram-gifts/assets/png/gift_"+gift+".png":"";
}
function renderInventory(items) {
  currentItems=items||[];
  $("inventoryFull").innerHTML=currentItems.length?currentItems.map(item=>{
    const src=giftImage(item.prize_id);
    return `<div class="inventory-item"><div class="item-art tg-gift-art">${src?`<img src="${src}" alt="">`:"✦"}</div><div><strong>${escapeHtml(item.prize_name)}</strong><small>${escapeHtml(item.rarity)}</small></div></div>`;
  }).join(""):'<div class="empty-state">Пока здесь пусто</div>';
  $("itemCount").textContent=currentItems.length+" предметов";
  $("profileItemCount").textContent=currentItems.length;
}
async function load() {
  $("taskList").innerHTML='<div class="empty-state">Загружаем задания…</div>';
  $("taskCount").textContent="Загрузка…";
  try {
    const [me,inventory]=await Promise.all([api("/api/me"),api("/api/inventory")]);
    setBalance(me.balance);
    const initial=(me.name||"M").slice(0,1).toUpperCase();
    $("avatar").textContent=initial;
    $("profileAvatar").textContent=initial;
    $("profileName").textContent=me.name||"Игрок Mystic";
    $("profileUsername").textContent=me.username?"@"+me.username:"Telegram account";
    renderInventory(inventory.items);
    await loadTasks();
  } catch(error) {
    renderLoadError(error);
  }
}
document.querySelectorAll(".nav-item").forEach(button=>button.addEventListener("click",()=>showScreen(button.dataset.screen)));
$("profileShortcut").addEventListener("click",()=>showScreen("profileScreen"));
$("homeBrand").addEventListener("click",event=>{event.preventDefault();showScreen("homeScreen");});
load();
