(() => {
  'use strict';

  const DB_NAME = 'studyplay-beta-db';
  const DB_VERSION = 1;
  const STATE_KEY = 'main';
  const CDN_SQL = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';

  const GAME_DEFS = [
    ['flash', '🃏', 'Flashcards', 'Pregunta → respuesta'],
    ['quiz', '🎯', 'Quiz', 'Elige la respuesta'],
    ['match', '🔗', 'Unir', 'Relaciona conceptos'],
    ['memory', '🧠', 'Memorama', 'Encuentra las parejas'],
    ['truefalse', '✅', 'Verdadero / Falso', 'Decide rápidamente'],
    ['write', '✍️', 'Escribir', 'Recuerda sin pistas'],
    ['order', '🔀', 'Ordenar', 'Reconstruye la frase'],
    ['listen', '🎧', 'Listening', 'Escucha y reconoce'],
    ['speed', '⚡', 'Reto rápido', '60 segundos'],
    ['survival', '☠️', 'Supervivencia', '3 vidas']
  ];

  const DEMO_CARDS = [
    ['1','Lesson 01','a couple of','two people or things considered together','a c__ __p__ __ o__','The monkey has a couple of bananas.'],
    ['2','Lesson 01','a long time ago','many years ago','a l__ __ __ t__ __ __ a__ __','A long time ago, dinosaurs lived on Earth.'],
    ['3','Lesson 01','a lot of','a large amount or number','a l__ __ o__','He has a lot of hair.'],
    ['4','Lesson 01','above all','most importantly','a__ __v__ a__ __','Above all, a soldier must be brave.'],
    ['5','Lesson 01','according to','as shown or said by','a__c__ __d__ __ t__','According to scientists, the Earth is becoming warmer.'],
    ['6','Lesson 01','after all','despite what has been said','a__t__ __ a__ __','After all, we are only human.'],
    ['7','Lesson 02','all the time','very frequently or continuously','','He talks about football all the time.'],
    ['8','Lesson 02','agree with','to have the same opinion as','','I agree with you.'],
    ['9','Lesson 02','all of a sudden','suddenly and unexpectedly','','All of a sudden, the lights went out.'],
    ['10','Lesson 02','all the way','during the entire distance','','We walked all the way home.'],
    ['11','Lesson 02','as a result','because of something that happened','','It rained; as a result, the match was canceled.'],
    ['12','Lesson 02','at first','at the beginning','','At first, the task seemed difficult.']
  ].map(x => ({ id:`demo-${x[0]}`, deck:x[1], front:x[2], back:x[3], hint:x[4], example:x[5], sound:'', images:[], tags:[], anki:{reps:0,lapses:0,ivl:0} }));

  const DEFAULT_STATE = () => ({
    library: {
      name: 'Demo · English Expressions',
      sourceName: 'demo',
      sourceBlob: null,
      mediaMap: {},
      cards: DEMO_CARDS
    },
    selectedDeck: 'ALL',
    progress: {},
    stats: { xp: 0, correct: 0, wrong: 0, streak: 1, lastStudyDay: '' }
  });

  let state = DEFAULT_STATE();
  let currentGame = null;
  let currentObjectUrls = [];
  let runtimeZip = null;
  let runtimeMediaReverse = null;
  let deferredInstallPrompt = null;

  const $ = (id) => document.getElementById(id);
  const screens = { home:$('homeScreen'), import:$('importScreen'), progress:$('progressScreen'), play:$('playScreen') };

  function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
  function shuffle(arr){
    const out=[...arr];
    for(let i=out.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
    return out;
  }
  function sample(arr,n){ return shuffle(arr).slice(0,Math.min(n,arr.length)); }
  function normalizeText(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/<[^>]*>/g,' ').replace(/[^a-z0-9]+/g,' ').trim(); }
  function stripCloze(s){ return String(s||'').replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g,'$1'); }
  function stripHtml(html){
    const div=document.createElement('div');
    div.innerHTML=stripCloze(String(html||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/div>/gi,'\n'));
    return (div.textContent||'').replace(/\n{3,}/g,'\n\n').trim();
  }
  function extractSounds(html){ return [...String(html||'').matchAll(/\[sound:([^\]]+)\]/gi)].map(m=>m[1]); }
  function extractImages(html){ return [...String(html||'').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]); }
  function dateKey(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains('state')) db.createObjectStore('state'); };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  async function loadState(){
    try{
      const db=await openDB();
      const value=await new Promise((resolve,reject)=>{ const tx=db.transaction('state','readonly'); const req=tx.objectStore('state').get(STATE_KEY); req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); });
      db.close();
      if(value && value.library && Array.isArray(value.library.cards)) state=value;
    }catch(err){ console.warn('No se pudo cargar IndexedDB',err); }
  }
  async function saveState(){
    try{
      const db=await openDB();
      await new Promise((resolve,reject)=>{ const tx=db.transaction('state','readwrite'); tx.objectStore('state').put(state,STATE_KEY); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
      db.close();
    }catch(err){ console.warn('No se pudo guardar IndexedDB',err); }
  }

  function getCards(){
    const cards=state.library.cards||[];
    if(state.selectedDeck==='ALL') return cards;
    return cards.filter(c=>c.deck===state.selectedDeck || c.deck.startsWith(`${state.selectedDeck} / `));
  }
  function cardProgress(card){
    return state.progress[card.id] || { seen:0,correct:0,wrong:0,mastery:0,last:'',nextDue:'' };
  }
  function recordResult(card, ok, mode, xp=10){
    const p=cardProgress(card);
    p.seen+=1;
    p.last=new Date().toISOString();
    if(ok){ p.correct+=1; p.mastery=clamp((p.mastery||0)+14,0,100); state.stats.correct+=1; state.stats.xp+=xp; }
    else { p.wrong+=1; p.mastery=clamp((p.mastery||0)-8,0,100); state.stats.wrong+=1; }
    const days = p.mastery>=80 ? 7 : p.mastery>=50 ? 3 : p.mastery>=20 ? 1 : 0;
    const due=new Date(); due.setDate(due.getDate()+days); p.nextDue=due.toISOString();
    state.progress[card.id]=p;
    const today=dateKey();
    if(state.stats.lastStudyDay!==today){
      if(state.stats.lastStudyDay){ const y=new Date(); y.setDate(y.getDate()-1); state.stats.streak = state.stats.lastStudyDay===dateKey(y) ? (state.stats.streak||0)+1 : 1; }
      state.stats.lastStudyDay=today;
    }
    saveState(); updateStatsUI();
  }

  function updateStatsUI(){
    const reviews=state.stats.correct+state.stats.wrong;
    const acc=reviews?Math.round(state.stats.correct/reviews*100):0;
    const all=state.library.cards||[];
    const mastered=all.filter(c=>cardProgress(c).mastery>=80).length;
    const avg=all.length?Math.round(all.reduce((s,c)=>s+(cardProgress(c).mastery||0),0)/all.length):0;
    $('xpValue').textContent=state.stats.xp||0; $('correctValue').textContent=state.stats.correct||0; $('accuracyValue').textContent=`${acc}%`; $('streakValue').textContent=state.stats.streak||1; $('masteryBar').style.width=`${avg}%`;
    $('pReviews').textContent=reviews; $('pAccuracy').textContent=`${acc}%`; $('pMastered').textContent=mastered; $('pXp').textContent=state.stats.xp||0;
    let n=0,l=0,m=0; all.forEach(c=>{ const x=cardProgress(c).mastery||0; if(x>=80)m++; else if(x>0)l++; else n++; });
    $('newCount').textContent=n; $('learningCount').textContent=l; $('masteredCount').textContent=m;
    const hard=[...all].filter(c=>cardProgress(c).seen>0).sort((a,b)=>{ const pa=cardProgress(a),pb=cardProgress(b); return (pb.wrong-pb.correct)-(pa.wrong-pa.correct); }).slice(0,5);
    const list=$('hardestList'); list.replaceChildren();
    if(!hard.length){ const p=document.createElement('p'); p.className='muted'; p.textContent='Todavía no hay suficientes respuestas.'; list.appendChild(p); }
    hard.forEach(c=>{ const p=cardProgress(c); const row=document.createElement('div'); row.className='hard-row'; const a=document.createElement('span'); a.textContent=c.front; const b=document.createElement('b'); b.textContent=`${p.wrong} errores`; row.append(a,b); list.appendChild(row); });
  }

  function renderHome(){
    const cards=getCards();
    $('activeDeckName').textContent=state.selectedDeck==='ALL'?state.library.name:state.selectedDeck;
    $('activeDeckMeta').textContent=`${cards.length} tarjetas · ${state.library.sourceName==='demo'?'datos de prueba':'importado de '+state.library.sourceName}`;
    const gameGrid=$('gameGrid'); gameGrid.replaceChildren();
    GAME_DEFS.forEach(([id,emoji,title,sub])=>{ const b=document.createElement('button'); b.type='button'; b.className='game-tile'; b.disabled=cards.length<2 && ['quiz','match','memory','truefalse','listen','speed','survival'].includes(id); const e=document.createElement('span'); e.className='emoji'; e.textContent=emoji; const s=document.createElement('strong'); s.textContent=title; const sm=document.createElement('small'); sm.textContent=b.disabled?'Necesita más tarjetas':sub; b.append(e,s,sm); b.addEventListener('click',()=>startGame(id)); gameGrid.appendChild(b); });
    renderDecks(); updateStatsUI();
  }

  function renderDecks(){
    const counts=new Map();
    (state.library.cards||[]).forEach(c=>counts.set(c.deck||'Sin mazo',(counts.get(c.deck||'Sin mazo')||0)+1));
    const list=$('deckList'); list.replaceChildren();
    const allBtn=makeDeckButton('ALL',state.library.name,state.library.cards.length); list.appendChild(allBtn);
    [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name,count])=>list.appendChild(makeDeckButton(name,name,count)));
  }
  function makeDeckButton(value,label,count){
    const b=document.createElement('button'); b.type='button'; b.className=`deck-item${state.selectedDeck===value?' active':''}`;
    const left=document.createElement('div'); const strong=document.createElement('strong'); strong.textContent=label; const small=document.createElement('small'); small.textContent=value==='ALL'?'Colección completa':'Mazo / submazo'; left.append(strong,document.createElement('br'),small); const n=document.createElement('b'); n.textContent=count; b.append(left,n);
    b.addEventListener('click',()=>{state.selectedDeck=value; saveState(); renderHome();}); return b;
  }

  function showScreen(name){
    Object.entries(screens).forEach(([key,el])=>el.classList.toggle('active',key===name));
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.screen===name));
    if(name==='home')renderHome(); if(name==='progress')updateStatsUI();
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function setGameHeader(eyebrow,title,counter=''){
    $('gameEyebrow').textContent=eyebrow; $('gameTitle').textContent=title; $('gameCounter').textContent=counter; $('gameCounter').classList.toggle('hidden',!counter); $('gameFeedback').textContent='';
  }
  function clearGameArea(){
    currentObjectUrls.forEach(URL.revokeObjectURL); currentObjectUrls=[]; $('gameArea').replaceChildren(); $('gameFeedback').textContent='';
  }
  function makeQuestion(text, label='Pregunta'){
    const card=document.createElement('div'); card.className='question-card'; const p=document.createElement('p'); p.className='eyebrow'; p.textContent=label; const h=document.createElement('h3'); h.textContent=text; card.append(p,h); return card;
  }
  function makeAnswerButton(text, onClick){ const b=document.createElement('button'); b.type='button'; b.className='answer-btn'; b.textContent=text; b.addEventListener('click',()=>onClick(b)); return b; }
  function randomCard(cards=getCards()){ return cards[Math.floor(Math.random()*cards.length)]; }
  function chooseDistractors(card, field='back', n=3){ return sample(getCards().filter(c=>c.id!==card.id && normalizeText(c[field])!==normalizeText(card[field]) && c[field]),n).map(c=>c[field]); }

  function startGame(type){
    const cards=getCards();
    if(!cards.length) return;
    currentGame=type; clearGameArea(); showScreen('play');
    if(type==='flash') gameFlash(cards);
    else if(type==='quiz') gameQuiz(cards);
    else if(type==='match') gameMatch(cards);
    else if(type==='memory') gameMemory(cards);
    else if(type==='truefalse') gameTrueFalse(cards);
    else if(type==='write') gameWrite(cards);
    else if(type==='order') gameOrder(cards);
    else if(type==='listen') gameListen(cards);
    else if(type==='speed') gameSpeed(cards);
    else if(type==='survival') gameSurvival(cards);
  }

  function gameFlash(cards){
    let index=0;
    const render=()=>{
      clearGameArea(); const card=cards[index%cards.length]; setGameHeader('FLASHCARDS','Repaso clásico',`${index%cards.length+1}/${cards.length}`);
      const fc=document.createElement('button'); fc.type='button'; fc.className='flash-card'; let flipped=false;
      const lab=document.createElement('p'); lab.className='eyebrow'; lab.textContent='PREGUNTA'; const h=document.createElement('h3'); h.textContent=card.front; const sub=document.createElement('p'); sub.className='muted'; sub.textContent='Toca para ver la respuesta'; fc.append(lab,h,sub);
      fc.addEventListener('click',()=>{flipped=!flipped;lab.textContent=flipped?'RESPUESTA':'PREGUNTA';h.textContent=flipped?card.back:card.front;sub.textContent=flipped?(card.example||'Toca para volver'):'Toca para ver la respuesta';});
      const actions=document.createElement('div'); actions.className='flash-actions'; [['Otra vez',false,0],['Bien',true,10],['Fácil',true,15]].forEach(([t,ok,xp])=>{const b=document.createElement('button');b.type='button';b.className='answer-btn';b.textContent=t;b.addEventListener('click',()=>{recordResult(card,ok,'flash',xp);index++;render();});actions.appendChild(b)});
      $('gameArea').append(fc,actions);
    }; render();
  }

  function gameQuiz(cards){
    let round=0; const total=Math.min(10,cards.length*2);
    const render=()=>{ clearGameArea(); if(round>=total){gameComplete('Quiz completado');return;} const card=randomCard(cards); setGameHeader('QUIZ','Elige la respuesta',`${round+1}/${total}`); $('gameArea').appendChild(makeQuestion(card.front)); const answers=document.createElement('div');answers.className='answers'; const opts=shuffle([card.back,...chooseDistractors(card,'back',3)]); opts.forEach(opt=>answers.appendChild(makeAnswerButton(opt,b=>{const ok=normalizeText(opt)===normalizeText(card.back);answers.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(ok?'good':'bad');if(!ok){[...answers.children].find(x=>normalizeText(x.textContent)===normalizeText(card.back))?.classList.add('good');}$('gameFeedback').textContent=ok?'✅ Correcto · +15 XP':`❌ Correcta: ${card.back}`;recordResult(card,ok,'quiz',15);setTimeout(()=>{round++;render();},650);}))); $('gameArea').appendChild(answers); }; render();
  }

  function gameMatch(cards){
    const chosen=sample(cards,Math.min(5,cards.length)); let left=null,right=null,done=new Set();
    setGameHeader('UNIR','Relaciona conceptos',`0/${chosen.length}`); const wrap=document.createElement('div');wrap.className='pair-grid';const L=document.createElement('div'),R=document.createElement('div');L.className=R.className='pair-col';
    const check=()=>{if(!left||!right)return;const ok=left.dataset.id===right.dataset.id;if(ok){const card=chosen.find(c=>c.id===left.dataset.id);done.add(card.id);[left,right].forEach(x=>{x.classList.remove('selected');x.classList.add('done');x.disabled=true;});recordResult(card,true,'match',10);$('gameFeedback').textContent='✅ Pareja correcta';$('gameCounter').textContent=`${done.size}/${chosen.length}`;if(done.size===chosen.length)setTimeout(()=>gameComplete('¡Todas las parejas!'),500);}else{const card=chosen.find(c=>c.id===left.dataset.id);recordResult(card,false,'match',0);[left,right].forEach(x=>x.classList.remove('selected'));$('gameFeedback').textContent='❌ No coinciden';}left=right=null;};
    chosen.forEach(c=>{const b=document.createElement('button');b.type='button';b.className='pair-btn';b.textContent=c.front;b.dataset.id=c.id;b.addEventListener('click',()=>{L.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');left=b;check();});L.appendChild(b)});
    shuffle(chosen).forEach(c=>{const b=document.createElement('button');b.type='button';b.className='pair-btn';b.textContent=c.back;b.dataset.id=c.id;b.addEventListener('click',()=>{R.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');right=b;check();});R.appendChild(b)}); wrap.append(L,R); $('gameArea').appendChild(wrap);
  }

  function gameMemory(cards){
    const chosen=sample(cards,Math.min(6,cards.length)); const deck=shuffle(chosen.flatMap(c=>[{id:c.id,text:c.front,card:c},{id:c.id,text:c.back,card:c}])); let open=[],done=new Set(),lock=false,moves=0;
    setGameHeader('MEMORAMA','Encuentra las parejas',`0/${chosen.length}`); const stats=document.createElement('div');stats.className='timer-row';const movesEl=document.createElement('span');movesEl.className='timer-pill';movesEl.textContent='Movimientos: 0';stats.append(movesEl);const grid=document.createElement('div');grid.className='memo-grid';
    deck.forEach(item=>{const b=document.createElement('button');b.type='button';b.className='memo-card';b.textContent='?';b.dataset.id=item.id;b.addEventListener('click',()=>{if(lock||b.classList.contains('open')||b.classList.contains('done'))return;b.classList.add('open');b.textContent=item.text;open.push(b);if(open.length===2){moves++;movesEl.textContent=`Movimientos: ${moves}`;const[a,d]=open;if(a.dataset.id===d.dataset.id){[a,d].forEach(x=>x.classList.add('done'));done.add(a.dataset.id);recordResult(item.card,true,'memory',12);$('gameCounter').textContent=`${done.size}/${chosen.length}`;$('gameFeedback').textContent='✅ ¡Pareja encontrada!';open=[];if(done.size===chosen.length)setTimeout(()=>gameComplete(`Memorama en ${moves} movimientos`),500);}else{recordResult(item.card,false,'memory',0);lock=true;$('gameFeedback').textContent='❌ Memoriza dónde estaban';setTimeout(()=>{[a,d].forEach(x=>{x.classList.remove('open');x.textContent='?'});open=[];lock=false;},700)}}});grid.appendChild(b)}); $('gameArea').append(stats,grid);
  }

  function gameTrueFalse(cards){
    let round=0,total=Math.min(10,cards.length*2); const render=()=>{clearGameArea();if(round>=total){gameComplete('Verdadero/Falso completado');return;}const card=randomCard(cards);const isTrue=Math.random()>.5;const shown=isTrue?card.back:randomCard(cards.filter(c=>c.id!==card.id)).back;setGameHeader('VERDADERO / FALSO','¿Coinciden?',`${round+1}/${total}`);$('gameArea').appendChild(makeQuestion(`${card.front}  =  ${shown}`,'AFIRMACIÓN'));const box=document.createElement('div');box.className='tf-grid';[['✅ Verdadero',true],['❌ Falso',false]].forEach(([t,val])=>box.appendChild(makeAnswerButton(t,b=>{const ok=val===isTrue;box.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(ok?'good':'bad');$('gameFeedback').textContent=ok?'✅ Correcto':'❌ Incorrecto';recordResult(card,ok,'truefalse',10);setTimeout(()=>{round++;render();},550)})));$('gameArea').appendChild(box);};render();
  }

  function gameWrite(cards){
    let round=0,total=Math.min(10,cards.length); const render=()=>{clearGameArea();if(round>=total){gameComplete('Escritura completada');return;}const card=cards[round%cards.length];const useHint=!!card.hint;const prompt=useHint?stripHtml(card.hint):card.front;const expected=useHint?card.front:card.back;setGameHeader('ESCRIBIR','Recuerda la respuesta',`${round+1}/${total}`);$('gameArea').appendChild(makeQuestion(prompt,useHint?'PISTA':'PREGUNTA'));const form=document.createElement('form');const input=document.createElement('input');input.className='text-input';input.placeholder='Escribe tu respuesta';input.autocomplete='off';const submit=document.createElement('button');submit.type='submit';submit.className='primary-btn';submit.style.marginTop='10px';submit.textContent='Comprobar';form.append(input,submit);form.addEventListener('submit',e=>{e.preventDefault();if(!input.value.trim())return;const ok=normalizeText(input.value)===normalizeText(expected);input.disabled=true;submit.disabled=true;$('gameFeedback').textContent=ok?'✅ Correcto · +20 XP':`❌ Respuesta: ${expected}`;recordResult(card,ok,'write',20);setTimeout(()=>{round++;render();},850)});$('gameArea').appendChild(form);setTimeout(()=>input.focus(),0);};render();
  }

  function gameOrder(cards){
    const candidates=cards.filter(c=>c.front.trim().split(/\s+/).length>=2);if(!candidates.length){setGameHeader('ORDENAR','Sin frases disponibles');$('gameArea').appendChild(makeQuestion('Este mazo no tiene expresiones de varias palabras para ordenar.'));return;}let round=0,total=Math.min(8,candidates.length);const render=()=>{clearGameArea();if(round>=total){gameComplete('Ordenar completado');return;}const card=candidates[round%candidates.length],words=card.front.trim().split(/\s+/),pool=shuffle(words.map((w,i)=>({w,id:i}))),chosen=[];setGameHeader('ORDENAR','Reconstruye la expresión',`${round+1}/${total}`);const target=document.createElement('div');target.className='question-card';const lab=document.createElement('p');lab.className='eyebrow';lab.textContent='TU RESPUESTA';const out=document.createElement('h3');out.textContent='…';target.append(lab,out);const chips=document.createElement('div');chips.className='answers';chips.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';pool.forEach(tok=>{const b=makeAnswerButton(tok.w,()=>{if(b.disabled)return;b.disabled=true;chosen.push(tok);out.textContent=chosen.map(x=>x.w).join(' ');});chips.appendChild(b)});const check=document.createElement('button');check.type='button';check.className='primary-btn';check.style.marginTop='12px';check.textContent='Comprobar';check.addEventListener('click',()=>{if(chosen.length!==words.length){$('gameFeedback').textContent='Usa todas las palabras.';return;}const ok=normalizeText(chosen.map(x=>x.w).join(' '))===normalizeText(card.front);$('gameFeedback').textContent=ok?'✅ Orden correcto':`❌ Correcto: ${card.front}`;recordResult(card,ok,'order',18);setTimeout(()=>{round++;render();},700)});$('gameArea').append(target,chips,check);};render();
  }

  async function ensureRuntimeZip(){
    if(runtimeZip) return runtimeZip;
    if(!state.library.sourceBlob || !window.JSZip) return null;
    runtimeZip=await JSZip.loadAsync(state.library.sourceBlob);
    runtimeMediaReverse={};
    Object.entries(state.library.mediaMap||{}).forEach(([k,v])=>runtimeMediaReverse[v]=k);
    return runtimeZip;
  }
  async function mediaUrl(filename){
    try{const zip=await ensureRuntimeZip();if(!zip||!filename)return null;const key=(runtimeMediaReverse||{})[filename];const entry=key?zip.file(key):zip.file(filename);if(!entry)return null;const blob=await entry.async('blob');const url=URL.createObjectURL(blob);currentObjectUrls.push(url);return url;}catch{return null;}
  }

  function gameListen(cards){
    let round=0,total=Math.min(10,cards.length);const render=async()=>{clearGameArea();if(round>=total){gameComplete('Listening completado');return;}const card=randomCard(cards);setGameHeader('LISTENING','Escucha y elige',`${round+1}/${total}`);const q=document.createElement('div');q.className='question-card';const icon=document.createElement('div');icon.style.fontSize='3rem';icon.style.textAlign='center';icon.textContent='🔊';const play=document.createElement('button');play.type='button';play.className='primary-btn';play.textContent='Reproducir';q.append(icon,play);$('gameArea').appendChild(q);let audio=null;const filename=card.sound||'';if(filename){const url=await mediaUrl(filename);if(url)audio=new Audio(url);}play.addEventListener('click',()=>{if(audio){audio.currentTime=0;audio.play().catch(()=>{});}else if('speechSynthesis'in window){speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(card.front));}else{$('gameFeedback').textContent='Audio no disponible en este navegador.';}});const answers=document.createElement('div');answers.className='answers';shuffle([card.front,...chooseDistractors(card,'front',3)]).forEach(opt=>answers.appendChild(makeAnswerButton(opt,b=>{const ok=normalizeText(opt)===normalizeText(card.front);answers.querySelectorAll('button').forEach(x=>x.disabled=true);b.classList.add(ok?'good':'bad');$('gameFeedback').textContent=ok?'✅ Correcto':'❌ Intenta otra vez';recordResult(card,ok,'listen',15);setTimeout(()=>{round++;render();},650)})));$('gameArea').appendChild(answers);};render();
  }

  function gameSpeed(cards){
    setGameHeader('RETO RÁPIDO','60 segundos','0 pts');let score=0,combo=0,time=60,active=false,timer=null;
    const timerRow=document.createElement('div');timerRow.className='timer-row';const t=document.createElement('span');t.className='timer-pill';t.textContent='⏱ 60s';const c=document.createElement('span');c.className='timer-pill';c.textContent='🔥 x0';timerRow.append(t,c);const content=document.createElement('div');const start=document.createElement('button');start.type='button';start.className='primary-btn';start.textContent='Empezar';$('gameArea').append(timerRow,content,start);
    const next=()=>{content.replaceChildren();const card=randomCard(cards);content.appendChild(makeQuestion(card.front));const ans=document.createElement('div');ans.className='answers';ans.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';shuffle([card.back,...chooseDistractors(card,'back',3)]).forEach(opt=>ans.appendChild(makeAnswerButton(opt,()=>{if(!active)return;const ok=normalizeText(opt)===normalizeText(card.back);if(ok){combo++;score+=10+Math.min(combo,5)*2;}else{combo=0;score=Math.max(0,score-5);}recordResult(card,ok,'speed',ok?2:0);$('gameCounter').textContent=`${score} pts`;c.textContent=`🔥 x${combo}`;next();})));content.appendChild(ans);};
    start.addEventListener('click',()=>{if(active)return;active=true;start.classList.add('hidden');next();timer=setInterval(()=>{time--;t.textContent=`⏱ ${time}s`;if(time<=0){clearInterval(timer);active=false;content.replaceChildren();content.appendChild(makeQuestion(`Puntuación final: ${score}`,'TIEMPO TERMINADO'));const again=document.createElement('button');again.type='button';again.className='primary-btn';again.style.marginTop='12px';again.textContent='Jugar otra vez';again.addEventListener('click',()=>gameSpeed(cards));content.appendChild(again);}},1000);});
  }

  function gameSurvival(cards){
    let hearts=3,score=0;setGameHeader('SUPERVIVENCIA','No pierdas tus 3 vidas','❤️❤️❤️');const render=()=>{clearGameArea();if(hearts<=0){setGameHeader('SUPERVIVENCIA','Fin de la partida',`${score} pts`);$('gameArea').appendChild(makeQuestion(`Llegaste a ${score} respuestas correctas.`,'RESULTADO'));const b=document.createElement('button');b.type='button';b.className='primary-btn';b.style.marginTop='12px';b.textContent='Nueva partida';b.addEventListener('click',()=>gameSurvival(cards));$('gameArea').appendChild(b);return;}const card=randomCard(cards);$('gameCounter').textContent=`${'❤️'.repeat(hearts)} · ${score}`;$('gameArea').appendChild(makeQuestion(card.front));const ans=document.createElement('div');ans.className='answers';shuffle([card.back,...chooseDistractors(card,'back',3)]).forEach(opt=>ans.appendChild(makeAnswerButton(opt,()=>{const ok=normalizeText(opt)===normalizeText(card.back);recordResult(card,ok,'survival',ok?6:0);if(ok){score++;$('gameFeedback').textContent='✅ Sigue así';}else{hearts--;$('gameFeedback').textContent=`❌ Era: ${card.back}`;}setTimeout(render,600)})));$('gameArea').appendChild(ans);};render();
  }

  function gameComplete(message){
    clearGameArea();setGameHeader('COMPLETADO','¡Buen trabajo!','');const q=makeQuestion(message,'SESIÓN');const b=document.createElement('button');b.type='button';b.className='primary-btn';b.style.marginTop='12px';b.textContent='Volver a juegos';b.addEventListener('click',()=>showScreen('home'));$('gameArea').append(q,b);
  }

  function startMixed(){
    const candidates=['quiz','truefalse','write','order','listen'];
    startGame(candidates[Math.floor(Math.random()*candidates.length)]);
    $('gameEyebrow').textContent='SESIÓN MIXTA';
  }

  function sqlRows(db,sql){
    const res=db.exec(sql);if(!res.length)return[];const {columns,values}=res[0];return values.map(row=>Object.fromEntries(columns.map((c,i)=>[c,row[i]])));
  }
  async function ensureImportLibs(){
    const missing=[];if(!window.JSZip)missing.push('JSZip');if(!window.fzstd)missing.push('fzstd');if(!window.initSqlJs)missing.push('sql.js');if(missing.length)throw new Error(`No cargaron dependencias: ${missing.join(', ')}. Revisa tu conexión y vuelve a intentar.`);
  }

  async function parseAnkiPackage(file){
    await ensureImportLibs();
    const zip=await JSZip.loadAsync(file); let bytes=null;
    const modern=zip.file('collection.anki21b'); const a21=zip.file('collection.anki21'); const a2=zip.file('collection.anki2');
    if(modern){ bytes=fzstd.decompress(await modern.async('uint8array')); }
    else if(a21){ bytes=await a21.async('uint8array'); }
    else if(a2){ bytes=await a2.async('uint8array'); }
    else throw new Error('No encontré una colección Anki compatible dentro del paquete.');
    const SQL=await initSqlJs({locateFile:f=>CDN_SQL+f}); const db=new SQL.Database(bytes);
    const fields=sqlRows(db,'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord');
    const fieldMap={}; fields.forEach(f=>{(fieldMap[f.ntid]??=[])[f.ord]=f.name;});
    let decks=[];try{decks=sqlRows(db,'SELECT id, name FROM decks');}catch{decks=[];}
    const deckMap=Object.fromEntries(decks.map(d=>[String(d.id),String(d.name).replace(/\x1f/g,' / ')]));
    const rows=sqlRows(db,'SELECT c.id card_id, c.nid, c.did, c.reps, c.lapses, c.ivl, n.mid, n.tags, n.flds FROM cards c JOIN notes n ON c.nid=n.id');
    const cards=[];
    for(const row of rows){
      const names=fieldMap[row.mid]||[]; const vals=String(row.flds||'').split('\x1f'); const obj={}; names.forEach((name,i)=>obj[name]=vals[i]||'');
      const values=vals.map(stripHtml).filter(Boolean);
      const frontRaw=obj.Key_Phrase||obj.Front||obj.Text||obj.Question||values[0]||'';
      const backRaw=obj.Synonyms||obj.Back||obj.Definition||obj.Answer||values[1]||'';
      const front=stripHtml(frontRaw), back=stripHtml(backRaw);
      if(!front||!back)continue;
      const allHtml=Object.values(obj).join('\n');
      cards.push({
        id:`anki-${row.card_id}`,
        deck:deckMap[String(row.did)]||'Anki',
        front,
        back,
        hint:stripHtml(obj.Suggestion||obj.Hint||''),
        example:stripHtml(obj.Example||obj.Sentence||''),
        translation:stripHtml(obj.Translation||obj.Vietnamese||obj.Spanish||''),
        sound:extractSounds(obj.Sound||allHtml)[0]||'',
        images:extractImages(allHtml),
        tags:String(row.tags||'').trim().split(/\s+/).filter(Boolean),
        anki:{reps:Number(row.reps||0),lapses:Number(row.lapses||0),ivl:Number(row.ivl||0)}
      });
    }
    db.close();
    let mediaMap={}; const media=zip.file('media');
    if(media){
      try{const raw=await media.async('uint8array');let txt='';try{txt=new TextDecoder().decode(fzstd.decompress(raw));}catch{txt=new TextDecoder().decode(raw);}mediaMap=JSON.parse(txt);}catch{mediaMap={};}
    }
    if(!cards.length) throw new Error('El paquete se abrió, pero no encontré tarjetas utilizables.');
    const roots=[...new Set(cards.map(c=>c.deck.split(' / ')[0]))];
    return {name:roots.length===1?roots[0]:file.name.replace(/\.(apkg|colpkg)$/i,''),sourceName:file.name,sourceBlob:file,mediaMap,cards};
  }

  async function parseTxt(file){
    const text=await file.text(); const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/); const metadata=lines.filter(l=>l.startsWith('#')); let sep='\t';
    const sepLine=metadata.find(l=>l.startsWith('#separator:')); if(sepLine){const v=sepLine.split(':').slice(1).join(':').trim();if(v==='semicolon')sep=';';else if(v==='comma')sep=',';else sep='\t';}
    const data=lines.filter(l=>l.trim()&&!l.startsWith('#')); const cards=[];
    data.forEach((line,i)=>{const cols=line.split(sep);const front=stripHtml(cols[0]||''),back=stripHtml(cols[1]||'');if(front&&back)cards.push({id:`txt-${Date.now()}-${i}`,deck:'Imported TXT',front,back,hint:'',example:'',translation:'',sound:'',images:[],tags:(cols[2]||'').split(/\s+/).filter(Boolean),anki:{reps:0,lapses:0,ivl:0}})});
    if(!cards.length)throw new Error('No encontré pares de columnas pregunta/respuesta en el TXT.');
    return {name:file.name.replace(/\.txt$/i,''),sourceName:file.name,sourceBlob:file,mediaMap:{},cards};
  }

  async function handleImport(file){
    const status=$('importStatus');const preview=$('importPreview');status.classList.remove('hidden');preview.classList.add('hidden');preview.replaceChildren();status.textContent='Analizando archivo…';
    try{
      const ext=file.name.split('.').pop().toLowerCase(); const lib=ext==='txt'?await parseTxt(file):await parseAnkiPackage(file);
      const decks=new Map();lib.cards.forEach(c=>decks.set(c.deck,(decks.get(c.deck)||0)+1));
      status.textContent=`✅ ${file.name} analizado correctamente.`;
      const box=document.createElement('div');box.className='panel';const h=document.createElement('h3');h.textContent=lib.name;const stats=document.createElement('div');stats.className='import-summary';[['Tarjetas',lib.cards.length],['Mazos',decks.size],['Audio',lib.cards.filter(c=>c.sound).length],['Con imágenes',lib.cards.filter(c=>c.images.length).length]].forEach(([l,v])=>{const d=document.createElement('div');d.className='import-stat';const b=document.createElement('b');b.textContent=v;const s=document.createElement('span');s.className='muted';s.textContent=l;d.append(b,s);stats.appendChild(d)});const dl=document.createElement('div');dl.className='import-decks';[...decks.entries()].slice(0,20).forEach(([name,count])=>{const row=document.createElement('div');row.className='import-deck-row';const n=document.createElement('span');n.style.flex='1';n.textContent=name;const c=document.createElement('b');c.textContent=count;row.append(n,c);dl.appendChild(row)});const btn=document.createElement('button');btn.type='button';btn.className='primary-btn';btn.style.marginTop='14px';btn.textContent='Importar y empezar';btn.addEventListener('click',async()=>{state.library=lib;state.selectedDeck='ALL';state.progress={};state.stats={xp:0,correct:0,wrong:0,streak:1,lastStudyDay:''};runtimeZip=null;runtimeMediaReverse=null;await saveState();status.textContent='✅ Importado. Tu progreso se guardará automáticamente en este dispositivo.';showScreen('home');});box.append(h,stats,dl,btn);preview.appendChild(box);preview.classList.remove('hidden');
    }catch(err){console.error(err);status.textContent=`❌ ${err.message||'No se pudo importar el archivo.'}`;}
  }

  async function resetProgress(){
    if(!confirm('¿Reiniciar todo el progreso de estudio? El mazo importado se conservará.'))return;
    state.progress={};state.stats={xp:0,correct:0,wrong:0,streak:1,lastStudyDay:''};await saveState();updateStatsUI();
  }

  function registerPWA(){
    if('serviceWorker'in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installBtn').classList.remove('hidden');});
    $('installBtn').addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').classList.add('hidden');});
  }

  async function init(){
    await loadState();
    document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>showScreen(b.dataset.screen)));
    $('exitGameBtn').addEventListener('click',()=>showScreen('home'));
    $('mixedSessionBtn').addEventListener('click',startMixed);
    $('fileInput').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)handleImport(f);e.target.value='';});
    $('resetProgressBtn').addEventListener('click',resetProgress);
    registerPWA(); renderHome(); updateStatsUI();
  }

  init();
})();
