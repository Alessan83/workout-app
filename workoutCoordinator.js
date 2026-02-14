/* =========================================================
   workoutCoordinator.js — COORDINATOR v4.2
   ---------------------------------------------------------
   Bridge UI ↔ SessionEngine
   Aggiornato per EquipmentEngine:
     - longBand
     - clipBand
     - miniLoop
     - bodyweight (dynamic / plyometric / isometric)
========================================================= */

/* global StudyEngine, SessionEngine */

const WorkoutCoordinator = (function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function safeInt(v, fb = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fb;
  }

  function safeBool(v) {
    return !!v;
  }

  let exerciseDB = null;
  let currentSession = null;

  /* =====================================================
     READ UI FLAGS
  ===================================================== */

  function readFlagsFromUI() {
    const minutes = safeInt($("modeMinutes")?.value, 25);
    const runDay = safeBool($("flagRunDay")?.checked);
    const fasting = safeBool($("flagFasting")?.checked);
    const rpe3 = safeInt($("rpe3")?.value, 2);
    const noAnchors = $("flagNoAnchors")
      ? safeBool($("flagNoAnchors")?.checked)
      : true;

    return { minutes, runDay, fasting, rpe3, noAnchors };
  }

  /* =====================================================
     LOAD RENDERING
  ===================================================== */

  function renderLoad(it) {

    if (it.loadType === "longBand")
      return ` — Banda lunga ${it.bandKg}kg`;

    if (it.loadType === "clipBand")
      return ` — Banda moschettone ${it.bandKg}kg`;

    if (it.loadType === "miniLoop")
      return ` — Miniloop ${it.miniLoop}`;

    if (it.loadType === "bodyweight") {
      if (it.bodyweightSubtype === "plyometric")
        return " — Corpo libero (pliometrico)";
      if (it.bodyweightSubtype === "dynamic")
        return " — Corpo libero (dinamico)";
      if (it.bodyweightSubtype === "isometric")
        return " — Corpo libero (isometrico)";
      return " — Corpo libero";
    }

    return "";
  }

  /* =====================================================
     SESSION RENDERING
  ===================================================== */

  function renderSession(session) {

    const box = $("sessionBox");
    if (!box) return;

    const b = session.blocks || {};

    function renderItem(it, idx) {

      const unit =
        it.unit === "seconds"
          ? `${it.seconds || 0}s`
          : `${it.reps || 0} reps`;

      const sets = it.sets ? `${it.sets} set` : "1 set";
      const rest = it.restSec ? ` — rest ${it.restSec}s` : "";
      const load = renderLoad(it);

      const cue = (it.cues?.length)
        ? `\n• ${it.cues.slice(0, 3).join("\n• ")}`
        : "";

      const warn = (it.warnings?.length)
        ? `\n⚠ ${it.warnings.slice(0, 2).join(" | ")}`
        : "";

      return `
<div class="exRow" data-family="${it.family || ""}">
  <div><b>${idx + 1}. ${it.name}</b></div>
  <div>${sets} — ${unit}${load}${rest}</div>
  <div style="opacity:.85; font-size:.92em; white-space:pre-line">${cue}${warn}</div>
</div>`;
    }

    function section(title, arr) {
      if (!arr || !arr.length) return "";
      return `<div class="sec">
        <h3>${title}</h3>
        ${arr.map(renderItem).join("")}
      </div>`;
    }

    const meta = session.meta || {};

    const head = `
<div class="sec">
  <div><b>Oggi</b>: ${meta.dayKey} — ${meta.minutes}’ — RPE ${meta.rpe3}
  ${meta.deload ? " — DELOAD" : ""}</div>
  <div style="opacity:.85">Tempo stimato: ${meta.estimatedMinutes}’</div>
  ${(meta.sessionWarnings?.length)
    ? `<div style="opacity:.9">⚠ ${meta.sessionWarnings.slice(0,3).join(" | ")}</div>`
    : ""}
</div>`;

    box.innerHTML =
      head +
      section("Forza", b.strength);

    renderCompletionInputs(session);
  }

  /* =====================================================
     COMPLETION UI
  ===================================================== */

  function renderCompletionInputs(session) {

    const area = $("completeBox");
    if (!area) return;

    const strength = session.blocks?.strength || [];

    const repOptions = [8, 10, 12, 14, 16, 18, 20]
      .map(x => `<option value="${x}">${x}</option>`)
      .join("");

    function rowFor(fam, label) {

      const ex = strength.find(x => x.family === fam);
      if (!ex) return "";

      const loadInfo = renderLoad(ex);

      if (ex.unit === "seconds") {
        return `
<div class="doneRow">
  <div><b>${label}</b>: ${ex.name}</div>
  <div style="opacity:.8">Carico: ${loadInfo}</div>
  <div>Durata eseguita: ${ex.seconds}s</div>
</div>`;
      }

      return `
<div class="doneRow" data-family="${fam}">
  <div><b>${label}</b>: ${ex.name}</div>
  <div style="opacity:.8">Carico: ${loadInfo}</div>
  <div>
    Reps fatte:
    <select id="done_${fam}">${repOptions}</select>
    <label style="margin-left:10px">
      Tecnica OK <input type="checkbox" id="ok_${fam}" checked />
    </label>
  </div>
</div>`;
    }

    area.innerHTML = `
<div class="sec">
  <h3>Fine allenamento</h3>
  ${rowFor("pull","PULL")}
  ${rowFor("push","PUSH")}
  ${rowFor("posterior","POSTERIOR")}
  <div style="margin-top:10px">
    Note:
    <input id="done_notes" type="text"
      style="width:100%" placeholder="facoltativo" />
  </div>
</div>`;
  }

  /* =====================================================
     STREAK
  ===================================================== */

  function renderStreak() {

    const el = $("streakBox");
    if (!el || !StudyEngine) return;

    const st = StudyEngine.getState();
    const dayKey = st?.lastCompletedDay || "—";
    const streak = st?.streak || 0;

    el.innerHTML = `
<div class="sec">
  <div><b>Ultimo giorno</b>: ${dayKey}</div>
  <div><b>Streak</b>: ${streak} giorni</div>
</div>`;
  }

  /* =====================================================
     MAIN ACTIONS
  ===================================================== */

  function ensureDBLoaded() {
    if (!exerciseDB)
      throw new Error("exerciseDB not loaded in coordinator.");
  }

  function generateToday() {
    ensureDBLoaded();
    const flags = readFlagsFromUI();
    currentSession =
      SessionEngine.getOrCreateTodaySession(exerciseDB, flags);
    renderSession(currentSession);
    renderStreak();
  }

  function completeWorkout() {

    if (!currentSession)
      throw new Error("No current session.");

    const s = currentSession.blocks?.strength || [];

    const pull = s.find(x => x.family === "pull");
    const push = s.find(x => x.family === "push");
    const post = s.find(x => x.family === "posterior");

    const payload = {
      repsDone: {
        pull: pull ? safeInt($("done_pull")?.value, 0) : 0,
        push: push ? safeInt($("done_push")?.value, 0) : 0,
        posterior: post ? safeInt($("done_posterior")?.value, 0) : 0
      },
      techniqueOk: {
        pullOk: pull ? safeBool($("ok_pull")?.checked) : true,
        pushOk: push ? safeBool($("ok_push")?.checked) : true,
        posteriorOk: post ? safeBool($("ok_posterior")?.checked) : true
      },
      notes: $("done_notes")?.value || ""
    };

    const out = SessionEngine.completeWorkout(currentSession, payload);

    renderStreak();

    const status = $("statusBox");
    if (status) status.textContent = "Allenamento salvato.";

    const exportBox = $("exportBox");
    if (exportBox && out.exportBlob)
      exportBox.value = JSON.stringify(out.exportBlob, null, 2);
  }

  function exportJSON() {
    const blob = SessionEngine.exportJSON();
    const txt = JSON.stringify(blob, null, 2);
    const exportBox = $("exportBox");
    if (exportBox) exportBox.value = txt;
    return txt;
  }

  /* =====================================================
     PUBLIC API
  ===================================================== */

  return {
    setExerciseDB(db) { exerciseDB = db; },
    generateToday,
    completeWorkout,
    exportJSON,
    getCurrentSession() { return currentSession; }
  };

})();
