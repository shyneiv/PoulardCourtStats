const STORAGE_KEY = "courtstats.games.v1";
const AI_STORAGE_KEY = "courtstats.ai.v1";

const STAT_KEYS = ["PTS","REB","AST","STL","BLK","TO","FGM","FGA","TPM","TPA","FTM","FTA","PF"];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function extractYouTubeId(input) {
  const s = (input || "").trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$/i);
  return m ? (m[1] || m[2]) : null;
}

function emptyStats() {
  const s = {};
  STAT_KEYS.forEach((k) => { s[k] = 0; });
  return s;
}

function makePlayer(name, i) {
  return { id: uid(), name: name || `Player ${i}`, ...emptyStats(), aiAssisted: false };
}

function defaultRoster(prefix) {
  return [1, 2, 3, 4, 5].map((i) => makePlayer(`${prefix} ${i}`, i));
}

function ensureRosters(game) {
  if (!Array.isArray(game.homeRoster) || !game.homeRoster.length) {
    game.homeRoster = defaultRoster("Player");
  }
  if (!Array.isArray(game.awayRoster) || !game.awayRoster.length) {
    game.awayRoster = defaultRoster("Player");
  }
  [...game.homeRoster, ...game.awayRoster].forEach((p) => {
    STAT_KEYS.forEach((k) => { if (typeof p[k] !== "number") p[k] = 0; });
    if (p.aiAssisted == null) p.aiAssisted = false;
  });
  return game;
}

function newGame(partial = {}) {
  // Do not call load() here — that caused infinite recursion on first visit
  // (empty localStorage → load → newGame → load → … → blank page).
  return {
    id: uid(),
    title: partial.title || "Game 1",
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
    homeRoster: defaultRoster("Player"),
    awayRoster: defaultRoster("Player"),
    selectedPlayerId: null,
    selectedSide: "home",
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
    const data = JSON.parse(raw);
    (data.games || []).forEach(ensureRosters);
    return data;
  } catch {
    const g = newGame({ title: "Game 1" });
    return { games: [g], selectedId: g.id, tab: "dash" };
  }
}

