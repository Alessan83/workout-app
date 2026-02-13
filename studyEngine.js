// =======================================================
// STUDY ENGINE v3.0
// Coordinato con SessionEngine + BiomechanicalEngine
// =======================================================

const StudyEngine = (function(){

// ------------------------------
// CONFIG
// ------------------------------

const STORAGE_KEY = "studyEngineV3";

const BAND_LEVELS = [15,25,35];

const TENSION_FACTOR = {
  15:1.0,
  25:1.4,
  35:1.8
};

// Curva S 12 settimane
const S_CURVE = [
  0.85,0.9,0.95,1.0,
  1.05,1.1,1.15,1.2,
  1.15,1.1,1.0,0.8
];

const POSTERIOR_PULL_RATIO = 1.2;

// ------------------------------
// INIT STATE
// ------------------------------

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
    categories:{
      pull:defaultCategory(15),
      push:defaultCategory(15),
      posterior:defaultCategory(25),
      core:{
        time:30,
        sets:2,
        streak:0,
        fatigue:0,
        history:[]
      }
    }
  };
}

// ------------------------------
// STORAGE
// ------------------------------

function load(){
  return JSON.parse(localStorage.getItem(STORAGE_KEY)) || initState();
}

function save(data){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ------------------------------
// STIMULUS
// ------------------------------

function calcStimulus(cat){
  if(!cat.band) return cat.time * cat.sets;
  return cat.time * cat.sets * TENSION_FACTOR[cat.band];
}

// ------------------------------
// CURVA S
// ------------------------------

function applySCurve(cat, week){

  let index = (week-1)%12;
  let factor = S_CURVE[index];

  cat.time = Math.round(cat.time * factor);

  return cat;
}

// ------------------------------
// PROGRESSION LOGIC
// ------------------------------

function progressCategory(cat, categoryName, rpe, week){

  if(rpe <=2){
    cat.streak++;
  } else {
    cat.streak = 0;
    cat.fatigue++;
  }

  // DELOAD
  if(cat.fatigue >=2){
    cat.time = Math.max(35, cat.time -5);
    cat.sets = Math.max(2, cat.sets -1);
    cat.fatigue = 0;
    cat.streak = 0;
    return cat;
  }

  // PROGRESSION
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

        // Protezione L5-S1: posterior max 25
        if(categoryName === "posterior" && BAND_LEVELS[currentIndex+1] > 25){
          // non aumenta banda, aumenta solo tempo
          cat.time +=5;
        } else {
          cat.band = BAND_LEVELS[currentIndex+1];
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

// ------------------------------
// LUMBAR PROTECTION
// ------------------------------

function lumbarProtection(data){

  let pullLoad = calcStimulus(data.categories.pull);
  let posteriorLoad = calcStimulus(data.categories.posterior);

  if(posteriorLoad > pullLoad * POSTERIOR_PULL_RATIO){

    data.categories.posterior.time -=5;
    data.categories.posterior.sets =
      Math.max(2, data.categories.posterior.sets -1);
  }

  return data;
}

// ------------------------------
// RUN DAY ADJUST
// ------------------------------

function runDayAdjust(data){

  data.categories.posterior.time =
    Math.round(data.categories.posterior.time * 0.7);

  data.categories.posterior.sets =
    Math.max(2, data.categories.posterior.sets -1);

  return data;
}

// ------------------------------
// FASTING ADJUST
// ------------------------------

function fastingAdjust(data){

  Object.keys(data.categories).forEach(cat=>{
    data.categories[cat].time =
      Math.round(data.categories[cat].time * 0.9);
  });

  return data;
}

// ------------------------------
// FOR SESSION ENGINE
// ------------------------------

function getCategoryParams(){

  let data = load();

  return {
    week:data.week,
    categories:data.categories
  };
}

// ------------------------------
// REPORT SESSION RESULT
// ------------------------------

function reportSessionResult(report){

  /*
  report = {
    rpe:{pull:1,push:2,posterior:2,core:1},
    runDay:true/false,
    fasting:true/false,
    realSessionTime:1500,
    totalStress:80
  }
  */

  let data = load();

  Object.keys(report.rpe).forEach(cat=>{

    if(data.categories[cat]){

      data.categories[cat] =
        progressCategory(
          data.categories[cat],
          cat,
          report.rpe[cat],
          data.week
        );

      data.categories[cat].history.push({
        date:new Date().toISOString(),
        time:data.categories[cat].time,
        band:data.categories[cat].band || null,
        realSessionTime:report.realSessionTime,
        totalStress:report.totalStress
      });
    }
  });

  if(report.runDay)
    data = runDayAdjust(data);

  if(report.fasting)
    data = fastingAdjust(data);

  data = lumbarProtection(data);

  data.sessions.push({
    date:new Date().toISOString(),
    week:data.week,
    duration:report.realSessionTime,
    stress:report.totalStress
  });

  if(data.sessions.length % 3 ===0){
    data.week++;
  }

  save(data);

  return data;
}

// ------------------------------
// DASHBOARD ANALYTICS
// ------------------------------

function getDashboard(){

  let data = load();

  let summary = {
    week:data.week,
    totalSessions:data.sessions.length,
    categories:{}
  };

  Object.keys(data.categories).forEach(cat=>{
    summary.categories[cat] = {
      band:data.categories[cat].band || null,
      time:data.categories[cat].time,
      sets:data.categories[cat].sets,
      stimulus:calcStimulus(data.categories[cat])
    };
  });

  return summary;
}

// ------------------------------
// SIMULATION
// ------------------------------

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

// ------------------------------
// EXPORT JSON
// ------------------------------

function exportJSON(){
  return JSON.stringify(load(),null,2);
}

// ------------------------------
// PUBLIC API
// ------------------------------

return {
  load,
  save,
  getCategoryParams,
  reportSessionResult,
  getDashboard,
  simulateProgress,
  exportJSON
};

})();
