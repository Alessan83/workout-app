// ==========================================
// STUDY ENGINE v2.0 - FULL BIOMECHANICAL CORE
// ==========================================

const StudyEngine = (function(){

// -----------------------------
// CONFIG
// -----------------------------

const BAND_LEVELS = [15,25,35];

const TENSION_FACTOR = {
  15:1.0,
  25:1.4,
  35:1.8
};

// Curva S 12 settimane (fattore moltiplicativo)
const S_CURVE = [
  0.85,0.9,0.95,1.0,
  1.05,1.1,1.15,1.2,
  1.15,1.1,1.0,0.8
];

// -----------------------------
// PROFILI BIOMECCANICI
// -----------------------------

const CATEGORY_RULES = {

  pull:{
    cues:[
      "Core contratto",
      "Colonna neutra",
      "Scapole retratte e depresse"
    ],
    lumbarRisk:1,
    hinge:false,
    maxBand:35
  },

  push:{
    cues:[
      "Addome attivo",
      "Spalle basse",
      "No iperestensione lombare"
    ],
    lumbarRisk:1,
    hinge:false,
    maxBand:35
  },

  posterior:{
    cues:[
      "Hinge dalle anche",
      "Schiena neutra",
      "Glutei attivi",
      "No flessione lombare"
    ],
    lumbarRisk:2,
    hinge:true,
    maxBand:25 // Protezione L5-S1
  },

  core:{
    cues:[
      "Anti-estensione",
      "Respirazione controllata",
      "Bacino neutro"
    ],
    lumbarRisk:1,
    hinge:false
  }

};

// -----------------------------
// INIT STATE
// -----------------------------

function defaultCategory(band=15){
  return {
    band:band,
    time:40,
    sets:3,
    streak:0,
    fatigue:0,
    history:[]
  };
}

function initState(){
  return {
    week:1,
    sessions:[],
    consecutiveDays:0,
    categories:{
      pull:defaultCategory(15),
      push:defaultCategory(15),
      posterior:defaultCategory(25),
      core:{time:30,sets:2,streak:0,fatigue:0,history:[]}
    }
  };
}

// -----------------------------
// STORAGE
// -----------------------------

function load(){
  return JSON.parse(localStorage.getItem("studyEngineV2")) || initState();
}

function save(data){
  localStorage.setItem("studyEngineV2",JSON.stringify(data));
}

// -----------------------------
// STIMULUS CALCULATION
// -----------------------------

function calcStimulus(cat){
  if(!cat.band) return cat.time * cat.sets;
  return cat.time * cat.sets * TENSION_FACTOR[cat.band];
}

// -----------------------------
// CURVA S 12 SETTIMANE
// -----------------------------

function applySCurve(cat, week){
  let index = (week-1)%12;
  let factor = S_CURVE[index];

  cat.time = Math.round(cat.time * factor);

  return cat;
}

// -----------------------------
// PROGRESSION CORE
// -----------------------------

function progressCategory(cat, categoryName, rpe, week){

  if(rpe <=2){
    cat.streak++;
  } else {
    cat.streak = 0;
    cat.fatigue++;
  }

  // Deload automatico
  if(cat.fatigue >=2){
    cat.time = Math.max(35, cat.time -5);
    cat.sets = Math.max(2, cat.sets -1);
    cat.fatigue = 0;
    cat.streak = 0;
    return cat;
  }

  // Progressione
  if(cat.streak >=2){

    if(cat.time < 50){
      cat.time +=5;
    }
    else if(cat.sets <4){
      cat.sets +=1;
    }
    else if(cat.band){
      let currentIndex = BAND_LEVELS.indexOf(cat.band);
      if(currentIndex < BAND_LEVELS.length-1){
        let nextBand = BAND_LEVELS[currentIndex+1];

        if(nextBand <= CATEGORY_RULES[categoryName].maxBand){
          cat.band = nextBand;
        }

        cat.time = 40;
        cat.sets = 3;
      }
    }

    cat.streak = 0;
  }

  cat = applySCurve(cat, week);

  return cat;
}

// -----------------------------
// LUMBAR PROTECTION
// -----------------------------

function lumbarProtection(data){

  let pullLoad = calcStimulus(data.categories.pull);
  let posteriorLoad = calcStimulus(data.categories.posterior);

  if(posteriorLoad > pullLoad * 1.2){
    data.categories.posterior.time -=5;
    data.categories.posterior.sets = Math.max(2,data.categories.posterior.sets-1);
  }

  return data;
}

// -----------------------------
// MODALITÀ CORSA
// -----------------------------

function runDayAdjust(data){
  data.categories.posterior.time = Math.round(data.categories.posterior.time * 0.7);
  data.categories.posterior.sets = Math.max(2,data.categories.posterior.sets-1);
  return data;
}

// -----------------------------
// MODALITÀ DIGIUNO
// -----------------------------

function fastingAdjust(data){
  Object.keys(data.categories).forEach(cat=>{
    data.categories[cat].time = Math.round(data.categories[cat].time * 0.9);
  });
  return data;
}

// -----------------------------
// COMPLETE SESSION
// -----------------------------

function completeSession(input){

  let data = load();

  Object.keys(input.rpe).forEach(cat=>{
    data.categories[cat] =
      progressCategory(data.categories[cat], cat, input.rpe[cat], data.week);

    data.categories[cat].history.push({
      date:new Date().toISOString(),
      time:data.categories[cat].time,
      band:data.categories[cat].band || null
    });
  });

  if(input.runDay) data = runDayAdjust(data);
  if(input.fasting) data = fastingAdjust(data);

  data = lumbarProtection(data);

  data.sessions.push({
    date:new Date().toISOString(),
    week:data.week
  });

  if(data.sessions.length % 3 ===0){
    data.week++;
  }

  save(data);
  return data;
}

// -----------------------------
// DASHBOARD
// -----------------------------

function getDashboard(){

  let data = load();

  let dashboard = {};

  Object.keys(data.categories).forEach(cat=>{
    dashboard[cat] = {
      band:data.categories[cat].band || null,
      time:data.categories[cat].time,
      sets:data.categories[cat].sets,
      stimulus:calcStimulus(data.categories[cat])
    };
  });

  dashboard.week = data.week;
  dashboard.totalSessions = data.sessions.length;
  dashboard.consecutiveDays = data.consecutiveDays;

  return dashboard;
}

// -----------------------------
// SIMULATORE
// -----------------------------

function simulateProgress(weeks=12){

  let sim = initState();

  for(let i=0;i<weeks*3;i++){

    Object.keys(sim.categories).forEach(cat=>{
      sim.categories[cat] =
        progressCategory(sim.categories[cat],cat,1,sim.week);
    });

    if(i%3===0) sim.week++;
  }

  return sim;
}

// -----------------------------
// EXPORT JSON
// -----------------------------

function exportJSON(){
  return JSON.stringify(load(),null,2);
}

// -----------------------------
// PUBLIC API
// -----------------------------

return {
  load,
  save,
  completeSession,
  getDashboard,
  simulateProgress,
  exportJSON,
  rules:CATEGORY_RULES
};

})();
