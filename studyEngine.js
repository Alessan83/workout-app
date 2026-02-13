// ===============================
// STUDY ENGINE CORE v1.0
// ===============================

const StudyEngine = (function(){

// ---- CONFIG BASE ----

const BAND_LEVELS = [15,25,35];

const TENSION_FACTOR = {
  15:1.0,
  25:1.4,
  35:1.8
};

const DEFAULT_CATEGORY = () => ({
  band:15,
  time:40,
  sets:3,
  streak:0,
  fatigue:0
});

// ---- INITIAL STATE ----

function initState(){
  return {
    week:1,
    sessions:[],
    categories:{
      pull:DEFAULT_CATEGORY(),
      push:DEFAULT_CATEGORY(),
      posterior:{band:25,time:40,sets:3,streak:0,fatigue:0},
      core:{time:30,sets:2,streak:0,fatigue:0}
    }
  };
}

// ---- LOAD / SAVE ----

function load(){
  return JSON.parse(localStorage.getItem("studyEngine")) || initState();
}

function save(data){
  localStorage.setItem("studyEngine",JSON.stringify(data));
}

// ---- STIMULUS CALC ----

function calcStimulus(cat){
  return cat.time * cat.sets * TENSION_FACTOR[cat.band];
}

// ---- PROGRESSION LOGIC ----

function progressCategory(cat, rpe){

  // RPE: 1=Facile, 2=Medio, 3=Duro

  if(rpe <=2){
    cat.streak++;
  } else {
    cat.streak = 0;
    cat.fatigue++;
  }

  // DELoad
  if(cat.fatigue >=2){
    cat.time = Math.max(35, cat.time - 5);
    cat.sets = Math.max(2, cat.sets - 1);
    cat.fatigue = 0;
    cat.streak = 0;
    return cat;
  }

  // PROGRESSION
  if(cat.streak >=2){

    if(cat.time < 50){
      cat.time += 5;
    } 
    else if(cat.sets < 4){
      cat.sets += 1;
    } 
    else {
      let nextIndex = BAND_LEVELS.indexOf(cat.band)+1;
      if(nextIndex < BAND_LEVELS.length){
        cat.band = BAND_LEVELS[nextIndex];
      }
      cat.time = 40;
      cat.sets = 3;
    }

    cat.streak = 0;
  }

  return cat;
}

// ---- LUMBAR PROTECTION RULE ----

function lumbarCheck(data){

  let pullLoad = calcStimulus(data.categories.pull);
  let posteriorLoad = calcStimulus(data.categories.posterior);

  if(posteriorLoad > pullLoad * 1.2){
    data.categories.posterior.time -=5;
    data.categories.posterior.sets = Math.max(2,data.categories.posterior.sets-1);
  }

  return data;
}

// ---- SESSION COMPLETE ----

function completeSession(inputRPE){

  // inputRPE example:
  // {pull:1,push:2,posterior:2,core:1}

  let data = load();

  Object.keys(inputRPE).forEach(cat=>{
    if(data.categories[cat]){
      data.categories[cat] = progressCategory(data.categories[cat], inputRPE[cat]);
    }
  });

  data = lumbarCheck(data);

  data.sessions.push({
    date:new Date().toISOString(),
    week:data.week
  });

  // Week increment every 3 sessions
  if(data.sessions.length % 3 ===0){
    data.week++;
  }

  save(data);
  return data;
}

// ---- EXPORT ----

return {
  init:initState,
  load,
  save,
  completeSession,
  calcStimulus
};

})();
