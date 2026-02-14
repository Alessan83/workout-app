/* =========================================================
   equipmentEngine.js — Equipment Engine v2.0
   ---------------------------------------------------------
   Responsabilità:
   - Modellare l'attrezzatura reale disponibile
   - Assegnare il carico iniziale corretto per pattern
   - Gestire progressione carico settimanale
   - Distinguere corpo libero:
       • isometrico
       • dinamico metabolico
       • pliometrico
   ---------------------------------------------------------
   NON gestisce:
   - Progressione sets/reps (StudyEngine)
   - Sicurezza lombare (BiomechanicalEngine)
========================================================= */

const EquipmentEngine = (function () {
  "use strict";

  /* =====================================================
     1️⃣ INVENTARIO REALE
  ===================================================== */

  const inventory = {
    longBandsKg: [15, 25, 35],                  // bande lunghe
    clipBandsKg: [4.5, 9.1, 13.6, 18.1, 22.6],  // moschettoni
    miniLoops: ["light", "medium", "hard", "xhard", "xxhard"],
    softBand: true,                              // elastico azzurro morbido
    bodyweight: true
  };


  /* =====================================================
     2️⃣ MODELLO CARICO PER PATTERN
     Ogni pattern ha:
       - tipo attrezzo preferito
       - carico iniziale
       - step progressione
  ===================================================== */

  const patternLoadModel = {

    /* ----- UPPER BODY ----- */

    pull: {
      type: "longBand",
      startKg: 15,
      progressionStepKg: 10
    },

    push: {
      type: "longBand",
      startKg: 15,
      progressionStepKg: 10
    },

    /* ----- HINGE / POSTERIOR ----- */

    hinge: {
      type: "longBand",
      startKg: 15,
      progressionStepKg: 10
    },

    posterior_accessory: {
      type: "clipBand",
      startKg: 9.1,
      progressionStepKg: 4.5
    },

    tibialis: {
      type: "clipBand",
      startKg: 4.5,
      progressionStepKg: 4.5
    },

    glute_bridge: {
      type: "miniLoop",
      startLevel: "medium"
    },

    /* ----- CORE ----- */

    core_isometric: {
      type: "bodyweight",
      subtype: "isometric"
    },

    /* ----- CARDIO / BODYWEIGHT ----- */

    cardio_dynamic: {
      type: "bodyweight",
      subtype: "dynamic"
    },

    plyometric: {
      type: "bodyweight",
      subtype: "plyometric"
    }

  };


  /* =====================================================
     3️⃣ FUNZIONI DI SUPPORTO
  ===================================================== */

  function nearestAvailable(value, list) {
    return list.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
    );
  }

  function calculateProgressedLoad(start, step, week) {
    const increment = Math.floor((week - 1) / 2); // aumenta ogni 2 settimane
    return start + (increment * step);
  }


  /* =====================================================
     4️⃣ FUNZIONE PRINCIPALE
     INPUT:
       - pattern (string)
       - week (numero settimana)
     OUTPUT:
       - oggetto carico strutturato
  ===================================================== */

  function getLoadForPattern(pattern, week = 1) {

    const rule = patternLoadModel[pattern];

    if (!rule) {
      return { type: "bodyweight", subtype: "generic" };
    }

    /* ----- BODYWEIGHT ----- */

    if (rule.type === "bodyweight") {
      return {
        type: "bodyweight",
        subtype: rule.subtype || "generic"
      };
    }

    /* ----- MINILOOP ----- */

    if (rule.type === "miniLoop") {
      return {
        type: "miniLoop",
        level: rule.startLevel
      };
    }

    /* ----- LONG BAND ----- */

    if (rule.type === "longBand") {
      const rawLoad = calculateProgressedLoad(
        rule.startKg,
        rule.progressionStepKg,
        week
      );

      return {
        type: "longBand",
        kg: nearestAvailable(rawLoad, inventory.longBandsKg)
      };
    }

    /* ----- CLIP BAND ----- */

    if (rule.type === "clipBand") {
      const rawLoad = calculateProgressedLoad(
        rule.startKg,
        rule.progressionStepKg,
        week
      );

      return {
        type: "clipBand",
        kg: nearestAvailable(rawLoad, inventory.clipBandsKg)
      };
    }

    return { type: "bodyweight" };
  }


  /* =====================================================
     5️⃣ ACCESSO INVENTARIO
  ===================================================== */

  function getInventory() {
    return inventory;
  }


  /* =====================================================
     EXPORT
  ===================================================== */

  return {
    getLoadForPattern,
    getInventory
  };

})();
