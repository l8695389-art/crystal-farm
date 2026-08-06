const MAX_ENERGY = 500;
const ENERGY_REGEN_MS = 2000;

const MISSIONS = [
  { id: "tap50", label: "Chạm 50 lần hôm nay", reward: 100, check: (s) => s.dailyTaps >= 50 },
  { id: "coins1000", label: "Đạt 1.000 xu", reward: 200, check: (s) => s.coins >= 1000 },
  { id: "streak3", label: "Điểm danh 3 ngày liên tiếp", reward: 300, check: (s) => s.streak >= 3 },
];

function todayStr(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00Z").getTime();
  const d2 = new Date(b + "T00:00:00Z").getTime();
  return Math.round((d2 - d1) / 86400000);
}

// --- màn hình loading: thanh chạy tới ~90% trong lúc chờ API,
// nhảy lên 100% khi dữ liệu đã sẵn sàng rồi mới ẩn màn hình ---
const loadingFill = document.getElementById("loading-bar-fill");
const loadingPct = document.getElementById("loading-pct");
let loadingProgress = 0;
let loadingTickTimer = null;

function setLoadingProgress(pct) {
  loadingProgress = pct;
  loadingFill.style.width = pct + "%";
  loadingPct.textContent = Math.round(pct) + "%";
}

function startLoadingAnimation() {
  loadingTickTimer = setInterval(() => {
    if (loadingProgress >= 90) return;
    // càng gần 90% càng chạy chậm lại, tạo cảm giác đang tải thật
    const step = Math.max(0.5, (90 - loadingProgress) / 12);
    setLoadingProgress(Math.min(90, loadingProgress + step));
  }, 90);
}

async function finishLoadingAnimation() {
  clearInterval(loadingTickTimer);
  setLoadingProgress(100);
  await new Promise((resolve) => setTimeout(resolve, 250));
  document.getElementById("loading").classList.add("hidden");
}

startLoadingAnimation();

// --- Telegram identity (falls back to a local id when opened outside Telegram) ---
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

// App chỉ được phép chạy khi thực sự mở từ Telegram (có initData hợp lệ).
// Cho phép bỏ qua khi test trên localhost để tiện phát triển với `wrangler dev`.
const isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);
const isTelegramLaunch = !!(tg && tg.initData && tg.initData.length > 0);

if (!isTelegramLaunch && !isLocalDev) {
  clearInterval(loadingTickTimer);
  document.getElementById("loading").classList.add("hidden");
  document.getElementById("blocked").classList.remove("hidden");
  throw new Error("Blocked: not opened inside Telegram");
}

if (tg) {
  tg.ready();
  tg.expand();
}
const tgUser = tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
const initData = tg ? tg.initData : "";

function getLocalId() {
  let id = localStorage.getItem("crystal_local_id");
  if (!id) {
    id = "local-" + crypto.randomUUID();
    localStorage.setItem("crystal_local_id", id);
  }
  return id;
}
const PLAYER_ID = tgUser ? String(tgUser.id) : getLocalId();

// Ưu tiên tên hiển thị Telegram (first + last name); nếu không có thì dùng
// @username; nếu cũng không có thì để trống (sẽ hỏi thủ công ở màn welcome).
function resolveTelegramNickname(user) {
  if (!user) return "";
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (displayName) return displayName;
  if (user.username) return "@" + user.username;
  return "";
}
const TELEGRAM_NICKNAME = resolveTelegramNickname(tgUser);
const TELEGRAM_AVATAR_URL = tgUser && tgUser.photo_url ? tgUser.photo_url : "";
const TELEGRAM_USERNAME = tgUser && tgUser.username ? tgUser.username : "";

function defaultState() {
  return {
    id: PLAYER_ID,
    nickname: TELEGRAM_NICKNAME,
    username: TELEGRAM_USERNAME,
    avatarUrl: TELEGRAM_AVATAR_URL,
    coins: 0,
    energy: MAX_ENERGY,
    lastEnergyTs: Date.now(),
    streak: 0,
    lastCheckin: null,
    totalTaps: 0,
    dailyTaps: 0,
    dailyTapsDate: todayStr(),
    claimedMissions: [],
  };
}

let state = null;
let saveTimer = null;
let particleId = 0;

