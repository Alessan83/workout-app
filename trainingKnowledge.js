/* trainingKnowledge.js
   Knowledge base (NO exercises list): rules, biomechanics, safety, dosing.
   Other engines (StudyEngine, SessionEngine, BiomechanicalEngine, Coordinator)
   should READ from here and decide WHAT to do (selection/progression).
*/

(function (global) {
  "use strict";

  const TrainingKnowledge = {
    version: "2.0.0",
    updated: "2026-02-14",

    /* =========================
       1) DEFINIZIONI: REPS vs SECONDI
       ========================= */
    doseTypes: {
      REPS: "reps",
      SECONDS: "seconds",
      MIXED: "mixed" // es. 8 reps + 2s hold a fine ROM
    },

    // Classificazione esercizio in base a nome/tag (fallback se exerciseDB è incompleto)
    // Nota: gli esercizi isometrici (plank, side plank, holds) sono TIME-BASED.
    classifyDoseType(ex) {
      const name = (ex?.name || "").toLowerCase();
      const tags = (ex?.tags || []).map(t => String(t).toLowerCase());

      const has = (s) => name.includes(s) || tags.includes(s);

      // Time-based core holds
      if (
        has("plank") || has("side plank") || has("hollow") || has("hold") ||
        has("isometric") || has("iso") || has("dead bug hold") ||
        has("bridge hold") || has("wall sit")
      ) return this.doseTypes.SECONDS;

      // Mixed: reps + hold (es. hip thrust con 2-5s tenuta)
      if (has("tenuta") || has("pause") || has("isometria")) return this.doseTypes.MIXED;

      // Default: reps
      return this.doseTypes.REPS;
    },

    // Regola specifica richiesta: side plank non in kg/reps, ma in secondi
    // (Se exerciseDB ti dà "kg" o "reps" per side plank: correggilo qui)
    normalizeExercisePrescription(ex) {
      const clone = JSON.parse(JSON.stringify(ex || {}));
      const dt = this.classifyDoseType(clone);

      if (dt === this.doseTypes.SECONDS) {
        // forza seconds se era errato
        clone.prescription = clone.prescription || {};
        clone.prescription.unit = "seconds";
        // rimuovi kg se non sensato
        if (clone.prescription.loadKg) delete clone.prescription.loadKg;
      }

      // Side plank: sempre seconds
      const n = (clone.name || "").toLowerCase();
      if (n.includes("side plank") || n.includes("plank laterale")) {
        clone.prescription = clone.prescription || {};
        clone.prescription.unit = "seconds";
        if (clone.prescription.loadKg) delete clone.prescription.loadKg;
      }

      return clone;
    },

    /* =========================
       2) TEMPO (TUT) e METRONOMO VISIVO
       ========================= */
    tempo: {
      // Default tempo richiesto: 2" eccentrica + 1" stabilizzazione + 2" concentrica
      defaultSeconds: { down: 2, hold: 1, up: 2 },

      // Nota biomeccanica utile: carichi/pressioni >2s possono favorire fuoriuscita acqua dal disco
      // (da tesi lombalgia: distinzione <2s vs >2s)  [oai_citation:3‡Attivit_fisica_Lombalgia.pdf](sediment://file_00000000d6d47243b8f98fbd80b6b84c)
      discPressureNote: {
        source: "Attivit_fisica_Lombalgia",
        rule: "Preferire ritmo controllato e evitare soste prolungate in flessione lombare sotto fatica."
      },

      // Calcolo durata set a reps in base al tempo
      estimateSetSeconds(reps, tempo = null) {
        const t = tempo || this.defaultSeconds;
        const repSec = (t.down || 0) + (t.hold || 0) + (t.up || 0);
        return Math.max(0, reps * repSec);
      },

      // Per holds: secondi totali
      estimateHoldSeconds(seconds) {
        return Math.max(0, seconds);
      }
    },

    /* =========================
       3) SICUREZZA RACHIDE / LOMBARE
       (principi generali + vincoli per engine)
       ========================= */
    spineSafety: {
      // referto utente: iniziali fenomeni spondilo-discoartrosi (più torace),
      // minima riduzione L5-S1 posteriore -> priorità: neutral spine + core endurance, progressione graduale.
      goals: [
        "Stabilità (anti-flessione/anti-estensione/anti-rotazione)",
        "Controllo bacino (retro/neutral, no iperlordosi in fatica)",
        "Tolleranza al carico progressiva (deload programmati)"
      ],

      // Stop rules
      stopRules: [
        "Dolore acuto, irradiato, formicolii: interrompere e regredire.",
        "Perdita di neutral spine ripetuta: riduci banda/reps o cambia esercizio.",
        "Aumento dolore il giorno dopo >2/10 rispetto al baseline: deload nella prossima seduta."
      ],

      // Cue tecnici “non negoziabili”
      universalCues: [
        "Collo neutro, mento leggermente retratto.",
        "Costole giù (no flare), addome compatto.",
        "Bacino neutro o lieve retroversione nelle tenute (plank).",
        "Respirazione controllata: espira nella fase di sforzo, non trattenere."
      ],

      // Vincolo richiesto: posterior chain <= 1.2 × pull
      // Implementazione: volumePosterior <= 1.2 * volumePull (set equivalenti)
      posteriorToPullCap: 1.2,

      // Esercizi/condizioni da limitare quando: fatica alta o giornata corsa
      cautionPatterns: [
        "Flessione lombare ripetuta sotto fatica (hinge che degrada, crunch aggressivi).",
        "Rotazioni veloci del tronco se perdi controllo (Russian twist pesante).",
        "Tenute prolungate in flessione (es. buon-morning in postura scarsa)."
      ]
    },

    /* =========================
       4) DOSAGGI BASE (WARM-UP / MOBILITÀ / CORE / RESPIRAZIONE)
       NOTA: qui metto “unità” e range (reps o sec), non lista esercizi completa.
       ========================= */
    dosingTemplates: {
      // Dati da tesi lombalgia: esempi 10 reps x2, psoas 30" x2, plank, side plank ecc.  [oai_citation:4‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
      warmup: {
        durationMin: { for25: 3, for35: 5 },
        examples: [
          { item: "Circonduzioni spalle con bastone/elastico", unit: "reps", range: [8, 12] },
          { item: "Cat-cow / mobilità colonna controllata", unit: "reps", range: [8, 12] },
          { item: "Hip hinge patterning", unit: "reps", range: [8, 12] }
        ]
      },

      mobility: {
        durationMin: { for25: 2, for35: 3 },
        examples: [
          { item: "Psoas stretch in affondo, busto dritto", unit: "seconds", range: [20, 40] }, // 30" x2 in fonte  [oai_citation:5‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
          { item: "Basculamento bacino + antero/retroversione", unit: "reps", range: [8, 12] }  // 10 reps x2 in fonte  [oai_citation:6‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
        ]
      },

      coreControl: {
        durationMin: { for25: 2, for35: 3 },
        examples: [
          { item: "Plank", unit: "seconds", range: [15, 30] },          // fonte  [oai_citation:7‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
          { item: "Side plank", unit: "seconds", range: [15, 30] },     // fonte  [oai_citation:8‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
          { item: "Bird dog (controllo)", unit: "reps", range: [6, 10] } // esempio coerente con routine senza appigli  [oai_citation:9‡Allenamento bande senza appigli.docx](sediment://file_00000000f9f8720a81ffcd60d1b6c8de)
        ],
        notes: [
          "Per plank: addome compatto, bacino in retroversione leggera (fonte)  [oai_citation:10‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)"
        ]
      },

      breathingCooldown: {
        durationMin: { for25: 2, for35: 3 },
        // respirazione diaframmatica: 3-4 secondi per fase (insp/hold/exp/empty)  [oai_citation:11‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)
        protocol: { unit: "seconds", perPhaseRange: [3, 4], phases: ["inspira", "trattieni", "espira", "vuoto"] }
      }
    },

    /* =========================
       5) INTENSITÀ / RPE (3 livelli)
       ========================= */
    rpe3: {
      // Semplificato: 3 livelli operativi
      levels: [
        { id: 1, label: "facile", targetRepsInReserve: 3, deloadBias: 0.0 },
        { id: 2, label: "medio",  targetRepsInReserve: 2, deloadBias: 0.0 },
        { id: 3, label: "duro",   targetRepsInReserve: 1, deloadBias: 0.1 } // più probabile deload se accumulo
      ]
    },

    /* =========================
       6) PROGRESSIONE (tempo → set → banda)
       - curva S su 12 settimane (astratta)
       - deload automatico
       - avanzamento settimana: ogni 3 sessioni
       ========================= */
    progressionModel: {
      totalWeeks: 12,
      sessionsPerWeekNominal: 3,
      weekAdvancesEverySessions: 3,

      // S-curve (logistica) normalizzata 0..1
      // utile per modulare volume/intensità: lenta all’inizio, accelera, poi plateau.
      logisticS(t, k = 8, x0 = 0.5) {
        // t in [0,1]
        const x = Math.min(1, Math.max(0, t));
        const y = 1 / (1 + Math.exp(-k * (x - x0)));
        // normalizza circa (non perfetta) -> ok per uso interno
        return y;
      },

      // In quale fase siamo (0..1) dato weekIndex (1..12)
      phaseFromWeek(weekIndex) {
        const w = Math.min(this.totalWeeks, Math.max(1, weekIndex));
        return (w - 1) / (this.totalWeeks - 1);
      },

      // Regola progressione richiesta: prima aumenti tempo/TUT o reps nel range,
      // poi aumenti set, poi banda (15→25→35) quando chiudi range alto con forma ok.
      // (La logica concreta la applica StudyEngine/Coordinator usando questi parametri.)
      rules: {
        bandSteps: [15, 25, 35],
        repMenu: [8, 10, 12, 14, 16, 18, 20],

        // soglie consigliate
        promoteBandIf: {
          rpeLevelMax: 2,          // non deve essere "duro"
          completedAtOrAboveRep: 16 // chiude range alto (es. >=16) con tecnica buona
        },

        deload: {
          everyNthWeek: 4,
          volumeReduction: 0.30, // -30% serie (coerente con tua routine)  [oai_citation:12‡Allenamento bande senza appigli.docx](sediment://file_00000000f9f8720a81ffcd60d1b6c8de)
          intensityKeep: true
        }
      }
    },

    /* =========================
       7) MODALITÀ: giorno corsa / digiuno
       ========================= */
    modifiers: {
      runDay: {
        description: "Riduce volume gambe e impatti posterior chain, preserva rachide.",
        lowerVolumeMultiplier: 0.7,
        hingeCaution: true
      },
      fasting: {
        description: "Riduce volume totale 10–15% quando digiuno lungo.",
        totalVolumeMultiplier: 0.85
      }
    },

    /* =========================
       8) REGOLE “SENZA APPIGLI”
       (nessun ancoraggio: solo sotto piedi / intorno corpo / mini-loop)
       ========================= */
    noAnchorRules: {
      allowedAnchors: ["under_feet", "around_body", "mini_loop", "floor_supported"],
      adaptationGuidelines: [
        "Se esercizio richiede ancoraggio alto/basso: converti in variante 'sotto piedi' o 'band around back'.",
        "Preferisci rematori sotto piedi, press sopra testa sotto piedi, pull-apart/face pull con mini-loop."
      ],
      exampleFromRoutine: "Row sotto piedi, deadlift sotto piedi, floor press con band dietro schiena." //  [oai_citation:13‡Allenamento bande senza appigli.docx](sediment://file_00000000f9f8720a81ffcd60d1b6c8de)
    },

    /* =========================
       9) CUE TECNICI & CONTROLLI POSTURALI (per engine/UI)
       ========================= */
    technicalChecks: {
      // checklist rapida da mostrare prima di iniziare ogni set
      preSetChecklist: [
        "Piedi stabili, pressione tripode (alluce–mignolo–tallone).",
        "Colonna neutra: no gobba/no iperlordosi.",
        "Scapole: depresse/retratte quanto basta, collo lungo.",
        "Addome attivo: espira, chiudi costole."
      ],

      // controlli specifici (motore biomeccanico può agganciare tag)
      byPattern: {
        hinge: [
          "Anche indietro, tibie quasi verticali.",
          "Band vicino al corpo, non tirare con schiena.",
          "Stop se senti la lombare 'prendere carico' più dei glutei."
        ],
        rowPull: [
          "Spalle lontane dalle orecchie.",
          "Tira con gomiti, non con bicipite/cervicale."
        ],
        push: [
          "Costole giù, glutei attivi.",
          "Gomiti 30–45° (non flare)."
        ],
        plank: [
          "Retroversione bacino leggera, addome compatto (fonte)  [oai_citation:14‡Attivit_fisica_Lombalgia.pdf](sediment://file_000000003ec8720a9dc16b0c9c7dc04e)"
        ]
      }
    }
  };

  // Export (browser)
  global.TrainingKnowledge = TrainingKnowledge;

})(typeof window !== "undefined" ? window : globalThis);
