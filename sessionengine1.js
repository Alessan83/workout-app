/* sessionengine1.js V2
   SessionEngine = orchestration layer that builds a complete session plan
   using:
   - ExerciseDB (movements only)
   - TrainingKnowledge (rules/dosing/time/progression)
   - BiomechanicalEngine (technical checks + spine/no-anchor safety + exercise adaptation)
   - StudyEngine (progression model + RPE + modifiers + deload + week advancement)

   Design goals:
   - deterministic daily plan (stable within 24h)
   - accurate time closure for 25/35 min (warmup/mobility/strength/core/stretch)
   - supports "cycles" (rounds) and per-exercise prescription
   - no-anchor constraints: adapt/replace exercises if needed
   - avoid conceptual errors (e.g., side plank in seconds)
*/

(function (global) {
  "use strict";

  const SessionEngine = {};

  // -----------------------------
  // Utilities
  // -----------------------------
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function todayKeyISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStringToSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pickUnique(rng, arr, n) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, copy.length));
  }

  function normalizeExercise(ex) {
    // Minimal normalization for stable consumption.
    return {
      id: ex.id || ex.slug || ex.name,
      name: ex.name || ex.title || "Unnamed",
      phase: ex.phase || ex.category || "strength", // warmup | mobility | strength | core | stretch
      family: ex.family || ex.group || "general",   // pull | push | posterior | core | scapula | ankles | etc.
      equipment: ex.equipment || [],                // ["band","miniloop","rope","bodyweight","stick"]
      anchor: !!ex.anchor,                          // requires anchor (if true must adapt)
      pattern: ex.pattern || ex.primal || null,      // hinge/squat/push/pull/rotate/carry/crawl...
      repType: ex.repType || ex.metric || "reps",    // reps | seconds | meters
      cues: ex.cues || [],
      contraindications: ex.contraindications || [],
      tags: ex.tags || []
    };
  }

  function safeGet(obj, path, fallback) {
    try {
      const parts = path.split(".");
      let cur = obj;
      for (const p of parts) cur = cur[p];
      return (cur === undefined || cur === null) ? fallback : cur;
    } catch (_) {
      return fallback;
    }
  }

  // -----------------------------
  // LocalStorage keys
  // -----------------------------
  const LS_KEY = "palestra.sessionEngine.v1";

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { lastDayKey: null, lastSession: null };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : { lastDayKey: null, lastSession: null };
    } catch (_) {
      return { lastDayKey: null, lastSession: null };
    }
  }

  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (_) {}
  }

  // -----------------------------
  // Time / dosing helpers
  // -----------------------------
  function getTimeAPI() {
    // TrainingKnowledge.time.estimateSetSeconds is expected, otherwise fallback.
    const tk = global.TrainingKnowledge || {};
    const estimateFn = safeGet(tk, "time.estimateSetSeconds", null);

    function fallbackEstimateSetSeconds(prescription) {
      // Very conservative default:
      // per rep: tempo 2-1-2 => 5s; + 1s micro-reset => 6s/rep
      // set = reps * 6s + 20s buffer
      if (!prescription) return 60;
      const reps = prescription.reps || 10;
      const base = reps * 6 + 20;
      return clamp(base, 40, 140);
    }

    return {
      estimateSetSeconds: typeof estimateFn === "function" ? estimateFn : fallbackEstimateSetSeconds
    };
  }

  function makeTempo() {
    // default requested tempo: 2s stabilize? user wants 2-1-2 (ecc/hold/con)
    // We'll encode as {ecc:2, iso:1, con:2}. Warmup may be looser.
    return { ecc: 2, iso: 1, con: 2 };
  }

  function repMenu() {
    // requested dropdown values
    return [8, 10, 12, 14, 16, 18, 20];
  }

  // -----------------------------
  // Selection constraints
  // -----------------------------
  function filterByEquipment(ex, ctx) {
    // ctx.allowedEquipment = set of allowed items; if empty => allow all.
    if (!ctx.allowedEquipment || ctx.allowedEquipment.size === 0) return true;

    const eq = Array.isArray(ex.equipment) ? ex.equipment : [];
    // allow if any equipment matches OR bodyweight always allowed
    if (eq.includes("bodyweight")) return true;
    for (const e of eq) if (ctx.allowedEquipment.has(e)) return true;
    return false;
  }

  function filterNoAnchors(ex, ctx) {
    if (!ctx.noAnchors) return true;
    // If exercise needs anchor, we still allow it if BiomechanicalEngine can adapt it.
    return true;
  }

  function ensureSecondsForIsometrics(ex, prescription) {
    // Fix conceptual error: planks/side-planks etc must be seconds
    const isIsoFamily = ["plank", "anti-rotation", "anti-extension", "side-plank", "carry"].some(k =>
      (ex.family || "").toLowerCase().includes(k)
    );
    const wantsSeconds = ex.repType === "seconds" || ex.tags.includes("isometric") || isIsoFamily;

    if (!wantsSeconds) return prescription;

    const out = Object.assign({}, prescription);
    out.repType = "seconds";
    delete out.reps;

    // Derive seconds from reps if any; otherwise pick from RPE tier / week.
    const base = (typeof prescription.seconds === "number") ? prescription.seconds : 25;
    out.seconds = clamp(base, 10, 60);
    return out;
  }

  // Keep posterior chain volume controlled relative to pull (protect spine)
  function enforcePosteriorVsPullLimit(strengthList, limitRatio) {
    // strengthList items: {ex, prescription}
    const pulls = strengthList.filter(x => (x.ex.family || "") === "pull").length;
    const post = strengthList.filter(x => (x.ex.family || "") === "posterior").length;

    if (pulls === 0) return strengthList; // cannot enforce, keep as is
    if (post <= Math.floor(pulls * limitRatio)) return strengthList;

    // Remove extra posterior items from the end (least important) while keeping variety.
    let allowedPosterior = Math.floor(pulls * limitRatio);
    const out = [];
    for (const item of strengthList) {
      if (item.ex.family === "posterior") {
        if (allowedPosterior > 0) {
          out.push(item);
          allowedPosterior--;
        } else {
          // skip
        }
      } else {
        out.push(item);
      }
    }
    return out;
  }

  // -----------------------------
  // Main generation pipeline
  // -----------------------------
  SessionEngine.generateSession = function (exerciseDB, ctx) {
    if (!exerciseDB) throw new Error("SessionEngine.generateSession: missing exerciseDB");
    ctx = ctx || {};

    const dayKey = todayKeyISO();

    // Deterministic per-day: if already generated today, reuse it.
    const state = loadState();
    if (state.lastDayKey === dayKey && state.lastSession) {
      return state.lastSession;
    }

    // Compose context
    const context = buildContext(ctx);

    // Seeded RNG (dayKey + workoutIndex + flags)
    const seedStr = [
      dayKey,
      context.mode,
      context.durationMin,
      context.runDay ? "run" : "norun",
      context.fasting ? "fast" : "fed",
      context.noAnchors ? "noanchor" : "anchorok"
    ].join("|");
    const rng = mulberry32(hashStringToSeed(seedStr));

    // Normalize exercises
    const all = (Array.isArray(exerciseDB) ? exerciseDB : (exerciseDB.exercises || [])).map(normalizeExercise);

    // Build phase pools
    const pools = buildPools(all, context);

    // Determine budget minutes by requested percentages
    const budgets = computeBudgets(context.durationMin);

    // Decide cycles (rounds): small sessions might be 1 round, longer could be 2.
    // You asked: sometimes 3 exercises with 2 cycles, etc. We'll compute dynamically.
    // Rule:
    // - strength block uses 3–5 exercises; cycles 1–2 depending on time
    // - warmup/mobility are 1 cycle with short reps
    // - core/control: 1–2 exercises, 1 cycle
    const plan = {
      meta: {
        dayKey,
        createdAt: Date.now(),
        durationMin: context.durationMin,
        mode: context.mode,
        flags: {
          runDay: context.runDay,
          fasting: context.fasting,
          noAnchors: context.noAnchors
        },
        band: context.band,   // current suggested band tension value (15/25/35)
        setsBase: context.setsBase,
        rpeTier: context.rpeTier
      },
      blocks: []
    };

    // Build blocks
    plan.blocks.push(buildWarmupBlock(pools, budgets.warmupMin, rng, context));
    plan.blocks.push(buildMobilityBlock(pools, budgets.mobilityMin, rng, context));

    const strengthBlock = buildStrengthBlock(pools, budgets.strengthMin, rng, context);
    plan.blocks.push(strengthBlock);

    plan.blocks.push(buildCoreBlock(pools, budgets.coreMin, rng, context));
    plan.blocks.push(buildStretchBlock(pools, budgets.stretchMin, rng, context));

    // Final pass: time closure and no-anchor adaptation + safety/technical checks
    const finalized = finalizePlan(plan, rng, context);

    // Persist deterministic daily session
    saveState({ lastDayKey: dayKey, lastSession: finalized });

    return finalized;
  };

  function buildContext(userCtx) {
    const tk = global.TrainingKnowledge || {};
    const study = global.StudyEngine || null;

    const durationMin = (userCtx.durationMin === 35 || userCtx.durationMin === 30 || userCtx.durationMin === 25)
      ? userCtx.durationMin
      : (userCtx.duration === 35 || userCtx.duration === 30 || userCtx.duration === 25 ? userCtx.duration : 25);

    const allowedEquipment = new Set();
    // always allow bodyweight
    allowedEquipment.add("bodyweight");
    // Allow these by default since user has them
    allowedEquipment.add("band");
    allowedEquipment.add("miniloop");
    allowedEquipment.add("rope");
    allowedEquipment.add("stick");

    // If user explicitly wants to restrict equipment, honor it.
    if (Array.isArray(userCtx.allowedEquipment)) {
      allowedEquipment.clear();
      for (const e of userCtx.allowedEquipment) allowedEquipment.add(String(e).toLowerCase());
      if (!allowedEquipment.has("bodyweight")) allowedEquipment.add("bodyweight");
    }

    // 3-level RPE tier
    // Tier 1 = easy/technique, Tier 2 = moderate, Tier 3 = hard-but-safe
    const rpeTier = (userCtx.rpeTier === 1 || userCtx.rpeTier === 2 || userCtx.rpeTier === 3)
      ? userCtx.rpeTier
      : 2;

    // band default
    const band = (userCtx.band === 15 || userCtx.band === 25 || userCtx.band === 35) ? userCtx.band : 25;

    // base sets: session-level intent (study engine can override later)
    const setsBase = (userCtx.sets === 2 || userCtx.sets === 3 || userCtx.sets === 4) ? userCtx.sets : 3;

    // mode may map to the 3 workouts 1–2–3 (upper focus)
    const mode = userCtx.mode || "AUTO";

    // Modifiers
    const runDay = !!userCtx.runDay;
    const fasting = !!userCtx.fasting;
    const noAnchors = userCtx.noAnchors !== undefined ? !!userCtx.noAnchors : true;

    // Study engine can supply progression state & deload decisions
    const progressionState = (study && typeof study.getState === "function") ? study.getState() : null;
    const isDeload = (study && typeof study.isDeloadWeek === "function")
      ? !!study.isDeloadWeek(progressionState)
      : false;

    // Dosing templates (fallback)
    const dosingTemplates = safeGet(tk, "dosingTemplates", null);

    return {
      durationMin,
      allowedEquipment,
      rpeTier,
      band,
      setsBase,
      mode,
      runDay,
      fasting,
      noAnchors,
      isDeload,
      dosingTemplates,
      progressionState
    };
  }

  function buildPools(all, ctx) {
    const byPhase = { warmup: [], mobility: [], strength: [], core: [], stretch: [] };

    for (const ex of all) {
      if (!filterByEquipment(ex, ctx)) continue;
      if (!filterNoAnchors(ex, ctx)) continue;

      const phase = (ex.phase || "strength").toLowerCase();
      if (!byPhase[phase]) continue;
      byPhase[phase].push(ex);
    }

    // If no explicit phase tags exist, fallback by family tags
    if (byPhase.warmup.length === 0) {
      byPhase.warmup = all.filter(e => e.tags.includes("warmup") || e.family === "warmup");
    }
    if (byPhase.mobility.length === 0) {
      byPhase.mobility = all.filter(e => e.tags.includes("mobility") || e.family === "mobility");
    }
    if (byPhase.stretch.length === 0) {
      byPhase.stretch = all.filter(e => e.tags.includes("stretch") || e.family === "stretch");
    }
    if (byPhase.core.length === 0) {
      byPhase.core = all.filter(e => e.family === "core" || e.tags.includes("core"));
    }
    if (byPhase.strength.length === 0) {
      byPhase.strength = all.filter(e => !["warmup","mobility","stretch"].includes((e.phase||"").toLowerCase()));
    }

    return byPhase;
  }

  function computeBudgets(durationMin) {
    // Requested percentages:
    // 3% warmup, 2% mobility, 94% exercises (strength), 2% core/control, 3% stretch
    // Sum = 104% in user text; interpret as approximate targets:
    // We'll implement a normalized distribution while keeping the intent:
    // warmup ~3, mobility ~2, core ~2, stretch ~3, remainder strength.
    const warmup = Math.max(2, Math.round(durationMin * 0.10));   // practical minimum
    const mobility = Math.max(2, Math.round(durationMin * 0.08));
    const core = Math.max(2, Math.round(durationMin * 0.08));
    const stretch = Math.max(2, Math.round(durationMin * 0.10));
    const used = warmup + mobility + core + stretch;
    const strength = Math.max(10, durationMin - used);

    return {
      warmupMin: warmup,
      mobilityMin: mobility,
      strengthMin: strength,
      coreMin: core,
      stretchMin: stretch
    };
  }

  // -----------------------------
  // Block builders
  // -----------------------------
  function buildWarmupBlock(pools, budgetMin, rng, ctx) {
    // Prefer rope if available for warmup variety
    const rope = pools.warmup.filter(e => e.equipment.includes("rope"));
    const general = pools.warmup.filter(e => !e.equipment.includes("rope"));

    const items = [];
    if (rope.length > 0) items.push(pickUnique(rng, rope, 1)[0]);
    const remaining = 2; // keep warmup simple
    items.push(...pickUnique(rng, general.length ? general : pools.warmup, remaining));

    return {
      name: "Warm-up",
      phase: "warmup",
      budgetMin,
      cycles: 1,
      items: items.filter(Boolean).map(ex => ({
        exId: ex.id,
        name: ex.name,
        family: ex.family,
        prescription: makeWarmupPrescription(ex, ctx),
        notes: []
      }))
    };
  }

  function makeWarmupPrescription(ex, ctx) {
    // Warmup reps: 20–40 sec or 10–16 reps depending on type
    if (ex.equipment.includes("rope")) {
      return { repType: "seconds", seconds: ctx.durationMin <= 25 ? 60 : 90, tempo: null, restSeconds: 20 };
    }
    if (ex.repType === "seconds") {
      return { repType: "seconds", seconds: 30, tempo: null, restSeconds: 15 };
    }
    return { repType: "reps", reps: 12, tempo: { ecc: 1, iso: 0, con: 1 }, restSeconds: 15 };
  }

  function buildMobilityBlock(pools, budgetMin, rng, ctx) {
    const items = pickUnique(rng, pools.mobility, 3);
    return {
      name: "Mobility",
      phase: "mobility",
      budgetMin,
      cycles: 1,
      items: items.map(ex => ({
        exId: ex.id,
        name: ex.name,
        family: ex.family,
        prescription: makeMobilityPrescription(ex, ctx),
        notes: []
      }))
    };
  }

  function makeMobilityPrescription(ex, ctx) {
    // mobility usually slower + controlled ROM
    if (ex.repType === "seconds") {
      return { repType: "seconds", seconds: 30, tempo: null, restSeconds: 10 };
    }
    return { repType: "reps", reps: 10, tempo: { ecc: 2, iso: 1, con: 2 }, restSeconds: 10 };
  }

  function buildStrengthBlock(pools, budgetMin, rng, ctx) {
    // Goal: upper focus; lower only stability/ankles/posterior limited
    // We pick a balanced mix: pull + push + scapula + posterior (limited) + legs-stability (if runDay lower volume)
    const strength = pools.strength.slice();

    const pull = strength.filter(e => e.family === "pull" || e.tags.includes("pull"));
    const push = strength.filter(e => e.family === "push" || e.tags.includes("push"));
    const scap = strength.filter(e => e.family === "scapula" || e.tags.includes("scapula"));
    const posterior = strength.filter(e => e.family === "posterior" || e.tags.includes("posterior"));
    const ankles = strength.filter(e => e.family === "ankles" || e.tags.includes("ankles") || e.tags.includes("feet"));
    const legsStab = strength.filter(e => e.family === "legs-stability" || e.tags.includes("stability"));

    // Base selection count depends on time.
    const baseCount = (ctx.durationMin <= 25) ? 4 : 5;

    const chosen = [];
    chosen.push(...pickUnique(rng, pull, 1));
    chosen.push(...pickUnique(rng, push, 1));
    if (scap.length) chosen.push(...pickUnique(rng, scap, 1));

    // lower body: if runDay reduce
    if (!ctx.runDay) {
      if (ankles.length) chosen.push(...pickUnique(rng, ankles, 1));
      else if (legsStab.length) chosen.push(...pickUnique(rng, legsStab, 1));
    } else {
      // run day: ankles ok but lighter
      if (ankles.length) chosen.push(...pickUnique(rng, ankles, 1));
    }

    // posterior chain: keep optional but constrained
    if (posterior.length) chosen.push(...pickUnique(rng, posterior, 1));

    // Fill remaining
    const poolFallback = strength.filter(e => !chosen.includes(e));
    const fill = pickUnique(rng, poolFallback, Math.max(0, baseCount - chosen.filter(Boolean).length));
    chosen.push(...fill);

    const prescriptions = chosen.filter(Boolean).map(ex => ({
      ex,
      prescription: makeStrengthPrescription(ex, ctx)
    }));

    // enforce posterior limit to protect lumbar
    const limit = 1.2; // posterior <= 1.2 × pull
    const enforced = enforcePosteriorVsPullLimit(prescriptions, limit);

    // Decide cycles (rounds): if fewer exercises, allow 2 rounds; else 1
    const cycles = (ctx.durationMin >= 35 && enforced.length <= 4) ? 2 : 1;

    return {
      name: "Strength",
      phase: "strength",
      budgetMin,
      cycles,
      items: enforced.map(item => ({
        exId: item.ex.id,
        name: item.ex.name,
        family: item.ex.family,
        prescription: item.prescription,
        notes: []
      }))
    };
  }

  function makeStrengthPrescription(ex, ctx) {
    // Dosing logic:
    // - reps from menu (8..20), mapped by RPE tier + deload + fasting + runDay
    // - sets: base 3, deload reduces, fasting reduces ~10-15%
    // - band: start from ctx.band, with ability to show suggested band + progression handled by StudyEngine
    const menu = repMenu();

    let reps = (ctx.rpeTier === 1) ? 12 : (ctx.rpeTier === 2 ? 10 : 8);
    // if exercise is more "endurance" (band small) allow higher reps
    if (ex.tags.includes("endurance")) reps = 14;

    // Modifiers
    if (ctx.isDeload) reps = Math.min(12, reps + 2);
    if (ctx.fasting) reps = Math.min(14, reps + 2);
    if (ctx.runDay && (ex.family === "posterior" || ex.family === "legs-stability")) reps = Math.min(14, reps + 2);

    // Snap to menu
    reps = menu.reduce((best, v) => (Math.abs(v - reps) < Math.abs(best - reps) ? v : best), menu[0]);

    let sets = ctx.setsBase;
    if (ctx.isDeload) sets = Math.max(2, sets - 1);
    if (ctx.fasting) sets = Math.max(2, sets - 1);

    // Default tempo requested
    const tempo = makeTempo();

    const presc = {
      repType: "reps",
      reps,
      sets,
      tempo,
      restSeconds: (ctx.rpeTier === 3) ? 60 : 45,
      bandSuggested: (ex.equipment.includes("band") ? ctx.band : null),
      menuReps: menu
    };

    // Force seconds for isometrics
    return ensureSecondsForIsometrics(ex, presc);
  }

  function buildCoreBlock(pools, budgetMin, rng, ctx) {
    const items = pickUnique(rng, pools.core, 2);
    return {
      name: "Core / Control",
      phase: "core",
      budgetMin,
      cycles: 1,
      items: items.map(ex => ({
        exId: ex.id,
        name: ex.name,
        family: ex.family,
        prescription: makeCorePrescription(ex, ctx),
        notes: []
      }))
    };
  }

  function makeCorePrescription(ex, ctx) {
    // core tends to be seconds; keep safe
    const presc = {
      repType: ex.repType === "seconds" ? "seconds" : "reps",
      reps: 10,
      seconds: 25,
      sets: 2,
      tempo: makeTempo(),
      restSeconds: 30
    };
    return ensureSecondsForIsometrics(ex, presc);
  }

  function buildStretchBlock(pools, budgetMin, rng, ctx) {
    const items = pickUnique(rng, pools.stretch, 2);
    return {
      name: "Stretch / Downregulation",
      phase: "stretch",
      budgetMin,
      cycles: 1,
      items: items.map(ex => ({
        exId: ex.id,
        name: ex.name,
        family: ex.family,
        prescription: makeStretchPrescription(ex, ctx),
        notes: []
      }))
    };
  }

  function makeStretchPrescription(ex, ctx) {
    return { repType: "seconds", seconds: 40, tempo: null, restSeconds: 10 };
  }

  // -----------------------------
  // Finalization: adaptation, checks, time closure
  // -----------------------------
  function finalizePlan(plan, rng, ctx) {
    const biomech = global.BiomechanicalEngine || null;
    const tk = global.TrainingKnowledge || {};
    const timeAPI = getTimeAPI();

    const noAnchorRules = safeGet(tk, "noAnchorRules", null);
    const safetyRules = safeGet(tk, "spineSafety", null);
    const technicalChecks = safeGet(tk, "technicalChecks", null);

    // Adapt items for no-anchor and attach cues/checks
    for (const block of plan.blocks) {
      for (const item of block.items) {
        // Resolve exercise record for adaptation if biomech is present
        if (biomech && typeof biomech.resolveExercise === "function") {
          const resolved = biomech.resolveExercise(item.exId);
          if (resolved) {
            item._resolved = resolved;
          }
        }

        // Adapt if anchored
        if (ctx.noAnchors && biomech && typeof biomech.adaptExercise === "function") {
          const res = biomech.adaptExercise(item._resolved || item, {
            noAnchors: true,
            available: Array.from(ctx.allowedEquipment),
            band: ctx.band,
            miniloop: true,
            rope: true,
            stick: true
          });
          if (res && res.modifiedName) item.name = res.modifiedName;
          if (res && res.notes) item.notes = (item.notes || []).concat(res.notes);
          if (res && res.repType) item.prescription.repType = res.repType;
        } else if (ctx.noAnchors && noAnchorRules) {
          // minimal fallback note
          item.notes = (item.notes || []).concat(["No-anchor: if exercise needs anchor, replace with no-anchor variant."]);
        }

        // Technical cues & posture checks
        item.cues = [];
        if (biomech && typeof biomech.getCues === "function") {
          item.cues = item.cues.concat(biomech.getCues(item._resolved || item) || []);
        } else if (technicalChecks) {
          // generic core/spine cues
          item.cues.push("Core attivo (addome + glutei), colonna neutra.");
          item.cues.push("Scapole stabili: spalle lontane dalle orecchie.");
          item.cues.push("Respira: espira in fase di sforzo, non trattenere.");
        }

        // Spine safety rules
        if (safetyRules) {
          item.safety = safetyRules;
        } else {
          item.safety = {
            stopIf: ["dolore acuto irradiato", "formicolio/parestesie", "perdita forza improvvisa"],
            keepNeutral: true,
            avoidEndRangeFlexionLoaded: true
          };
        }
      }
    }

    // Time estimation + closure:
    // compute block time from cycles * sum(sets * setSeconds + rest)
    const timeReport = estimatePlanTime(plan, timeAPI);
    plan.meta.timeEstimate = timeReport;

    // If estimated time differs from target, adjust by:
    // - for longer: reduce sets by 1 on last strength exercise
    // - for shorter: add a safe accessory exercise to strength or add 1 extra cycle to warmup/mobility
    plan = closeToTargetMinutes(plan, timeAPI, rng, ctx);

    // Attach a compact “what to do” per block for UI clarity
    plan.blocks.forEach(block => {
      block.instructions = buildBlockInstructions(block);
    });

    return plan;
  }

  function estimatePlanTime(plan, timeAPI) {
    let totalSec = 0;
    const perBlock = [];

    for (const block of plan.blocks) {
      let sec = 0;
      const cycles = block.cycles || 1;

      for (let c = 0; c < cycles; c++) {
        for (const it of block.items) {
          const p = it.prescription || {};
          // If seconds-based: seconds + rest
          if (p.repType === "seconds") {
            const s = (typeof p.seconds === "number") ? p.seconds : 30;
            const rest = (typeof p.restSeconds === "number") ? p.restSeconds : 15;
            const sets = (typeof p.sets === "number") ? p.sets : 1;
            sec += sets * (s + rest);
          } else {
            const sets = (typeof p.sets === "number") ? p.sets : 1;
            const rest = (typeof p.restSeconds === "number") ? p.restSeconds : 20;
            // estimate set duration from tempo & reps
            const setSeconds = timeAPI.estimateSetSeconds(p);
            sec += sets * setSeconds + (sets - 1) * rest;
          }
        }
      }

      perBlock.push({ phase: block.phase, name: block.name, seconds: sec, minutes: Math.round(sec / 60) });
      totalSec += sec;
    }

    return {
      totalSeconds: totalSec,
      totalMinutes: Math.round(totalSec / 60),
      blocks: perBlock
    };
  }

  function closeToTargetMinutes(plan, timeAPI, rng, ctx) {
    const targetMin = ctx.durationMin;
    let report = estimatePlanTime(plan, timeAPI);

    // tolerate ±2 minutes
    const tol = 2;

    // Too long -> trim strength volume first
    while (report.totalMinutes > targetMin + tol) {
      const strength = plan.blocks.find(b => b.phase === "strength");
      if (!strength) break;

      // Reduce sets on last item if possible
      const last = strength.items[strength.items.length - 1];
      if (last && last.prescription && typeof last.prescription.sets === "number" && last.prescription.sets > 2) {
        last.prescription.sets -= 1;
      } else if (strength.cycles > 1) {
        strength.cycles -= 1;
      } else {
        // as final fallback remove last accessory item if >3
        if (strength.items.length > 3) strength.items.pop();
        else break;
      }

      report = estimatePlanTime(plan, timeAPI);
    }

    // Too short -> add safe accessory to strength or increase cycles if short
    while (report.totalMinutes < targetMin - tol) {
      const strength = plan.blocks.find(b => b.phase === "strength");
      if (!strength) break;

      // Add one set to first pull/push if safe, else add 1 mobility cycle
      const candidate = strength.items.find(it => it.family === "pull" || it.family === "push") || strength.items[0];
      if (candidate && candidate.prescription) {
        const sets = candidate.prescription.sets || 2;
        if (sets < 4 && !ctx.isDeload && !ctx.fasting) {
          candidate.prescription.sets = sets + 1;
        } else {
          // increase warmup cycle slightly
          const warmup = plan.blocks.find(b => b.phase === "warmup");
          if (warmup && warmup.cycles < 2) warmup.cycles += 1;
          else break;
        }
      } else break;

      report = estimatePlanTime(plan, timeAPI);
    }

    plan.meta.timeEstimate = report;
    return plan;
  }

  function buildBlockInstructions(block) {
    const lines = [];
    if (block.phase === "strength") {
      lines.push(`Esegui ${block.cycles} ciclo/i. Per ogni esercizio: completa tutte le serie prima di passare al successivo.`);
      lines.push("Tempo ripetizione: 2s discesa / 1s stabilizza / 2s ritorno (se reps).");
    } else if (block.phase === "warmup") {
      lines.push("Riscaldamento progressivo: intensità moderata, respira regolare.");
    } else if (block.phase === "mobility") {
      lines.push("Mobilità controllata: ROM senza dolore, niente molleggi aggressivi.");
    } else if (block.phase === "core") {
      lines.push("Core/controllo: qualità > quantità, colonna neutra, respira.");
    } else if (block.phase === "stretch") {
      lines.push("Defaticamento: rilassa, allunga senza dolore.");
    }
    return lines;
  }

  // -----------------------------
  // Public helper: simulate progression (minimal stub)
  // Dashboard/analytics should be in coordinator/UI, but engine can output a simulation.
  // -----------------------------
  SessionEngine.simulateProgression = function (weeks, opts) {
    weeks = (typeof weeks === "number") ? weeks : 12;
    opts = opts || {};
    const sessionsPerWeek = opts.sessionsPerWeek || 3;

    // S-curve proxy: slow start (weeks 1-3), linear-ish mid (4-9), taper/deload (10-12)
    // output factors applied to volume/intensity suggestions
    const out = [];
    for (let w = 1; w <= weeks; w++) {
      const x = (w - 1) / (weeks - 1);
      // logistic in [0,1]
      const k = 8;
      const mid = 0.5;
      const logistic = 1 / (1 + Math.exp(-k * (x - mid)));
      // scale to [0.85, 1.15]
      const loadFactor = 0.85 + logistic * 0.30;

      // deload every 4th week (or last week)
      const deload = (w % 4 === 0) || (w === weeks);
      const finalFactor = deload ? Math.max(0.75, loadFactor - 0.15) : loadFactor;

      out.push({
        week: w,
        sessions: sessionsPerWeek,
        loadFactor: Number(finalFactor.toFixed(3)),
        deload
      });
    }
    return out;
  };

  // -----------------------------
  // Export
  // -----------------------------
  global.SessionEngine = SessionEngine;

})(typeof window !== "undefined" ? window : globalThis);