// --- API ---
async function apiGetPlayer(id) {
  const res = await fetch(`/api/player?id=${encodeURIComponent(id)}`);
  const data = await res.json();
  return data.player;
}
async function apiSavePlayer(player) {
  await fetch("/api/player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, initData }),
  });
}
async function apiGetLeaderboard() {
  const res = await fetch("/api/leaderboard");
  const data = await res.json();
  return data.leaderboard || [];
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => apiSavePlayer(state).catch(() => {}), 500);
}

// --- init ---
(async function init() {
  let player = null;
  try {
    player = await apiGetPlayer(PLAYER_ID);
  } catch {
    player = null;
  }

  if (player) {
    state = player;
    if (state.dailyTapsDate !== todayStr()) {
      state.dailyTaps = 0;
      state.dailyTapsDate = todayStr();
    }
    // Đồng bộ tên/ảnh đại diện mới nhất từ Telegram mỗi lần mở lại
    // (người dùng có thể đã đổi tên hoặc ảnh từ lần trước).
    if (TELEGRAM_NICKNAME) state.nickname = TELEGRAM_NICKNAME;
    if (TELEGRAM_AVATAR_URL) state.avatarUrl = TELEGRAM_AVATAR_URL;
    if (TELEGRAM_USERNAME) state.username = TELEGRAM_USERNAME;
  } else {
    state = defaultState();
  }

  await finishLoadingAnimation();

  if (!state.nickname) {
    // Chỉ xảy ra khi mở ngoài Telegram (test cục bộ) hoặc tài khoản
    // Telegram không có tên lẫn username.
    document.getElementById("welcome").classList.remove("hidden");
  } else {
    scheduleSave();
    showGame();
  }
})();

document.getElementById("start-btn").addEventListener("click", () => {
  const name = document.getElementById("nickname-input").value.trim().slice(0, 16);
  if (!name) return;
  state.nickname = name;
  document.getElementById("welcome").classList.add("hidden");
  scheduleSave();
  showGame();
});

function showGame() {
  document.getElementById("phone").classList.remove("hidden");
  render();
  setInterval(energyTick, ENERGY_REGEN_MS);
  refreshLeaderboard();
}

function energyTick() {
  if (state.energy >= MAX_ENERGY) return;
  state.energy = Math.min(MAX_ENERGY, state.energy + 1);
  state.lastEnergyTs = Date.now();
  renderEnergy();
  scheduleSave();
}

// --- render ---
function renderAvatar(containerEl, nickname, avatarUrl) {
  containerEl.innerHTML = "";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = nickname;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:inherit;";
    img.onerror = () => {
      containerEl.innerHTML = "";
      containerEl.textContent = nickname.slice(0, 1).toUpperCase();
    };
    containerEl.appendChild(img);
  } else {
    containerEl.textContent = nickname.slice(0, 1).toUpperCase();
  }
}

function render() {
  renderAvatar(document.getElementById("avatar-letter"), state.nickname, state.avatarUrl);
  document.getElementById("nick-text").textContent = state.nickname;
  document.getElementById("taps-text").textContent = `${state.totalTaps.toLocaleString()} lần chạm`;
  document.getElementById("coin-text").textContent = state.coins.toLocaleString();
  renderEnergy();
  renderCheckin();
  renderMissions();
}

function renderEnergy() {
  const pct = Math.round((state.energy / MAX_ENERGY) * 100);
  document.getElementById("energy-fill").style.width = pct + "%";
  document.getElementById("energy-text").textContent = `${state.energy}/${MAX_ENERGY}`;
}

function renderCheckin() {
  const btn = document.getElementById("checkin-btn");
  const label = document.getElementById("checkin-label");
  const checkedInToday = state.lastCheckin === todayStr();
  btn.disabled = checkedInToday;
  label.textContent = checkedInToday
    ? `Đã điểm danh · Chuỗi ${state.streak} ngày`
    : `Điểm danh · Chuỗi ${state.streak} ngày`;
}

