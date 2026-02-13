// ==========================================
// SESSION ENGINE 1.0
// Coordina Study + Biomechanical + Time
// ==========================================

const SessionEngine = (function(){

// ------------------------------------
// GLOBAL CONFIG
// ------------------------------------

const GLOBAL = {
  noAnchors: true,
  tempoPerRep: 5,       // 2-1-2
  defaultRest: 30,
  warmupTime: 150,
  mobilityTime: 150,
  coreTime: 120
};

// ------------------------------------
// STRUCTURE DECISION (volume logic)
// ------------------------------------

function decideStructure(week, sessionMinutes){

  if(sessionMinutes === 25){

    if(week <= 4)
      return { sets:2, reps:15 };

    if(week <= 8)
      return { sets:3, reps:12 };

    return { sets:3, reps:8 };
  }

  if(sessionMinutes === 35){

    if(week <= 4)
      return { sets:2, reps:15 };

    if(week <= 8)
      return { sets:3, reps:12 };

    return { sets:4, reps:8 };
  }

}

// ------------------------------------
// ADAPT EXERCISE (NO ANCHOR)
// ------------------------------------

function adaptExerciseIfNeeded(ex){

  if(!GLOBAL.noAnchors) return ex;

  if(!ex.requiresAnchor) return ex;

  // Versione modificata semplice
  return {
    ...ex,
    name: ex.name + " (free version)",
    requiresAnchor:false
  };
}

// ------------------------------------
// TIME CALCULATION
// ------------------------------------

function calculateDynamicTime(sets, reps, rest){

  let active = reps * GLOBAL.tempoPerRep;
  let perSet = active + rest;

  return sets * perSet;
}

function calculateIsometricTime(sets, hold, rest){

  return sets * (hold + rest);
}

// ------------------------------------
// BUILD FULL EXERCISE STRUCTURE
// ------------------------------------

function buildExerciseStructure(ex, structure){

  let adapted = adaptExerciseIfNeeded(ex);

  let isIsometric = adapted.type === "isometric";

  let totalTime;

  if(isIsometric){

    totalTime = calculateIsometricTime(
      2,
      30,
      GLOBAL.defaultRest
    );

    return {
      ...adapted,
      sets:2,
      hold:30,
      rest:GLOBAL.defaultRest,
      totalTime
    };
  }

  totalTime = calculateDynamicTime(
    structure.sets,
    structure.reps,
    GLOBAL.defaultRest
  );

  return {
    ...adapted,
    sets:structure.sets,
    reps:structure.reps,
    tempo:"2-1-2",
    rest:GLOBAL.defaultRest,
    totalTime
  };
}

// ------------------------------------
// GENERATE SESSION
// ------------------------------------
function generateSession(exerciseDB, options){

  const studyData = StudyEngine.load();
  const week = studyData.week;

  const structure =
    decideStructure(week, options.sessionMinutes);

  const targetTotal = options.sessionMinutes * 60;

  const strengthTarget =
    targetTotal -
    GLOBAL.warmupTime -
    GLOBAL.mobilityTime -
    GLOBAL.coreTime;

  const context = {
    runDay: options.runDay || false,
    fasting: options.fasting || false,
    sets: structure.sets,
    band: options.band || 25
  };

  let exercises = [];
  let totalStrengthTime = 0;

  let attempts = 0;

  while(totalStrengthTime < strengthTarget && attempts < 50){

    attempts++;

    const biomechSession =
      BiomechanicalEngine.generateSession(exerciseDB,{
        ...context,
        targetExerciseCount:1
      });

    let ex = biomechSession.exercises[0];

    let built =
      buildExerciseStructure(ex, structure);

    // Evita duplicati
    if(exercises.find(e => e.name === built.name)){
      continue;
    }

    // Se supera troppo, riduci set
    if(totalStrengthTime + built.totalTime > strengthTarget){

      if(built.sets > 2){
        built.sets -=1;
        built.totalTime = calculateDynamicTime(
          built.sets,
          built.reps,
          built.rest
        );
      }
    }

    totalStrengthTime += built.totalTime;
    exercises.push(built);
  }

  const totalTime =
    GLOBAL.warmupTime +
    GLOBAL.mobilityTime +
    totalStrengthTime +
    GLOBAL.coreTime;

  return {
    week,
    sessionMinutes: options.sessionMinutes,
    warmup: GLOBAL.warmupTime,
    mobility: GLOBAL.mobilityTime,
    core: GLOBAL.coreTime,
    strengthTime: totalStrengthTime,
    totalTime,
    targetTotal,
    delta: targetTotal - totalTime,
    exercises
  };
}

// ------------------------------------
// PUBLIC API
// ------------------------------------

return {
  generateSession
};

})();
