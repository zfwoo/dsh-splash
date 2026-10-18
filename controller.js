/**
 * Splash — the injected controller.
 *
 * A plain classic script, not a module: it runs in the page before the client
 * bundle is even fetched, so it cannot import anything and must survive on the
 * DOM alone. The Host reads this file at startup and ships its exact text as the
 * body `script` row.
 *
 * It lives in a real .js file rather than inside a template literal in index.js
 * on purpose. While it was a template literal, any backtick in a comment closed
 * the literal early and Node reported a bare `Unexpected identifier` somewhere
 * else entirely — a trap that cost three debugging rounds. Here the comments are
 * free, and `node --check controller.js` guards the syntax directly.
 *
 * Everything the Host knows at index-render time arrives through one JSON-safe
 * `global` row, {@link PRELUDE}: the two global names, the state attribute, the
 * palette allowlist, the boot-log script and its pacing, and the two default
 * durations. That keeps this file free of build-time substitution.
 */

(()=>{try{
var PRELUDE='__DSH_SPLASH_PRELUDE__';
var P=globalThis[PRELUDE]||{};
var CFG=globalThis[P.configGlobal]||{};
var el=document.getElementById('dsh-splash');
if(!el)return;
var logBox=el.querySelector('[data-dsh-splash-log]');
var hint=el.querySelector('[data-dsh-splash-hint]');
var pct=el.querySelector('[data-dsh-splash-pct]');
var skip=el.querySelector('[data-dsh-splash-skip]');
var note=el.querySelector('[data-dsh-splash-skipnote]');
var timeline=el.querySelector('[data-dsh-splash-timeline]');
var LOG=P.log;
var CAP=P.cap;
var HOLD=typeof CFG.minDurationMs==='number'?CFG.minDurationMs:P.defaultMin;
var MAX=typeof CFG.maxTimeoutMs==='number'?CFG.maxTimeoutMs:P.defaultMax;
var PREVIEW_HOLD=5200;
var zh=/^zh/i.test(navigator.language||'');
var TEXT=zh?{boot:'启动中 / BOOTING',ready:'就绪 / READY',stuck:'启动较慢，请稍候 / STILL STARTING',cont:'继续 / CONTINUE',skip:'按任意键跳过 / PRESS ANY KEY TO SKIP'}
             :{boot:'BOOTING',ready:'READY',stuck:'STILL STARTING',cont:'CONTINUE',skip:'PRESS ANY KEY TO SKIP'};
var ALLOWED=P.presets;
var startedAt=Date.now(),hold=HOLD,done=false,scheduled=false,announced=false,appReadyNow=false;
var observer=null,deadline=null,raf=0,pumping=false,readyPoll=null,previewing=false,landed=0,awaiting=false;

function elapsed(){return Date.now()-startedAt}

/* --- the meter is the animation's own timeline ---------------------------- */
/* One steady rate across the whole hold, so it always ends on 100% at the
   moment the overlay collapses — the bar and the ending agree, and neither the
   meter nor the log freezes at 100% after a fast boot. The kernel card's own
   arc was mirrored here before and abandoned on purpose: it finishes early on a
   fast machine, which left the bar pinned at 100% for the rest of the hold, out
   of step with the log it was supposed to be in step with. */
function timelineRatio(){
  return Math.max(0,Math.min(1,elapsed()/Math.max(1,hold)));
}
function paint(){
  if(announced)return;
  setProgress(timelineRatio());
}
function setProgress(ratio){
  el.style.setProperty('--dsh-progress',(ratio*100).toFixed(1)+'%');
  if(pct)pct.textContent=Math.round(ratio*100)+'%';
}
/* One loop at most. A preview restarts the meter, and an unguarded second pump
   would be a second loop sharing this single handle — teardown could then cancel
   only one of them and the other would keep painting for the life of the page. */
function pump(){
  if(pumping)return;
  pumping=true;
  var step=function(){
    paint();
    advance();
    raf=requestAnimationFrame(step);
  };
  step();
}
pump()

/* --- the log lands on the same timeline ----------------------------------- */
/* Line n appears when the meter crosses its own share of the animation, so the
   narrative and the bar move together for the whole hold instead of the log
   finishing early and the bar crawling on alone. */
function advance(){
  if(done||announced)return;
  if(timelineRatio()>=1){
    if(appReadyNow)announce();else if(!awaiting){awaiting=true;prompt();poll()}
    return
  }
  // Line n of a script of N sits at n/(N+1) of the animation, which leaves the
  // final share for the ready line the collapse ends on.
  var mark=(landed+1)/(LOG.length+1);
  if(timelineRatio()>=mark&&landed<LOG.length)landNext();
}
function landNext(){
  addLine(LOG[landed]);
  landed+=1;
}

/* --- the log ------------------------------------------------------------- */
function addLine(text,idle){
  var line=document.createElement('div');
  line.className=idle?'dsh-line is-idle':'dsh-line';
  var mark=document.createElement('span');
  mark.className='dsh-lineMark';
  mark.textContent='>';
  var body=document.createElement('span');
  body.className='dsh-lineText';
  body.textContent=text;
  var ok=document.createElement('span');
  ok.className='dsh-lineOk';
  line.appendChild(mark);line.appendChild(body);line.appendChild(ok);
  logBox.appendChild(line);
  while(logBox.children.length>CAP)logBox.removeChild(logBox.firstChild);
  if(!idle){
    // A real tool prints the line, then the result. Deferring the badge keeps
    // that two-beat rhythm instead of a wall of pre-approved output.
    setTimeout(function(){
      // The literal character, not an escape. While this file's text was
      // assembled inside a template literal, `\u2713` had to be written with a
      // doubled backslash to survive the outer literal — and lifting the text out
      // of that literal silently kept the doubled form, so the badge rendered the
      // six characters `\u2713` instead of a check mark. A literal has no such
      // layer to get wrong.
      mark.textContent='✓';
      ok.textContent='ok';
      line.className='dsh-line is-ok';
    },140);
  }
  return line;
}
function prompt(){
  if(done||announced)return;
  addLine('awaiting application frame',true);
}
/* The scripted lines are spent and the application is still not up: a waiting
   line takes the terminal's last row and a slow poll watches for the frame. */
function poll(){
  clearInterval(readyPoll);
  readyPoll=setInterval(function(){
    if(done||announced){clearInterval(readyPoll);return}
    if(appReadyNow)announce();
  },400);
}
function announce(){
  if(announced||done)return;
  announced=true;
  clearInterval(readyPoll);
  addLine('ready');
  setProgress(1);
  if(hint)hint.textContent=TEXT.ready;
}

/* --- readiness ----------------------------------------------------------- */
function bootCard(){return document.querySelector('[data-dsh-boot]')}
function appReady(){
  if(bootCard()!==null)return false;
  var root=document.getElementById('root');
  return root===null||root.childElementCount>0;
}
function stuck(){
  if(done)return;
  el.setAttribute('data-dsh-splash-stuck','');
  if(hint)hint.textContent=TEXT.stuck;
  if(note)note.hidden=true;
  if(skip){skip.hidden=false;skip.textContent=TEXT.cont}
}
function teardown(){
  pumping=false;
  cancelAnimationFrame(raf);
  if(observer)observer.disconnect();
  clearTimeout(deadline);clearInterval(readyPoll);
  document.removeEventListener('keydown',onKey,true);
}
/* The collapse itself. Every path that ends the overlay runs this: the state
   attribute is what hides the kernel card, so leaving it behind would hide the
   very failure the operator needs to read. */
function fade(reason){
  if(done)return;done=true;teardown();
  document.documentElement.removeAttribute(P.stateAttribute);
  el.setAttribute('aria-busy','false');
  el.classList.add('is-leaving');
  setTimeout(function(){el.remove()},400);
}
/* Arm the collapse for the end of the hold. Kept separate from the collapse
   itself because the log keeps printing until then: readiness decides WHEN the
   overlay leaves, not what it is allowed to say in the meantime. */
function scheduleFade(reason){
  if(done||scheduled)return;
  scheduled=true;
  var wait=Math.max(0,hold-elapsed());
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    setTimeout(function(){fade(reason)},wait);
  })});
}
function scan(){
  if(done||previewing)return;
  var card=bootCard();
  // A failed boot keeps its card forever and never reaches React, so the
  // failure has to hand the screen back instead of being hidden by the splash.
  if(card!==null&&/Failed to load plugins/.test(card.textContent||'')){fade('boot-failed');return}
  if(!appReady())return;
  appReadyNow=true;
  scheduleFade('ready');
}

