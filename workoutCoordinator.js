// =======================================================
// WORKOUT COORDINATOR v4.0 (STABILE)
// Integra:
// - TrainingKnowledge (regole teoriche)
// - exerciseDB (database esercizi)
// - StudyEngine (progressione + storico sessioni)
// - SessionEngine (costruzione seduta con tempo reale)
// - BiomechanicalEngine (sicurezza + stress + cues)
// + Adattamento settimanale da bilancia (trend ogni 7 giorni)
// =======================================================

const WorkoutCoordinator = (function(){

// ------------------------------
// STORAGE
// ------------------------------
const KEY = "workoutCoordinatorV4";

function loadState(){
  return JSON.parse(localStorage.getItem(KEY)) || {
    weeklyBody: [],   // [{dateISO, bodyFat, weight, muscleMass, subcutFat}]
    lastWeeklyUpdateISO: null
  };
}
function saveState(st){
  localStorage.setItem(KEY, JSON.stringify(st));
}

// ------------------------------
// UTILS
// ------------------------------
function todayISO(){
  return new Date().toISOString();
}
function daysBetween(isoA, isoB){
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  return Math.floor(Math.abs(a - b) / (1000*60*60*24));
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

// ------------------------------
// DEFAULTS (se mancano dati bilancia)
// ------------------------------
function normalizeUserData(userData){
  return {
    bodyFat: (userData && typeof userData.bodyFat === "number") ? userData.bodyFat : 20,
    weight: (userData && typeof userData.weight === "number") ? userData.weight : null,
    muscleMass: (userData && typeof userData.muscleMass === "number") ? userData.muscleMass : null,
    subcutFat: (userData && typeof userData.subcutFat === "number") ? userData.subcutFat : null
  };
}

// =======================================================
// 1) WEEKLY BODY DATA + TREND
// =======================================================

function addWeeklyBodyEntry(userData, force=false){
  const st = loadState();
  const now = todayISO();

  // aggiungi solo se è passato ~7 giorni dall’ultimo entry
  if(!force && st.weeklyBody.length > 0){
    const last = st.weeklyBody[st.weeklyBody.length-1];
    if(daysBetween(last.dateISO, now) < 7) return st; // non aggiorna
  }

  st.weeklyBody.push({ dateISO: now, ...normalizeUserData(userData) });
  st.lastWeeklyUpdateISO = now;

  // mantieni max 16 settimane in memoria (circa 4 mesi)
  if(st.weeklyBody.length > 16){
    st.weeklyBody = st.weeklyBody.slice(st.weeklyBody.length - 16);
  }

  saveState(st);
  return st;
}

function getWeeklyTrend(){
  const st = loadState();
  if(st.weeklyBody.length < 2) return null;

  const cur = st.weeklyBody[st.weeklyBody.length-1];
  const prev = st.weeklyBody[st.weeklyBody.length-2];

  // soglie minime per ignorare rumore impedenziometrico
  const bfDelta = (cur.bodyFat != null && prev.bodyFat != null) ? (cur.bodyFat - prev.bodyFat) : 0;
  const musDelta = (cur.muscleMass != null && prev.muscleMass != null) ? (cur.muscleMass - prev.muscleMass) : 0;

  return {
    current: cur,
    previous: prev,
    bfDelta,
    musDelta
  };
}

// =======================================================
// 2) GOAL MODE + POLICY (da TrainingKnowledge)
// =======================================================

function buildPolicyFromKnowledge(week, userData, flags, weeklyTrend){

  // TrainingKnowledge fornisce: goalMode/phase/range/tempo ecc.
  // In caso non esista TrainingKnowledge, fallback coerente.
  const hasTK = (typeof TrainingKnowledge !== "undefined");

  const goalMode = hasTK
    ? TrainingKnowledge.determineGoalMode(userData.bodyFat)
    : (userData.bodyFat >= 23 ? "cut" : (userData.bodyFat >= 20 ? "recomposition" : "strength"));

  const phase = hasTK
    ? TrainingKnowledge.determinePhase(week)
    : "accumulation";

  const repRange = hasTK
    ? TrainingKnowledge.getRepRange(goalMode, phase)
    : {min:8, max:12};

  const tempo = hasTK
    ? TrainingKnowledge.getTempo(goalMode)
    : "2-1-2";

  // Bias settimanali (derivati da trend)
  // - Se BF non scende (bfDelta >= 0.2) => aumenta metabolico leggermente
  // - Se muscolo cala (musDelta <= -0.2) => aumenta tensione leggermente
  let metabolicBias = 1.0;
  let tensionBias = 1.0;

  if(weeklyTrend){
    if(weeklyTrend.bfDelta >= 0.2) metabolicBias += 0.05;
    if(weeklyTrend.musDelta <= -0.2) tensionBias += 0.05;
  }

  // Regole rachide (sempre)
  // Il BiomechanicalEngine le applica per esercizio; qui impostiamo limiti/policy generali.
  const spinePolicy = {
    noAnchors: true,
    hingeLimit: 2,
    posteriorMaxBand: 25
  };

  return {
    sessionMinutes: flags.sessionMinutes || 25,
    runDay: !!flags.runDay,
    fasting: !!flags.fasting,

    week,
    goalMode,
    phase,

    repRange,
    tempo,

    metabolicBias,
    tensionBias,

    spinePolicy
  };
}

// =======================================================
// 3) SESSION GENERATION (orchestrazione completa)
// =======================================================

function generateTodayWorkout(exerciseDB, userDataRaw, flags){

  const userData = normalizeUserData(userDataRaw);

  // (A) optional: aggiorna weekly entry se sono passati 7 giorni
  //     l’utente può anche forzare chiamando recordWeeklyBody() manualmente
  addWeeklyBodyEntry(userData, false);

  const weeklyTrend = getWeeklyTrend();

  const studyParams = StudyEngine.getCategoryParams();
  const week = studyParams.week;

  // policy dal knowledge + trend
  const policy = buildPolicyFromKnowledge(week, userData, flags, weeklyTrend);

  // banda di riferimento: usa quella della categoria pull (coerente col tuo sistema)
  // Nota: per posterior comunque il biomechanical limiterà a 25 se hinge.
  policy.band = studyParams.categories.pull.band;

  // passa policy a SessionEngine (SessionEngine deve usare BiomechanicalEngine dentro al loop)
  // SessionEngine restituisce sessione completa + summary biomeccanico (stress/risk)
  const session = SessionEngine.generateSession(exerciseDB, policy);

  // arricchisci con contesto (utile UI + export)
  return {
    session,
    meta: {
      generatedAt: todayISO(),
      week,
      goalMode: policy.goalMode,
      phase: policy.phase,
      runDay: policy.runDay,
      fasting: policy.fasting,
      repRange: policy.repRange,
      tempo: policy.tempo,
      metabolicBias: policy.metabolicBias,
      tensionBias: policy.tensionBias
    },
    weeklyTrend
  };
}

// =======================================================
// 4) COMPLETE WORKOUT (salvataggio progressione)
// =======================================================

function completeTodayWorkout(sessionObj, rpeData, flags){

  // sessionObj può essere {session, meta,...} o direttamente session
  const session = sessionObj.session ? sessionObj.session : sessionObj;

  // struttura report (StudyEngine aggiorna progressione + curva S)
  const report = {
    rpe: rpeData,
    runDay: !!flags.runDay,
    fasting: !!flags.fasting,
    realSessionTime: session.totalTime,
    totalStress: session.summary && typeof session.summary.totalStress === "number"
      ? session.summary.totalStress
      : 0
  };

  StudyEngine.reportSessionResult(report);
  return StudyEngine.getDashboard();
}

// =======================================================
// 5) API: weekly body data management + export
// =======================================================

function recordWeeklyBody(userData){
  return addWeeklyBodyEntry(normalizeUserData(userData), true);
}

function getWeeklyBodyHistory(){
  return loadState().weeklyBody.slice();
}

function exportJSONForAnalysis(){
  // export unico: utile per analisi futura con ChatGPT
  return JSON.stringify({
    coordinator: loadState(),
    study: JSON.parse(StudyEngine.exportJSON()),
    exportedAt: todayISO()
  }, null, 2);
}

// =======================================================
// PUBLIC API
// =======================================================

return {
  // ciclo principale
  generateTodayWorkout,
  completeTodayWorkout,

  // bilancia settimanale
  recordWeeklyBody,
  getWeeklyBodyHistory,

  // trend / export
  getWeeklyTrend,
  exportJSONForAnalysis
};

})();
