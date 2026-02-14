/* ==========================================
   StudyEngine.js — coordination core (v3.1)
   Responsibilities:
   - progression model (time -> sets -> band)
   - deload rules
   - modifiers (runDay, fasting)
   - weekly advancement every 3 completed sessions
   - posterior <= 1.2 * pull constraint (global)
   - produces targets for SessionEngine
   - stores state in localStorage
========================================== */

/* global TrainingKnowledge */

(function () {
  "use strict";

  const StudyEngine = {};

  const LS_KEY = "palestra_study_state_v3";

  // ---- menus
  const REP_MENU = [8, 10, 12, 14, 16, 18, 20];
  const BAND_MENU = [15, 25, 35];
  const RPE3 = { EASY: 1, MOD: 2, HARD: 3 };

  // ---- helpers
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function jparse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
  function jstring(x) { return JSON.stringify(x); }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ---- 12-week S-curve volume/intensity driver (lightweight)
  function sCurve01(week1to12) {
    const w = clamp(week1to12, 1, 12) - 1; // 0..11
    const x = (w - 5.5) / 2.0;
    return 1 / (1 + Math.exp(-x));
  }

  function volumeMultiplier(week1to12) {
    const s = sCurve01(week1to12);
    // 0.90 -> 1.12
    return 0.90 + (1.12 - 0.90) * s;
  }

  // ---- state
  function defaultState() {
    return {
      version: "3.1",
      week: 1,
      sessionInWeek: 0, // 0..2 (advance week every 3)
      streak: 0,
      lastCompletedDay: null,
      hardSessionsInRow: 0,
      deloadArmed: false,

      // independent progressions (targets)
      prog: {
        pull:      { repIndex: 1, band: 15, setBase: 3 }, // 10 reps
        push:      { repIndex: 1, band: 15, setBase: 3 },
        posterior: { repIndex: 1, band: 15, setBase: 2 }, // constrained
        core:      { holdSeconds: 25, setBase: 2 }         // time-based
      }
    };
  }

  function loadState() {
    const raw = localStorage.getItem(LS_KEY);
    const st = jparse(raw, null);
    if (!st || !st.prog) return defaultState();

    // forward-safe defaults
    st.version = st.version || "3.1";
    st.week = typeof st.week === "number" ? st.week : 1;
    st.sessionInWeek = typeof st.sessionInWeek === "number" ? st.sessionInWeek : 0;
    st.streak = typeof st.streak === "number" ? st.streak : 0;
    st.hardSessionsInRow = typeof st.hardSessionsInRow === "number" ? st.hardSessionsInRow : 0;
    st.deloadArmed = !!st.deloadArmed;

    st.prog.pull = st.prog.pull || { repIndex: 1, band: 15, setBase: 3 };
    st.prog.push = st.prog.push || { repIndex: 1, band: 15, setBase: 3 };
    st.prog.posterior = st.prog.posterior || { repIndex: 1, band: 15, setBase: 2 };
    st.prog.core = st.prog.core || { holdSeconds: 25, setBase: 2 };

    return st;
  }

  function saveState(st) {
    localStorage.setItem(LS_KEY, jstring(st));
  }

  // ---- context (inputs from UI/Coordinator)
  StudyEngine.getContextForToday = function (userFlags) {
    const flags = userFlags || {};
    const minutes = (flags.minutes === 35 || flags.minutes === 30 || flags.minutes === 25) ? flags.minutes : 25;

    return {
      dayKey: todayISO(),
      minutes,
      runDay: !!flags.runDay,
      fasting: !!flags.fasting,
      rpe3: clamp(flags.rpe3 || RPE3.MOD, 1, 3),
      noAnchors: flags.noAnchors !== undefined ? !!flags.noAnchors : true,
      equipment: flags.equipment || ["bodyweight", "band", "miniloop", "rope", "stick"]
    };
  };

  // ---- produce targets used by SessionEngine
  StudyEngine.getTargets = function (state, ctx) {
    const st = state || loadState();
    const c = ctx || StudyEngine.getContextForToday({});

    // base multipliers
    let mult = volumeMultiplier(st.week);

    // modifiers
    if (c.minutes <= 25) mult *= 0.95;
    if (c.minutes >= 35) mult *= 1.05;

    if (c.runDay) mult *= 0.92;
    if (c.fasting) mult *= 0.88;

    // deload applies for next completed session if armed OR every 4th week on first session
    const weekBoundaryDeload = (st.week % 4 === 0) && (st.sessionInWeek === 0);
    const deload = st.deloadArmed || weekBoundaryDeload;
    if (deload) mult *= 0.70;

    // RPE: hard => small volume reduction
    if (c.rpe3 === RPE3.HARD) mult *= 0.93;

    // sets targets (rounded + clamped)
    const pullSets = clamp(Math.round(st.prog.pull.setBase * mult), 2, 6);
    const pushSets = clamp(Math.round(st.prog.push.setBase * mult), 2, 6);

    let posteriorSets = clamp(Math.round(st.prog.posterior.setBase * mult), 1, 4);
    // spine safety: posterior <= 1.2 * pull
    posteriorSets = Math.min(posteriorSets, Math.max(1, Math.floor(pullSets * 1.2)));

    const coreSets = clamp(Math.round(st.prog.core.setBase * mult), 1, 4);

    // reps targets
    const pullReps = REP_MENU[clamp(st.prog.pull.repIndex, 0, REP_MENU.length - 1)];
    const pushReps = REP_MENU[clamp(st.prog.push.repIndex, 0, REP_MENU.length - 1)];
    const postReps = REP_MENU[clamp(st.prog.posterior.repIndex, 0, REP_MENU.length - 1)];

    // core hold seconds (time-based)
    const baseHold = st.prog.core.holdSeconds || 25;
    const hold = clamp(Math.round(baseHold * (deload ? 0.85 : 1.0) * (c.fasting ? 0.95 : 1.0)), 15, 60);

    // band suggestions
    const pullBand = BAND_MENU.includes(st.prog.pull.band) ? st.prog.pull.band : 15;
    const pushBand = BAND_MENU.includes(st.prog.push.band) ? st.prog.push.band : 15;
    const postBand = BAND_MENU.includes(st.prog.posterior.band) ? st.prog.posterior.band : 15;

    // rest seconds template (can be overridden by trainingKnowledge)
    const rest = StudyEngine.getRestSeconds(c.rpe3, deload);

    // Provide a compact targets object (SessionEngine consumes)
    return {
      meta: {
        week: st.week,
        sessionInWeek: st.sessionInWeek,
        deload,
        mult: Number(mult.toFixed(3))
      },
      warmup:   { style: "simple", cycles: (c.minutes >= 35 ? 2 : 1) },
      mobility: { style: "simple", count: 2 },
      strength: {
        pull:      { sets: pullSets, reps: pullReps, band: pullBand, rest, repMenu: REP_MENU, bandMenu: BAND_MENU },
        push:      { sets: pushSets, reps: pushReps, band: pushBand, rest, repMenu: REP_MENU, bandMenu: BAND_MENU },
        posterior: { sets: posteriorSets, reps: postReps, band: postBand, rest, repMenu: REP_MENU, bandMenu: BAND_MENU }
      },
      core:     { sets: coreSets, seconds: hold, rest: 15 },
      cooldown: { style: "simple", count: 1 }
    };
  };

  StudyEngine.getRestSeconds = function (rpe3, deload) {
    // allow TrainingKnowledge override
    if (TrainingKnowledge && TrainingKnowledge.modifiers && typeof TrainingKnowledge.modifiers.restSeconds === "function") {
      return TrainingKnowledge.modifiers.restSeconds(rpe3, deload);
    }
    if (deload) return 25;
    if (rpe3 === RPE3.EASY) return 25;
    if (rpe3 === RPE3.MOD) return 35;
    return 45;
  };

  // ---- apply result ONLY on "Allenamento completato"
  // result expects at minimum:
  // { dayKey, rpe3, summary:{pullRepsDone, pushRepsDone, posteriorRepsDone}, minutes, runDay, fasting }
  StudyEngine.applySessionResult = function (state, result) {
    const st = state || loadState();
    const r = result || {};
    const dayKey = r.dayKey || todayISO();

    // streak
    if (st.lastCompletedDay) {
      const last = new Date(st.lastCompletedDay + "T00:00:00");
      const cur = new Date(dayKey + "T00:00:00");
      const diff = Math.round((cur - last) / 86400000);
      if (diff === 1) st.streak += 1;
      else if (diff > 1) st.streak = 1;
      // diff==0: same day, keep
    } else {
      st.streak = 1;
    }
    st.lastCompletedDay = dayKey;

    // hard sessions row
    const rpe3 = clamp(r.rpe3 || RPE3.MOD, 1, 3);
    if (rpe3 === RPE3.HARD) st.hardSessionsInRow += 1;
    else st.hardSessionsInRow = 0;

    // deload arming:
    // - if 2 HARD sessions in a row => arm deload for next session
    // - else if already armed => consume it now (will be cleared below)
    if (st.hardSessionsInRow >= 2) st.deloadArmed = true;

    // progression time -> sets -> band (per family)
    function progressBandIfPossible(prog) {
      const idx = BAND_MENU.indexOf(prog.band);
      if (idx >= 0 && idx < BAND_MENU.length - 1) {
        prog.band = BAND_MENU[idx + 1];
        prog.repIndex = 2; // reset to 12 after band jump
        return true;
      }
      return false;
    }

    function advanceFamily(key, repsDone) {
      const prog = st.prog[key];
      if (!prog) return;

      // core is time-based
      if (key === "core") {
        // if easy/mod and consistent -> +5s up to 60
        if (rpe3 !== RPE3.HARD) prog.holdSeconds = clamp((prog.holdSeconds || 25) + 5, 15, 60);
        else prog.holdSeconds = clamp((prog.holdSeconds || 25) - 5, 15, 60);
        return;
      }

      // during deload: slight regression/hold
      if (st.deloadArmed) {
        prog.repIndex = clamp(prog.repIndex - 1, 0, REP_MENU.length - 1);
        return;
      }

      const target = REP_MENU[clamp(prog.repIndex, 0, REP_MENU.length - 1)];
      const success = (repsDone >= target) && (rpe3 !== RPE3.HARD);
      const fail = (repsDone < Math.max(6, target - 4)) || (rpe3 === RPE3.HARD);

      if (success) {
        if (prog.repIndex < REP_MENU.length - 1) {
          prog.repIndex += 1;
        } else {
          // reps max => upgrade band or increase base sets (capped)
          const upgraded = progressBandIfPossible(prog);
          if (!upgraded) prog.setBase = clamp(prog.setBase + 1, 2, 5);
        }
      } else if (fail) {
        // small regression for stability
        prog.repIndex = clamp(prog.repIndex - 1, 0, REP_MENU.length - 1);
      }
    }

    const s = r.summary || {};
    advanceFamily("pull", s.pullRepsDone || s.pull || 0);
    advanceFamily("push", s.pushRepsDone || s.push || 0);
    advanceFamily("posterior", s.posteriorRepsDone || s.posterior || 0);
    advanceFamily("core", s.core || 0);

    // posterior constraint (global)
    const maxPosterior = Math.max(1, Math.floor(st.prog.pull.setBase * 1.2));
    st.prog.posterior.setBase = Math.min(st.prog.posterior.setBase, maxPosterior);

    // advance week every 3 sessions
    st.sessionInWeek = (st.sessionInWeek + 1) % 3;
    if (st.sessionInWeek === 0) st.week += 1;

    // consume deload if it was armed
    if (st.deloadArmed) st.deloadArmed = false;

    saveState(st);
    return st;
  };

  // ---- exports / state
  StudyEngine.getState = function () { return loadState(); };
  StudyEngine.setState = function (st) { saveState(st); };

  StudyEngine.exportJSON = function () {
    return {
      exportedAt: new Date().toISOString(),
      state: loadState()
    };
  };

  window.StudyEngine = StudyEngine;

})();
