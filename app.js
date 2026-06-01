const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const DEFAULT_LOCATION = {
  latitude: 35.6762,
  longitude: 139.6503,
  label: "東京都（サンプル地点）",
};

const state = { location: null, hourly: [], currentIndex: 0 };
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;

const refs = {
  heroCard: document.querySelector("#heroCard"),
  locationName: document.querySelector("#locationName"),
  locationSaved: document.querySelector("#locationSaved"),
  statusLabel: document.querySelector("#statusLabel"),
  riskGauge: document.querySelector("#riskGauge"),
  riskScore: document.querySelector("#riskScore"),
  riskTitle: document.querySelector("#riskTitle"),
  heroMessage: document.querySelector("#heroMessage"),
  riskReason: document.querySelector("#riskReason"),
  riskMeterFill: document.querySelector("#riskMeterFill"),
  chart: document.querySelector("#riskChart"),
  chartEmpty: document.querySelector("#chartEmpty"),
  timeline: document.querySelector("#alertTimeline"),
  warningStrip: document.querySelector("#warningStrip"),
  warningTitle: document.querySelector("#warningTitle"),
  warningMessage: document.querySelector("#warningMessage"),
  careTitle: document.querySelector("#careTitle"),
  careMessage: document.querySelector("#careMessage"),
  refreshButton: document.querySelector("#refreshButton"),
  locationButton: document.querySelector("#locationButton"),
  locationDialog: document.querySelector("#locationDialog"),
  locationForm: document.querySelector("#locationForm"),
  useCurrentLocationButton: document.querySelector("#useCurrentLocationButton"),
  locationInput: document.querySelector("#locationInput"),
  searchResults: document.querySelector("#searchResults"),
  notificationButton: document.querySelector("#notificationButton"),
  notificationStatus: document.querySelector("#notificationStatus"),
  navNotificationButton: document.querySelector("#navNotificationButton"),
  installCard: document.querySelector("#installCard"),
  installButton: document.querySelector("#installButton"),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pressureAt(index) {
  return state.hourly[index]?.pressure;
}

function symptomScore(index) {
  const current = pressureAt(index);
  if (!Number.isFinite(current)) return 0;
  const before6 = pressureAt(index - 6);
  const before12 = pressureAt(index - 12);
  const after3 = pressureAt(index + 3);
  const after6 = pressureAt(index + 6);
  const after12 = pressureAt(index + 12);
  const after24 = pressureAt(index + 24);
  const before3 = pressureAt(index - 3);
  const pastDrop6 = Number.isFinite(before6) ? Math.max(0, before6 - current) : 0;
  const pastDrop12 = Number.isFinite(before12) ? Math.max(0, before12 - current) : 0;
  const drop3 = Number.isFinite(after3) ? Math.max(0, current - after3) : 0;
  const drop6 = Number.isFinite(after6) ? Math.max(0, current - after6) : 0;
  const drop12 = Number.isFinite(after12) ? Math.max(0, current - after12) : 0;
  const drop24 = Number.isFinite(after24) ? Math.max(0, current - after24) : 0;
  const recentShift = Number.isFinite(before3) ? Math.abs(current - before3) : 0;
  const futureTrend = Math.max(drop3 * 18, drop6 * 12, drop12 * 8, drop24 * 7);
  const recentTrend = Math.max(pastDrop6 * 9, pastDrop12 * 5);
  const lowPressureLoad = Math.max(0, 1008 - current) * 4;
  const score = 8 + Math.max(futureTrend, recentTrend) + recentShift * 3 + lowPressureLoad;
  return Math.round(clamp(score, 0, 100));
}

function describeTrend(index) {
  const current = pressureAt(index);
  const drop = (hours) => {
    const future = pressureAt(index + hours);
    return Number.isFinite(current) && Number.isFinite(future) ? Math.max(0, current - future) : 0;
  };
  const trends = [
    { hours: 3, amount: drop(3), label: "短時間で急に下がる予報" },
    { hours: 6, amount: drop(6), label: "数時間かけて下がる予報" },
    { hours: 12, amount: drop(12), label: "半日かけて下がる予報" },
    { hours: 24, amount: drop(24), label: "1日かけて下がる予報" },
  ];
  const strongest = trends.sort((a, b) => b.amount - a.amount)[0];
  if (current <= 1007) return "低気圧の影響が続く予報です。回復傾向でも無理をしないでください。";
  if (strongest.amount >= 5) return `${strongest.label}。早めの備えがおすすめです。`;
  if (strongest.amount >= 2) return `${strongest.label}を検知しました。`;
  return "大きな下降傾向は検知されていません。";
}

function describeRisk(score) {
  if (score >= 70) {
    return {
      level: "alert",
      label: "警戒レベル",
      title: "不調が出やすい予報です",
      badge: "警戒",
      icon: "!",
      message: "頭痛やだるさに備えて、予定をゆるめに。早めの休息を意識しましょう。",
      care: "水分を取り、できるだけ静かな環境で休める時間を確保しましょう。",
    };
  }
  if (score >= 40) {
    return {
      level: "watch",
      label: "注意レベル",
      title: "少し注意して過ごしましょう",
      badge: "注意",
      icon: "↓",
      message: "体調が揺らぎやすい時間帯があります。こまめな休憩がおすすめです。",
      care: "無理を詰め込まず、首や肩をゆるめる休憩を早めに取りましょう。",
    };
  }
  return {
    level: "calm",
    label: "穏やかレベル",
    title: "大きな心配はなさそうです",
    badge: "穏やか",
    icon: "✓",
    message: "急な変化は少ない予報です。普段どおりにお過ごしください。",
    care: "大きな変化は少なめです。いつものペースで、疲れる前にひと息入れましょう。",
  };
}

function findCurrentIndex(hourly) {
  const now = Date.now();
  const candidate = hourly.findIndex((item) => new Date(item.time).getTime() >= now);
  return candidate === -1 ? 0 : candidate;
}

function formatTime(time, fallback = "現在") {
  if (!time) return fallback;
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(time));
}

