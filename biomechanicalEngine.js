// =======================================================
// BIOMECHANICAL ENGINE v2.1 (TrainingKnowledge-aligned)
// - Reads rules from TrainingKnowledge (single source of truth)
// - Normalizes dose type (reps vs seconds), fixes side plank
// - No-anchor adaptations based on noAnchorRules
// - Deterministic safety validation (no Math.random decisions here)
// - Cues + warnings + session-level validation
// =======================================================

/* global TrainingKnowledge */

const BiomechanicalEngine = (function () {
  "use strict";

  if (typeof TrainingKnowledge === "undefined") {
    throw new Error("TrainingKnowledge not loaded");
  }

  // ---------- helpers ----------
  const lower = (s) => String(s || "").toLowerCase();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const hasAny = (text, arr) => {
    const t = lower(text);
    return (arr || []).some(k => t.includes(lower(k)));
  };

  function normalizeExercise(ex) {
    const clone = JSON.parse(JSON.stringify(ex || {}));

    // normalize anchor flags from different DBs
    if (clone.anchor !== undefined && clone.requiresAnchor === undefined) {
      clone.requiresAnchor = !!clone.anchor;
    }
    if (clone.requiresAnchor === undefined) {
      const name = lower(clone.name);
      clone.requiresAnchor = hasAny(name, ["anchor", "door", "porta", "ancor", "fiss"]);
    }

    // normalize tags
    if (!Array.isArray(clone.tags)) clone.tags = [];
    if (clone.family) clone.tags.push(clone.family);
    if (clone.movement_pattern) clone.tags.push(clone.movement_pattern);

    // apply TrainingKnowledge normalization (side plank => seconds, etc.)
    return TrainingKnowledge.normalizeExercisePrescription(clone);
  }

  // ---------- classification ----------
  function classify(exRaw) {
    const ex0 = normalizeExercise(exRaw);
    const name = lower(ex0.name);

    const doseType = TrainingKnowledge.classifyDoseType(ex0);

    const hinge = !!ex0.hinge || hasAny(name, ["rdl", "romanian", "good morning", "hip hinge", "deadlift", "stacco"]);
    const antiRotation = !!ex0.antiRotation || hasAny(name, ["pallof", "anti-rot"]);
    const antiExtension = !!ex0.antiExtension || hasAny(name, ["plank", "hollow", "dead bug", "anti-ext"]);
    const isIsometric = (doseType === TrainingKnowledge.doseTypes.SECONDS) || hasAny(name, ["hold", "isometric", "iso"]);

    // family/pattern
    const family = ex0.family || ex0.group || ex0.category || (
      hasAny(name, ["plank", "dead bug", "hollow", "core"]) ? "core" :
      hasAny(name, ["squat", "lunge", "deadlift", "rdl", "glute", "hip", "calf", "tibialis"]) ? "posterior" :
      "upper"
    );

    const pattern =
      ex0.movement_pattern ||
      (hinge ? "hinge" :
       family === "core" && antiRotation ? "anti_rotation" :
       family === "core" && antiExtension ? "anti_extension" :
       family === "core" ? "core_general" :
       family === "upper" && hasAny(name, ["push", "press", "dip"]) ? "push" :
       family === "upper" ? "pull" :
       "general"
      );

    // conservative load heuristics (0..3)
    let compressive = 1, shear = 1, lumbar = 1;
    if (isIsometric) { compressive = 0; shear = antiRotation ? 0 : 1; lumbar = 1; }
    if (hinge) { compressive = 2; shear = 2; lumbar = 2; }
    if (family === "core" && antiExtension) { compressive = 0; shear = 1; lumbar = 1; }

    const lumbarRisk = clamp((lumbar + shear) - (isIsometric ? 1 : 0), 0, 3);

    // allowedMaxBand (optional DB override)
    let allowedMaxBand = ex0.allowedMaxBand;
    if (allowedMaxBand == null) {
      // hinge/posterior: conservative default
      allowedMaxBand = (hinge || family === "posterior") ? 25 : 35;
    }

    return {
      ...ex0,
      doseType,
      isIsometric,
      family,
      pattern,
      hinge,
      antiRotation,
      antiExtension,
      compressiveLoad: compressive,
      shearLoad: shear,
      lumbarStress: lumbar,
      lumbarRisk,
      allowedMaxBand
    };
  }

  // ---------- no-anchor adaptation ----------
  // Returns { ok:true, exercise, note } or { ok:false }
  function adaptNoAnchor(exClassified, allClassified) {
    const ex = exClassified;
    const rules = TrainingKnowledge.noAnchorRules;

    // if anchor not required => ok
    if (!ex.requiresAnchor) return { ok: true, exercise: ex, note: null };

    // explicit DB-provided adaptedVersion / adaptedId support
    if (ex.adaptedVersion && typeof ex.adaptedVersion === "object") {
      const a = classify(ex.adaptedVersion);
      a.requiresAnchor = false;
      return { ok: true, exercise: a, note: "Variante no-anchor (adaptedVersion)" };
    }
    if (ex.adaptedId && Array.isArray(allClassified)) {
      const found = allClassified.find(e => e.id === ex.adaptedId);
      if (found) return { ok: true, exercise: found, note: "Variante no-anchor (adaptedId)" };
    }

    // pattern-based safe replacement
    const pool = (allClassified || []).filter(e => !e.requiresAnchor);

    // anti-rotation anchored => pick core anti-rotation no-anchor
    if (ex.antiRotation) {
      const c = pool.filter(e => e.family === "core" && (e.antiRotation || hasAny(e.name, ["side plank", "bird dog", "dead bug"])));
      if (c.length) return { ok: true, exercise: c[0], note: "Sostituzione no-anchor (anti-rot)" };
    }

    // pull anchored => row under feet / pull-apart / high row
    if (ex.pattern === "pull") {
      const c = pool.filter(e => e.family === "upper" && hasAny(e.name, ["row", "rematore", "pull-apart", "high row", "rear fly", "face pull"]));
      if (c.length) return { ok: true, exercise: c[0], note: "Sostituzione no-anchor (pull)" };
    }

    // push anchored => band around back floor press / push-up variants
    if (ex.pattern === "push") {
      const c = pool.filter(e => hasAny(e.name, ["push-up", "floor press", "press", "pike push", "shoulder press"]));
      if (c.length) return { ok: true, exercise: c[0], note: "Sostituzione no-anchor (push)" };
    }

    // last resort: same family, low lumbar risk
    const safe = pool
      .filter(e => e.family === ex.family && e.lumbarRisk <= 2)
      .sort((a, b) => a.lumbarRisk - b.lumbarRisk);

    if (safe.length) return { ok: true, exercise: safe[0], note: "Sostituzione no-anchor (fallback safe)" };

    return { ok: false, note: "Nessuna variante no-anchor disponibile" };
  }

  // ---------- cues & safety ----------
  function getCues(exClassified) {
    const cues = [];

    // universal cues from TrainingKnowledge
    (TrainingKnowledge.spineSafety.universalCues || []).forEach(x => cues.push(x));

    // checklist pre-set
    (TrainingKnowledge.technicalChecks.preSetChecklist || []).forEach(x => cues.push(x));

    // pattern-specific
    const byP = TrainingKnowledge.technicalChecks.byPattern || {};
    if (exClassified.pattern === "hinge" && byP.hinge) cues.push(...byP.hinge);
    if (exClassified.pattern === "pull" && byP.rowPull) cues.push(...byP.rowPull);
    if (exClassified.pattern === "push" && byP.push) cues.push(...byP.push);
    if (hasAny(exClassified.name, ["plank", "side plank"]) && byP.plank) cues.push(...byP.plank);

    // exercise-specific cues if present
    if (Array.isArray(exClassified.cues)) cues.push(...exClassified.cues);
    if (exClassified.note) cues.push(exClassified.note);

    // de-dup + cap
    return Array.from(new Set(cues)).filter(Boolean).slice(0, 10);
  }

  function getWarnings(exClassified, ctx) {
    const w = [];

    if (exClassified.isIsometric) {
      w.push("Unità: secondi (tenuta). Qualità > durata.");
    }
    if (exClassified.hinge) {
      w.push("Hinge: stop se perdi neutro lombare; riduci ROM/banda.");
    }
    if (exClassified.antiExtension) {
      w.push("Anti-estensione: costole giù, evita iperestensione lombare.");
    }
    if (exClassified.antiRotation) {
      w.push("Anti-rotazione: bacino fermo, niente compensi.");
    }
    if (exClassified.requiresAnchor) {
      w.push("Richiede appiglio: usare variante no-anchor proposta.");
    }

    // caution patterns from TrainingKnowledge
    (TrainingKnowledge.spineSafety.cautionPatterns || []).forEach(x => w.push(x));

    // if runDay: extra caution hinge
    if (ctx?.runDay && exClassified.hinge) {
      w.push("Giorno corsa: hinge/hinge pesanti sconsigliati.");
    }

    return Array.from(new Set(w)).slice(0, 8);
  }

  // Validate exercise against context
  function validateExercise(exClassified, ctx) {
    const c = ctx || {};

    // fasting: more conservative (no hard compressive patterns)
    if (c.fasting && exClassified.compressiveLoad > 1) return { ok: false, reason: "Fasting: esercizio troppo compressivo" };

    // runDay: avoid hinge by default
    if (c.runDay && exClassified.hinge) return { ok: false, reason: "Run day: hinge escluso" };

    // band cap
    if (c.band != null && exClassified.allowedMaxBand != null && c.band > exClassified.allowedMaxBand) {
      return { ok: false, reason: "Banda troppo alta per esercizio" };
    }

    return { ok: true };
  }

  // ---------- session validation ----------
  // Expects session.blocks.strength array items with .exercise + .sets
  function validateSession(session) {
    const warn = [];

    if (!session || !session.blocks) return { warnings: ["Sessione non valida"] };

    let pullSets = 0, posteriorSets = 0, hingeCount = 0;

    const strength = session.blocks.strength || [];
    strength.forEach(it => {
      if (!it || !it.exercise) return;
      const ex = classify(it.exercise);

      const sets = it.sets || 0;

      // treat upper pull/push both count as "pull budget" for this ratio?:
      // to align with your rule, we count UPPER as pull-base, POSTERIOR as posterior.
      if (ex.family === "upper") pullSets += sets;
      if (ex.family === "posterior") posteriorSets += sets;
      if (ex.hinge) hingeCount += 1;
    });

    const cap = TrainingKnowledge.spineSafety.posteriorToPullCap || 1.2;
    if (pullSets > 0 && posteriorSets > pullSets * cap) {
      warn.push("Posterior overload: riduci posterior/hinge o aumenta tirate upper.");
    }
    // hinge limit: conservative: max 2
    if (hingeCount > 2) warn.push("Troppi hinge nella sessione: limitare a 2.");

    // stop rules always available to UI
    (TrainingKnowledge.spineSafety.stopRules || []).forEach(x => warn.push(x));

    return { warnings: Array.from(new Set(warn)).slice(0, 10) };
  }

  // ---------- public API ----------
  return {
    classify,
    adaptNoAnchor: (ex) => adaptNoAnchor(classify(ex), null), // convenience (single ex)
    adaptExerciseNoAnchor: adaptNoAnchor, // full form with pool
    validateExercise,
    getCues,
    getWarnings,
    validateSession
  };

})();
