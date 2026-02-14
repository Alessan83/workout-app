/* =========================================================
   BIOMECHANICAL ENGINE v3.0
   ---------------------------------------------------------
   Responsabilità:
   - Normalizzazione esercizi
   - Classificazione pattern biomeccanico
   - Valutazione rischio lombare
   - Validazione rispetto al contesto (runDay, fasting)
   - Adattamento no-anchor
   - Generazione cues e warnings
   - Validazione sessione (posterior cap ecc.)
   ---------------------------------------------------------
   NON gestisce:
   - Progressione volume (StudyEngine)
   - Scelta carico (EquipmentEngine)
========================================================= */

const BiomechanicalEngine = (function () {
  "use strict";

  if (typeof TrainingKnowledge === "undefined") {
    throw new Error("TrainingKnowledge not loaded");
  }

  /* =====================================================
     HELPERS
  ===================================================== */

  const lower = (s) => String(s || "").toLowerCase();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function hasAny(text, keywords) {
    const t = lower(text);
    return (keywords || []).some(k => t.includes(lower(k)));
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  /* =====================================================
     1️⃣ NORMALIZZAZIONE ESERCIZIO
  ===================================================== */

  function normalizeExercise(exRaw) {
    const ex = deepClone(exRaw);

    ex.name = ex.name || "Esercizio";

    // normalize anchor flag
    if (ex.requiresAnchor === undefined) {
      ex.requiresAnchor = hasAny(ex.name, [
        "anchor", "door", "porta", "sbarra", "barra", "lat machine"
      ]);
    }

    // normalize dose type
    ex = TrainingKnowledge.normalizeExercisePrescription(ex);

    return ex;
  }

  /* =====================================================
     2️⃣ CLASSIFICAZIONE PATTERN
  ===================================================== */

  function classify(exRaw) {

    const ex = normalizeExercise(exRaw);
    const name = lower(ex.name);

    const doseType = TrainingKnowledge.classifyDoseType(ex);

    let pattern = "general";
    let family = "upper";

    // --- CORE ---
    if (hasAny(name, ["plank", "side plank", "hollow", "dead bug"])) {
      pattern = "core_isometric";
      family = "core";
    }

    // --- HINGE ---
    else if (hasAny(name, ["rdl", "deadlift", "stacco", "good morning", "hip hinge"])) {
      pattern = "hinge";
      family = "posterior";
    }

    // --- TIBIALIS ---
    else if (hasAny(name, ["tibialis"])) {
      pattern = "tibialis";
      family = "posterior";
    }

    // --- GLUTE BRIDGE ---
    else if (hasAny(name, ["bridge", "hip thrust"])) {
      pattern = "glute_bridge";
      family = "posterior";
    }

    // --- PUSH ---
    else if (hasAny(name, ["push", "press", "dip"])) {
      pattern = "push";
      family = "upper";
    }

    // --- PULL ---
    else if (hasAny(name, ["row", "rematore", "pull", "face pull"])) {
      pattern = "pull";
      family = "upper";
    }

    // --- CARDIO ---
    else if (hasAny(name, ["jumping jack", "mountain", "burpee"])) {
      pattern = "cardio_dynamic";
      family = "conditioning";
    }

    // --- PLYO ---
    else if (hasAny(name, ["jump squat", "jump lunge", "plyo"])) {
      pattern = "plyometric";
      family = "conditioning";
    }

    /* =====================================================
       RISK MODEL
    ===================================================== */

    let compressive = 1;
    let shear = 1;

    if (pattern === "hinge") {
      compressive = 2;
      shear = 2;
    }

    if (pattern === "core_isometric") {
      compressive = 0;
      shear = 1;
    }

    if (pattern === "plyometric") {
      compressive = 2;
      shear = 1;
    }

    const lumbarRisk = clamp(compressive + shear - 1, 0, 3);

    return {
      ...ex,
      pattern,
      family,
      doseType,
      compressiveLoad: compressive,
      shearLoad: shear,
      lumbarRisk
    };
  }

  /* =====================================================
     3️⃣ VALIDAZIONE CONTESTO
  ===================================================== */

  function validateExercise(exClassified, ctx = {}) {

    if (ctx.runDay && exClassified.pattern === "hinge") {
      return { ok: false, reason: "Run day: hinge escluso" };
    }

    if (ctx.fasting && exClassified.compressiveLoad > 1) {
      return { ok: false, reason: "Fasting: carico compressivo alto" };
    }

    if (ctx.deload && exClassified.pattern === "plyometric") {
      return { ok: false, reason: "Deload: plyometric escluso" };
    }

    return { ok: true };
  }

  /* =====================================================
     4️⃣ ADATTAMENTO NO-ANCHOR
  ===================================================== */

  function adaptNoAnchor(exClassified, pool = []) {

    if (!exClassified.requiresAnchor) {
      return { ok: true, exercise: exClassified };
    }

    const safePool = pool.filter(e => !e.requiresAnchor);

    const alternative = safePool.find(e =>
      classify(e).pattern === exClassified.pattern
    );

    if (alternative) {
      return {
        ok: true,
        exercise: classify(alternative),
        note: "Variante no-anchor"
      };
    }

    return { ok: false };
  }

  /* =====================================================
     5️⃣ CUES
  ===================================================== */

  function getCues(exClassified) {

    const cues = [];

    // universal spine cues
    (TrainingKnowledge.spineSafety.universalCues || [])
      .forEach(c => cues.push(c));

    // pattern specific
    if (exClassified.pattern === "hinge") {
      cues.push("Hinge: mantieni neutro lombare.");
    }

    if (exClassified.pattern === "core_isometric") {
      cues.push("Addome compatto, bacino neutro.");
    }

    if (exClassified.pattern === "plyometric") {
      cues.push("Atterra morbido, ginocchia allineate.");
    }

    return Array.from(new Set(cues)).slice(0, 8);
  }

  /* =====================================================
     6️⃣ WARNINGS
  ===================================================== */

  function getWarnings(exClassified, ctx = {}) {

    const warnings = [];

    if (exClassified.pattern === "hinge") {
      warnings.push("Riduci ROM se perdi neutro.");
    }

    if (ctx.runDay && exClassified.pattern === "plyometric") {
      warnings.push("Run day: plyometric da valutare.");
    }

    if (exClassified.lumbarRisk >= 3) {
      warnings.push("Alto stress lombare.");
    }

    return Array.from(new Set(warnings)).slice(0, 6);
  }

  /* =====================================================
     7️⃣ VALIDAZIONE SESSIONE
  ===================================================== */

  function validateSession(session) {

    if (!session || !session.blocks) {
      return { warnings: ["Sessione non valida"] };
    }

    let pullSets = 0;
    let posteriorSets = 0;

    const strength = session.blocks.strength || [];

    strength.forEach(item => {
      const ex = classify(item.exercise || item);

      if (ex.family === "upper") pullSets += (item.sets || 0);
      if (ex.family === "posterior") posteriorSets += (item.sets || 0);
    });

    const cap = TrainingKnowledge.spineSafety.posteriorToPullCap || 1.2;

    const warnings = [];

    if (pullSets > 0 && posteriorSets > pullSets * cap) {
      warnings.push("Posterior > limite 1.2x pull.");
    }

    return { warnings };
  }

  /* =====================================================
     EXPORT
  ===================================================== */

  return {
    classify,
    validateExercise,
    adaptNoAnchor,
    getCues,
    getWarnings,
    validateSession
  };

})();
