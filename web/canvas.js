import {zoomAt, fitBounds, freshCanvas, readCanvas} from './canvas-math.js';

// Layout belongs to this browser/project, separately from narrative versions.
export function createCanvas({onChange, onTool, notify}) {
  const viewport = document.querySelector('#board-scroll');
  const world = document.querySelector('#canvas-world');
  const prompt = document.querySelector('#composer');
  let state = freshCanvas(), projectId, hand = false, space = false, drag, suppressClick = false;
  let storageWarning = false;
  const editing = el => !!el.closest('input,textarea,select,[contenteditable="true"],dialog');
  const objectId = el => el.id === 'composer' ? 'prompt' : el.dataset.scene;
  const save = () => {
    if (!projectId) return;
    try { localStorage.setItem('storyscene-canvas-v1:'+projectId, JSON.stringify(state)); }
    catch { if (!storageWarning) { storageWarning=true; notify('Canvas positions could not be saved in this browser. Your manuscript is saved separately.'); } }
  };
  function position(el) {
    const p = state.positions[objectId(el)] || {x:0,y:0};
    el.style.translate = `${p.x}px ${p.y}px`;
  }
  function paint() {
    const {x,y,zoom} = state.view;
    world.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.backgroundSize = `${24*zoom}px ${24*zoom}px`;
    document.querySelector('#zoom-value').textContent = Math.round(zoom*100)+'%';
    onChange(zoom);
  }
  function refresh() {
    world.querySelectorAll('.scene-card,#composer').forEach(position);
    paint();
  }
  function load(id) {
    projectId=id;
    try { state=readCanvas(localStorage.getItem('storyscene-canvas-v1:'+id)); }
    catch { state=freshCanvas(); }
    refresh();
  }
  function setTool(value) {
    hand=value; viewport.classList.toggle('hand-tool',hand);
    document.querySelector('#hand-tool').classList.toggle('active',hand);
    document.querySelector('#hand-tool').setAttribute('aria-pressed',String(hand));
  }
  function zoom(factor, point={x:viewport.clientWidth/2,y:viewport.clientHeight/2}) {
    state.view=zoomAt(state.view,point,state.view.zoom*factor);paint();save();
  }
  function bounds(elements) {
    const root=world.getBoundingClientRect(), z=state.view.zoom;
    const rects=elements.filter(el=>el.offsetWidth && el.offsetHeight).map(el=>el.getBoundingClientRect());
    if(!rects.length)return {x:0,y:0,width:740,height:400};
    const x=Math.min(...rects.map(r=>r.left)), y=Math.min(...rects.map(r=>r.top));
    return {x:(x-root.left)/z,y:(y-root.top)/z,width:(Math.max(...rects.map(r=>r.right))-x)/z,height:(Math.max(...rects.map(r=>r.bottom))-y)/z};
  }
  function fit(elements) {
    state.view=fitBounds(bounds(elements),{width:viewport.clientWidth,height:viewport.clientHeight});paint();save();
  }
  function focusPrompt() { fit([prompt]);document.querySelector('#prompt').focus({preventScroll:true}); }
  viewport.addEventListener('wheel',e=>{
    if(editing(e.target) && !(e.ctrlKey||e.metaKey))return;
    e.preventDefault();
    const unit=e.deltaMode===1?16:e.deltaMode===2?viewport.clientHeight:1;
    if(e.ctrlKey||e.metaKey){const r=viewport.getBoundingClientRect();zoom(Math.exp(-e.deltaY*unit*.008),{x:e.clientX-r.left,y:e.clientY-r.top});}
    else {state.view.x-=(e.shiftKey?e.deltaY:e.deltaX)*unit;state.view.y-=(e.shiftKey?e.deltaX:e.deltaY)*unit;paint();save();}
  },{passive:false});
  viewport.addEventListener('pointerdown',e=>{
    if(e.button!==0&&e.button!==1)return;
    const card=e.target.closest('.scene-card'), handle=e.target.closest('[data-canvas-handle]');
    const interactive=e.target.closest('button,input,textarea,select,a,[contenteditable="true"]');
    const object=handle?.closest('#composer') || (!interactive && card);
    const pan=e.button===1 || hand || space || (!e.target.closest('.scene-card,#composer,.scene-detail,.chapter-heading,.canvas-empty') && !interactive);
    if(!pan&&!object)return;
    e.preventDefault();
    drag={id:e.pointerId,object:pan?null:object,start:{x:e.clientX,y:e.clientY},origin:pan?{...state.view}:{...(state.positions[objectId(object)]||{x:0,y:0})},moved:false};
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('is-dragging');
  });
  viewport.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.id)return;
    const dx=e.clientX-drag.start.x,dy=e.clientY-drag.start.y;
    if(Math.hypot(dx,dy)>4)drag.moved=true;
    if(!drag.moved)return;
    if(drag.object){state.positions[objectId(drag.object)]={x:drag.origin.x+dx/state.view.zoom,y:drag.origin.y+dy/state.view.zoom};position(drag.object);}
    else {state.view.x=drag.origin.x+dx;state.view.y=drag.origin.y+dy;}
    paint();
  });
  function finish(e) {
    if(!drag||e.pointerId!==drag.id)return;
    const completed=drag;drag=null;
    // Capturing the pointer sends a click to the viewport; select stationary cards explicitly.
    if(completed.object && !completed.moved && e.type==='pointerup' && completed.object.matches('.scene-card')) completed.object.click();
    suppressClick=completed.moved;
    if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);
    viewport.classList.remove('is-dragging');save();
    setTimeout(()=>suppressClick=false,0);
  }
  viewport.addEventListener('pointerup',finish);viewport.addEventListener('pointercancel',finish);
  viewport.addEventListener('click',e=>{if(suppressClick){e.stopImmediatePropagation();e.preventDefault();}},true);
  world.addEventListener('keydown',e=>{
    if(editing(e.target)||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
    const obj=e.target.closest('.scene-card,[data-canvas-handle]');if(!obj)return;
    const el=obj.closest('#composer')||obj, id=objectId(el),p=state.positions[id]||{x:0,y:0},step=e.shiftKey?20:5;
    e.preventDefault();e.stopPropagation();
    state.positions[id]={x:p.x+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),y:p.y+(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0)};
    position(el);paint();save();
  });
  document.addEventListener('keydown',e=>{
    if(editing(e.target)||document.querySelector('#workspace').hidden)return;
    if(e.code==='Space'&&!e.target.closest('button,.scene-card')){e.preventDefault();space=true;viewport.classList.add('space-pan');}
    if(e.key.toLowerCase()==='h'&&!e.ctrlKey&&!e.metaKey){onTool('hand');setTool(true);}
  });
  document.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;viewport.classList.remove('space-pan');}});
  window.addEventListener('blur',()=>{space=false;viewport.classList.remove('space-pan');if(drag)finish({pointerId:drag.id,type:'pointercancel'});});
  document.querySelector('#hand-tool').addEventListener('click',()=>{onTool('hand');setTool(true);});
  document.querySelector('#zoom-in').addEventListener('click',()=>zoom(1.2));
  document.querySelector('#zoom-out').addEventListener('click',()=>zoom(1/1.2));
  document.querySelector('#zoom-value').addEventListener('click',()=>{state.view=zoomAt(state.view,{x:viewport.clientWidth/2,y:viewport.clientHeight/2},1);paint();save();});
  document.querySelector('#fit-canvas').addEventListener('click',()=>fit([...world.querySelectorAll('#composer,.scene-card,.chapter-heading,.scene-detail,.canvas-empty')]));
  document.querySelector('#focus-prompt').addEventListener('click',focusPrompt);
  document.querySelector('#reset-layout').addEventListener('click',()=>{state=freshCanvas();refresh();save();notify('Canvas arranged. Story order is unchanged.');});
  new ResizeObserver(()=>paint()).observe(viewport);
  return {load,refresh,setTool,focusPrompt,zoom:()=>state.view.zoom};
}