function formatForecastDate(time) {
  if (!time) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(time));
}

function formatForecastDateTime(time, fallback = "現在") {
  if (!time) return fallback;
  return `${formatForecastDate(time)} ${formatTime(time)}`;
}

function saveLocation(location) {
  localStorage.setItem("pressure-care-location", JSON.stringify(location));
  refs.locationName.textContent = location.label;
  refs.locationSaved.hidden = false;
}

function updateHero() {
  const score = symptomScore(state.currentIndex);
  const risk = describeRisk(score);
  refs.heroCard.className = `hero-card tone-${risk.level}`;
  refs.statusLabel.textContent = risk.label;
  refs.riskGauge.style.setProperty("--risk", score);
  refs.riskScore.textContent = score;
  refs.riskTitle.textContent = risk.title;
  refs.heroMessage.textContent = risk.message;
  refs.riskReason.textContent = describeTrend(state.currentIndex);
  refs.riskMeterFill.style.width = `${score}%`;
  refs.careTitle.textContent = risk.level === "calm" ? "穏やかな日のセルフケア" : "早めのセルフケア";
  refs.careMessage.textContent = risk.care;
  updateWarningStrip();
}

function findUpcomingAlert() {
  return Array.from({ length: 13 }, (_, offset) => offset)
    .map((offset) => ({ offset, score: symptomScore(state.currentIndex + offset) }))
    .find(({ score }) => score >= 70);
}

function updateWarningStrip() {
  const alert = findUpcomingAlert();
  if (!alert) {
    refs.warningStrip.hidden = true;
    return;
  }
  const item = state.hourly[state.currentIndex + alert.offset];
  refs.warningTitle.textContent = "頭痛・不調リスクが高まります";
  refs.warningMessage.textContent =
    alert.offset === 0
      ? `現在の指数は ${alert.score}。早めに休める予定を作りましょう。`
      : `${formatForecastDateTime(item.time)}ごろの指数は ${alert.score}。早めに休める予定を作りましょう。`;
  refs.warningStrip.hidden = false;
}

