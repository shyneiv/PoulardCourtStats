const STORAGE_KEY = "courtstats.games.v1";

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function extractYouTubeId(input) {
  const s = (input || "").trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$/i);
  return m ? (m[1] || m[2]) : null;
}

function newGame(partial = {}) {
  const n = (load().games?.length || 0) + 1;
  return {
    id: uid(),
    title: partial.title || `Game ${n}`,
    homeName: partial.homeName || "HOME",
    awayName: partial.awayName || "AWAY",
    homeScore: 0,
    awayScore: 0,
    period: "1",
    youtubeURL: "",
    videoID: null,
    leadChanges: 0,
    largestLeadHome: 0,
    largestLeadAway: 0,
    events: [],
    createdAt: Date.now(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const g = newGame({ title: "Game 1" });
      return { games: [g], selectedId: g.id, tab: "dash" };
    }
    return JSON.parse(raw);
  } catch {
    const g = newGame({ title: "Game 1" });
    return { games: [g], selectedId: g.id, tab: "dash" };
  }
}

let state = load();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function selected() {
  return state.games.find((g) => g.id === state.selectedId) || state.games[0];
}

function addPoints(game, toHome, points) {
  const oldMargin = game.homeScore - game.awayScore;
  if (toHome) game.homeScore += points;
  else game.awayScore += points;
  const newMargin = game.homeScore - game.awayScore;
  let note = `${toHome ? game.homeName : game.awayName} +${points}`;
  if ((oldMargin <= 0 && newMargin > 0) || (oldMargin >= 0 && newMargin < 0) || (oldMargin === 0 && newMargin !== 0)) {
    game.leadChanges += 1;
    note += " • LEAD CHANGE";
  }
  if (newMargin > game.largestLeadHome) game.largestLeadHome = newMargin;
  if (-newMargin > game.largestLeadAway) game.largestLeadAway = -newMargin;
  game.events.unshift({
    id: uid(),
    t: Date.now(),
    home: game.homeScore,
    away: game.awayScore,
    dH: toHome ? points : 0,
    dA: toHome ? 0 : points,
    note,
    period: game.period,
  });
  save();
  render();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function render() {
  const root = document.getElementById("app");
  const game = selected();
  const tab = state.tab || "dash";

  root.innerHTML = `
    <div class="app">
      <div class="top">
        <div>
          <h1>CourtStats</h1>
          <div class="muted">${state.games.length} game${state.games.length === 1 ? "" : "s"} saved on this phone</div>
        </div>
        <button class="btn btn-primary" id="addGame">+ Game</button>
      </div>
      ${tab === "dash" ? renderDash() : ""}
      ${tab === "score" && game ? renderScore(game) : ""}
      ${tab === "watch" && game ? renderWatch(game) : ""}
      ${tab === "log" && game ? renderLog(game) : ""}
    </div>
    <nav class="tabs">
      <button data-tab="dash" class="${tab === "dash" ? "on" : ""}">Dashboard</button>
      <button data-tab="score" class="${tab === "score" ? "on" : ""}">Score</button>
      <button data-tab="watch" class="${tab === "watch" ? "on" : ""}">Watch</button>
      <button data-tab="log" class="${tab === "log" ? "on" : ""}">Log</button>
    </nav>
  `;

  root.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; save(); render(); };
  });
  document.getElementById("addGame").onclick = () => {
    const g = {
      id: uid(),
      title: `Game ${state.games.length + 1}`,
      homeName: "HOME",
      awayName: "AWAY",
      homeScore: 0,
      awayScore: 0,
      period: "1",
      youtubeURL: "",
      videoID: null,
      leadChanges: 0,
      largestLeadHome: 0,
      largestLeadAway: 0,
      events: [],
      createdAt: Date.now(),
    };
    state.games.unshift(g);
    state.selectedId = g.id;
    state.tab = "dash";
    save();
    render();
  };

  bindDash();
  bindScore();
  bindWatch();
}

function cardHTML(g) {
  const active = g.id === state.selectedId ? "active" : "";
  return `
    <article class="card ${active}" data-id="${g.id}">
      <div class="row spread">
        <div>
          <strong>${escapeHtml(g.title)}</strong>
          <div class="muted">P${g.period} • ${g.events.length} plays</div>
        </div>
        <button class="btn btn-danger del" data-id="${g.id}">Delete</button>
      </div>
      <div class="score">
        <div class="team home">
          <input class="nm-home" data-id="${g.id}" value="${escapeHtml(g.homeName)}" />
          <div class="num">${g.homeScore}</div>
        </div>
        <div class="muted">–</div>
        <div class="team away">
          <input class="nm-away" data-id="${g.id}" value="${escapeHtml(g.awayName)}" />
          <div class="num">${g.awayScore}</div>
        </div>
      </div>
      <select class="period per" data-id="${g.id}">
        ${["1","2","3","4","OT"].map((p) => `<option ${g.period===p?"selected":""}>${p}</option>`).join("")}
      </select>
      <div class="row">
        <div class="pts">${[1,2,3].map((n) => `<button data-id="${g.id}" data-side="home" data-pts="${n}">+${n}</button>`).join("")}</div>
        <div class="pts away">${[1,2,3].map((n) => `<button data-id="${g.id}" data-side="away" data-pts="${n}">+${n}</button>`).join("")}</div>
      </div>
    </article>
  `;
}

function renderDash() {
  return `<div class="grid">${state.games.map(cardHTML).join("")}</div>`;
}

