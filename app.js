/* ====== 基本設定 ====== */
const GAS_URL = window.GAS_URL; // 在 index.html 注入
const POLL_MS = 30_000;

// 範例路線設定（請把 key 換成真實值）
const ROUTES = [
  { id: 'r1', label: '綠線(往嘉義大學)', key: '071401' },
  { id: 'r2', label: '綠線(往大富路)', key: '071402' },
  { id: 'r3', label: '綠A線(往嘉義大學)', key: '0714A1' },
  { id: 'r4', label: '綠A線(往二二八公園)', key: '0714A2' }
];

const els = {
  timeline: document.querySelector('#timeline'),
  stationTpl: document.querySelector('#stationTpl'),
  search: document.querySelector('#search'),
  onlyActive: document.querySelector('#onlyActive'),
  nearbyFirst: document.querySelector('#nearbyFirst'),
  lastUpdate: document.querySelector('#lastUpdate'),
  refresh: document.querySelector('#btnRefresh'),
  globalAlert: document.querySelector('#globalAlert'),
  btnInstall: document.querySelector('#btnInstall'),
  routeSelect: document.querySelector('#routeSelect'),
};

let latest = null;
let userLoc = null;
let controller = null;
let deferredPrompt = null;
let selectedRoute = null;

/* ====== PWA 安裝提示 ====== */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.btnInstall.hidden = false;
});
els.btnInstall.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  els.btnInstall.hidden = true;
});

/* ====== 取得定位（非必要） ====== */
if ('geolocation' in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => { userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude }; renderTimeline(latest); },
    () => {} ,
    { enableHighAccuracy: false, maximumAge: 60_000, timeout: 8_000 }
  );
}

/* ====== 路線選單初始化 ====== */
function initRouteSelect(){
  if (!els.routeSelect) return;
  els.routeSelect.innerHTML = '';
  ROUTES.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id; opt.textContent = r.label; opt.dataset.key = r.key;
    els.routeSelect.appendChild(opt);
  });
  const saved = localStorage.getItem('selectedRouteId');
  if (saved && ROUTES.some(r => r.id === saved)) els.routeSelect.value = saved;
  selectedRoute = ROUTES.find(r => r.id === els.routeSelect.value) || ROUTES[0];
}
initRouteSelect();
if (els.routeSelect) {
  els.routeSelect.addEventListener('change', () => {
    selectedRoute = ROUTES.find(r => r.id === els.routeSelect.value);
    localStorage.setItem('selectedRouteId', selectedRoute.id);
    fetchAndRender(true);
  });
}

/* ====== 事件 ====== */
if (els.search) els.search.addEventListener('input', () => renderTimeline(latest));
if (els.onlyActive) els.onlyActive.addEventListener('change', () => renderTimeline(latest));
if (els.nearbyFirst) els.nearbyFirst.addEventListener('change', () => renderTimeline(latest));
if (els.refresh) els.refresh.addEventListener('click', () => fetchAndRender(true));

/* ====== 輔助函式 ====== */
const pad2 = (n) => String(n).padStart(2, '0');
const parseHHmm = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date(); now.setHours(h, m, 0, 0);
  return now;
};
const diffMin = (serverTimeHHmmss, ptimeText) => {
  if (!ptimeText) return null;
  if (ptimeText.includes('進站')) return 0;
  if (ptimeText.endsWith('分')) return parseInt(ptimeText, 10) || 0;
  if (/^\d{2}:\d{2}/.test(ptimeText)) {
    const [hh, mm] = (serverTimeHHmmss || '00:00:00').split(':').map(Number);
    const now = new Date(); now.setHours(hh||0, mm||0, 0, 0);
    const eta = parseHHmm(ptimeText);
    let d = Math.round((eta - now) / 60000);
    if (d < 0) d += 24 * 60; // 跨日補正
    return d;
  }
  return null;
};