function renderChart() {
  const points = state.hourly.slice(state.currentIndex, state.currentIndex + 25);
  if (points.length < 2) return;
  const scores = points.map((_, offset) => symptomScore(state.currentIndex + offset));
  const width = 640;
  const height = 216;
  const gutter = { top: 11, right: 10, bottom: 45, left: 43 };
  const innerWidth = width - gutter.left - gutter.right;
  const innerHeight = height - gutter.top - gutter.bottom;
  const x = (index) => gutter.left + (index / (scores.length - 1)) * innerWidth;
  const y = (score) => gutter.top + ((100 - score) / 100) * innerHeight;
  const line = scores.map((score, index) => `${x(index)},${y(score)}`).join(" ");
  const area = `${gutter.left},${gutter.top + innerHeight} ${line} ${x(scores.length - 1)},${gutter.top + innerHeight}`;
  const xTicks = [0, 6, 12, 18, 24].filter((index) => index < points.length);

  refs.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  refs.chart.innerHTML = `
    <defs>
      <linearGradient id="riskFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#e26f68" stop-opacity="0.75" />
        <stop offset="52%" stop-color="#efbd68" stop-opacity="0.38" />
        <stop offset="100%" stop-color="#a9d9cb" stop-opacity="0.12" />
      </linearGradient>
      <linearGradient id="riskLine" x1="0" x2="0" y1="1" y2="0">
        <stop offset="0%" stop-color="#377b77" />
        <stop offset="55%" stop-color="#ce9a43" />
        <stop offset="100%" stop-color="#c75a57" />
      </linearGradient>
    </defs>
    <rect x="${gutter.left}" y="${y(100)}" width="${innerWidth}" height="${y(70) - y(100)}" fill="#f9e5e2" opacity="0.74" />
    <rect x="${gutter.left}" y="${y(70)}" width="${innerWidth}" height="${y(40) - y(70)}" fill="#fbf0d5" opacity="0.74" />
    <rect x="${gutter.left}" y="${y(40)}" width="${innerWidth}" height="${y(0) - y(40)}" fill="#edf7f2" opacity="0.9" />
    ${[
      { score: 85, label: "警戒" },
      { score: 55, label: "注意" },
      { score: 18, label: "穏やか" },
    ]
      .map(
        ({ score, label }) => `
          <text x="0" y="${y(score) + 4}" fill="#79908e" font-size="11" font-weight="700">${label}</text>
        `,
      )
      .join("")}
    <polygon points="${area}" fill="url(#riskFill)" />
    <polyline points="${line}" fill="none" stroke="url(#riskLine)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${x(0)}" cy="${y(scores[0])}" r="6" fill="#245d60" stroke="#fff" stroke-width="3" />
    ${xTicks
      .map((index) => {
        const date = new Date(points[index].time);
        const anchor = index === 0 ? "start" : index === 24 ? "end" : "middle";
        return `
          <text x="${x(index)}" y="${height - 19}" text-anchor="${anchor}" fill="#79908e" font-size="10" font-weight="800">${index === 0 ? "現在" : formatForecastDate(points[index].time)}</text>
          <text x="${x(index)}" y="${height - 5}" text-anchor="${anchor}" fill="#79908e" font-size="10" font-weight="700">${date.getHours()}時</text>
        `;
      })
      .join("")}
  `;
  refs.chartEmpty.hidden = true;
}

function renderTimeline() {
  const rows = [0, 3, 6, 9, 12].map((offset) => {
    const item = state.hourly[state.currentIndex + offset];
    const score = symptomScore(state.currentIndex + offset);
    const risk = describeRisk(score);
    return `
      <div class="timeline-row risk-row">
        <div class="timeline-time">
          <span>${offset === 0 ? "現在" : formatForecastDate(item?.time)}</span>
          <strong>${formatTime(item?.time, "--:--")}</strong>
        </div>
        <span class="timeline-dot ${risk.level}"></span>
        <div class="risk-row-copy">
          <p class="risk-row-title">${risk.badge}<span class="badge ${risk.level}">${score}</span></p>
          <div class="mini-risk-bar"><span class="${risk.level}" style="width: ${score}%"></span></div>
        </div>
        <span class="timeline-change">${risk.icon}</span>
      </div>
    `;
  });
  refs.timeline.innerHTML = rows.join("");
}

async function fetchForecast(location) {
  refs.refreshButton.classList.add("is-spinning");
  refs.locationName.textContent = location.label;
  try {
    const params = new URLSearchParams({
      latitude: location.latitude,
      longitude: location.longitude,
      hourly: "pressure_msl",
      timezone: "auto",
      forecast_days: "3",
    });
    const response = await fetch(`${FORECAST_URL}?${params}`);
    if (!response.ok) throw new Error("予報を取得できませんでした。");
    const data = await response.json();
    state.location = location;
    state.hourly = data.hourly.time.map((time, index) => ({ time, pressure: data.hourly.pressure_msl[index] }));
    state.currentIndex = findCurrentIndex(state.hourly);
    updateHero();
    renderChart();
    renderTimeline();
    scheduleAlertNotification();
  } catch (error) {
    refs.heroCard.className = "hero-card tone-alert";
    refs.statusLabel.textContent = "データを取得できません";
    refs.riskTitle.textContent = "予報を表示できません";
    refs.heroMessage.textContent = `${error.message} 通信状態を確認して、再読み込みしてください。`;
    refs.timeline.innerHTML = '<p class="empty-state">予報を表示できませんでした。</p>';
    refs.chartEmpty.textContent = "予報を表示できませんでした";
    refs.chartEmpty.hidden = false;
  } finally {
    refs.refreshButton.classList.remove("is-spinning");
  }
}