function renderScore(g) {
  return `
    <div class="card">
      <input id="title" value="${escapeHtml(g.title)}" />
      <div class="score">
        <div class="team home">
          <input id="homeName" value="${escapeHtml(g.homeName)}" />
          <div class="num">${g.homeScore}</div>
        </div>
        <div>–</div>
        <div class="team away">
          <input id="awayName" value="${escapeHtml(g.awayName)}" />
          <div class="num">${g.awayScore}</div>
        </div>
      </div>
      <div class="muted">Margin ${g.homeScore - g.awayScore >= 0 ? "+" : ""}${g.homeScore - g.awayScore} • ${g.leadChanges} lead changes</div>
      <select class="period" id="period">
        ${["1","2","3","4","OT"].map((p) => `<option ${g.period===p?"selected":""}>${p}</option>`).join("")}
      </select>
      <p class="muted">${escapeHtml(g.homeName)}</p>
      <div class="pts">${[1,2,3].map((n) => `<button data-side="home" data-pts="${n}">+${n}</button>`).join("")}</div>
      <p class="muted">${escapeHtml(g.awayName)}</p>
      <div class="pts away">${[1,2,3].map((n) => `<button data-side="away" data-pts="${n}">+${n}</button>`).join("")}</div>
      <p><button class="btn btn-danger" id="reset">Reset this game</button></p>
    </div>
  `;
}

function renderWatch(g) {
  const src = g.videoID ? `https://www.youtube.com/embed/${g.videoID}?playsinline=1&rel=0` : "";
  return `
    <div class="card">
      <div class="muted">${escapeHtml(g.title)}</div>
      <div class="row" style="margin-top:8px">
        <input id="yt" placeholder="Paste YouTube URL or video ID" value="${escapeHtml(g.youtubeURL)}" />
        <button class="btn btn-primary" id="loadYt">Play</button>
      </div>
      <div class="player">${src ? `<iframe src="${src}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe>` : `<div class="muted" style="padding:48px;text-align:center">Paste a YouTube link for this game</div>`}</div>
      <div class="muted">Use Dashboard or Score to tap +1 / +2 / +3 while the game plays.</div>
    </div>
  `;
}

function renderLog(g) {
  if (!g.events.length) return `<div class="card muted">No scoring events yet.</div>`;
  return `
    <div class="card">
      <div class="muted">${escapeHtml(g.title)} • largest leads ${g.largestLeadHome} / ${g.largestLeadAway}</div>
      <ul class="log">
        ${g.events.map((e) => `<li>
          <strong class="home">${e.home}</strong> – <strong class="away">${e.away}</strong>
          <div class="muted">${escapeHtml(e.note)} • P${e.period} • ${fmtTime(e.t)}</div>
        </li>`).join("")}
      </ul>
    </div>
  `;
}

function bindDash() {
  document.querySelectorAll(".pts button[data-id]").forEach((b) => {
    b.onclick = () => {
      const g = state.games.find((x) => x.id === b.dataset.id);
      if (!g) return;
      state.selectedId = g.id;
      addPoints(g, b.dataset.side === "home", Number(b.dataset.pts));
    };
  });
  document.querySelectorAll(".del").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Delete this game?")) return;
      state.games = state.games.filter((g) => g.id !== b.dataset.id);
      if (!state.games.length) state.games = [{ ...newGame({ title: "Game 1" }), id: uid() }];
      if (!state.games.some((g) => g.id === state.selectedId)) state.selectedId = state.games[0].id;
      save(); render();
    };
  });
  document.querySelectorAll(".nm-home").forEach((i) => i.oninput = () => { find(i.dataset.id).homeName = i.value; save(); });
  document.querySelectorAll(".nm-away").forEach((i) => i.oninput = () => { find(i.dataset.id).awayName = i.value; save(); });
  document.querySelectorAll(".per").forEach((i) => i.onchange = () => { find(i.dataset.id).period = i.value; save(); });
  document.querySelectorAll(".card[data-id]").forEach((c) => {
    c.onclick = (e) => {
      if (e.target.closest("button, input, select")) return;
      state.selectedId = c.dataset.id; save(); render();
    };
  });
}

function find(id) { return state.games.find((g) => g.id === id); }

function bindScore() {
  const g = selected();
  if (!g || state.tab !== "score") return;
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.oninput = () => { fn(el.value); save(); }; };
  bind("title", (v) => g.title = v);
  bind("homeName", (v) => g.homeName = v);
  bind("awayName", (v) => g.awayName = v);
  const per = document.getElementById("period");
  if (per) per.onchange = () => { g.period = per.value; save(); };
  document.querySelectorAll(".card .pts button[data-side]").forEach((b) => {
    b.onclick = () => addPoints(g, b.dataset.side === "home", Number(b.dataset.pts));
  });
  const reset = document.getElementById("reset");
  if (reset) reset.onclick = () => {
    if (!confirm("Reset scores and events?")) return;
    g.homeScore = 0; g.awayScore = 0; g.period = "1"; g.events = []; g.leadChanges = 0; g.largestLeadHome = 0; g.largestLeadAway = 0;
    save(); render();
  };
}

function bindWatch() {
  const g = selected();
  if (!g || state.tab !== "watch") return;
  const load = document.getElementById("loadYt");
  if (load) load.onclick = () => {
    const url = document.getElementById("yt").value;
    g.youtubeURL = url;
    const id = extractYouTubeId(url);
    g.videoID = id;
    if (!id) alert("Could not find a valid YouTube video ID.");
    save(); render();
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

render();
