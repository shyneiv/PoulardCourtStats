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

function makePlayer(name, i, jersey) {
  const p = { id: uid(), name: name || `Player ${i}`, jersey: jersey != null && jersey !== "" ? String(jersey) : "", ...emptyStats(), aiAssisted: false };
  return p;
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
    if (p.jersey == null) p.jersey = "";
    else p.jersey = String(p.jersey);
  });
  if (!Array.isArray(game.snapshots)) game.snapshots = [];
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
    snapshots: [],
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


function normalizeGeminiModel(m) {
  const model = (m || "").trim();
  const retired = new Set([
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ]);
  if (!model || retired.has(model)) return "gemini-3.6-flash";
  return model;
}

/** Prefer user model, then other Flash variants when overloaded / missing. */
function geminiModelFallbackChain(preferred) {
  const primary = normalizeGeminiModel(preferred);
  const candidates = [
    primary,
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest",
  ];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const n = normalizeGeminiModel(c);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGeminiStatus(status) {
  return status === 429 || status === 503 || status === 500;
}

function defaultAI() {
  return {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    geminiKey: "",
    geminiModel: "gemini-3.6-flash",
  };
}

function loadAI() {
  try {
    const raw = localStorage.getItem(AI_STORAGE_KEY);
    if (!raw) return defaultAI();
    const d = JSON.parse(raw);
    return {
      apiKey: d.apiKey || "",
      baseUrl: d.baseUrl || "https://api.openai.com/v1",
      model: d.model || "gpt-4o-mini",
      geminiKey: d.geminiKey || "",
      geminiModel: normalizeGeminiModel(d.geminiModel),
    };
  } catch {
    return defaultAI();
  }
}

function saveAI(cfg) {
  localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(cfg));
  // Verify immediately so callers can detect private-mode / blocked storage
  const roundTrip = localStorage.getItem(AI_STORAGE_KEY);
  if (!roundTrip) throw new Error("Storage write failed");
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

function isPlaceholderPlayer(p) {
  return /^player\s*\d+$/i.test(String(p.name || "").trim());
}

function normalizeJersey(j) {
  if (j == null || j === "") return "";
  return String(j).trim().replace(/^#+/, "").replace(/\s+/g, "");
}

function formatRosterLabel(p) {
  const name = String(p.name || "").trim() || "Player";
  const j = normalizeJersey(p.jersey);
  return j ? `${name} (#${j})` : name;
}

function rosterPromptList(roster) {
  const real = (roster || []).filter((p) => !isPlaceholderPlayer(p) && !/^unassigned$/i.test(String(p.name || "").trim()));
  if (!real.length) return "(none yet — prefer names/numbers from the graphic)";
  return real.map(formatRosterLabel).join(", ");
}

function nameTokens(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Fuzzy name: exact, last-name, or shared significant token. */
function fuzzyNameMatch(existingName, incomingName) {
  const a = String(existingName || "").trim().toLowerCase();
  const b = String(incomingName || "").trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta[ta.length - 1] === tb[tb.length - 1] && ta[ta.length - 1].length >= 3) return true;
  const shared = ta.filter((t) => t.length >= 3 && tb.includes(t));
  return shared.length > 0;
}

function findRosterMatch(existing, row) {
  const jersey = normalizeJersey(row.jersey != null ? row.jersey : row.number != null ? row.number : row.num);
  if (jersey) {
    const byJ = existing.find((p) => normalizeJersey(p.jersey) === jersey && !isPlaceholderPlayer(p) && !/^unassigned$/i.test(p.name));
    if (byJ) return byJ;
  }
  const name = String(row.name || "").trim();
  if (!name) return null;
  const exact = existing.find((p) => String(p.name || "").trim().toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  return existing.find((p) => !isPlaceholderPlayer(p) && !/^unassigned$/i.test(p.name) && fuzzyNameMatch(p.name, name)) || null;
}

function mergeAIRoster(existing, incoming, sideLabel) {
  const notes = [];
  let addedReal = 0;
  (incoming || []).forEach((row) => {
    const name = String(row.name || "").trim();
    const jerseyIn = normalizeJersey(row.jersey != null ? row.jersey : row.number != null ? row.number : row.num);
    if (!name && !jerseyIn) return;
    if (name && /^player\s*\d+$/i.test(name)) return; // never import placeholders
    let p = findRosterMatch(existing, row);
    if (!p) {
      // Prefer known roster — only add if clearly a real name from graphic
      if (!name || /^unassigned$/i.test(name)) {
        // leave for reconcile / Unassigned
        return;
      }
      p = makePlayer(name, undefined, jerseyIn || undefined);
      existing.push(p);
      notes.push(`Added ${sideLabel} ${formatRosterLabel(p)}`);
      addedReal += 1;
    } else {
      if (jerseyIn && !normalizeJersey(p.jersey)) p.jersey = jerseyIn;
      else if (jerseyIn) p.jersey = jerseyIn;
      if (name && isPlaceholderPlayer(p)) p.name = name;
      else if (name && !fuzzyNameMatch(p.name, name) && normalizeJersey(p.jersey) && jerseyIn && normalizeJersey(p.jersey) === jerseyIn) {
        // jersey matched; keep roster name unless placeholder
      } else if (name && String(p.name).trim().toLowerCase() !== name.toLowerCase() && isPlaceholderPlayer(p)) {
        p.name = name;
      }
    }
    STAT_KEYS.forEach((k) => {
      if (row[k] != null && row[k] !== "") {
        const n = Number(row[k]);
        if (!Number.isNaN(n)) p[k] = Math.max(0, Math.round(n));
      }
    });
    p.aiAssisted = true;
  });
  // Drop default Player 1–5 rows once real names arrive
  if (addedReal > 0 || (incoming || []).some((r) => r && r.name && !/^player\s*\d+$/i.test(String(r.name)))) {
    for (let i = existing.length - 1; i >= 0; i--) {
      if (isPlaceholderPlayer(existing[i])) existing.splice(i, 1);
    }
  }
  return notes;
}

/** Make roster PTS sum match the official team score. */
function reconcileRosterToScore(roster, officialScore, sideLabel) {
  const notes = [];
  const target = Math.max(0, Math.round(Number(officialScore) || 0));
  let sum = teamTotals(roster).PTS;
  // Remove leftover placeholders with 0 contribution
  for (let i = roster.length - 1; i >= 0; i--) {
    if (isPlaceholderPlayer(roster[i]) && (Number(roster[i].PTS) || 0) === 0) roster.splice(i, 1);
  }
  sum = teamTotals(roster).PTS;
  const delta = target - sum;
  if (delta === 0) return notes;

  let unassigned = roster.find((p) => /^unassigned$/i.test(String(p.name || "").trim()));
  if (!unassigned) {
    unassigned = makePlayer("Unassigned");
    unassigned.aiAssisted = true;
    roster.push(unassigned);
  }
  unassigned.PTS = Math.max(0, (Number(unassigned.PTS) || 0) + delta);
  unassigned.aiAssisted = true;
  // If delta negative, we reduced unassigned; if still over, trim unassigned to 0 then leave mismatch note
  if (unassigned.PTS === 0 && delta < 0) {
    // try reducing from highest scorer cautiously — keep simple: leave mismatch flagged
  }
  sum = teamTotals(roster).PTS;
  if (sum !== target) {
    notes.push(`${sideLabel} PTS sum ${sum} ≠ score ${target}`);
  } else if (delta !== 0) {
    notes.push(`${sideLabel}: allocated ${delta > 0 ? "+" : ""}${delta} PTS to Unassigned so lineup matches score ${target}`);
  }
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
{"home":[{"name":"","jersey":"","PTS":0,"REB":0,"AST":0,"STL":0,"BLK":0,"TO":0,"FGM":0,"FGA":0,"TPM":0,"TPA":0,"FTM":0,"FTA":0,"PF":0}],"away":[...],"homeScore":0,"awayScore":0,"note":""}
Use integers. Omit unknown stats as 0. Include jersey as a string/number when visible (e.g. "23").
MATCHING RULES: Match by jersey number FIRST (normalize #23 and 23), then by name. Prefer the known roster below. Only add a new player if they clearly appear on the graphic. Put unmatched points on a player named "Unassigned".
Current home team: ${game.homeName}. Current away team: ${game.awayName}.
Known home players: ${rosterPromptList(game.homeRoster)}.
Known away players: ${rosterPromptList(game.awayRoster)}.`;
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
    const result = applyAIBoxResult(game, data, "AI Capture");
    aiStatus = result.matched
      ? `AI update applied — score ${game.homeScore}–${game.awayScore}, roster PTS match.`
      : `AI update applied — score ${game.homeScore}–${game.awayScore}, but roster PTS were ${result.homeSum}–${result.awaySum}. Check Unassigned.`;
    offerSnapshotAfterAI(game, "AI Capture");
    captureNote = "";
    save();
  } catch (e) {
    aiStatus = `AI failed: ${e.message || e}`;
  } finally {
    aiBusy = false;
    render();
  }
}

function youtubeWatchUrl(game) {
  const id = game.videoID || extractYouTubeId(game.youtubeURL);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function boxScorePrompt(game, mode) {
  const watchHint = mode === "youtube"
    ? `Watch and analyze this public basketball game YouTube video. Prioritize the official scorebug and any on-screen box score / player stat graphics. Use commentary only as a secondary cue.`
    : `Read scorebugs, broadcast graphics, and box score images.`;
  return `You are a basketball box-score assistant. ${watchHint}

CRITICAL ACCURACY RULES:
1. homeScore and awayScore MUST be the official team scores shown on the scorebug (or final score if the game is over).
2. For each team, the SUM of all player PTS MUST equal that team's homeScore/awayScore exactly.
3. If you cannot attribute every point to a named player, put the remaining points on a player named "Unassigned" so the sums still match.
4. Include only real players you can support from the video/graphic — never invent stars. Do not output placeholder names like "Player 1".
5. Use integers only. Unknown non-PTS stats may be 0. Include "jersey" when visible (string like "23").
6. home[] is ${game.homeName}; away[] is ${game.awayName}. Do not swap teams.
7. MATCHING: Match by jersey number FIRST (treat #23 and 23 as the same), then by name. Prefer the known roster. Only add a new player if they clearly appear on the graphic/video.

Return STRICT JSON only (no markdown) with this exact shape:
{"home":[{"name":"","jersey":"","PTS":0,"REB":0,"AST":0,"STL":0,"BLK":0,"TO":0,"FGM":0,"FGA":0,"TPM":0,"TPA":0,"FTM":0,"FTA":0,"PF":0}],"away":[{"name":"","jersey":"","PTS":0,"REB":0,"AST":0,"STL":0,"BLK":0,"TO":0,"FGM":0,"FGA":0,"TPM":0,"TPA":0,"FTM":0,"FTA":0,"PF":0}],"homeScore":0,"awayScore":0,"note":""}

Current home team: ${game.homeName}. Current away team: ${game.awayName}.
Known home players: ${rosterPromptList(game.homeRoster)}.
Known away players: ${rosterPromptList(game.awayRoster)}.
In note, mention the score source (scorebug/final graphic) and any uncertainty.`;
}

function applyAIBoxResult(game, data, label) {
  const notes = [];
  notes.push(...mergeAIRoster(game.homeRoster, data.home, game.homeName));
  notes.push(...mergeAIRoster(game.awayRoster, data.away, game.awayName));

  const homeOfficial = (data.homeScore != null && data.homeScore !== "")
    ? Math.max(0, Math.round(Number(data.homeScore)))
    : teamTotals(game.homeRoster).PTS;
  const awayOfficial = (data.awayScore != null && data.awayScore !== "")
    ? Math.max(0, Math.round(Number(data.awayScore)))
    : teamTotals(game.awayRoster).PTS;

  notes.push(...reconcileRosterToScore(game.homeRoster, homeOfficial, game.homeName));
  notes.push(...reconcileRosterToScore(game.awayRoster, awayOfficial, game.awayName));

  game.homeScore = homeOfficial;
  game.awayScore = awayOfficial;

  const homeSum = teamTotals(game.homeRoster).PTS;
  const awaySum = teamTotals(game.awayRoster).PTS;
  const matched = homeSum === game.homeScore && awaySum === game.awayScore;
  game.boxScoreAligned = matched;

  const summary = data.note || notes.join("; ") || `${label} box score update`;
  const scoreLine = `Score ${game.homeScore}–${game.awayScore}` + (matched
    ? " (roster PTS match)"
    : ` (roster PTS ${homeSum}–${awaySum} — check Unassigned)`);
  game.events.unshift({
    id: uid(),
    t: Date.now(),
    home: game.homeScore,
    away: game.awayScore,
    dH: 0, dA: 0,
    note: `${label}: ${scoreLine}. ${summary}`,
    period: game.period,
    ai: true,
  });
  return { summary, matched, homeSum, awaySum };
}

function deepCopyRoster(roster) {
  return (roster || []).map((p) => {
    const copy = { id: p.id, name: p.name, jersey: p.jersey != null ? String(p.jersey) : "", aiAssisted: !!p.aiAssisted };
    STAT_KEYS.forEach((k) => { copy[k] = Number(p[k]) || 0; });
    return copy;
  });
}

function ensureSnapshots(game) {
  if (!Array.isArray(game.snapshots)) game.snapshots = [];
  return game.snapshots;
}

function saveQuarterSnapshot(game, source, note) {
  ensureSnapshots(game);
  const snap = {
    id: uid(),
    period: String(game.period || "1"),
    t: Date.now(),
    homeScore: Number(game.homeScore) || 0,
    awayScore: Number(game.awayScore) || 0,
    homeRoster: deepCopyRoster(game.homeRoster),
    awayRoster: deepCopyRoster(game.awayRoster),
    note: note || "",
    source: source || "manual",
  };
  game.snapshots.unshift(snap);
  return snap;
}

function restoreQuarterSnapshot(game, snapId) {
  const snap = (game.snapshots || []).find((s) => s.id === snapId);
  if (!snap) return false;
  game.period = String(snap.period || game.period);
  game.homeScore = Number(snap.homeScore) || 0;
  game.awayScore = Number(snap.awayScore) || 0;
  game.homeRoster = deepCopyRoster(snap.homeRoster);
  game.awayRoster = deepCopyRoster(snap.awayRoster);
  game.selectedPlayerId = null;
  game.boxScoreAligned = undefined;
  return true;
}

function offerSnapshotAfterAI(game, label) {
  const period = String(game.period || "1");
  const qLabel = period === "OT" ? "OT" : `Q${period}`;
  if (confirm(`Save this as ${qLabel} snapshot?\n${game.homeScore}–${game.awayScore}`)) {
    saveQuarterSnapshot(game, label || "ai", captureNote || "");
    aiStatus = (aiStatus ? aiStatus + " · " : "") + `Saved ${qLabel} snapshot.`;
  }
}

async function callGeminiGenerate(model, body, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const errText = await res.text().catch(() => "");
  return { res, errText };
}

async function runGeminiYouTubeWatch(game) {
  if (!aiCfg.geminiKey) {
    aiStatus = "Set your Gemini API key in Settings first.";
    showSettings = true;
    render();
    return;
  }
  const ytUrl = youtubeWatchUrl(game);
  if (!ytUrl) {
    aiStatus = "Paste a public YouTube URL (or ID) and tap Play first.";
    render();
    return;
  }
  if (!game.videoID) {
    game.videoID = extractYouTubeId(game.youtubeURL);
    game.youtubeURL = game.youtubeURL || ytUrl;
  }
  aiBusy = true;
  aiStatus = "Gemini is watching the game… this can take a minute";
  render();
  try {
    const prompt = boxScorePrompt(game, "youtube");
    const body = {
      contents: [{
        parts: [
          { file_data: { file_uri: ytUrl } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const models = geminiModelFallbackChain(aiCfg.geminiModel);
    let lastErr = null;
    let json = null;
    let usedModel = models[0];

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      usedModel = model;
      // A few attempts per model for transient overload
      for (let attempt = 1; attempt <= 3; attempt++) {
        aiStatus = models.length > 1 && mi > 0
          ? `Busy on prior model — trying ${model} (attempt ${attempt}/3)…`
          : `Gemini (${model}) watching… attempt ${attempt}/3`;
        render();
        try {
          const { res, errText } = await callGeminiGenerate(model, body, aiCfg.geminiKey);
          if (!res.ok) {
            lastErr = new Error(`Gemini ${res.status}: ${errText.slice(0, 280)}`);
            if (res.status === 404) break; // try next model
            if (isRetryableGeminiStatus(res.status) && attempt < 3) {
              const wait = 1500 * attempt * attempt; // 1.5s, 6s, …
              aiStatus = `Gemini busy (${res.status}). Retrying in ${Math.round(wait / 1000)}s…`;
              render();
              await sleep(wait);
              continue;
            }
            if (isRetryableGeminiStatus(res.status)) break; // next model
            throw lastErr; // non-retryable
          }
          try { json = JSON.parse(errText); } catch {
            throw new Error("Gemini returned non-JSON response");
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3 && /Failed to fetch|NetworkError|network/i.test(String(e.message || e))) {
            await sleep(1500 * attempt);
            continue;
          }
          throw e;
        }
      }
      if (json) break;
    }

    if (!json) throw lastErr || new Error("Gemini unavailable after retries");

    const block = json.promptFeedback?.blockReason;
    if (block) throw new Error(`Gemini blocked: ${block}`);
    const content = (json.candidates || [])
      .map((c) => (c.content?.parts || []).map((p) => p.text || "").join(""))
      .join("\n")
      .trim();
    if (!content) {
      const finish = json.candidates?.[0]?.finishReason || "empty";
      throw new Error(`No content from Gemini (${finish})`);
    }
    const data = parseAIJson(content);
    const watchResult = applyAIBoxResult(game, data, "AI Watch");
    aiStatus = watchResult.matched
      ? `Gemini (${usedModel}) applied — score ${game.homeScore}–${game.awayScore}, roster PTS match.`
      : `Gemini (${usedModel}) applied — score ${game.homeScore}–${game.awayScore}; roster PTS ${watchResult.homeSum}–${watchResult.awaySum}. Check Unassigned.`;
    offerSnapshotAfterAI(game, "AI Watch");
    save();
  } catch (e) {
    aiStatus = `Gemini failed: ${e.message || e}`;
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
        <button type="button" class="btn btn-ghost" id="closeSettings">Close</button>
      </div>
      <p class="muted">Stored only in this browser (localStorage). Keys use text fields so iPhone Safari won’t drop them on Save.</p>
      <strong class="settings-sub">Screenshot AI Capture (OpenAI-compatible)</strong>
      <label class="field"><span>API key</span>
        <input type="text" id="aiKey" class="key-input" placeholder="sk-…" value="${escapeHtml(aiCfg.apiKey)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </label>
      <label class="field"><span>Base URL</span>
        <input type="text" id="aiBase" value="${escapeHtml(aiCfg.baseUrl)}" autocomplete="off" />
      </label>
      <label class="field"><span>Model</span>
        <input type="text" id="aiModel" value="${escapeHtml(aiCfg.model)}" autocomplete="off" />
      </label>
      ${aiCfg.apiKey ? `<div class="muted ok">OpenAI key saved (${aiCfg.apiKey.length} chars)</div>` : `<div class="muted">No OpenAI key — screenshot AI Capture disabled</div>`}
      <strong class="settings-sub">Gemini YouTube Watch</strong>
      <p class="muted">Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. YouTube videos must be <strong>public</strong>. Best on completed/VOD games; live/incomplete streams may fail or be incomplete. Analysis can take 30–120+ seconds.</p>
      <label class="field"><span>Gemini API key</span>
        <input type="text" id="geminiKey" class="key-input" placeholder="AIza…" value="${escapeHtml(aiCfg.geminiKey)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </label>
      <label class="field"><span>Gemini model</span>
        <input type="text" id="geminiModel" placeholder="gemini-3.6-flash" value="${escapeHtml(aiCfg.geminiModel)}" autocomplete="off" />
      </label>
      ${aiCfg.geminiKey ? `<div class="muted ok" id="geminiKeyStatus">Gemini key saved (${aiCfg.geminiKey.length} chars)</div>` : `<div class="muted" id="geminiKeyStatus">No Gemini key — Watch with AI disabled</div>`}
      <button type="button" class="btn btn-primary" id="saveAI">Save</button>
      <div class="muted" id="settingsSaveMsg"></div>
    </div>
  `;
}

function bindSettings() {
  const close = document.getElementById("closeSettings");
  if (close) close.onclick = () => { showSettings = false; render(); };
  const saveBtn = document.getElementById("saveAI");
  if (!saveBtn) return;

  const commitSave = () => {
    const aiKeyEl = document.getElementById("aiKey");
    const geminiKeyEl = document.getElementById("geminiKey");
    const msg = document.getElementById("settingsSaveMsg");
    // Blur first so mobile Safari commits pasted text into .value
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    const typedOpenAI = (aiKeyEl?.value || "").trim();
    const typedGemini = (geminiKeyEl?.value || "").trim();
    // Empty secret field means "keep existing" (iOS sometimes clears password/text fields visually)
    const next = {
      apiKey: typedOpenAI || aiCfg.apiKey || "",
      baseUrl: (document.getElementById("aiBase")?.value || "").trim() || "https://api.openai.com/v1",
      model: (document.getElementById("aiModel")?.value || "").trim() || "gpt-4o-mini",
      geminiKey: typedGemini || aiCfg.geminiKey || "",
      geminiModel: normalizeGeminiModel(document.getElementById("geminiModel")?.value),
    };

    try {
      saveAI(next);
      const verify = loadAI();
      if (typedGemini && verify.geminiKey !== typedGemini) {
        throw new Error("localStorage did not keep the Gemini key (private mode / storage blocked?)");
      }
      if (!verify.geminiKey) {
        if (msg) msg.textContent = "Saved, but Gemini key is still empty — paste the key into the Gemini field and Save again.";
        aiCfg = verify;
        render();
        return;
      }
      aiCfg = verify;
      aiStatus = `AI settings saved. Gemini key OK (${aiCfg.geminiKey.length} chars).`;
      showSettings = false;
      render();
    } catch (e) {
      if (msg) msg.textContent = `Could not save: ${e.message || e}`;
      else alert(`Could not save settings: ${e.message || e}`);
    }
  };

  // pointerdown reads sooner than click on some iOS versions
  saveBtn.onpointerdown = (e) => { e.preventDefault(); };
  saveBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    commitSave();
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
  const hasPlaceholders = roster.some(isPlaceholderPlayer);
  return `
    <div class="roster-block">
      <div class="row spread">
        <strong class="${cls}">${escapeHtml(label)} roster</strong>
        <div class="row roster-actions">
          ${hasPlaceholders ? `<button class="btn btn-ghost clear-placeholders" data-side="${side}" title="Remove Player 1–5 placeholders">Clear placeholders</button>` : ""}
          <button class="btn btn-ghost add-player" data-side="${side}">+ Player</button>
        </div>
      </div>
      <p class="muted">Edit name + #jersey. Replace Player 1–5 before Capture for fewer Unassigned.</p>
      <div class="roster-chips">
        ${roster.map((p) => `
          <div class="chip ${g.selectedPlayerId === p.id && g.selectedSide === side ? "sel" : ""}" data-side="${side}" data-pid="${p.id}">
            <span class="chip-hash">#</span>
            <input class="chip-jersey" data-side="${side}" data-pid="${p.id}" inputmode="numeric" placeholder="—" value="${escapeHtml(p.jersey || "")}" title="Jersey number" />
            <input class="chip-name" data-side="${side}" data-pid="${p.id}" value="${escapeHtml(p.name)}" placeholder="Name" />
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
      ${g.boxScoreAligned === false ? `<div class="ai-badge warn">Score ${side === "home" ? g.homeScore : g.awayScore} vs roster PTS ${tot.PTS} — see Unassigned</div>` : ""}
      ${g.boxScoreAligned === true && anyAI ? `<div class="muted ok">Roster PTS match team score</div>` : ""}
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
                <td class="name">${normalizeJersey(p.jersey) ? `<span class="jersey-num">#${escapeHtml(normalizeJersey(p.jersey))}</span> ` : ""}${escapeHtml(p.name)}${p.aiAssisted ? ' <span class="ai-dot" title="AI-assisted">✦</span>' : ""}</td>
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
      <strong>${normalizeJersey(p.jersey) ? `#${escapeHtml(normalizeJersey(p.jersey))} ` : ""}${escapeHtml(p.name)}</strong>
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

function snapshotPanel(g) {
  ensureSnapshots(g);
  const period = String(g.period || "1");
  const qLabel = period === "OT" ? "OT" : `Q${period}`;
  return `
    <div class="card snapshot-card">
      <div class="row spread">
        <strong>Quarter snapshots</strong>
        <button class="btn btn-primary" id="saveQSnap">Save ${escapeHtml(qLabel)} snapshot</button>
      </div>
      <div class="period-chips" id="periodChips">
        ${["1","2","3","4","OT"].map((p) => `
          <button type="button" class="period-chip ${g.period === p ? "on" : ""}" data-period="${p}">${p === "OT" ? "OT" : "Q" + p}</button>
        `).join("")}
      </div>
      <p class="muted">Saves a deep copy of current scores + rosters under the selected period.</p>
      ${(g.snapshots || []).length ? `
        <ul class="snap-list">
          ${g.snapshots.map((s) => {
            const lab = s.period === "OT" ? "OT" : `Q${s.period}`;
            return `<li>
              <div>
                <strong>${escapeHtml(lab)}</strong> ${s.homeScore}–${s.awayScore}
                <div class="muted">${escapeHtml(s.source || "manual")}${s.note ? " · " + escapeHtml(s.note) : ""} · ${fmtTime(s.t)}</div>
              </div>
              <button class="btn btn-ghost snap-restore" data-sid="${s.id}">Restore</button>
            </li>`;
          }).join("")}
        </ul>
      ` : `<div class="muted">No snapshots yet.</div>`}
    </div>
  `;
}

function renderBox(g) {
  return `
    ${rosterEditor("home", g)}
    ${rosterEditor("away", g)}
    ${snapshotPanel(g)}
    ${boxTable("home", g)}
    ${boxTable("away", g)}
    ${statPad(g)}
    <div class="card">
      <button class="btn btn-ghost" id="boxOpenSettings">AI Settings</button>
      <p class="muted">Tip: Watch tab — Gemini YouTube Watch or screenshot AI Capture. Full box graphics cut Unassigned.</p>
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
      <p class="muted warn">Embedded YouTube iframes cannot be read as pixels. Use <strong>Watch with AI</strong> (Gemini analyzes the public YouTube URL server-side) or screenshot AI Capture below.</p>
      <button class="btn watch-ai-btn" id="geminiWatch" ${aiBusy ? "disabled" : ""}>${aiBusy ? "Working…" : "✦ Watch YouTube with AI"}</button>
      <p class="muted">Requires a Gemini key in Settings. Public videos only; VOD/completed games work best (30–120+ sec).</p>
      ${aiStatus ? `<div class="ai-status">${escapeHtml(aiStatus)}</div>` : ""}
    </div>
    ${rosterEditor("home", g)}
    ${rosterEditor("away", g)}
    ${snapshotPanel(g)}
    <div class="side-toggle row">
      <button class="btn ${g.selectedSide === "home" ? "btn-primary" : "btn-ghost"} side-btn" data-side="home">${escapeHtml(g.homeName)}</button>
      <button class="btn ${g.selectedSide === "away" ? "btn-primary" : "btn-ghost"} side-btn" data-side="away">${escapeHtml(g.awayName)}</button>
    </div>
    <div class="roster-chips pick">
      ${(g.selectedSide === "away" ? g.awayRoster : g.homeRoster).map((p) => `
        <button class="chip-pick ${g.selectedPlayerId === p.id ? "sel" : ""}" data-pid="${p.id}">${normalizeJersey(p.jersey) ? `#${escapeHtml(normalizeJersey(p.jersey))} ` : ""}${escapeHtml(p.name)}</button>
      `).join("")}
    </div>
    ${statPad(g)}
    ${boxTable("home", g)}
    ${boxTable("away", g)}
    <div class="card capture-card">
      <strong>AI Capture</strong>
      <ol class="capture-checklist muted">
        <li>Set period (Q1–Q4 / OT chips above)</li>
        <li>Prefer a <strong>full box-score graphic</strong>, not a tiny scorebug</li>
        <li>Optional note (e.g. end of Q3)</li>
      </ol>
      <p class="muted warn">Full box graphics reduce Unassigned — jersey numbers on the roster help matching.</p>
      <input type="file" id="aiFile" accept="image/*" />
      <div class="muted">Photo library or camera — screenshots work.</div>
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
    g.snapshots = [];
    g.selectedPlayerId = null;
    g.boxScoreAligned = undefined;
    save(); render();
  };
}

function bindRosterCommon(g) {
  document.querySelectorAll(".add-player").forEach((b) => {
    b.onclick = () => {
      const side = b.dataset.side;
      const roster = side === "home" ? g.homeRoster : g.awayRoster;
      const p = makePlayer("", roster.length + 1);
      p.name = "";
      roster.push(p);
      g.selectedSide = side;
      g.selectedPlayerId = p.id;
      save(); render();
    };
  });
  document.querySelectorAll(".clear-placeholders").forEach((b) => {
    b.onclick = () => {
      const side = b.dataset.side;
      let roster = side === "home" ? g.homeRoster : g.awayRoster;
      const kept = roster.filter((p) => !isPlaceholderPlayer(p));
      if (!kept.length) {
        const empty = makePlayer("", 1);
        empty.name = "";
        if (side === "home") g.homeRoster = [empty];
        else g.awayRoster = [empty];
      } else {
        if (side === "home") g.homeRoster = kept;
        else g.awayRoster = kept;
      }
      g.selectedPlayerId = null;
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
  document.querySelectorAll(".chip-jersey").forEach((i) => {
    i.oninput = () => {
      const roster = i.dataset.side === "home" ? g.homeRoster : g.awayRoster;
      const p = roster.find((x) => x.id === i.dataset.pid);
      if (p) { p.jersey = normalizeJersey(i.value); i.value = p.jersey; save(); }
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

function bindSnapshotPanel(g) {
  document.querySelectorAll(".period-chip").forEach((b) => {
    b.onclick = () => {
      g.period = b.dataset.period;
      save(); render();
    };
  });
  const saveBtn = document.getElementById("saveQSnap");
  if (saveBtn) saveBtn.onclick = () => {
    const snap = saveQuarterSnapshot(g, "manual", captureNote || "");
    const lab = snap.period === "OT" ? "OT" : `Q${snap.period}`;
    aiStatus = `Saved ${lab} snapshot (${snap.homeScore}–${snap.awayScore}).`;
    save(); render();
  };
  document.querySelectorAll(".snap-restore").forEach((b) => {
    b.onclick = () => {
      if (!confirm("Restore this snapshot? Current box/score will be replaced.")) return;
      if (restoreQuarterSnapshot(g, b.dataset.sid)) {
        aiStatus = "Snapshot restored.";
        save(); render();
      }
    };
  });
}

function bindBox() {
  const g = selected();
  if (!g || state.tab !== "box") return;
  bindRosterCommon(g);
  bindSnapshotPanel(g);
  const s = document.getElementById("boxOpenSettings");
  if (s) s.onclick = () => { showSettings = true; render(); };
}

function bindWatch() {
  const g = selected();
  if (!g || state.tab !== "watch") return;
  bindRosterCommon(g);
  bindSnapshotPanel(g);
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
  const gem = document.getElementById("geminiWatch");
  if (gem) gem.onclick = () => { runGeminiYouTubeWatch(g); };
  const ws = document.getElementById("watchOpenSettings");
  if (ws) ws.onclick = () => { showSettings = true; render(); };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

render();