function locateCurrentPosition() {
  refs.locationName.textContent = "現在地を確認しています";
  if (!navigator.geolocation) return fetchForecast(DEFAULT_LOCATION);
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const location = { latitude: coords.latitude, longitude: coords.longitude, label: "現在地" };
      saveLocation(location);
      fetchForecast(location);
    },
    () => fetchForecast(DEFAULT_LOCATION),
    { enableHighAccuracy: false, timeout: 9000, maximumAge: 10 * 60 * 1000 },
  );
}

async function searchLocations(query) {
  refs.searchResults.innerHTML = '<p class="empty-state">検索しています。</p>';
  try {
    const params = new URLSearchParams({ name: query, count: "6", language: "ja", format: "json" });
    const response = await fetch(`${GEOCODING_URL}?${params}`);
    if (!response.ok) throw new Error("検索に失敗しました。");
    const data = await response.json();
    if (!data.results?.length) {
      refs.searchResults.innerHTML = '<p class="empty-state">一致する場所が見つかりませんでした。</p>';
      return;
    }
    refs.searchResults.innerHTML = data.results
      .map(
        (result, index) => `
          <button class="result-button" type="button" data-result-index="${index}">
            <strong>${result.name}</strong>
            <span>${[result.admin1, result.country].filter(Boolean).join("、")}</span>
          </button>
        `,
      )
      .join("");
    refs.searchResults.querySelectorAll("[data-result-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const result = data.results[Number(button.dataset.resultIndex)];
        refs.locationDialog.close();
        const location = {
          latitude: result.latitude,
          longitude: result.longitude,
          label: [result.name, result.admin1].filter(Boolean).join("、"),
        };
        saveLocation(location);
        fetchForecast(location);
      });
    });
  } catch (error) {
    refs.searchResults.innerHTML = `<p class="empty-state">${error.message}</p>`;
  }
}

function scheduleAlertNotification() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const alert = findUpcomingAlert();
  if (!alert) return;
  const item = state.hourly[state.currentIndex + alert.offset];
  const key = `${state.location.label}-${item.time}`;
  if (localStorage.getItem("pressure-care-last-notification") === key) return;
  const options = {
    body: `${formatForecastDateTime(item.time)}ごろから頭痛やだるさに注意。早めの休息を意識しましょう。`,
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: "pressure-care-alert",
    renotify: true,
    data: { url: "./" },
  };
  if (serviceWorkerRegistration) serviceWorkerRegistration.showNotification("気圧ケア: 不調リスク警告", options);
  else new Notification("気圧ケア: 不調リスク警告", options);
  localStorage.setItem("pressure-care-last-notification", key);
}

function updateNotificationButton() {
  if (!("Notification" in window)) {
    refs.notificationButton.textContent = "通知非対応";
    refs.notificationButton.disabled = true;
    refs.notificationStatus.textContent = "このブラウザでは通知を利用できません。";
  } else if (Notification.permission === "granted") {
    refs.notificationButton.textContent = "通知は有効";
    refs.notificationButton.disabled = true;
    refs.notificationStatus.textContent = "通知は有効です。起動中は15分ごとに警戒時間を確認します。";
  } else if (Notification.permission === "denied") {
    refs.notificationButton.textContent = "通知はブロック中";
    refs.notificationButton.disabled = true;
    refs.notificationStatus.textContent = "Chromeのサイト設定から通知を許可してください。";
  }
}

refs.refreshButton.addEventListener("click", () => (state.location ? fetchForecast(state.location) : locateCurrentPosition()));
refs.locationButton.addEventListener("click", () => refs.locationDialog.showModal());
refs.locationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return refs.locationDialog.close();
  const query = refs.locationInput.value.trim();
  if (query.length >= 2) searchLocations(query);
});
refs.useCurrentLocationButton.addEventListener("click", () => {
  refs.locationDialog.close();
  locateCurrentPosition();
});
refs.notificationButton.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  updateNotificationButton();
  scheduleAlertNotification();
});
refs.navNotificationButton.addEventListener("click", () => refs.notificationButton.click());
refs.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  refs.installCard.hidden = true;
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  refs.installButton.disabled = false;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  refs.installCard.hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      serviceWorkerRegistration = registration;
    })
    .catch(() => {});
}
updateNotificationButton();
refs.installButton.disabled = true;
const savedLocation = JSON.parse(localStorage.getItem("pressure-care-location") || "null");
if (savedLocation) {
  saveLocation(savedLocation);
  fetchForecast(savedLocation);
}
else locateCurrentPosition();

setInterval(() => {
  if (state.location) fetchForecast(state.location);
}, 15 * 60 * 1000);