function loadAI() {
  try {
    const raw = localStorage.getItem(AI_STORAGE_KEY);
    if (!raw) return { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
    const d = JSON.parse(raw);
    return {
      apiKey: d.apiKey || "",
      baseUrl: d.baseUrl || "https://api.openai.com/v1",
      model: d.model || "gpt-4o-mini",
    };
  } catch {
    return { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  }
}

function saveAI(cfg) {
  localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(cfg));
}

let state = load();
let aiCfg = loadAI();
let aiBusy = false;
let aiStatus = "";
let showSettings = false;
let captureNote = "";

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function selected() {
  const g = state.games.find((g) => g.id === state.selectedId) || state.games[0];
  if (g) ensureRosters(g);
  return g;
}

function teamTotals(roster) {
  const t = emptyStats();
  (roster || []).forEach((p) => {
    STAT_KEYS.forEach((k) => { t[k] += Number(p[k]) || 0; });
  });
  return t;
}

function syncScoreFromRoster(game) {
  const homePts = teamTotals(game.homeRoster).PTS;
  const awayPts = teamTotals(game.awayRoster).PTS;
  // Only sync if roster PTS look intentional (non-zero somewhere) — keep manual score otherwise
  if (homePts > 0 || awayPts > 0) {
    game.homeScore = homePts;
    game.awayScore = awayPts;
  }
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

function bumpStat(game, side, playerId, key, delta) {
  const roster = side === "home" ? game.homeRoster : game.awayRoster;
  const p = roster.find((x) => x.id === playerId);
  if (!p) return;
  p[key] = Math.max(0, (Number(p[key]) || 0) + delta);
  if (key === "PTS") {
    if (side === "home") game.homeScore = Math.max(0, game.homeScore + delta);
    else game.awayScore = Math.max(0, game.awayScore + delta);
  }
  // FG helpers: make/miss also bump PTS when appropriate is handled by caller
  save();
  render();
}

function applyFg(game, side, playerId, kind, made) {
  const roster = side === "home" ? game.homeRoster : game.awayRoster;
  const p = roster.find((x) => x.id === playerId);
  if (!p) return;
  if (kind === "2") {
    p.FGA = (p.FGA || 0) + 1;
    if (made) { p.FGM = (p.FGM || 0) + 1; p.PTS = (p.PTS || 0) + 2; if (side === "home") game.homeScore += 2; else game.awayScore += 2; }
  } else if (kind === "3") {
    p.FGA = (p.FGA || 0) + 1;
    p.TPA = (p.TPA || 0) + 1;
    if (made) {
      p.FGM = (p.FGM || 0) + 1;
      p.TPM = (p.TPM || 0) + 1;
      p.PTS = (p.PTS || 0) + 3;
      if (side === "home") game.homeScore += 3; else game.awayScore += 3;
    }
  } else if (kind === "ft") {
    p.FTA = (p.FTA || 0) + 1;
    if (made) {
      p.FTM = (p.FTM || 0) + 1;
      p.PTS = (p.PTS || 0) + 1;
      if (side === "home") game.homeScore += 1; else game.awayScore += 1;
    }
  }
  game.events.unshift({
    id: uid(),
    t: Date.now(),
    home: game.homeScore,
    away: game.awayScore,
    dH: 0, dA: 0,
    note: `${p.name}: ${kind.toUpperCase()} ${made ? "MAKE" : "MISS"}`,
    period: game.period,
  });
  save();
  render();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pct(m, a) {
  if (!a) return "—";
  return Math.round((m / a) * 100) + "%";
}

function mergeAIRoster(existing, incoming, sideLabel) {
  const byName = new Map();
  existing.forEach((p) => byName.set(String(p.name || "").trim().toLowerCase(), p));
  const notes = [];
  (incoming || []).forEach((row) => {
    const name = String(row.name || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    let p = byName.get(key);
    if (!p) {
      p = makePlayer(name);
      existing.push(p);
      byName.set(key, p);
      notes.push(`Added ${sideLabel} ${name}`);
    }
    STAT_KEYS.forEach((k) => {
      if (row[k] != null && row[k] !== "") {
        const n = Number(row[k]);
        if (!Number.isNaN(n)) p[k] = n;
      }
    });
    p.aiAssisted = true;
  });
  return notes;
}

function parseAIJson(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function runAICapture(game, file, note) {
  if (!aiCfg.apiKey) {
    aiStatus = "Set your API key in Settings first.";
    showSettings = true;
    render();
    return;
  }
  if (!file) {
    aiStatus = "Choose or take a photo of the scorebug / box score graphic.";
    render();
    return;
  }
  aiBusy = true;
  aiStatus = "Reading graphic with AI…";
  render();
  try {
    const dataUrl = await fileToDataUrl(file);
    const base = (aiCfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const system = `You are a basketball box-score OCR assistant. Read scorebugs, broadcast graphics, and box score images.
Return STRICT JSON only (no markdown) with this shape:
{"home":[{"name":"","PTS":0,"REB":0,"AST":0,"STL":0,"BLK":0,"TO":0,"FGM":0,"FGA":0,"TPM":0,"TPA":0,"FTM":0,"FTA":0,"PF":0}],"away":[...],"homeScore":0,"awayScore":0,"note":""}
Use integers. Omit unknown stats as 0. Prefer player names as shown on screen.
Current home team: ${game.homeName}. Current away team: ${game.awayName}.
Known home players: ${game.homeRoster.map((p) => p.name).join(", ")}.
Known away players: ${game.awayRoster.map((p) => p.name).join(", ")}.`;
    const userText = note
      ? `Optional note from user: ${note}\nExtract / update the box score JSON.`
      : "Extract / update the box score JSON from this image.";

    const body = {
      model: aiCfg.model || "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiCfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    const data = parseAIJson(content);
    const notes = [];
    notes.push(...mergeAIRoster(game.homeRoster, data.home, game.homeName));
    notes.push(...mergeAIRoster(game.awayRoster, data.away, game.awayName));
    if (data.homeScore != null && data.homeScore !== "") game.homeScore = Number(data.homeScore) || game.homeScore;
    else game.homeScore = teamTotals(game.homeRoster).PTS;
    if (data.awayScore != null && data.awayScore !== "") game.awayScore = Number(data.awayScore) || game.awayScore;
    else game.awayScore = teamTotals(game.awayRoster).PTS;
    const summary = data.note || notes.join("; ") || "AI box score update";
    game.events.unshift({
      id: uid(),
      t: Date.now(),
      home: game.homeScore,
      away: game.awayScore,
      dH: 0, dA: 0,
      note: `AI Capture: ${summary}`,
      period: game.period,
      ai: true,
    });
    aiStatus = "AI update applied — verify stats.";
    captureNote = "";
    save();
  } catch (e) {
    aiStatus = `AI failed: ${e.message || e}`;
  } finally {
    aiBusy = false;
    render();
  }
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
        <div class="row">
          <button class="btn btn-ghost" id="openSettings" title="AI settings">⚙</button>
          <button class="btn btn-primary" id="addGame">+ Game</button>
        </div>
      </div>
      ${showSettings ? renderSettings() : ""}
      ${tab === "dash" ? renderDash() : ""}
      ${tab === "score" && game ? renderScore(game) : ""}
      ${tab === "box" && game ? renderBox(game) : ""}
      ${tab === "watch" && game ? renderWatch(game) : ""}
      ${tab === "log" && game ? renderLog(game) : ""}
    </div>
    <nav class="tabs">
      <button data-tab="dash" class="${tab === "dash" ? "on" : ""}">Dash</button>
      <button data-tab="score" class="${tab === "score" ? "on" : ""}">Score</button>
      <button data-tab="box" class="${tab === "box" ? "on" : ""}">Box</button>
      <button data-tab="watch" class="${tab === "watch" ? "on" : ""}">Watch</button>
      <button data-tab="log" class="${tab === "log" ? "on" : ""}">Log</button>
    </nav>
  `;

  root.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; save(); render(); };
  });
  document.getElementById("addGame").onclick = () => {
    const g = newGame({ title: `Game ${state.games.length + 1}` });
    state.games.unshift(g);
    state.selectedId = g.id;
    state.tab = "dash";
    save();
    render();
  };
  const setBtn = document.getElementById("openSettings");
  if (setBtn) setBtn.onclick = () => { showSettings = !showSettings; render(); };

  bindSettings();
  bindDash();
  bindScore();
  bindBox();
  bindWatch();
}

function renderSettings() {
  return `
    <div class="card settings-panel">
      <div class="row spread">
        <strong>AI Settings</strong>
        <button class="btn btn-ghost" id="closeSettings">Close</button>
      </div>
      <p class="muted">Stored only in this browser (localStorage). OpenAI-compatible Chat Completions + vision.</p>
      <label class="field"><span>API key</span>
        <input type="password" id="aiKey" placeholder="sk-…" value="${escapeHtml(aiCfg.apiKey)}" autocomplete="off" />
      </label>
      <label class="field"><span>Base URL</span>
        <input type="text" id="aiBase" value="${escapeHtml(aiCfg.baseUrl)}" />
      </label>
      <label class="field"><span>Model</span>
        <input type="text" id="aiModel" value="${escapeHtml(aiCfg.model)}" />
      </label>
      <button class="btn btn-primary" id="saveAI">Save</button>
      ${aiCfg.apiKey ? `<div class="muted ok">Key saved (${aiCfg.apiKey.length} chars)</div>` : `<div class="muted">No key yet — AI Capture disabled</div>`}
    </div>
  `;
}

function bindSettings() {
  const close = document.getElementById("closeSettings");
  if (close) close.onclick = () => { showSettings = false; render(); };
  const saveBtn = document.getElementById("saveAI");
  if (saveBtn) saveBtn.onclick = () => {
    aiCfg = {
      apiKey: document.getElementById("aiKey").value.trim(),
      baseUrl: document.getElementById("aiBase").value.trim() || "https://api.openai.com/v1",
      model: document.getElementById("aiModel").value.trim() || "gpt-4o-mini",
    };
    saveAI(aiCfg);
    aiStatus = "AI settings saved.";
    showSettings = false;
    render();
  };
}

function cardHTML(g) {
  ensureRosters(g);
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

function rosterEditor(side, g) {
  const roster = side === "home" ? g.homeRoster : g.awayRoster;
  const label = side === "home" ? g.homeName : g.awayName;
  const cls = side === "home" ? "home" : "away";
  return `
    <div class="roster-block">
      <div class="row spread">
        <strong class="${cls}">${escapeHtml(label)} roster</strong>
        <button class="btn btn-ghost add-player" data-side="${side}">+ Player</button>
      </div>
      <div class="roster-chips">
        ${roster.map((p) => `
          <div class="chip ${g.selectedPlayerId === p.id && g.selectedSide === side ? "sel" : ""}" data-side="${side}" data-pid="${p.id}">
            <input class="chip-name" data-side="${side}" data-pid="${p.id}" value="${escapeHtml(p.name)}" />
            <button class="chip-del" data-side="${side}" data-pid="${p.id}" title="Remove">×</button>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function boxTable(side, g) {
  const roster = side === "home" ? g.homeRoster : g.awayRoster;
  const label = side === "home" ? g.homeName : g.awayName;
  const cls = side === "home" ? "home" : "away";
  const tot = teamTotals(roster);
  const anyAI = roster.some((p) => p.aiAssisted);
  return `
    <div class="card box-card">
      <div class="row spread">
        <strong class="${cls}">${escapeHtml(label)}</strong>
        <span class="num sm ${cls}">${side === "home" ? g.homeScore : g.awayScore}</span>
      </div>
      ${anyAI ? `<div class="ai-badge">AI-assisted — verify</div>` : ""}
      <div class="table-wrap">
        <table class="box-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th>
              <th>FG</th><th>3P</th><th>FT</th><th>PF</th>
            </tr>
          </thead>
          <tbody>
            ${roster.map((p) => `
              <tr class="${g.selectedPlayerId === p.id && g.selectedSide === side ? "sel" : ""} ${p.aiAssisted ? "ai-row" : ""}" data-side="${side}" data-pid="${p.id}">
                <td class="name">${escapeHtml(p.name)}${p.aiAssisted ? ' <span class="ai-dot" title="AI-assisted">✦</span>' : ""}</td>
                <td>${p.PTS}</td><td>${p.REB}</td><td>${p.AST}</td><td>${p.STL}</td><td>${p.BLK}</td><td>${p.TO}</td>
                <td>${p.FGM}-${p.FGA}</td><td>${p.TPM}-${p.TPA}</td><td>${p.FTM}-${p.FTA}</td><td>${p.PF}</td>
              </tr>
            `).join("")}
            <tr class="totals">
              <td>TEAM</td>
              <td>${tot.PTS}</td><td>${tot.REB}</td><td>${tot.AST}</td><td>${tot.STL}</td><td>${tot.BLK}</td><td>${tot.TO}</td>
              <td>${tot.FGM}-${tot.FGA}</td><td>${tot.TPM}-${tot.TPA}</td><td>${tot.FTM}-${tot.FTA}</td><td>${tot.PF}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function statPad(g) {
  const side = g.selectedSide || "home";
  const roster = side === "home" ? g.homeRoster : g.awayRoster;
  const p = roster.find((x) => x.id === g.selectedPlayerId) || roster[0];
  if (!p) return `<div class="card muted">Add a player to start tracking.</div>`;
  g.selectedPlayerId = p.id;
  g.selectedSide = side;
  return `
    <div class="card stat-pad">
      <div class="muted">Selected · ${escapeHtml(side === "home" ? g.homeName : g.awayName)}</div>
      <strong>${escapeHtml(p.name)}</strong>
      <div class="stat-grid">
        ${["PTS","REB","AST","STL","BLK","TO","PF"].map((k) => `
          <div class="stat-cell">
            <button class="stat-btn" data-stat="${k}" data-d="1">+${k}</button>
            <button class="stat-btn dim" data-stat="${k}" data-d="-1">−</button>
          </div>
        `).join("")}
      </div>
      <div class="fg-row">
        <button class="btn btn-ghost fg" data-fg="2" data-made="1">2✓</button>
        <button class="btn btn-ghost fg" data-fg="2" data-made="0">2✗</button>
        <button class="btn btn-ghost fg" data-fg="3" data-made="1">3✓</button>
        <button class="btn btn-ghost fg" data-fg="3" data-made="0">3✗</button>
        <button class="btn btn-ghost fg" data-fg="ft" data-made="1">FT✓</button>
        <button class="btn btn-ghost fg" data-fg="ft" data-made="0">FT✗</button>
      </div>
    </div>
  `;
}

function renderBox(g) {
  return `
    ${rosterEditor("home", g)}
    ${rosterEditor("away", g)}
    ${boxTable("home", g)}
    ${boxTable("away", g)}
    ${statPad(g)}
    <div class="card">
      <button class="btn btn-ghost" id="boxOpenSettings">AI Settings</button>
      <p class="muted">Tip: use Watch tab for YouTube + AI Capture of scorebugs.</p>
    </div>
  `;
}

function renderWatch(g) {
  const src = g.videoID
    ? `https://www.youtube.com/embed/${g.videoID}?playsinline=1&rel=0&enablejsapi=1`
    : "";
  return `
    <div class="card">
      <div class="muted">${escapeHtml(g.title)} · ${escapeHtml(g.homeName)} ${g.homeScore} – ${g.awayScore} ${escapeHtml(g.awayName)}</div>
      <div class="row" style="margin-top:8px">
        <input id="yt" type="text" placeholder="Paste YouTube URL or video ID" value="${escapeHtml(g.youtubeURL)}" />
        <button class="btn btn-primary" id="loadYt">Play</button>
      </div>
      <div class="player">${src ? `<iframe id="ytFrame" src="${src}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe>` : `<div class="muted" style="padding:48px;text-align:center">Paste a YouTube link for this game</div>`}</div>
      <p class="muted warn">YouTube iframes can't be read by AI — screenshot / photo the scorebug, then use AI Capture below.</p>
    </div>
    ${rosterEditor("home", g)}
    ${rosterEditor("away", g)}
    <div class="side-toggle row">
      <button class="btn ${g.selectedSide === "home" ? "btn-primary" : "btn-ghost"} side-btn" data-side="home">${escapeHtml(g.homeName)}</button>
      <button class="btn ${g.selectedSide === "away" ? "btn-primary" : "btn-ghost"} side-btn" data-side="away">${escapeHtml(g.awayName)}</button>
    </div>
    <div class="roster-chips pick">
      ${(g.selectedSide === "away" ? g.awayRoster : g.homeRoster).map((p) => `
        <button class="chip-pick ${g.selectedPlayerId === p.id ? "sel" : ""}" data-pid="${p.id}">${escapeHtml(p.name)}</button>
      `).join("")}
    </div>
    ${statPad(g)}
    ${boxTable("home", g)}
    ${boxTable("away", g)}
    <div class="card capture-card">
      <strong>AI Capture</strong>
      <p class="muted">Upload or take a photo of the broadcast scorebug / box score graphic.</p>
      <input type="file" id="aiFile" accept="image/*" capture="environment" />
      <label class="field"><span>Optional note</span>
        <input type="text" id="aiNote" placeholder="e.g. end of Q3 box score" value="${escapeHtml(captureNote)}" />
      </label>
      <button class="btn btn-primary capture-btn" id="aiRun" ${aiBusy ? "disabled" : ""}>${aiBusy ? "Working…" : "✦ AI Capture"}</button>
      <button class="btn btn-ghost" id="watchOpenSettings">Settings</button>
      ${aiStatus ? `<div class="ai-status">${escapeHtml(aiStatus)}</div>` : ""}
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
          <div class="muted">${e.ai ? "✦ " : ""}${escapeHtml(e.note)} • P${e.period} • ${fmtTime(e.t)}</div>
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
      if (!state.games.length) state.games = [newGame({ title: "Game 1" })];
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
    if (!confirm("Reset scores, events, and box stats?")) return;
    g.homeScore = 0; g.awayScore = 0; g.period = "1"; g.events = [];
    g.leadChanges = 0; g.largestLeadHome = 0; g.largestLeadAway = 0;
    g.homeRoster = defaultRoster("Player");
    g.awayRoster = defaultRoster("Player");
    g.selectedPlayerId = null;
    save(); render();
  };
}

function bindRosterCommon(g) {
  document.querySelectorAll(".add-player").forEach((b) => {
    b.onclick = () => {
      const side = b.dataset.side;
      const roster = side === "home" ? g.homeRoster : g.awayRoster;
      const p = makePlayer(`Player ${roster.length + 1}`);
      roster.push(p);
      g.selectedSide = side;
      g.selectedPlayerId = p.id;
      save(); render();
    };
  });
  document.querySelectorAll(".chip-name").forEach((i) => {
    i.oninput = () => {
      const roster = i.dataset.side === "home" ? g.homeRoster : g.awayRoster;
      const p = roster.find((x) => x.id === i.dataset.pid);
      if (p) { p.name = i.value; save(); }
    };
    i.onclick = (e) => e.stopPropagation();
  });
  document.querySelectorAll(".chip-del").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const side = b.dataset.side;
      let roster = side === "home" ? g.homeRoster : g.awayRoster;
      if (roster.length <= 1) return alert("Keep at least one player.");
      if (side === "home") g.homeRoster = roster.filter((p) => p.id !== b.dataset.pid);
      else g.awayRoster = roster.filter((p) => p.id !== b.dataset.pid);
      if (g.selectedPlayerId === b.dataset.pid) g.selectedPlayerId = null;
      save(); render();
    };
  });
  document.querySelectorAll(".chip[data-pid], .box-table tbody tr[data-pid]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("input, button")) return;
      g.selectedSide = el.dataset.side;
      g.selectedPlayerId = el.dataset.pid;
      save(); render();
    };
  });
  document.querySelectorAll(".stat-btn").forEach((b) => {
    b.onclick = () => {
      const side = g.selectedSide || "home";
      const pid = g.selectedPlayerId;
      if (!pid) return;
      bumpStat(g, side, pid, b.dataset.stat, Number(b.dataset.d));
    };
  });
  document.querySelectorAll(".fg").forEach((b) => {
    b.onclick = () => {
      const side = g.selectedSide || "home";
      const pid = g.selectedPlayerId;
      if (!pid) return;
      applyFg(g, side, pid, b.dataset.fg, b.dataset.made === "1");
    };
  });
}

function bindBox() {
  const g = selected();
  if (!g || state.tab !== "box") return;
  bindRosterCommon(g);
  const s = document.getElementById("boxOpenSettings");
  if (s) s.onclick = () => { showSettings = true; render(); };
}

function bindWatch() {
  const g = selected();
  if (!g || state.tab !== "watch") return;
  bindRosterCommon(g);
  document.querySelectorAll(".side-btn").forEach((b) => {
    b.onclick = () => {
      g.selectedSide = b.dataset.side;
      const roster = g.selectedSide === "home" ? g.homeRoster : g.awayRoster;
      if (!roster.some((p) => p.id === g.selectedPlayerId)) g.selectedPlayerId = roster[0]?.id || null;
      save(); render();
    };
  });
  document.querySelectorAll(".chip-pick").forEach((b) => {
    b.onclick = () => { g.selectedPlayerId = b.dataset.pid; save(); render(); };
  });
  const load = document.getElementById("loadYt");
  if (load) load.onclick = () => {
    const url = document.getElementById("yt").value;
    g.youtubeURL = url;
    const id = extractYouTubeId(url);
    g.videoID = id;
    if (!id) alert("Could not find a valid YouTube video ID.");
    save(); render();
  };
  const noteEl = document.getElementById("aiNote");
  if (noteEl) noteEl.oninput = () => { captureNote = noteEl.value; };
  const run = document.getElementById("aiRun");
  if (run) run.onclick = () => {
    const file = document.getElementById("aiFile")?.files?.[0];
    runAICapture(g, file, document.getElementById("aiNote")?.value || "");
  };
  const ws = document.getElementById("watchOpenSettings");
  if (ws) ws.onclick = () => { showSettings = true; render(); };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

render();
