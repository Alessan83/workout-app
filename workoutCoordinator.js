// ========================================================
// WORKOUT COORDINATOR v2.0
// Orchestratore centrale del sistema
// ========================================================

const WorkoutCoordinator = (function(){

// --------------------------------------------------------
// CONFIGURAZIONE GOAL
// --------------------------------------------------------

const GOAL = {
  RECOMPOSITION:"recomposition",
  CUT:"cut",
  STRENGTH:"strength"
};

// --------------------------------------------------------
// 1️⃣ ANALISI STATO UTENTE
// --------------------------------------------------------

function analyzeUserState(userData){

  let goalMode = GOAL.STRENGTH;

  if(userData.bodyFat >= 20){
    goalMode = GOAL.RECOMPOSITION;
  }

  if(userData.bodyFat >= 24){
    goalMode = GOAL.CUT;
  }

  return {
    goalMode,
    metabolicBias: userData.bodyFat > 20 ? 1.05 : 1.0,
    tensionBias: userData.muscleTrend < 0 ? 1.1 : 1.0
  };
}

// --------------------------------------------------------
// 2️⃣ GENERAZIONE SESSIONE COORDINATA
// --------------------------------------------------------

function generateTodayWorkout(exerciseDB, userData, flags){

  const studyParams =
    StudyEngine.getCategoryParams();

  const analysis =
    analyzeUserState(userData);

  const policy = {
    sessionMinutes: flags.sessionMinutes || 25,
    runDay: flags.runDay || false,
    fasting: flags.fasting || false,
    band: studyParams.categories.pull.band,
    week: studyParams.week,
    metabolicBias: analysis.metabolicBias,
    tensionBias: analysis.tensionBias,
    goalMode: analysis.goalMode
  };

  const session =
    SessionEngine.generateSession(exerciseDB, policy);

  return {
    session,
    goalMode: analysis.goalMode,
    week: studyParams.week
  };
}

// --------------------------------------------------------
// 3️⃣ COMPLETAMENTO SESSIONE
// --------------------------------------------------------

function completeTodayWorkout(session, rpeData, flags){

  const report = {
    rpe: rpeData,
    runDay: flags.runDay || false,
    fasting: flags.fasting || false,
    realSessionTime: session.totalTime,
    totalStress: session.summary.totalStress,
    lumbarRisk: session.summary.lumbarRisk
  };

  StudyEngine.reportSessionResult(report);

  return StudyEngine.getDashboard();
}

// --------------------------------------------------------
// 4️⃣ EXPORT COMPLETO STATO SISTEMA
// --------------------------------------------------------

function exportFullSystemState(){

  return {
    study: StudyEngine.exportJSON(),
    timestamp: new Date().toISOString()
  };
}

// --------------------------------------------------------

return {
  generateTodayWorkout,
  completeTodayWorkout,
  exportFullSystemState
};

})();