/* --- skipping: any key, or anywhere on the overlay ----------------------- */
function onKey(event){
  if(event.metaKey||event.ctrlKey||event.altKey)return;
  var key=event.key;
  if(key==='Shift'||key==='Control'||key==='Alt'||key==='Meta'||key==='CapsLock'||key==='Tab')return;
  if(key===' '||key.indexOf('Arrow')===0||key.indexOf('Page')===0||key==='Home'||key==='End'||key==='Backspace')event.preventDefault();
  fade('key');
}

function start_(){
  if(CFG.enabled!==true){
    // Disabled: nothing is covered and nothing is watched. The facade stays so
    // the settings row can still replay the animation.
    return;
  }
  document.documentElement.setAttribute(P.stateAttribute,'on');
  if(note)note.textContent=TEXT.skip;
  if(hint)hint.textContent=TEXT.boot;
  setTimeout(function(){if(!done)el.setAttribute('data-dsh-splash-elapsed','')},1100);
  paint();
  observer=new MutationObserver(scan);
  observer.observe(document.body,{childList:true,subtree:true});
  el.addEventListener('click',function(event){
    var target=event.target;
    if(target&&target.closest&&target.closest('[data-dsh-splash-skip]')){event.stopPropagation();fade('skip');return}
    fade('click');
  });
  document.addEventListener('keydown',onKey,true);
  deadline=setTimeout(stuck,MAX);
  pump();
  scan();
}

