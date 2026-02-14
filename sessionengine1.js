/* =========================================================
   sessionengine1.js  — SessionEngine v3.0 (coordinated)
   Works with:
     - exercises.json (movement DB)
     - trainingKnowledge.js (rules/tempo/dosing)
     - studyEngine.js (state/progression/deload/targets)
     - biomechanicalEngine.js (no-anchor adapt + safety + cues)
     - workoutCoordinator.js (UI calls getOrCreateTodaySession + completeWorkout)

   Design goals:
     - Deterministic "same day = same session" (seeded by dayKey + mode + flags)
     - 25/30/35 minutes manual mode
     - Accurate time closure using TrainingKnowledge.tempo.estimateSetSeconds()
     - No save unless completeWorkout() is called
     - Offline localStorage persistence (today session + history)
========================================================= */

/* global TrainingKnowledge, StudyEngine, BiomechanicalEngine */

const SessionEngine = (function () {
  "use strict";

  // ------------------ localStorage keys ------------------
  const LS_TODAY_PREFIX = "palestra_session_today_v3_"; // + dayKey + "_" + minutes + flagsHash
  const LS_HISTORY_KEY = "palestra_session_history_v3"; // array
  const LS_EXPORT_KEY = "palestra_export_blob_v3";      // last export snapshot

  // ------------------ helpers ------------------
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const lower = (s) => String(s || "").toLowerCase();

  function jparse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
  function jstring(x) { return JSON.stringify(x); }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function hashStr(str) {
    // simple stable hash for flags
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  // deterministic RNG (xorshift32)
  function makeRng(seedStr) {
    let x = 0x811c9dc5 ^ parseInt(hashStr(seedStr), 16);
    return function rand() {
      // xorshift32
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17; x >>>= 0;
      x ^= x << 5;  x >>>= 0;
      return (x >>> 0) / 4294967296;
    };
  }

  function pickOne(arr, rand) {
    if (!arr || !arr.length) return null;
    const i = Math.floor(rand() * arr.length);
    return arr[i];
  }

  function uniq(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  // ------------------ time model ------------------
  function getTempoAPI() {
    if (!TrainingKnowledge || !TrainingKnowledge.tempo) throw new Error("TrainingKnowledge.tempo missing");
    return TrainingKnowledge.tempo;
  }

  function estimateExerciseSeconds(item) {
    // item: {unit, sets, reps, seconds, restSec, tempo, transitionSec}
    const tempoAPI = getTempoAPI();
    const sets = item.sets || 1;
    const rest = item.restSec || 0;
    const transition = item.transitionSec || 8;

    let active = 0;
    if (item.unit === "seconds") {
      active = tempoAPI.estimateHoldSeconds(item.seconds || 0);
    } else {
      const reps = item.reps || 0;
      active = tempoAPI.estimateSetSeconds(reps, item.tempo || null);
    }

    // Between sets: (sets-1)*rest. Add small transition once per exercise.
    return (sets * active) + (Math.max(0, sets - 1) * rest) + transition;
  }

  function sumSeconds(list) {
    return (list || []).reduce((acc, x) => acc + estimateExerciseSeconds(x), 0);
  }

  // ------------------ selection utils ------------------
  function normalizeDB(exerciseDB) {
    const arr = Array.isArray(exerciseDB) ? exerciseDB : [];
    return arr.filter(Boolean);
  }

  function classifyAll(exerciseDB) {
    const db = normalizeDB(exerciseDB);
    return db.map(ex => BiomechanicalEngine.classify(ex));
  }

  function filterNoAnchor(pool, noAnchors) {
    if (!noAnchors) return pool.slice();
    // keep even those requiring anchor, because we can adapt; selection will adapt later
    return pool.slice();
  }

  function chooseStrengthExercises(pool, targets, ctx, rand) {
    // Choose 1 pull, 1 push, 1 posterior (stabilization). Upper focus.
    // Uses pattern heuristic from BiomechanicalEngine.classify().
    const noAnchors = !!ctx.noAnchors;

    const candidates = filterNoAnchor(pool, noAnchors);

    const pullPool = candidates.filter(e => (e.pattern === "pull" || e.family === "upper") && !e.hinge);
    const pushPool = candidates.filter(e => (e.pattern === "push" || e.family === "upper") && !e.hinge);
    let postPool  = candidates.filter(e => (e.family === "posterior") || e.hinge || /glute|hip|calf|tibialis|hinge|deadlift|rdl/i.test(e.name));

    // Run day: avoid hinge; prefer calves/tibialis/hip stability.
    if (ctx.runDay) {
      postPool = candidates.filter(e =>
        (e.family === "posterior") &&
        !e.hinge &&
        e.lumbarRisk <= 2 &&
        /calf|polpacc|tibialis|cavigl|ankle|glute bridge|bridge|hip/i.test(e.name)
      );
      if (!postPool.length) {
        postPool = candidates.filter(e => (e.family === "posterior") && !e.hinge && e.lumbarRisk <= 2);
      }
    } else {
      // non-run day: still keep lumbar-safe (<=2 preferred)
      const safe = postPool.filter(e => e.lumbarRisk <= 2);
      if (safe.length) postPool = safe;
    }

    // deterministically pick
    let pull = pickOne(pullPool, rand) || pickOne(candidates, rand);
    let push = pickOne(pushPool, rand) || pickOne(candidates, rand);
    let post = pickOne(postPool, rand) || pickOne(candidates.filter(e => e.family === "posterior"), rand) || pickOne(candidates, rand);

    // de-duplicate by id/name
    const used = new Set();
    function take(ex) {
      if (!ex) return null;
      const key = ex.id || ex.name;
      if (used.has(key)) return null;
      used.add(key);
      return ex;
    }

    pull = take(pull) || pickOne(pullPool.filter(e => !used.has(e.id || e.name)), rand);
    push = take(push) || pickOne(pushPool.filter(e => !used.has(e.id || e.name)), rand);
    post = take(post) || pickOne(postPool.filter(e => !used.has(e.id || e.name)), rand);

    // Adapt no-anchor (if necessary)
    function adapt(ex) {
      if (!ex) return null;
      if (!ctx.noAnchors) return ex;

      const res = BiomechanicalEngine.adaptExerciseNoAnchor(ex, candidates);
      if (res && res.ok && res.exercise) return res.exercise;
      return ex; // fallback
    }

    pull = adapt(pull);
    push = adapt(push);
    post = adapt(post);

    return { pull, push, posterior: post };
  }

  // ------------------ build blocks ------------------
  function buildWarmupBlock(targets, ctx) {
    // Use dosingTemplates.warmup examples; convert into executable items
    const tpl = targets.warmup || TrainingKnowledge.dosingTemplates.warmup;
    const mins = (ctx.minutes >= 35) ? tpl.durationMin.for35 : tpl.durationMin.for25;

    // One to two “micro-exercises” from examples, 1 set each, reps mid-range
    const exs = (tpl.examples || []).slice(0, 3);
    const items = exs.map((e) => {
      const mid = Math.round((e.range[0] + e.range[1]) / 2);
      return {
        kind: "warmup",
        name: e.item,
        unit: e.unit,
        sets: 1,
        reps: e.unit === "reps" ? mid : undefined,
        seconds: e.unit === "seconds" ? mid : undefined,
        restSec: 0,
        tempo: TrainingKnowledge.tempo.defaultSeconds,
        transitionSec: 6
      };
    });

    return { minutesTarget: mins, items };
  }

  function buildMobilityBlock(targets, ctx) {
    const tpl = targets.mobility || TrainingKnowledge.dosingTemplates.mobility;
    const mins = (ctx.minutes >= 35) ? tpl.durationMin.for35 : tpl.durationMin.for25;

    const exs = (tpl.examples || []).slice(0, 2);
    const items = exs.map((e) => {
      const mid = Math.round((e.range[0] + e.range[1]) / 2);
      return {
        kind: "mobility",
        name: e.item,
        unit: e.unit,
        sets: 1,
        reps: e.unit === "reps" ? mid : undefined,
        seconds: e.unit === "seconds" ? mid : undefined,
        restSec: 0,
        tempo: TrainingKnowledge.tempo.defaultSeconds,
        transitionSec: 6
      };
    });

    return { minutesTarget: mins, items };
  }

  function buildCoreControlBlock(targets, ctx) {
    // Small control block (not the “main core” which user wants minimal)
    const tpl = targets.coreControl || TrainingKnowledge.dosingTemplates.coreControl;
    const mins = (ctx.minutes >= 35) ? tpl.durationMin.for35 : tpl.durationMin.for25;

    // choose 1 item only to keep it short
    const e = (tpl.examples && tpl.examples.length) ? tpl.examples[0] : { item: "Plank", unit: "seconds", range: [15, 30] };
    const mid = Math.round((e.range[0] + e.range[1]) / 2);

    return {
      minutesTarget: mins,
      items: [{
        kind: "core_control",
        name: e.item,
        unit: e.unit,
        sets: 1,
        reps: e.unit === "reps" ? mid : undefined,
        seconds: e.unit === "seconds" ? mid : undefined,
        restSec: 10,
        tempo: TrainingKnowledge.tempo.defaultSeconds,
        transitionSec: 6
      }]
    };
  }

  function buildCooldownBlock(targets, ctx) {
    const tpl = targets.breathingCooldown || TrainingKnowledge.dosingTemplates.breathingCooldown;
    const mins = (ctx.minutes >= 35) ? tpl.durationMin.for35 : tpl.durationMin.for25;

    // breathing protocol: represent as one timed item (phases)
    const p = tpl.protocol || { unit: "seconds", perPhaseRange: [3, 4], phases: ["inspira", "trattieni", "espira", "vuoto"] };
    const perPhase = Math.round((p.perPhaseRange[0] + p.perPhaseRange[1]) / 2);
    const cycleSec = perPhase * (p.phases ? p.phases.length : 4);

    return {
      minutesTarget: mins,
      items: [{
        kind: "cooldown",
        name: "Respirazione diaframmatica (protocollo)",
        unit: "seconds",
        sets: 1,
        seconds: cycleSec * 3, // ~3 cicli
        restSec: 0,
        transitionSec: 0,
        note: `Fasi: ${(p.phases || []).join(" / ")} — ${perPhase}s ciascuna`
      }]
    };
  }

  function buildStrengthBlock(exAll, targets, ctx, rand) {
    const chosen = chooseStrengthExercises(exAll, targets, ctx, rand);

    // Apply StudyEngine targets for sets/reps/band
    const pullT = targets.strength.pull;
    const pushT = targets.strength.push;
    const postT = targets.strength.posterior;

    function pack(ex, t, familyLabel) {
      if (!ex) return null;

      // validate against context/band
      const v = BiomechanicalEngine.validateExercise(ex, { ...ctx, band: t.band });
      if (!v.ok) {
        // fallback: reduce band to allowed max or drop sets
        const safeBand = Math.min(t.band, ex.allowedMaxBand || t.band);
        const v2 = BiomechanicalEngine.validateExercise(ex, { ...ctx, band: safeBand });
        if (!v2.ok) {
          // last resort: mark as warning but keep (UI can show)
        }
        t = { ...t, band: safeBand, sets: Math.max(1, t.sets - 1) };
      }

      const cues = BiomechanicalEngine.getCues(ex);
      const warnings = BiomechanicalEngine.getWarnings(ex, ctx);

      // normalize prescription (seconds vs reps)
      const unit = ex.prescription?.unit || (ex.doseType === TrainingKnowledge.doseTypes.SECONDS ? "seconds" : "reps");

      return {
        kind: "strength",
        family: familyLabel,
        id: ex.id,
        name: ex.name,
        pattern: ex.pattern,
        unit,
        sets: t.sets,
        reps: unit === "reps" ? t.reps : undefined,
        seconds: unit === "seconds" ? (familyLabel === "core" ? targets.core.seconds : 25) : undefined,
        band: unit === "reps" ? t.band : undefined,
        restSec: t.rest,
        tempo: TrainingKnowledge.tempo.defaultSeconds,
        transitionSec: 10,
        cues,
        warnings,
        noAnchor: !!ctx.noAnchors
      };
    }

    const items = [];
    const pullItem = pack(chosen.pull, pullT, "pull");
    const pushItem = pack(chosen.push, pushT, "push");
    const postItem = pack(chosen.posterior, postT, "posterior");

    if (pullItem) items.push(pullItem);
    if (pushItem) items.push(pushItem);
    if (postItem) items.push(postItem);

    return items;
  }

  // ------------------ time closure ------------------
  function closeToMinutes(session, targetMinutes) {
    // Ensure total <= targetMinutes with deterministic trimming:
    // reduce sets from posterior first, then push, then pull, then drop warmup extras.
    const targetSec = targetMinutes * 60;

    function totalSec(s) {
      return (
        sumSeconds(s.blocks.warmup) +
        sumSeconds(s.blocks.mobility) +
        sumSeconds(s.blocks.strength) +
        sumSeconds(s.blocks.coreControl) +
        sumSeconds(s.blocks.cooldown)
      );
    }

    let sec = totalSec(session);
    if (sec <= targetSec) return;

    const strength = session.blocks.strength;

    function reduceSetsOfFamily(fam) {
      const it = strength.find(x => x.family === fam);
      if (!it) return false;
      if ((it.sets || 1) <= 1) return false;
      it.sets -= 1;
      return true;
    }

    // trimming loop (bounded)
    let guard = 50;
    while (sec > targetSec && guard-- > 0) {
      if (reduceSetsOfFamily("posterior")) { sec = totalSec(session); continue; }
      if (reduceSetsOfFamily("push")) { sec = totalSec(session); continue; }
      if (reduceSetsOfFamily("pull")) { sec = totalSec(session); continue; }

      // If still too long, shorten warmup/mobility by removing last item
      if (session.blocks.warmup.length > 1) { session.blocks.warmup.pop(); sec = totalSec(session); continue; }
      if (session.blocks.mobility.length > 1) { session.blocks.mobility.pop(); sec = totalSec(session); continue; }

      // Last resort: reduce rest
      const sIt = strength.find(x => (x.restSec || 0) > 20);
      if (sIt) { sIt.restSec = Math.max(20, sIt.restSec - 5); sec = totalSec(session); continue; }

      break;
    }
  }

  function fillStrengthIfTooShort(session, targetMinutes) {
    // If total time is too short, increase sets in pull/push first, then posterior (respect cap).
    const targetSec = targetMinutes * 60;
    function totalSec(s) {
      return (
        sumSeconds(s.blocks.warmup) +
        sumSeconds(s.blocks.mobility) +
        sumSeconds(s.blocks.strength) +
        sumSeconds(s.blocks.coreControl) +
        sumSeconds(s.blocks.cooldown)
      );
    }
    let sec = totalSec(session);
    if (sec >= targetSec * 0.92) return; // close enough

    const cap = (TrainingKnowledge.spineSafety.posteriorToPullCap || 1.2);
    const strength = session.blocks.strength;

    function setsOf(fam) {
      const it = strength.find(x => x.family === fam);
      return it ? (it.sets || 0) : 0;
    }

    function addSet(fam, maxSets) {
      const it = strength.find(x => x.family === fam);
      if (!it) return false;
      if ((it.sets || 1) >= maxSets) return false;
      it.sets += 1;
      return true;
    }

    let guard = 40;
    while (sec < targetSec * 0.92 && guard-- > 0) {
      // increase pull/push up to 6
      if (addSet("pull", 6)) { sec = totalSec(session); continue; }
      if (addSet("push", 6)) { sec = totalSec(session); continue; }

      // posterior allowed up to floor(pull*cap)
      const pullSets = setsOf("pull");
      const maxPost = Math.max(1, Math.floor(pullSets * cap));
      if (addSet("posterior", Math.min(4, maxPost))) { sec = totalSec(session); continue; }

      break;
    }
  }

  // ------------------ public: generation ------------------
  function generateSession(exerciseDB, userFlags) {
    if (!TrainingKnowledge || !StudyEngine || !BiomechanicalEngine) {
      throw new Error("Missing required engines: TrainingKnowledge / StudyEngine / BiomechanicalEngine");
    }

    const st = StudyEngine.getState();
    const ctx = StudyEngine.getContextForToday(userFlags || {});
    const targets = StudyEngine.getTargets(st, ctx);

    // daily seed includes mode + flags that must keep same session if reopened
    const seedStr = [
      targets.meta.dayKey,
      ctx.minutes,
      ctx.runDay ? "run" : "norun",
      ctx.fasting ? "fast" : "nofast",
      ctx.rpe3,
      ctx.noAnchors ? "noanchor" : "anchor"
    ].join("|");

    const rand = makeRng(seedStr);

    const exAll = classifyAll(exerciseDB);

    const warm = buildWarmupBlock(targets, ctx);
    const mob = buildMobilityBlock(targets, ctx);
    const coreCtrl = buildCoreControlBlock(targets, ctx);
    const cool = buildCooldownBlock(targets, ctx);

    const strengthItems = buildStrengthBlock(exAll, targets, ctx, rand);

    const session = {
      meta: {
        version: "3.0",
        dayKey: targets.meta.dayKey,
        minutes: ctx.minutes,
        runDay: ctx.runDay,
        fasting: ctx.fasting,
        rpe3: ctx.rpe3,
        deload: !!targets.meta.deload,
        mult: targets.meta.mult,
        seed: seedStr
      },
      targets,
      blocks: {
        warmup: warm.items,
        mobility: mob.items,
        strength: strengthItems,
        coreControl: coreCtrl.items,
        cooldown: cool.items
      }
    };

    // close time: first fill if too short, then trim if too long
    fillStrengthIfTooShort(session, ctx.minutes);
    closeToMinutes(session, ctx.minutes);

    // session-level warnings
    const sessCheck = BiomechanicalEngine.validateSession(session);
    session.meta.sessionWarnings = (sessCheck && sessCheck.warnings) ? sessCheck.warnings : [];

    // attach time totals for UI
    session.meta.estimatedSeconds = (
      sumSeconds(session.blocks.warmup) +
      sumSeconds(session.blocks.mobility) +
      sumSeconds(session.blocks.strength) +
      sumSeconds(session.blocks.coreControl) +
      sumSeconds(session.blocks.cooldown)
    );
    session.meta.estimatedMinutes = Number((session.meta.estimatedSeconds / 60).toFixed(1));

    return session;
  }

  // Deterministic key for localStorage "today session"
  function todayKeyFromFlags(flags) {
    const ctx = StudyEngine.getContextForToday(flags || {});
    const base = `${ctx.dayKey}_${ctx.minutes}_${ctx.runDay ? 1 : 0}${ctx.fasting ? 1 : 0}${ctx.rpe3}${ctx.noAnchors ? 1 : 0}`;
    return LS_TODAY_PREFIX + base;
  }

  function getOrCreateTodaySession(exerciseDB, userFlags) {
    const key = todayKeyFromFlags(userFlags);
    const cached = jparse(localStorage.getItem(key), null);
    if (cached && cached.meta && cached.meta.dayKey === todayISO()) return cached;

    const session = generateSession(exerciseDB, userFlags);
    localStorage.setItem(key, jstring(session));
    return session;
  }

  // ------------------ completion (save ONLY here) ------------------
  // resultPayload example expected from UI:
  // {
  //   repsDone: { pull: 12, push: 10, posterior: 12 },  // per main exercise
  //   bandsUsed: { pull:25, push:15, posterior:15 },    // optional override
  //   techniqueOk: { pullOk:true, pushOk:true, posteriorOk:true },
  //   notes: "..."
  // }
  function completeWorkout(session, resultPayload) {
    if (!session || !session.meta) throw new Error("Missing session");
    const r = resultPayload || {};

    // Build summary for StudyEngine progression
    const repsDone = r.repsDone || {};
    const tech = r.techniqueOk || {};

    const summary = {
      pull: Number(repsDone.pull || 0),
      push: Number(repsDone.push || 0),
      posterior: Number(repsDone.posterior || 0),
      core: 0
    };

    // Apply progression (only now)
    const st = StudyEngine.getState();
    const newState = StudyEngine.applySessionResult(st, {
      dayKey: session.meta.dayKey,
      rpe3: session.meta.rpe3,
      summary,
      technique: {
        pullOk: tech.pullOk !== undefined ? !!tech.pullOk : true,
        pushOk: tech.pushOk !== undefined ? !!tech.pushOk : true,
        posteriorOk: tech.posteriorOk !== undefined ? !!tech.posteriorOk : true
      },
      wasDeload: session.meta.deload === true
    });

    // Append to history
    const hist = jparse(localStorage.getItem(LS_HISTORY_KEY), []);
    hist.push({
      completedAt: new Date().toISOString(),
      meta: session.meta,
      summary,
      notes: r.notes || "",
      stateAfter: newState
    });
    localStorage.setItem(LS_HISTORY_KEY, jstring(hist));

    // Save export blob for later “ChatGPT analysis”
    const exportBlob = {
      exportedAt: new Date().toISOString(),
      session,
      result: { summary, notes: r.notes || "" },
      studyState: newState
    };
    localStorage.setItem(LS_EXPORT_KEY, jstring(exportBlob));

    return { ok: true, newState, exportBlob };
  }

  function getHistory() {
    return jparse(localStorage.getItem(LS_HISTORY_KEY), []);
  }

  function exportJSON() {
    return jparse(localStorage.getItem(LS_EXPORT_KEY), null) || {
      exportedAt: new Date().toISOString(),
      session: null,
      result: null,
      studyState: StudyEngine.getState()
    };
  }

  // ------------------ public API ------------------
  return {
    generateSession,
    getOrCreateTodaySession,
    completeWorkout,
    getHistory,
    exportJSON
  };

})();
