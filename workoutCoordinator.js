/* =========================================================
   workoutCoordinator.js — COORDINATOR v4.1 (aligned)
   Compatible with:
     - exercises.json  (movement DB loaded elsewhere into `exerciseDB`)
     - trainingKnowledge.js (global TrainingKnowledge)
     - studyEngine.js (global StudyEngine)
     - biomechanicalEngine.js (global BiomechanicalEngine)
     - sessionengine1.js (global SessionEngine)

   Responsibilities (ONLY):
     - Read UI flags (minutes/runDay/fasting/rpe3/noAnchors)
     - Get deterministic today session (SessionEngine.getOrCreateTodaySession)
     - Render session to UI (minimal hooks, no styling opinions)
     - On "Allenamento completato" collect inputs and call SessionEngine.completeWorkout
     - Maintain streak box (single square) using StudyEngine state
     - Provide Export JSON blob for future ChatGPT analysis

   Notes:
     - No progression logic here.
     - No biomechanics logic here.
     - No saving unless user presses "Allenamento completato".
========================================================= */

/* global StudyEngine, SessionEngine */

const WorkoutCoordinator = (function () {
  "use strict";

  // -------------- DOM helpers --------------
  const $ = (id) => document.getElementById(id);

  function safeInt(v, fb = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fb;
  }

  function safeBool(v) {
    return !!v;
  }

  // -------------- State --------------
  let exerciseDB = null;
  let currentSession = null;

  // -------------- UI flag reading --------------
  function readFlagsFromUI() {
    // You can map these IDs to your real HTML controls.
    // If a control is missing, defaults are applied.
    const minutes = safeInt($("modeMinutes")?.value, 25); // expected: 25/30/35
    const runDay = safeBool($("flagRunDay")?.checked);
    const fasting = safeBool($("flagFasting")?.checked);
    const rpe3 = safeInt($("rpe3")?.value, 2); // 1..3
    const noAnchors = $("flagNoAnchors") ? safeBool($("flagNoAnchors")?.checked) : true;

    return { minutes, runDay, fasting, rpe3, noAnchors };
  }

  // -------------- Rendering --------------
  // Minimal renderer: expects a container element with id "sessionBox"
  // You can replace this with your UI code; keep data model unchanged.
  function renderSession(session) {
    const box = $("sessionBox");
    if (!box) return;

    const b = session.blocks;

    function renderItem(it, idx) {
      const unit = it.unit === "seconds" ? `${it.seconds || 0}s` : `${it.reps || 0} reps`;
      const band = it.band ? ` — banda ${it.band}` : "";
      const sets = it.sets ? `${it.sets} set` : "1 set";
      const rest = it.restSec ? ` — rest ${it.restSec}s` : "";
      const cue = (it.cues && it.cues.length) ? `\n• ${it.cues.slice(0, 3).join("\n• ")}` : "";
      const warn = (it.warnings && it.warnings.length) ? `\n⚠ ${it.warnings.slice(0, 2).join(" | ")}` : "";

      return `
<div class="exRow" data-family="${it.family || it.kind || ""}">
  <div><b>${idx + 1}. ${it.name}</b></div>
  <div>${sets} — ${unit}${band}${rest}</div>
  <div style="opacity:.85; font-size:.92em; white-space:pre-line">${cue}${warn}</div>
</div>`;
    }

    function section(title, arr) {
      if (!arr || !arr.length) return "";
      const html = arr.map(renderItem).join("\n");
      return `<div class="sec"><h3>${title}</h3>${html}</div>`;
    }

    const meta = session.meta || {};
    const head = `
<div class="sec">
  <div><b>Oggi</b>: ${meta.dayKey} — ${meta.minutes}’ — RPE ${meta.rpe3} ${meta.deload ? "— DELOAD" : ""}</div>
  <div style="opacity:.85">Tempo stimato: ${meta.estimatedMinutes}’</div>
  ${(meta.sessionWarnings && meta.sessionWarnings.length) ? `<div style="opacity:.9">⚠ ${meta.sessionWarnings.slice(0,3).join(" | ")}</div>` : ""}
</div>`;

    box.innerHTML =
      head +
      section("Riscaldamento", b.warmup) +
      section("Mobilità", b.mobility) +
      section("Forza (3 esercizi)", b.strength) +
      section("Core / Controllo", b.coreControl) +
      section("Cooldown (respiro)", b.cooldown);

    // Also render input controls for reps done (dropdown) + technique OK toggles
    renderCompletionInputs(session);
  }

  function renderCompletionInputs(session) {
    const area = $("completeBox");
    if (!area) return;

    const strength = session.blocks.strength || [];
    const repOptions = [8, 10, 12, 14, 16, 18, 20]
      .map(x => `<option value="${x}">${x}</option>`)
      .join("");

    // Build rows for pull/push/posterior based on `family`
    const rowFor = (fam, label) => {
      const ex = strength.find(x => x.family === fam);
      if (!ex) return "";
      return `
<div class="doneRow" data-family="${fam}">
  <div><b>${label}</b>: ${ex.name}</div>
  <div>
    Reps fatte:
    <select id="done_${fam}">${repOptions}</select>
    <label style="margin-left:10px">
      Tecnica OK <input type="checkbox" id="ok_${fam}" checked />
    </label>
  </div>
</div>`;
    };

    area.innerHTML = `
<div class="sec">
  <h3>Fine allenamento</h3>
  ${rowFor("pull","PULL")}
  ${rowFor("push","PUSH")}
  ${rowFor("posterior","POSTERIOR")}
  <div style="margin-top:10px">
    Note: <input id="done_notes" type="text" style="width:100%" placeholder="facoltativo" />
  </div>
</div>`;
  }

  // -------------- Streak (single square) --------------
  function renderStreak() {
    const el = $("streakBox");
    if (!el || !StudyEngine) return;

    const st = StudyEngine.getState();
    const dayKey = (st && st.lastCompletedDay) ? st.lastCompletedDay : "—";
    const streak = (st && st.streak) ? st.streak : 0;

    el.innerHTML = `
<div class="sec">
  <div><b>Ultimo giorno</b>: ${dayKey}</div>
  <div><b>Streak</b>: ${streak} giorni</div>
</div>`;
  }

  // -------------- Main actions --------------
  function ensureDBLoaded() {
    if (!exerciseDB) throw new Error("exerciseDB not loaded in coordinator. Load exercises.json first.");
  }

  function generateToday() {
    ensureDBLoaded();
    const flags = readFlagsFromUI();
    currentSession = SessionEngine.getOrCreateTodaySession(exerciseDB, flags);
    renderSession(currentSession);
    renderStreak();
  }

  function completeWorkout() {
    if (!currentSession) throw new Error("No current session. Generate first.");
    const s = currentSession.blocks.strength || [];

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

    // After completion: update streak + regenerate next session only on user request
    renderStreak();

    // Optional: show export blob to a textarea if present
    const exportBox = $("exportBox");
    if (exportBox) exportBox.value = JSON.stringify(out.exportBlob, null, 2);

    // Minimal feedback (avoid alerts if you prefer)
    const status = $("statusBox");
    if (status) status.textContent = "Allenamento salvato.";
  }

  function exportJSON() {
    const blob = SessionEngine.exportJSON();
    const txt = JSON.stringify(blob, null, 2);

    const exportBox = $("exportBox");
    if (exportBox) exportBox.value = txt;

    return txt;
  }

  // -------------- Public API --------------
  return {
    // set DB once loaded
    setExerciseDB(db) {
      exerciseDB = db;
    },

    // UI actions
    generateToday,
    completeWorkout,
    exportJSON,

    // for debugging
    getCurrentSession() { return currentSession; }
  };

})();