/* Retarget the overlay at the config the settings row is holding.
 *
 * The palette lives on the markup's `data-ds-preset`, which the Host pinned
 * when it rendered this index. The row writes the new value to the Host and
 * updates its own state optimistically, so without this the chip would light up
 * on the newly picked palette while the overlay kept painting the one the page
 * was served with — the row and the animation disagreeing, which is exactly how
 * "preview does not show the theme I picked" gets reported.
 *
 * Values are checked against the Host's own list: this runs in the page, and a
 * selector built from page-supplied data is not something to trust blindly.
 *
 * Deliberately palette-only. Patching `enabled` live would let a switch flip put
 * a full-screen overlay on top of the settings panel with no controller left
 * running to dismiss it — an unskippable screen is a far worse bug than a stale
 * palette. The switch takes effect on the next boot, which is what its own
 * notice says.
 */
function applyPatch(patch){
  if(!patch)return;
  if(ALLOWED.indexOf(patch.preset)>=0)el.setAttribute('data-ds-preset',patch.preset);
}

globalThis[P.facadeGlobal]={
  config:CFG,
  fade:fade,
  // Second readiness signal, raised by the client half from an overlay entry
  // that only mounts once the application frame really renders.
  frameLive:scan,
  // Live retarget, so a palette change lands on the overlay the operator is
  // already looking at as well as on the next preview.
  apply:applyPatch,
  // Settings-row preview: replays the whole animation on the shipped markup, so
  // a disabled splash can still be seen without a Host round trip or a restart.
  preview:function(patch){
    applyPatch(patch);
    if(!el.isConnected)document.body.appendChild(el);
    el.hidden=false;
    el.classList.remove('is-leaving');
    el.removeAttribute('data-dsh-splash-stuck');
    if(logBox)while(logBox.firstChild)logBox.removeChild(logBox.firstChild);
    if(skip)skip.hidden=true;
    if(note){note.hidden=false;note.textContent=TEXT.skip}
    if(hint)hint.textContent=TEXT.boot;
    setProgress(0);
    // Re-arm the timeline bar: a CSS animation only restarts when the element
    // is re-created or its animation declaration is reset, so read a layout
    // property in between to force the restart.
    hold=PREVIEW_HOLD;
    el.style.setProperty('--dsh-hold',PREVIEW_HOLD+'ms');
    if(timeline){timeline.style.animation='none';void timeline.offsetWidth;timeline.style.animation=''}
    previewing=true;done=false;scheduled=false;announced=false;landed=0;awaiting=false;startedAt=Date.now();
    // A preview shows the happy path end to end: the log drains into the ready
    // badge and the meter snaps home, so readiness is asserted rather than
    // waited for. The hold is long enough for the whole script to land.
    appReadyNow=true;
    document.documentElement.setAttribute(P.stateAttribute,'on');
    clearTimeout(deadline);
    pump();
    scheduleFade('preview');
  },
};
start_();
}catch(error){
  var failed=document.getElementById('dsh-splash');
  if(failed)failed.remove();
  document.documentElement.removeAttribute(P.stateAttribute);
}})()