function renderMissions() {
  const list = document.getElementById("missions-list");
  list.innerHTML = "";
  for (const m of MISSIONS) {
    const done = m.check(state);
    const claimed = state.claimedMissions.includes(m.id);
    const row = document.createElement("div");
    row.className = "mission-row";
    row.innerHTML = `
      <div>
        <div class="mission-label">${m.label}</div>
        <div class="sub-text">Thưởng ${m.reward} xu</div>
      </div>
      ${
        claimed
          ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3ED8C3" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`
          : `<button class="claim-btn" ${done ? "" : "disabled"} data-mission="${m.id}">Nhận</button>`
      }
    `;
    list.appendChild(row);
  }
  list.querySelectorAll(".claim-btn").forEach((btn) => {
    btn.addEventListener("click", () => claimMission(btn.dataset.mission));
  });
}

async function renderLeaderboard(rows) {
  const list = document.getElementById("leaderboard-list");
  if (!rows.length) {
    list.innerHTML = `<div class="sub-text">Chưa có dữ liệu.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((row, i) => {
      const avatar = row.avatar_url
        ? `<img src="${escapeHtml(row.avatar_url)}" alt="" style="width:28px;height:28px;border-radius:8px;object-fit:cover;" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'lb-avatar-fallback',textContent:'${escapeHtml(row.nickname.slice(0, 1).toUpperCase())}'}))" />`
        : `<div class="lb-avatar-fallback">${escapeHtml(row.nickname.slice(0, 1).toUpperCase())}</div>`;
      return `
      <div class="lb-row">
        <span class="lb-rank">${i + 1}</span>
        ${avatar}
        <span class="lb-name">${escapeHtml(row.nickname)}</span>
        <span class="lb-coins">${row.coins.toLocaleString()} xu</span>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function refreshLeaderboard() {
  try {
    const rows = await apiGetLeaderboard();
    renderLeaderboard(rows);
  } catch {}
}

// --- toast ---
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// --- game actions ---
document.getElementById("crystal-wrap").addEventListener("click", (e) => {
  if (state.energy <= 0) return;

  const crit = Math.random() < 0.1;
  const gain = crit ? 6 : 1;
  const isNewDay = state.dailyTapsDate !== todayStr();

  state.coins += gain;
  state.energy -= 1;
  state.totalTaps += 1;
  state.dailyTaps = isNewDay ? 1 : state.dailyTaps + 1;
  state.dailyTapsDate = todayStr();
  state.lastEnergyTs = Date.now();

  document.getElementById("coin-text").textContent = state.coins.toLocaleString();
  document.getElementById("taps-text").textContent = `${state.totalTaps.toLocaleString()} lần chạm`;
  renderEnergy();
  renderMissions();

  const glow = document.getElementById("glow");
  const btn = document.getElementById("crystal-btn");
  glow.classList.add("pulse");
  btn.classList.add("pulse");
  setTimeout(() => {
    glow.classList.remove("pulse");
    btn.classList.remove("pulse");
  }, 120);

  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const p = document.createElement("span");
  p.className = "particle";
  p.style.left = x + "px";
  p.style.top = y + "px";
  p.textContent = "+" + gain;
  e.currentTarget.appendChild(p);
  setTimeout(() => p.remove(), 700);

  scheduleSave();
});

document.getElementById("checkin-btn").addEventListener("click", () => {
  const today = todayStr();
  if (state.lastCheckin === today) return;
  let newStreak = 1;
  if (state.lastCheckin) {
    const gap = daysBetween(state.lastCheckin, today);
    newStreak = gap === 1 ? state.streak + 1 : 1;
  }
  const reward = 50 * Math.min(newStreak, 10);
  state.streak = newStreak;
  state.lastCheckin = today;
  state.coins += reward;
  showToast(`+${reward} xu · Chuỗi ${newStreak} ngày`);
  render();
  scheduleSave();
});

function claimMission(id) {
  const m = MISSIONS.find((x) => x.id === id);
  if (!m || state.claimedMissions.includes(id) || !m.check(state)) return;
  state.coins += m.reward;
  state.claimedMissions.push(id);
  showToast(`Nhận +${m.reward} xu`);
  render();
  scheduleSave();
}

// --- tabs ---
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-play").classList.add("hidden");
    document.getElementById("tab-leaderboard").classList.add("hidden");
    document.getElementById("tab-missions").classList.add("hidden");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "leaderboard") refreshLeaderboard();
  });
});

// save on page hide
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state) {
    apiSavePlayer(state).catch(() => {});
  }
});
