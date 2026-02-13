/* ==========================================
   STUDY ENGINE
   Motore tecnico-scientifico allenamento
========================================== */

const StudyEngine = {

  /* ==========================
     1️⃣ ANALISI ESERCIZIO
  ========================== */

  analyzeExercise(ex){

    return {
      pattern: this.getMovementPattern(ex),
      spinalLoad: this.getSpinalLoad(ex),
      stabilityDemand: this.getStabilityDemand(ex),
      primaryMuscle: ex.primary_muscle || "general",
      evidenceTag: this.getEvidenceTag(ex)
    };

  },

  getMovementPattern(ex){
    return ex.movement_pattern || "unknown";
  },

  getSpinalLoad(ex){

    if(ex.load_type === "external" && ex.movement_pattern === "hinge"){
      return "high_lumbar_load";
    }

    if(ex.movement_pattern === "anti_extension"){
      return "protective_core";
    }

    return "moderate";
  },

  getStabilityDemand(ex){

    if(ex.type === "unilateral") return "high";
    if(ex.type === "band") return "moderate";
    return "low";
  },

  getEvidenceTag(ex){

    // Qui collegherai la tua bibliografia
    if(ex.movement_pattern === "hinge"){
      return "McGill_spine_mechanics";
    }

    if(ex.movement_pattern === "horizontal_pull"){
      return "Scapular_retraction_evidence";
    }

    return "general_strength_guidelines";
  },

  /* ==========================
     2️⃣ STRUTTURA ALLENAMENTO
  ========================== */

  buildSessionStructure(mode){

    if(mode === "25"){
      return {
        mobility: 3,
        activation: 2,
        strength: 5,
        metabolic: 2,
        cooldown: 1
      };
    }

    if(mode === "35"){
      return {
        mobility: 4,
        activation: 3,
        strength: 7,
        metabolic: 3,
        cooldown: 1
      };
    }

  },

  /* ==========================
     3️⃣ CONTROLLO VOLUME
  ========================== */

  validateSession(exercises){

    let hingeCount = 0;
    let lumbarLoadHigh = 0;

    exercises.forEach(ex=>{
      const analysis = this.analyzeExercise(ex);

      if(analysis.pattern === "hinge") hingeCount++;
      if(analysis.spinalLoad === "high_lumbar_load") lumbarLoadHigh++;
    });

    return {
      hingeCount,
      lumbarLoadHigh,
      warning: lumbarLoadHigh > 2 ? "Ridurre carico lombare" : null
    };
  }

};
