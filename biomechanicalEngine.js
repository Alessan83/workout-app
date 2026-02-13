// =======================================================
// BIOMECHANICAL ENGINE v2.0
// Coordinato con StudyEngine v3 + SessionEngine1
// - Sicurezza rachide (L5-S1), hinge limit, stress budget
// - Adattamento esercizi con appiglio -> varianti free
// - Cues + warnings per esecuzione
// =======================================================

const BiomechanicalEngine = (function(){

// -------------------------------
// CONFIG
// -------------------------------

const CFG = {
  // budget stress per singola sessione (sessionEngine riempie tempo: qui limitiamo rischio)
  maxSessionStress: 110,

  // limite hinge (stacchi/hinge pattern) per sessione
  maxHingePerSession: 2,

  // vincolo posterior vs pull (simile a StudyEngine, ma applicato sulla sessione generata)
  posteriorPullRatio: 1.2,

  // fattori banda (coerenti con StudyEngine)
  bandFactor: {15:1.0, 25:1.4, 35:1.8},

  // se non hai ancoraggi: non scartare ma adattare
  noAnchorsDefault: true,

  // se fasting: riduce tolleranza a stress alto
  fastingStressMultiplier: 0.90,

  // se runDay: riduce tolleranza a hinge e posterior
  runDayStressMultiplier: 0.90,

  // penalità per duplicati (evita ripetizioni nella stessa sessione)
  duplicatePenalty: 0.25
};

// -------------------------------
// DEFAULT CUES PER CATEGORIA
// -------------------------------

const CATEGORY_CUES = {
  pull: [
    "Core contratto (addome attivo)",
    "Schiena neutra (no cifosi/iperestensione)",
    "Scapole: retrazione + depressione, poi tira",
    "Gomiti vicino al corpo, controllo eccentrica"
  ],
  push: [
    "Costole giù (evita iperlordosi)",
    "Spalle basse e stabili",
    "Polsi neutri, gomiti 30–60° dal busto",
    "Controllo eccentrica, niente rimbalzi"
  ],
  posterior: [
    "Hinge dalle anche (non piegare la schiena)",
    "Colonna neutra, core attivo prima di scendere",
    "Carico su glutei/femorali, non sulla lombare",
    "Ritorno controllato (no slanci)"
  ],
  core: [
    "Anti-estensione: bacino neutro, costole giù",
    "Respirazione controllata (non trattenere)",
    "Stabilità prima della durata"
  ],
  warmup: ["Movimenti fluidi, ROM controllato, senza dolore"],
  mobility: ["ROM progressivo, nessun rimbalzo, respira"],
};

// -------------------------------
// UTILS
// -------------------------------

function lower(s){ return String(s||"").toLowerCase(); }

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function hasAny(text, arr){
  const t = lower(text);
  return arr.some(k => t.includes(lower(k)));
}

// -------------------------------
// CLASSIFICAZIONE (robusta ma compatibile con DB eterogenei)
// -------------------------------

function classifyExercise(ex){

  const name = lower(ex.name);

  const type = ex.type || (hasAny(name, ["plank","hold","isometric","side plank"]) ? "isometric" : "dynamic");

  const hinge = Boolean(ex.hinge) || hasAny(name, ["rdl","romanian","good morning","hip hinge","deadlift","stacco"]);
  const antiRotation = Boolean(ex.antiRotation) || hasAny(name, ["pallof","anti-rot"]);
  const antiExtension = Boolean(ex.antiExtension) || hasAny(name, ["plank","hollow","dead bug","anti-ext"]);

  // family/cat: nel tuo DB spesso c'è "family" (upper/lower/core) e/o category
  const family = ex.family || (
    hasAny(name, ["plank","dead bug","hollow","core"]) ? "core" :
    (hasAny(name, ["squat","lunge","deadlift","rdl","glute","hip","calf","tibialis"]) ? "lower" : "upper")
  );

  // requiresAnchor: se nel DB non c'è, deduciamo da parole chiave
  const requiresAnchor = (ex.requiresAnchor === true) ||
    hasAny(name, ["anchor","door","porta","fiss", "attacc", "ancor"]);

  // carichi base (0-3): euristiche conservative
  let compressiveLoad = 1;
  let shearLoad = 1;
  let lumbarStress = 1;

  if(type === "isometric"){
    compressiveLoad = 0;
    shearLoad = antiRotation ? 0 : 1;
    lumbarStress = 1;
  }

  if(hinge){
    compressiveLoad = 2;
    shearLoad = 2;
    lumbarStress = 2;
  }

  if(family === "core" && antiExtension){
    compressiveLoad = 0;
    shearLoad = 1;
    lumbarStress = 1;
  }

  // rischio lombare 0-3 (più alto = più cautela)
  const lumbarRisk = clamp(
    (lumbarStress + shearLoad) - (type === "isometric" ? 1 : 0),
    0, 3
  );

  // allowedMaxBand: posterior per sicurezza di default max 25 (se non specificato dal DB)
  let allowedMaxBand = ex.allowedMaxBand;
  if(allowedMaxBand == null){
    allowedMaxBand = (family === "lower" && hinge) ? 25 : 35;
  }

  // cues: usa note del DB se presenti + cues categoria
  const cues = []
    .concat(ex.cues || [])
    .concat(ex.note ? [ex.note] : [])
    .concat(family === "core" ? CATEGORY_CUES.core : [])
    .concat(family === "lower" && hinge ? CATEGORY_CUES.posterior : [])
    .concat(family === "upper" ? (ex.category === "push" ? CATEGORY_CUES.push : CATEGORY_CUES.pull) : []);

  return {
    ...ex,
    type,
    family,
    hinge,
    antiRotation,
    antiExtension,
    requiresAnchor,
    compressiveLoad,
    shearLoad,
    lumbarStress,
    lumbarRisk,
    allowedMaxBand,
    cues
  };
}

// -------------------------------
// ADATTAMENTO NO-ANCHOR (non scarta: sostituisce)
// -------------------------------
// Supporta 2 strade:
// A) nel DB esiste ex.adaptedVersion (oggetto) o ex.adaptedId (id riferimento)
// B) fallback automatico per pattern, scegliendo un esercizio "free" simile

function adaptExercise(ex, allClassified, globalConfig){

  if(!globalConfig.noAnchors) return ex;

  if(!ex.requiresAnchor) return ex;

  // A) adaptedVersion inline
  if(ex.adaptedVersion && typeof ex.adaptedVersion === "object"){
    return classifyExercise(ex.adaptedVersion);
  }

  // A2) adaptedId: prova a trovare
  if(ex.adaptedId){
    const found = allClassified.find(e => e.id === ex.adaptedId);
    if(found) return found;
  }

  // B) fallback automatico:
  // - se anti-rotazione ancorata -> scegli core anti-rotation senza appiglio (es. side plank, dead bug reach, suitcase hold bw)
  // - se row ancorata -> scegli row/band sotto piedi
  // - se face pull ancorato -> pull-apart / high row sotto piedi

  const name = lower(ex.name);

  if(hasAny(name, ["pallof","anti-rot"])){
    const candidates = allClassified.filter(e =>
      e.family === "core" &&
      !e.requiresAnchor &&
      (e.antiRotation || hasAny(e.name, ["side plank","copenhagen","dead bug","bird dog"]))
    );
    if(candidates.length) return candidates[Math.floor(Math.random()*candidates.length)];
  }

  if(hasAny(name, ["row","rematore","tirata"])){
    const candidates = allClassified.filter(e =>
      !e.requiresAnchor &&
      e.family === "upper" &&
      hasAny(e.name, ["row","rematore","pull apart","high row"])
    );
    if(candidates.length) return candidates[Math.floor(Math.random()*candidates.length)];
  }

  if(hasAny(name, ["face pull"])){
    const candidates = allClassified.filter(e =>
      !e.requiresAnchor &&
      e.family === "upper" &&
      hasAny(e.name, ["pull apart","rear fly","high row","face pull"])
    );
    if(candidates.length) return candidates[Math.floor(Math.random()*candidates.length)];
  }

  // fallback generale: scegli un esercizio safe della stessa family
  const safe = allClassified
    .filter(e => !e.requiresAnchor && e.family === ex.family && e.lumbarRisk <= 2);
  if(safe.length) return safe[Math.floor(Math.random()*safe.length)];

  // ultimo fallback: ritorna comunque, ma sarà filtrato altrove
  return ex;
}

// -------------------------------
// STRESS CALC (coerente con StudyEngine)
// -------------------------------

function calcExerciseStress(ex, sets, band){
  const bf = band ? (CFG.bandFactor[band] || 1) : 1;
  return (ex.compressiveLoad + ex.shearLoad + ex.lumbarStress) * sets * bf;
}

// -------------------------------
// SESSION CONSTRAINTS (runDay/fasting/hinge/stress)
// -------------------------------

function safetyFilter(ex, context, state){

  // tipo isometrico: banda non applicabile (se context band imposto, non è un problema: stress usa band solo se band passata)
  // ma possiamo ridurre stress isometrico ignorando band: lo gestisce SessionEngine quando costruisce la struttura (band=null).
  // Qui: non blocchiamo.

  // hinge count
  if(ex.hinge && state.hingeCount >= CFG.maxHingePerSession) return false;

  // runDay: elimina hinge (o lascia solo hinge a rischio basso)
  if(context.runDay && ex.hinge) return false;

  // fasting: elimina esercizi con compressive>1
  if(context.fasting && ex.compressiveLoad > 1) return false;

  // banda massima consentita per esercizio
  if(ex.allowedMaxBand != null && context.band != null && context.band > ex.allowedMaxBand) return false;

  // stress budget
  const projected = state.totalStress + calcExerciseStress(ex, context.sets, context.band);
  if(projected > state.maxStressBudget) return false;

  // duplicati: penalizziamo fortemente
  if(state.usedIds.has(ex.id || ex.name)){
    // non sempre è vietato, ma lo rendiamo molto improbabile
    return (Math.random() < CFG.duplicatePenalty);
  }

  return true;
}

// -------------------------------
// SESSION STATE PREP
// -------------------------------

function initSessionState(context){

  let maxBudget = CFG.maxSessionStress;
  if(context.fasting) maxBudget *= CFG.fastingStressMultiplier;
  if(context.runDay) maxBudget *= CFG.runDayStressMultiplier;

  return {
    totalStress: 0,
    hingeCount: 0,
    lumbarRiskIndex: 0,
    usedIds: new Set(),
    maxStressBudget: Math.round(maxBudget)
  };
}

// -------------------------------
// BALANCE CHECK (posterior vs pull) su sessione generata
// -------------------------------

function checkPosteriorPullBalance(exercises){

  let pull = 0;
  let post = 0;

  exercises.forEach(ex=>{
    // euristica: upper dynamic pull/push viene contato come pull per bilanciamento
    // e hinge/lower come posterior
    if(ex.family === "upper") pull += (ex.compressiveLoad + ex.shearLoad);
    if(ex.family === "lower") post += (ex.compressiveLoad + ex.shearLoad);
  });

  if(pull <= 0) return { safe:true };

  if(post > pull * CFG.posteriorPullRatio){
    return { safe:false, warning:"Posterior overload: ridurre hinge/lower o aumentare tirate upper." };
  }

  return { safe:true };
}

// -------------------------------
// PICK ONE EXERCISE (per SessionEngine che riempie tempo)
// -------------------------------

function pickOne(exerciseDB, context){

  // flatten + classify
  let all = [];
  Object.keys(exerciseDB).forEach(k=>{
    exerciseDB[k].forEach(ex=> all.push(classifyExercise(ex)));
  });

  // adaptation layer: se noAnchors, trasformiamo al volo quando candidati
  const globalConfig = { noAnchors: (context.noAnchors ?? CFG.noAnchorsDefault) };

  const state = context._state || initSessionState(context);

  // filtro candidati
  let pool = all;

  // preferenze pattern (se context.preferFamily/pattern c'è)
  if(context.preferFamily){
    const p = pool.filter(e => e.family === context.preferFamily);
    if(p.length) pool = p;
  }

  // shuffle tentativi
  for(let tries=0; tries<80; tries++){

    const cand0 = pool[Math.floor(Math.random()*pool.length)];
    const cand = adaptExercise(cand0, all, globalConfig);

    if(!safetyFilter(cand, context, state)) continue;

    // aggiorna state (ma non definitivo: SessionEngine aggiorna davvero quando decide di includerlo)
    return { exercise:cand, state };
  }

  // fallback: prendi il più safe
  const safeSorted = pool
    .map(e => adaptExercise(e, all, globalConfig))
    .filter(e => !e.requiresAnchor)
    .sort((a,b)=> a.lumbarRisk - b.lumbarRisk);

  if(safeSorted.length){
    const cand = safeSorted[0];
    if(safetyFilter(cand, context, state)){
      return { exercise:cand, state };
    }
  }

  return { exercise:null, state };
}

// -------------------------------
// COMMIT EXERCISE INTO STATE (SessionEngine call)
// -------------------------------

function commitExercise(ex, context, state){

  const stress = calcExerciseStress(ex, context.sets, context.band);
  state.totalStress += stress;
  state.lumbarRiskIndex += ex.lumbarRisk;

  if(ex.hinge) state.hingeCount += 1;

  state.usedIds.add(ex.id || ex.name);

  return state;
}

// -------------------------------
// PER-EXERCISE CUES & WARNINGS
// -------------------------------

function getSafetyInfo(ex){

  const warnings = [];

  if(ex.type === "isometric"){
    warnings.push("Esegui in tenuta: qualità > durata");
  }

  if(ex.hinge){
    warnings.push("Neutro lombare: se perdi neutro, riduci ROM");
    warnings.push("Core attivo PRIMA di scendere");
  }

  if(ex.antiExtension){
    warnings.push("Costole giù: evita iperestensione lombare");
  }

  if(ex.antiRotation){
    warnings.push("Bacino fermo: non ruotare per compensare");
  }

  if(ex.requiresAnchor){
    warnings.push("Richiede appiglio: usare variante free proposta");
  }

  // cues: unisci e compatta
  const cues = Array.from(new Set([...(ex.cues||[]), ...(CATEGORY_CUES[ex.category]||[])]))
    .filter(Boolean)
    .slice(0, 8);

  return { cues, warnings };
}

// -------------------------------
// SESSION SUMMARY (per dashboard)
// -------------------------------

function summarizeSession(exercises, context, state){

  const balance = checkPosteriorPullBalance(exercises);

  return {
    totalStress: state.totalStress,
    hingeCount: state.hingeCount,
    lumbarRiskIndex: state.lumbarRiskIndex,
    stressBudget: state.maxStressBudget,
    balance
  };
}

// -------------------------------
// PUBLIC API
// -------------------------------

return {
  // per SessionEngine (riempimento tempo): prendi 1 esercizio safe
  pickOne,

  // per SessionEngine: committa nello state (stress/hinge/dup)
  commitExercise,

  // per UI: cues e warnings
  getSafetyInfo,

  // per StudyEngine/UI: summary sessione
  summarizeSession,

  // utilities
  calcExerciseStress
};

})();
