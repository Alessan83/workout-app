/* =========================================================
   trainingKnowledge.js — Knowledge Base v2.1 (STABLE)
   Used by:
     - StudyEngine
     - SessionEngine
     - BiomechanicalEngine
     - WorkoutCoordinator
========================================================= */

(function (global) {
  "use strict";

  const TrainingKnowledge = {

    version: "2.1.0",
    updated: "2026-02-15",

    /* =========================
       1) DOSE TYPES
    ========================= */

    doseTypes: {
      REPS: "reps",
      SECONDS: "seconds",
      MIXED: "mixed"
    },

    classifyDoseType(ex) {
      const name = (ex?.name || "").toLowerCase();
      const tags = (ex?.tags || []).map(t => String(t).toLowerCase());

      const has = (s) => name.includes(s) || tags.includes(s);

      if (
        has("plank") ||
        has("side plank") ||
        has("hollow") ||
        has("hold") ||
        has("isometric") ||
        has("wall sit")
      ) return this.doseTypes.SECONDS;

      if (has("pause") || has("isometria")) return this.doseTypes.MIXED;

      return this.doseTypes.REPS;
    },

    normalizeExercisePrescription(ex) {
      const clone = JSON.parse(JSON.stringify(ex || {}));
      const dt = this.classifyDoseType(clone);

      clone.prescription = clone.prescription || {};

      if (dt === this.doseTypes.SECONDS) {
        clone.prescription.unit = "seconds";
        delete clone.prescription.loadKg;
      } else {
        clone.prescription.unit = "reps";
      }

      return clone;
    },

    /* =========================
       2) TEMPO MODEL
    ========================= */

    tempo: {

      defaultSeconds: { down: 2, hold: 1, up: 2 },

      estimateSetSeconds(reps, tempo = null) {
        const t = tempo || this.defaultSeconds;
        const repSec =
          (t.down || 0) +
          (t.hold || 0) +
          (t.up || 0);

        return Math.max(0, reps * repSec);
      },

      estimateHoldSeconds(seconds) {
        return Math.max(0, Number(seconds || 0));
      }

    },

    /* =========================
       3) SPINE SAFETY
    ========================= */

    spineSafety: {

      goals: [
        "Neutral spine",
        "Core endurance",
        "Gradual load progression"
      ],

      stopRules: [
        "Acute pain → stop",
        "Repeated loss of neutral spine → reduce load",
        "Next-day pain spike → deload"
      ],

      universalCues: [
        "Collo neutro",
        "Costole giù",
        "Addome attivo",
        "Respira controllato"
      ],

      posteriorToPullCap: 1.2,

      cautionPatterns: [
        "Flessione lombare sotto fatica",
        "Rotazioni esplosive non controllate"
      ]
    },

    /* =========================
       4) DOSING TEMPLATES
    ========================= */

    dosingTemplates: {

      warmup: {
        durationMin: { for25: 3, for35: 5 },
        examples: [
          { item: "Circonduzioni spalle", unit: "reps", range: [8, 12] },
          { item: "Cat-cow", unit: "reps", range: [8, 12] },
          { item: "Hip hinge patterning", unit: "reps", range: [8, 12] }
        ]
      },

      mobility: {
        durationMin: { for25: 2, for35: 3 },
        examples: [
          { item: "Stretch psoas", unit: "seconds", range: [20, 40] },
          { item: "Basculamento bacino", unit: "reps", range: [8, 12] }
        ]
      },

      coreControl: {
        durationMin: { for25: 2, for35: 3 },
        examples: [
          { item: "Plank", unit: "seconds", range: [15, 30] },
          { item: "Side plank", unit: "seconds", range: [15, 30] },
          { item: "Bird dog", unit: "reps", range: [6, 10] }
        ]
      },

      breathingCooldown: {
        durationMin: { for25: 2, for35: 3 },
        protocol: {
          unit: "seconds",
          perPhaseRange: [3, 4],
          phases: ["inspira", "trattieni", "espira", "vuoto"]
        }
      }

    },

    /* =========================
       5) RPE MODEL
    ========================= */

    rpe3: {
      levels: [
        { id: 1, label: "facile", targetRepsInReserve: 3 },
        { id: 2, label: "medio",  targetRepsInReserve: 2 },
        { id: 3, label: "duro",   targetRepsInReserve: 1 }
      ]
    },

    /* =========================
       6) PROGRESSION MODEL
    ========================= */

    progressionModel: {

      totalWeeks: 12,
      sessionsPerWeekNominal: 3,
      weekAdvancesEverySessions: 3,

      rules: {
        bandSteps: [15, 25, 35],
        repMenu: [8, 10, 12, 14, 16, 18, 20],

        promoteBandIf: {
          rpeLevelMax: 2,
          completedAtOrAboveRep: 16
        },

        deload: {
          everyNthWeek: 4,
          volumeReduction: 0.30,
          intensityKeep: true
        }
      }
    },

    /* =========================
       7) MODIFIERS
    ========================= */

    modifiers: {

      runDay: {
        lowerVolumeMultiplier: 0.7,
        hingeCaution: true
      },

      fasting: {
        totalVolumeMultiplier: 0.85
      }

    },

    /* =========================
       8) NO-ANCHOR RULES
    ========================= */

    noAnchorRules: {

      allowedAnchors: [
        "under_feet",
        "around_body",
        "mini_loop",
        "floor_supported"
      ],

      adaptationGuidelines: [
        "Convert high anchor → under feet",
        "Prefer band around back for press",
        "Use mini-loop for activation"
      ]
    },

    /* =========================
       9) TECHNICAL CHECKS
    ========================= */

    technicalChecks: {

      preSetChecklist: [
        "Tripod foot",
        "Neutral spine",
        "Scapole stabili",
        "Addome attivo"
      ],

      byPattern: {
        hinge: [
          "Anche indietro",
          "Schiena neutra",
          "Band vicino al corpo"
        ],
        rowPull: [
          "Gomiti dietro",
          "Spalle lontane orecchie"
        ],
        push: [
          "Costole giù",
          "Gomiti 30-45°"
        ],
        plank: [
          "Retroversione leggera",
          "Addome compatto"
        ]
      }
    }

  };

  global.TrainingKnowledge = TrainingKnowledge;

})(typeof window !== "undefined" ? window : globalThis);