const distanceKm = (a, b) => {
  if (!a || !b) return Infinity;
  const R = 6371, toRad = (x)=>x*Math.PI/180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const statusClass = (ptime) => {
  if (!ptime) return 'dim';
  if (ptime.includes('進站') || ptime.includes('即將')) return 'active';
  if (ptime.endsWith('分')) {
    const n = parseInt(ptime, 10);
    if (n <= 1) return 'active';
    if (n <= 3) return 'upcoming';
    return 'delayed';
  }
  return 'dim';
};

/* ====== 渲染時間軸 ====== */
function renderTimeline(json) {
  if (!els.timeline) return;
  els.timeline.setAttribute('aria-busy', 'true');

  // 若沒有傳入 json，嘗試從 localStorage 載入
  if (!json) {
    try { json = JSON.parse(localStorage.getItem('lastData') || 'null'); } catch {}
    if (!json) { els.timeline.innerHTML = ''; els.timeline.setAttribute('aria-busy','false'); return; }
  }

  latest = json;
  const { time: serverTime, data: stops = [], stop: addrs = [] } = json;

  // 全域公告（保留）
  const firstAlert = (stops.find(s => s.alert) || {}).alert || '';
  if (firstAlert) {
    els.globalAlert.hidden = false;
    els.globalAlert.textContent = firstAlert.replace(/\s+/g, ' ').trim();
  } else {
    els.globalAlert.hidden = true;
    els.globalAlert.textContent = '';
  }

  // map sid -> addr
  const addrMap = Object.fromEntries((addrs || []).map(s => [String(s.sid), s.addr]));

  const kw = (els.search && els.search.value ? els.search.value.trim().toLowerCase() : '');
  const onlyActive = els.onlyActive && els.onlyActive.checked;

  // 建立 rows（包含 addr 與計算 etaMin / 距離）
  let rows = (stops || [])
    .map(s => ({
      ...s,
      addr: addrMap[String(s.sid)] || '',
      etaMin: diffMin(serverTime, s.ptime),
      distKm: userLoc ? distanceKm(userLoc, { lat: Number(s.lat), lon: Number(s.lon) }) : Infinity
    }))
    .filter(s => {
      if (kw && !(`${s.na}${s.ena}`.toLowerCase().includes(kw))) return false;
      if (onlyActive && !(s.ptime?.includes('分') || s.ptime?.includes('進站') || s.car)) return false;
      return true;
    });

  // 排序
  if (els.nearbyFirst && els.nearbyFirst.checked && userLoc) {
    rows.sort((a,b) => a.distKm - b.distKm);
  } else {
    rows.sort((a,b) => Number(a.sequence) - Number(b.sequence));
  }

  // ===== 去重：同名站只保留第一筆（以站名 trim().toLowerCase() 判斷） =====
  const seen = new Set();
  rows = rows.filter(s => {
    const key = (s.na || '').trim().toLowerCase();
    if (!key) return true; // 沒名稱的仍保留（或你可選擇過濾）
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 計算是否有重複站名（已去重，這裡僅供後續邏輯使用；實際應該全為 1）
  const nameCount = {};
  rows.forEach(s => { const name = s.na || ''; nameCount[name] = (nameCount[name] || 0) + 1; });

  // 清空並建立 DOM
  els.timeline.innerHTML = '';
  const frag = document.createDocumentFragment();
  let autoScrollTarget = null;

  rows.forEach((s, i) => {
    const clone = els.stationTpl.content.cloneNode(true);
    const rowEl = clone.querySelector('.station-row');
    const timeEl = clone.querySelector('.time');
    const delayEl = clone.querySelector('.delay'); // 隱藏 per-stop
    const nameEl = clone.querySelector('.stop-name');
    const addrEl = clone.querySelector('.addr');

    // 加上 data 屬性（方便後續 JS 使用）
    if (rowEl) {
      rowEl.dataset.sid = String(s.sid || '');
      rowEl.dataset.index = String(i);
      rowEl.dataset.hasCar = s.car ? '1' : '0';
    }

    // 左側只顯示時間（HH:MM 或 原字串 或 —）
    timeEl.textContent = s.ptime?.match(/^\d{2}:\d{2}/) ? s.ptime.match(/^\d{2}:\d{2}/)[0] : (s.ptime || '—');

    // 隱藏 per-stop 的 delay/備註（依你要求）
    if (delayEl) delayEl.hidden = true;

    // 站名：顯示名稱（已去重，所以不需顯示地址）
    nameEl.textContent = s.na || '(未命名站點)';
    addrEl.textContent = ''; // 右側地址全部隱藏（CSS 也強制隱藏）

    // 狀態 class
    const cls = statusClass(s.ptime || '');
    rowEl.classList.add(cls);

    // 決定自動捲動目標（第一個 active）
    if (!autoScrollTarget && cls === 'active') {
      autoScrollTarget = rowEl;
    }

    frag.appendChild(clone);
  });

  els.timeline.appendChild(frag);
  els.timeline.setAttribute('aria-busy', 'false');

  // 更新時間顯示（UI 上方）
  const now = new Date();
  if (els.lastUpdate) els.lastUpdate.textContent = `更新於 ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  // ===== 建立「往下到下一站」的高亮段（支援多台車） =====
  // 先清除舊的 highlight-seg（避免累積）
  els.timeline.querySelectorAll('.highlight-seg').forEach(n => n.remove());

  const rowEls = Array.from(els.timeline.querySelectorAll('.station-row'));
  const timelineRect = els.timeline.getBoundingClientRect();
  const cs = getComputedStyle(els.timeline);
  const lineWidth = parseFloat(cs.getPropertyValue('--timeline-line-width')) || 2;

  rowEls.forEach((rowEl, idx) => {
    const isActive = rowEl.classList.contains('active');
    const hasCar = rowEl.dataset.hasCar === '1';
    if (!(isActive || hasCar)) return; // 只為 active 或有車畫 highlight

    const dot = rowEl.querySelector('.dot');
    if (!dot) return;
    if (idx >= rowEls.length - 1) return; // 最後一站沒有下一站就跳過

    const nextRow = rowEls[idx + 1];
    const nextDot = nextRow.querySelector('.dot');
    if (!nextDot) return;

    const dotRect = dot.getBoundingClientRect();
    const nextDotRect = nextDot.getBoundingClientRect();

    const dotCenterY = (dotRect.top - timelineRect.top) + (dotRect.height / 2);
    const nextCenterY = (nextDotRect.top - timelineRect.top) + (nextDotRect.height / 2);
    const height = Math.max(2, nextCenterY - dotCenterY);

    const dotCenterX = (dotRect.left - timelineRect.left) + (dotRect.width / 2);

    const seg = document.createElement('div');
    seg.className = 'highlight-seg';
    seg.style.top = `${dotCenterY}px`;
    seg.style.left = `${dotCenterX - (lineWidth / 2)}px`;
    seg.style.width = `${lineWidth}px`;
    seg.style.height = `${height}px`;

    // 根據來源 row 的狀態決定顏色（使用 CSS 變數）
    // 優先：active -> --hot, upcoming -> --ok, delayed -> --warn, default -> --muted
    let segColorVar = '--muted';
    if (rowEl.classList.contains('active')) segColorVar = '--hot';
    else if (rowEl.classList.contains('upcoming')) segColorVar = '--warn';
    else if (rowEl.classList.contains('delayed')) segColorVar = '--ok';

    // 讀取 :root 變數值並套用（保證顏色一致）
    const rootStyles = getComputedStyle(document.documentElement);
    const segColor = rootStyles.getPropertyValue(segColorVar).trim() || '#999';
    seg.style.background = segColor;

    els.timeline.appendChild(seg);
  });

  // ===== 自動捲動：優先 active，沒有就找 upcoming =====
  if (autoScrollTarget) {
    setTimeout(() => autoScrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }), 160);
  } else {
    const upcoming = els.timeline.querySelector('.station-row.upcoming');
    if (upcoming) upcoming.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}



/* ====== 抓資料（支援多路線） ====== */
async function fetchJSON(signal) {
  if (!selectedRoute) selectedRoute = ROUTES[0];
  const params = new URLSearchParams({ key: selectedRoute.key });
  const url = `${GAS_URL}?${params.toString()}`;
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAndRender(manual = false) {
  try {
    if (controller) controller.abort();
    controller = new AbortController();

    const json = await fetchJSON(controller.signal);
    renderTimeline(json);
    localStorage.setItem('lastData', JSON.stringify(json));
    // 通知 SW 做資料快取（可選）
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CACHE_LAST_DATA', payload: json });
    }
  } catch (err) {
    console.error('fetchAndRender error', err);
    if (manual) alert('讀取失敗，已使用上次資料（若有）。');
    renderTimeline(null);
  }
}

// 啟動：先抓一次，再每 POLL_MS 輪詢
fetchAndRender();
setInterval(fetchAndRender, POLL_MS);
