// ==========================================
// BIOMECHANICAL ENGINE v1.0
// Advanced Safety + Rachide Protection
// ==========================================

const BiomechanicalEngine = (function(){

// -------------------------------
// CONFIG GLOBAL
// -------------------------------

const MAX_SESSION_STRESS = 100;
const MAX_HINGE_PER_SESSION = 2;
const POSTERIOR_PULL_RATIO = 1.2;

const BAND_FACTOR = {
  15:1.0,
  25:1.4,
  35:1.8
};

// -------------------------------
// CLASSIFICAZIONE AUTOMATICA
// -------------------------------

function classifyExercise(ex){

  let hinge = ex.name.toLowerCase().includes("rdl") ||
              ex.name.toLowerCase().includes("hinge") ||
              ex.name.toLowerCase().includes("good morning");

  let antiRotation = ex.name.toLowerCase().includes("pallof");

  let antiExtension = ex.name.toLowerCase().includes("plank");

  let compressiveLoad = 1;
  let shearLoad = 1;
  let lumbarStress = 1;

  if(hinge){
    compressiveLoad = 2;
    shearLoad = 2;
    lumbarStress = 2;
  }

  if(ex.family === "lower" && !hinge){
    compressiveLoad = 1;
    shearLoad = 1;
  }

  if(ex.family === "core"){
    compressiveLoad = 0;
    shearLoad = antiRotation ? 0 : 1;
  }

  return {
    ...ex,
    hinge,
    antiRotation,
    antiExtension,
    compressiveLoad,
    shearLoad,
    lumbarStress
  };
}

// -------------------------------
// STRESS CALCULATION
// -------------------------------

function calcExerciseStress(ex, sets, band){

  let bandMultiplier = band ? BAND_FACTOR[band] : 1;

  return (
    (ex.compressiveLoad + ex.shearLoad + ex.lumbarStress)
    * sets
    * bandMultiplier
  );
}

// -------------------------------
// SAFETY CHECKS
// -------------------------------

function safetyFilter(candidate, context, sessionState){

  // Hinge limit
  if(candidate.hinge && sessionState.hingeCount >= MAX_HINGE_PER_SESSION){
    return false;
  }

  // Run day → riduci hinge
  if(context.runDay && candidate.hinge){
    return false;
  }

  // Fasting → evita carichi elevati
  if(context.fasting && candidate.compressiveLoad > 1){
    return false;
  }

  // Stress totale
  let projectedStress =
    sessionState.totalStress +
    calcExerciseStress(candidate, context.sets, context.band);

  if(projectedStress > MAX_SESSION_STRESS){
    return false;
  }

  return true;
}

// -------------------------------
// SESSION GENERATOR
// -------------------------------

function generateSession(exerciseDB, context){

  let session = [];
  let sessionState = {
    totalStress:0,
    hingeCount:0
  };

  // Flatten DB
  let allExercises = [];

  Object.keys(exerciseDB).forEach(cat=>{
    exerciseDB[cat].forEach(ex=>{
      allExercises.push(classifyExercise(ex));
    });
  });

  while(session.length < context.targetExerciseCount){

    let randomIndex =
      Math.floor(Math.random()*allExercises.length);

    let candidate = allExercises[randomIndex];

    if(!safetyFilter(candidate, context, sessionState)){
      continue;
    }

    session.push(candidate);

    let stress =
      calcExerciseStress(candidate, context.sets, context.band);

    sessionState.totalStress += stress;

    if(candidate.hinge){
      sessionState.hingeCount++;
    }
  }

  return {
    exercises:session,
    totalStress:sessionState.totalStress,
    hingeCount:sessionState.hingeCount
  };
}

// -------------------------------
// POSTERIOR vs PULL BALANCE
// -------------------------------

function enforcePullPosteriorBalance(session){

  let pullStress = 0;
  let posteriorStress = 0;

  session.exercises.forEach(ex=>{
    if(ex.family === "upper"){
      pullStress += ex.compressiveLoad;
    }
    if(ex.family === "lower"){
      posteriorStress += ex.compressiveLoad;
    }
  });

  if(posteriorStress > pullStress * POSTERIOR_PULL_RATIO){
    return {
      warning:"Posterior overload detected. Replace hinge movement.",
      safe:false
    };
  }

  return {safe:true};
}

// -------------------------------
// OUTPUT CUES & WARNINGS
// -------------------------------

function getExerciseSafetyInfo(ex){

  let warnings = [];

  if(ex.hinge){
    warnings.push("Controlla neutro lombare");
    warnings.push("Attiva core prima di scendere");
  }

  if(ex.antiExtension){
    warnings.push("Evita cedimento lombare");
  }

  if(ex.antiRotation){
    warnings.push("Non compensare con il bacino");
  }

  return {
    cues:ex.note || "",
    warnings
  };
}

// -------------------------------
// PUBLIC API
// -------------------------------

return {
  generateSession,
  enforcePullPosteriorBalance,
  getExerciseSafetyInfo,
  calcExerciseStress
};

})();
