import {icon, icons, figure, stage} from './art.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = x => structuredClone(x);
const S = {p:null,projects:[],versions:[],scene:null,detail:null,tab:'workspace',engine:sessionStorage.getItem('storyscene-engine')||'demo',
  refs:[],scope:null,pendingRef:null,lastRef:null,answer:'',busy:false,dirty:false,editSeq:0,saving:null,saveTimer:null,
  pen:false,showOverlays:true,showLinks:false,zoom:100,collapsed:new Set(),textSelection:null,selectedVersion:null,settings:{}};
let toastTimer;

async function api(path, data, method='POST') {
 const opts={method: data===undefined?'GET':method,headers:{'X-Storyscene':'local-app'}};
 if(data instanceof FormData)opts.body=data;
 else if(data!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(data);}
 const response=await fetch('/api'+path,opts);
 const result=await response.json().catch(()=>({detail:'The local server did not return a readable response.'}));
 if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:'The request is invalid. Check the fields and try again.');
 return result;
}
function toast(text,error=false){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').className=error?'error':'';$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,error?10000:4800);}
function saveStatus(text,error=false){$('#save-status').textContent=text;$('#save-status').classList.toggle('error',error);}
function handleError(e){console.error(e);toast(e.message||'Something went wrong. Your previous versions are preserved.',true);}
function listen(selector,event,fn){const node=$(selector);if(node)node.addEventListener(event,async e=>{try{await fn(e);}catch(error){handleError(error);}});}
function documentText(d=S.p.document){return d.blocks.map(b=>b.text).join('\n\n');}
function sceneById(id=S.scene){return S.p.document.scenes.find(s=>s.id===id);}
function currentScene(){return sceneById()||S.p.document.scenes[0];}
function chapter(id){return S.p.document.chapters.find(c=>c.id===id);}
function sourceScene(bid){return S.p.document.scenes.find(s=>s.blockIds.includes(bid));}
function docIds(scope,doc=S.p.document){
 if(!scope)return [];
 if(scope.level==='story')return doc.blocks.map(b=>b.id);
 if(scope.level==='passage')return doc.blocks.some(b=>b.id===scope.id)?[scope.id]:[];
 const field={scene:'id',section:'sectionId',chapter:'chapterId'}[scope.level];
 return [...new Set(doc.scenes.filter(s=>s[field]===scope.id).flatMap(s=>s.blockIds))];
}
function scopeName(scope){
 if(!scope)return 'Choose scope';
 if(scope.level==='story')return 'Whole story';
 if(scope.level==='passage')return 'Selected passage';
 if(scope.level==='scene')return sceneById(scope.id)?.title||'Missing scene';
 if(scope.level==='chapter')return chapter(scope.id)?.title||'Missing chapter';
 return S.p.document.chapters.flatMap(c=>c.sections).find(x=>x.id===scope.id)?.title||'Missing section';
}
function scopeFor(level,scene=currentScene(),bid){
 return {level,id:level==='story'?'story':level==='scene'?scene?.id:level==='section'?scene?.sectionId:level==='chapter'?scene?.chapterId:bid};
}
function refIsValid(r){
 const ids=docIds(r.scope);if(!ids.length)return false;
 const text=S.p.document.blocks.filter(b=>ids.includes(b.id)).map(b=>b.text).join('\n');
 if(r.kind==='character')return text.toLocaleLowerCase().includes(r.label.toLocaleLowerCase());
 if(r.quote)return text.includes(r.quote);
 return true;
}
function setBusy(value,label='Working…'){
 S.busy=value;$('#execute-button').disabled=value;$('#execute-button').innerHTML=value?`<span class="loading-dot">${esc(label)}</span>`:`Execute ${icon('arrow')}`;
 $$('.paragraph').forEach(p=>p.contentEditable=String(!value));
 $$('[data-mode],#import-button,#project-menu,#structure-button,#new-reference,#scope-button').forEach(b=>b.disabled=value);
 $('#request-status').textContent=value?'Processing · manuscript temporarily locked':'Ready when you are';
}
async function withBusy(fn,label){if(S.busy)return;setBusy(true,label);try{return await fn();}finally{setBusy(false);renderComposer();}}
async function updateProject(endpoint,data={},method='POST',rerender=true){
 await flushSave();const result=await api(`/projects/${S.p.id}${endpoint}`,{rev:S.p.rev,...data},method);
 if(result.document){S.p=result;if(rerender)render();}return result;
}
function queueSave(){S.dirty=true;S.editSeq++;saveStatus('Unsaved changes');clearTimeout(S.saveTimer);S.saveTimer=setTimeout(()=>flushSave().catch(handleError),1000);}
async function flushSave(){
 clearTimeout(S.saveTimer);
 if(S.saving)await S.saving;
 if(!S.dirty)return;
 const seq=S.editSeq, doc=clone(S.p.document);
 $$('.paragraph').forEach(el=>{const b=doc.blocks.find(b=>b.id===el.dataset.block);if(b){b.html=el.innerHTML;b.text=el.innerText;}});
 const title=$('#manuscript-title');if(title)doc.title=title.textContent.trim()||'Untitled story';
 saveStatus('Saving…');
 S.saving=(async()=>{try{const p=await api(`/projects/${S.p.id}`,{rev:S.p.rev,document:doc},'PATCH');S.p=p;if(seq===S.editSeq)S.dirty=false;renderHeader();renderFindings();renderRefs();renderBoard();if(S.p.diagnostic?.stale){$$('.text-block[class*="diag-"]').forEach(el=>{el.classList.add("outdated");const label=el.querySelector(".block-label");if(label)label.textContent="Outdated observation";});}requestAnimationFrame(drawInk);saveStatus(S.dirty?'Unsaved changes':'Saved on this device');}catch(e){saveStatus('Save failed · copy your edits',true);throw e;}finally{S.saving=null;}})();
 await S.saving;
 if(S.dirty)await flushSave();
}
async function openProject(id){
 if(S.p)await flushSave();S.p=await api(`/projects/${id}`);localStorage.setItem('storyscene-project',id);
 S.scene=S.p.document.scenes[0]?.id||null;S.detail=null;S.refs=[];S.scope=null;S.pendingRef=null;S.answer='';S.textSelection=null;
 S.tab='workspace';S.collapsed.clear();$('#prompt').value='';await refreshVersions();render();
}
async function refreshVersions(){S.versions=await api(`/projects/${S.p.id}/versions`);}
function render(){
 renderHeader();renderManuscript();renderBoard();renderRefs();renderComposer();renderClarification();renderFindings();renderReview();
 $('#workspace').hidden=S.tab!=='workspace';$('#versions-view').hidden=S.tab!=='versions';$$('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===S.tab));
 icons();requestAnimationFrame(()=>{drawInk();drawLinks();});saveStatus('Saved on this device');
}
function renderHeader(){
 $('#project-menu').innerHTML=esc(S.p.document.title)+icon('chevron');
 $('#version-name').textContent=S.p.pending?'Provisional draft':S.versions.find(v=>v.id===S.p.head)?.name||'Working draft';
 $$('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===S.p.mode);b.disabled=S.busy;});
 $('#mode-explanation').textContent=S.p.mode==='check'?'Check-in observes consequences. Your manuscript stays in your hands.':'Make room for another possibility. Changes stay yours to accept.';
 $('#engine-button').innerHTML=(S.engine==='demo'?'Sample walkthrough':'Hugging Face')+icon('chevron');$('#engine-button').classList.toggle('online',S.engine==='hf');
 $('#word-count').textContent=`${documentText().trim()?documentText().trim().split(/\s+/).length:0} words`;
 $('#scene-count').textContent=S.p.document.scenes.length;
}
function markedHTML(b){
 const template=document.createElement('template');template.innerHTML=b.html;
 const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 const names=S.p.document.characters.filter(c=>c.name?.length).sort((a,b)=>b.name.length-a.name.length);
 if(!names.length)return b.html;
 const rx=new RegExp('('+names.map(c=>c.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi');
 for(const node of nodes){const text=node.textContent;rx.lastIndex=0;if(!rx.test(text))continue;rx.lastIndex=0;const frag=document.createDocumentFragment();let end=0;for(const m of text.matchAll(rx)){
   frag.append(document.createTextNode(text.slice(end,m.index)));const span=document.createElement('span');span.className='entity-mention';span.dataset.entity=names.find(c=>c.name.toLowerCase()===m[0].toLowerCase()).id;span.dataset.name=m[0];span.dataset.sourceBlock=b.id;span.textContent=m[0];span.title='Save a scoped reference';frag.append(span);end=m.index+m[0].length;
 }frag.append(document.createTextNode(text.slice(end)));node.replaceWith(frag);}
 return template.innerHTML;
}
function renderManuscript(){
 S.textSelection=null;
 const doc=S.p.document,selected=sceneById(),before=S.p.pending?.before.document;
 if(!doc.blocks.length){$('#manuscript').innerHTML=`<div class="empty-manuscript">${icon('book')}<h2>A little space for a story.</h2><p>${S.p.mode==='check'?'Bring an existing story to examine its connections.':'Start with a manuscript, or build a new story from an idea.'}</p><button class="primary-button" data-action="import">Import story</button>${S.p.mode==='edit'?'<button class="secondary-button" data-action="create">Create story</button>':''}<button class="quiet-button" data-action="sample">Explore the sample</button></div>`;return;}
 let html=`<h2 class="manuscript-title" id="manuscript-title" contenteditable="true" role="textbox" aria-label="Story title">${esc(doc.title)}</h2><p class="manuscript-subtitle">A story in ${doc.chapters.length||'…'} chapters</p>`;
 const seenChapters=new Set();
 for(const b of doc.blocks){
  const sc=sourceScene(b.id),ch=sc?chapter(sc.chapterId):null;
  if(ch&&!seenChapters.has(ch.id)){seenChapters.add(ch.id);html+=`<p class="chapter-label">Chapter ${doc.chapters.indexOf(ch)+1}</p><h3 class="manuscript-chapter">${esc(ch.title)}</h3>`;}
  let cls='',label='';
  if(S.showOverlays&&selected){if(selected.blockIds.includes(b.id)){cls='selected';label='Scene source';}else if(selected.inheritedBlockIds.includes(b.id)){cls='inherited';label='Inherited context';}else if(selected.impactBlockIds.includes(b.id)){cls='impact';label='Potential impact';}}
  const issue=S.showOverlays&&!diagnosticStale()?S.p.diagnostic?.findings.find(f=>f.blockId===b.id&&!f.dismissed):null;
  if(issue){cls='diag-'+issue.category;label={remove:'Deletion target',change:'Needs attention',continuity:'Continuity at risk'}[issue.category];}
  const changed=before&&before.blocks.find(x=>x.id===b.id)?.text!==b.text;
  html+=`<div class="text-block ${cls} ${changed?'changed':''}" id="block-${esc(b.id)}" data-ink-anchor="block-${esc(b.id)}">${label?`<span class="block-label">${label}</span>`:''}<div class="paragraph" data-block="${esc(b.id)}" contenteditable="${!S.busy}" role="textbox" aria-label="Story passage" aria-multiline="true">${markedHTML(b)}</div></div>`;
 }
 html+=`<button class="dashed-button" id="append-paragraph">+ Write another passage</button>`;
 $('#manuscript').innerHTML=html;
 $$('.paragraph,#manuscript-title').forEach(el=>el.addEventListener('input',queueSave));
 $$('.paragraph').forEach(el=>{
  el.addEventListener('focus',()=>{const s=sourceScene(el.dataset.block);if(s&&S.scene!==s.id){S.scene=s.id;renderBoard();}});
  el.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));});
 });
 $('#append-paragraph')?.addEventListener('click',async()=>{try{await flushSave();const d=clone(S.p.document);d.blocks.push({id:'b_'+crypto.randomUUID(),text:'',html:''});await updateProject('',{document:d},'PATCH');$$('.paragraph').at(-1).focus();}catch(e){handleError(e);}});
}
function renderBoard(){
 const doc=S.p.document;
 if(!doc.scenes.length){$('#story-board').innerHTML=`<div class="canvas-empty">${icon('layers')}<h2>Find the shape of your story.</h2><p>${doc.blocks.length?'Arrange your manuscript into chapters, sections and scenes. The words remain yours.':'Your scenes will appear here once you bring a story to life.'}</p>${doc.blocks.length?'<button class="primary-button" data-action="structure">Structure story</button>':''}${S.p.outline?'<button class="secondary-button" data-action="outline">Review outline</button>':''}</div>`;return;}
 let html=S.p.structureDirty?'<p class="stale-notice">Needs refresh · The text changed. Scene summaries and relationships may be out of date.</p>':'';
 for(let ci=0;ci<doc.chapters.length;ci++){
  const c=doc.chapters[ci],closed=S.collapsed.has(c.id);
  html+=`<section class="chapter-group" data-ink-anchor="chapter-${esc(c.id)}"><div class="chapter-heading"><span class="chapter-number">${String(ci+1).padStart(2,'0')}</span><button data-collapse="${esc(c.id)}" aria-expanded="${!closed}">${esc(c.title)} ${icon('chevron')}</button><button class="chapter-options" data-chapter-ref="${esc(c.id)}" title="Save chapter reference">${icon('pin')}</button></div>`;
  if(!closed)for(const sec of c.sections){
   html+=`<div data-ink-anchor="section-${esc(sec.id)}"><p class="section-label">${esc(sec.title)}</p><div class="scene-grid">`;
   const scenes=doc.scenes.filter(s=>s.sectionId===sec.id);
   scenes.forEach((s,i)=>{const index=doc.scenes.indexOf(s);html+=`<article class="scene-card ${S.scene===s.id?'selected':''}" data-scene="${esc(s.id)}" draggable="true" data-ink-anchor="scene-${esc(s.id)}" tabindex="0" role="button" aria-label="Open scene ${esc(s.title)}"><span class="scene-number">SCENE ${String(index+1).padStart(2,'0')}</span><button class="scene-menu" data-menu-scene="${esc(s.id)}" title="Scene actions" aria-label="Scene actions">···</button><div class="scene-art">${stage(s.art)}<div class="scene-figures">${s.characters.slice(0,3).map(c=>`<button class="figure-button" draggable="true" data-entity="${esc(c.id)}" data-name="${esc(c.name)}" data-source-scene="${esc(s.id)}" aria-label="${esc(c.name)}" title="Select or drag ${esc(c.name)}">${figure(c.name)}</button>`).join('')}</div></div><div class="scene-caption"><h3>${esc(s.title)}</h3><div class="scene-caption-footer">${s.characters.slice(0,3).map(c=>`<span class="character-token ${/lea|léa/i.test(c.name)?'teal':''}">${esc(c.name)}</span>`).join('')}<span class="scene-state">${S.p.structureDirty?'Refresh needed':S.scene===s.id?'Selected':''}</span></div></div>${i<scenes.length-1?'<span class="flow-arrow" aria-hidden="true">→</span>':''}</article>`;});
   html+='</div></div>';
  }
  html+='</section>';
 }
 if(S.detail&&sceneById(S.detail)){const s=sceneById(S.detail);html+=`<section class="scene-detail"><button class="icon-button detail-close" data-action="close-detail" aria-label="Close scene details">${icon('close')}</button><span class="eyebrow">SCENE DETAILS</span><h3>${esc(s.title)}</h3><p><b>Action:</b> ${esc(s.action||'Not described yet')}</p><p><b>Place:</b> ${esc(s.setting||'Not specified')}</p><p>${esc(s.summary)}</p><div class="detail-cast">${s.characters.map(c=>`<button data-remove-character="${esc(c.id)}" data-name="${esc(c.name)}" title="Prepare a removal request">${esc(c.name)} ×</button>`).join('')}</div>${s.characters.map(c=>c.action?`<p><b>${esc(c.name)}:</b> ${esc(c.action)}</p>`:'').join('')}<div class="detail-actions"><button data-action="scene-reference">${icon('pin')}Save reference</button><button data-action="replace-scene">Replace text</button><button data-action="scene-variant">${icon('branch')}Create variant</button><button data-action="add-event">+ Add event</button></div><p class="relations-note">Illustration is a symbolic stage. Dependencies are interpretations to verify.</p></section>`;}
 html+='<svg id="dependencies-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>';
 $('#story-board').innerHTML=html;$('#story-board').style.setProperty('--card-min',Math.round(180*S.zoom/100)+'px');
 icons($('#story-board'));requestAnimationFrame(drawLinks);
}
function renderRefs(){
 $('#reference-count').textContent=S.p.refs.length;
 $('#reference-list').innerHTML=S.p.refs.length?S.p.refs.map(r=>{const valid=refIsValid(r);return `<article class="reference-card ${esc(r.scope.level)} ${valid?'':'stale'}" draggable="${valid}" data-ref="${esc(r.id)}" data-ink-anchor="ref-${esc(r.id)}" tabindex="0"><div class="ref-head"><span class="drag-handle">⠿</span><span class="avatar">${r.kind==='character'?figure(r.label,true):icon(r.kind==='event'?'key':'file')}</span><div><h3>${esc(r.label)}</h3><span class="scope-badge">${esc(r.scope.level)}</span></div></div><p class="reference-context">${esc(scopeName(r.scope))}<br>${valid?'Confirmed selection':'Target changed · select again'}</p><div class="reference-controls"><button data-ref-locate="${esc(r.id)}" title="Show source" aria-label="Show reference source">${icon('eye')}</button><button data-ref-edit="${esc(r.id)}" title="Change scope" aria-label="Change reference scope">${icon('pen')}</button><button data-ref-remove="${esc(r.id)}" title="Remove reference" aria-label="Remove reference">${icon('close')}</button><button data-ref-use="${esc(r.id)}" title="Add to request" aria-label="Add reference to request" ${valid?'':'disabled'}>${icon('arrow')}</button></div></article>`;}).join(''):'<p class="helper">No saved references yet.<br>Try selecting Rose in the first scene.</p>';
 $('#character-tray').innerHTML=`<p class="cast-label">YOUR CHARACTERS · DRAG TO A SCENE</p>${S.p.document.characters.map(c=>`<button class="cast-person" draggable="true" data-entity="${esc(c.id)}" data-name="${esc(c.name)}"><span class="avatar">${figure(c.name,true)}</span><div>${esc(c.name)}<small>${esc(c.role||'Character')}</small></div><span>⠿</span></button>`).join('')}<button class="quiet-button" data-action="add-character">+ Add character</button>`;
}
function renderComposer(){
 const refs=S.refs.map(id=>S.p.refs.find(r=>r.id===id)).filter(Boolean);
 $('#context-chips').innerHTML=refs.map(r=>`<span class="context-chip">${esc(r.label)} · ${esc(r.scope.level)}<button data-chip-remove="${esc(r.id)}" aria-label="Remove from request">×</button></span>`).join('');
 $('#scope-button').innerHTML=(S.scope?esc(scopeName(S.scope)):refs.length?'Scopes from references':'Choose scope')+icon('chevron');
 const unresolved=S.pendingRef||refs.some(r=>!refIsValid(r))||(!S.scope&&!refs.length)||(!$('#prompt').value.trim())||(S.p.clarification&&!S.answer.trim());
 $('#execute-button').disabled=S.busy||!!unresolved||!!S.p.pending||!S.p.document.blocks.length;
 $('#request-status').textContent=S.busy?'Working…':S.p.pending?'Review the provisional revision':S.pendingRef?'Resolve the reference scope':unresolved?'Add an instruction and scope':'Ready to execute';
 $('#composer-note').textContent=S.p.mode==='check'?'Only diagnostics will be generated. The story will not be rewritten.':'References define where edits are allowed. Click Execute when your request is complete.';
}
function renderClarification(){
 const el=$('#clarification');
 if(S.pendingRef){const r=S.pendingRef,sc=sceneById(r.sceneId)||sourceScene(r.blockId)||currentScene();
  el.hidden=false;el.innerHTML=`<button class="clarification-close" data-action="cancel-reference" aria-label="Cancel reference">×</button><strong>What does “${esc(r.label)}” refer to?</strong><p>Keep the element and its scope together. This selection will be saved for reuse.</p><div class="scope-choices">${sc?'<button data-resolve-scope="scene">This scene</button><button data-resolve-scope="section">This section</button><button data-resolve-scope="chapter">This chapter</button>':''}${r.blockId?'<button data-resolve-scope="passage">This passage</button>':''}<button data-resolve-scope="story">Whole story</button></div><div class="scope-choices"><input id="scope-answer" placeholder="Or type: this scene / chapter / whole story" aria-label="Scope clarification answer"><button data-action="scope-answer">Confirm</button></div>`;return;
 }
 if(S.p.clarification){el.hidden=false;el.innerHTML=`<strong>AI needs a little more context.</strong><p>${S.p.clarification.map(esc).join('<br>')}</p><div class="scope-choices"><input id="ai-answer" placeholder="Your clarification…" value="${esc(S.answer)}" aria-label="Answer the AI clarification"><button data-action="clarify-answer">Keep answer</button></div><p>Then click Execute to submit your clarified request.</p>`;return;}
 el.hidden=true;
}
function diagnosticStale(){return !!S.p.diagnostic&&(S.dirty||S.p.diagnostic.stale);}
function renderFindings(){
 const d=S.p.diagnostic,el=$('#findings-panel');el.hidden=!d;if(!d)return;
 // Server attaches an authoritative stale flag to every read/mutation response.
 const stale=d.stale||S.dirty;
 el.innerHTML=`<div class="findings-header"><h2>${icon('eye')} ${d.findings.length} observations</h2><button data-action="recheck">${icon('refresh')}Recheck</button><button data-action="hide-findings" title="Hide observations">×</button></div>${stale?'<p class="stale-notice">The manuscript changed. Recheck before relying on these observations.</p>':''}<p class="findings-coverage">${esc(d.coverage)} ${d.findings.length?'':'No issue detected within this check; this is not a guarantee of coherence.'}</p>${d.findings.map(f=>`<article class="finding ${esc(f.category)} ${f.dismissed?'dismissed':''}" data-finding="${esc(f.id)}"><div><small>${esc(f.severity)} · ${esc(f.category)}${f.uncertain?' · interpretation':''}</small><h3>${esc(sourceScene(f.blockId)?.title||'Manuscript passage')}</h3><p>${esc(f.note)}</p></div><button data-dismiss="${esc(f.id)}" title="Mark as intentional or restore">${f.dismissed?'Restore':'Intentional'}</button></article>`).join('')}${d.recheck&&d.engine==='hf'&&!stale&&d.findings.length&&d.findings.every(f=>f.category==='remove')?'<button class="danger-button" data-action="confirm-deletion">Review exact excerpts to delete</button>':''}`;
}
function renderReview(){
 const pending=S.p.pending,el=$('#review-bar');el.hidden=!pending;if(!pending)return;
 el.innerHTML=`${icon('branch')}<div><strong>Provisional · ${esc(pending.name)}</strong><p>${esc(pending.summary)}</p></div><div class="review-actions"><button class="quiet-button" data-action="review-diff">Compare</button><button class="secondary-button" data-decision="reject">${icon('close')}Reject</button><button class="primary-button" data-decision="accept">${icon('check')}Accept</button></div>`;
}

async function selectScene(id,detail=true){await flushSave();S.scene=id;if(detail)S.detail=id;renderManuscript();renderBoard();renderRefs();renderComposer();const s=sceneById(id);if(s?.blockIds[0])$('#block-'+CSS.escape(s.blockIds[0]))?.scrollIntoView({behavior:'smooth',block:'nearest'});requestAnimationFrame(drawInk);}
function startReference(r){if(S.busy)return;S.pendingRef={...r};S.lastRef=null;renderClarification();renderComposer();$('#clarification').scrollIntoView({block:'nearest'});}
async function resolveReference(level){
 const r=S.pendingRef;if(!r)return;const sc=sceneById(r.sceneId)||sourceScene(r.blockId)||currentScene(),scope=scopeFor(level,sc,r.blockId);
 if(!docIds(scope).length){toast('This scope has no text yet.',true);return;}
 const reference={id:r.id,label:r.label,kind:r.kind||'selection',entityId:r.entityId||r.blockId||r.sceneId,quote:r.quote||null,scope,sceneId:sc?.id,confirmed:true};
 await updateProject('/references',{reference},'POST',false);
 const saved=S.p.refs.find(x=>x.label===r.label&&x.scope.level===level&&x.scope.id===scope.id);
 S.pendingRef=null;S.lastRef=saved?.id;renderRefs();renderClarification();if(r.use&&saved)useReference(saved.id);renderComposer();
 toast(`Saved ${r.label} · ${level}. Drag it into your next request.`);
}
function useReference(id){const r=S.p.refs.find(r=>r.id===id);if(!r||!refIsValid(r)){toast('This reference needs a new selection before reuse.',true);return;}if(!S.refs.includes(id))S.refs.push(id);S.lastRef=id;renderComposer();$('#prompt').focus();}
function captureSelection(){
 const sel=window.getSelection();if(!sel||sel.isCollapsed)return;
 const node=sel.anchorNode?.nodeType===Node.ELEMENT_NODE?sel.anchorNode:sel.anchorNode?.parentElement;
 const para=node?.closest('.paragraph');if(!para)return;
 const end=sel.focusNode?.nodeType===Node.ELEMENT_NODE?sel.focusNode:sel.focusNode?.parentElement;
 if(!end?.closest('.paragraph')||end.closest('.paragraph')!==para)return;
 S.textSelection={text:sel.toString(),blockId:para.dataset.block,range:sel.getRangeAt(0).cloneRange()};
}
function referenceSelectedText(){
 captureSelection();const sel=S.textSelection;if(!sel?.text.trim()){toast('Select a passage in the manuscript first.');return;}
 const char=S.p.document.characters.find(c=>c.name.toLowerCase()===sel.text.trim().toLowerCase());
 startReference({label:char?.name||sel.text.trim().slice(0,55),quote:char?null:sel.text,kind:char?'character':'passage',entityId:char?.id,blockId:sel.blockId,use:true});
}
function modal(html){$('#dialog-content').innerHTML=html;icons($('#dialog'));$('#dialog').showModal();}
function closeModal(){$('#dialog').close();}
function errorInDialog(e){let el=$('#dialog-content .field-error');if(!el){el=document.createElement('p');el.className='field-error';$('#dialog-content').append(el);}el.textContent=e.message;}
function dialogAction(selector,fn){$(selector)?.addEventListener('click',async e=>{e.preventDefault();if(e.currentTarget.disabled)return;const b=e.currentTarget;b.disabled=true;try{await fn();}catch(error){errorInDialog(error);}finally{b.disabled=false;}});}
function heading(kicker,title,description=''){return `<span class="eyebrow">${esc(kicker)}</span><h1>${esc(title)}</h1>${description?`<p class="description">${esc(description)}</p>`:''}`;}

function importDialog(){
 if(S.p.pending){toast('Accept or reject the provisional revision first.',true);return;}
 modal(heading('BRING YOUR WORDS','Import a story','Your file is read locally. Text PDFs, Word documents and UTF-8 text files are supported.')+`<label for="import-title">Story title</label><input id="import-title" value="Untitled story"><label for="import-file">Choose a document</label><input type="file" id="import-file" accept=".pdf,.docx,.txt"><p class="dialog-note" id="extract-note">PDFs must contain selectable text. Original document formatting is not imported.</p><label for="import-text">Or paste your story</label><textarea id="import-text" rows="9" placeholder="Once upon a time…"></textarea><p class="dialog-note">A snapshot of the current project is kept in Versions. Importing starts a new manuscript in this project.</p><div class="dialog-actions"><button class="secondary-button" value="cancel">Cancel</button><button type="button" class="primary-button" id="confirm-import">Import story</button></div>`);
 $('#import-file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;$('#confirm-import').disabled=true;$('#extract-note').textContent='Reading the document locally…';try{const fd=new FormData();fd.append('file',f);const result=await api('/extract',fd);$('#import-text').value=result.text;$('#import-title').value=result.title;$('#extract-note').textContent=result.note;}catch(error){errorInDialog(error);}finally{$('#confirm-import').disabled=false;}});
 dialogAction('#confirm-import',async()=>{const text=$('#import-text').value,title=$('#import-title').value;await updateProject('/import',{text,title});closeModal();await refreshVersions();render();structureDialog();});
}
function structureDialog(){
 const n=S.p.document.blocks.length;
 if(!n){toast('Import a story first.');return;}
 modal(heading('CHAPTERS → SECTIONS → SCENES','Give your story a shape','AI structure interprets the story. Local grouping simply distributes the text passages without changing them.')+`<label for="structure-engine">Structure method</label><select id="structure-engine"><option value="hf" ${S.settings.configured?'selected':''}>AI structure · Hugging Face</option><option value="local" ${!S.settings.configured?'selected':''}>Local grouping · no AI</option></select><label for="structure-counts">Who chooses the counts?</label><select id="structure-counts"><option value="auto">Automatic</option><option value="custom">I will choose</option></select><div class="dialog-inline" id="custom-counts" hidden><div><label for="chapter-count">Chapters</label><input id="chapter-count" type="number" min="1" max="30" value="${Math.min(2,n)}"></div><div><label for="section-count">Sections per chapter</label><input id="section-count" type="number" min="1" max="10" value="1"></div><div><label for="scenes-count">Total scenes</label><input id="scenes-count" type="number" min="1" max="${n}" value="${Math.min(10,n)}"></div></div><p class="dialog-note">${n} source passages available. Each scene uses at least one whole passage. Scene summaries and relationships are refreshed; prose is preserved.</p><div class="dialog-actions"><button class="secondary-button" value="cancel">Cancel</button><button type="button" class="primary-button" id="build-structure">Build structure</button></div>`);
 $('#structure-counts').onchange=e=>$('#custom-counts').hidden=e.target.value!=='custom';
 dialogAction('#build-structure',async()=>{const engine=$('#structure-engine').value;const custom=$('#structure-counts').value==='custom'?{chapters:+$('#chapter-count').value,sections:+$('#section-count').value,scenes:+$('#scenes-count').value}:null;await withBusy(()=>updateProject('/structure',{engine,custom}),'Structuring');S.scene=S.p.document.scenes[0]?.id;await refreshVersions();closeModal();render();toast('Your story structure is ready.');});
}
function settingsDialog(){
 modal(heading('YOUR AI CONNECTION','Hugging Face','Storyscene runs locally. When you execute an AI request, the story context is sent to your selected hosted model through Hugging Face.')+`<label for="ai-engine">Request engine</label><select id="ai-engine"><option value="demo" ${S.engine==='demo'?'selected':''}>Sample walkthrough · no model calls</option><option value="hf" ${S.engine==='hf'?'selected':''}>Hugging Face · online inference</option></select><label for="hf-model">Hosted model ID</label><input id="hf-model" placeholder="organization/model:provider" value="${esc(S.settings.model||'')}" autocomplete="off"><p class="dialog-note">Choose a model currently offered by an Inference Provider. Uploading a model to the Hub alone does not make it available for inference.</p><label for="hf-token">Hugging Face token ${S.settings.hasToken?'· already set':''}</label><input id="hf-token" type="password" placeholder="hf_…" autocomplete="new-password"><p class="dialog-note">Needs Inference Providers permission. The token stays in server memory and is never saved in project files or exports. You can also set HF_TOKEN and HF_MODEL before starting the app.</p><p class="dialog-note">Prototype context limit: 60,000 characters per AI request, including structure. Larger requests are rejected without truncation.</p><div class="dialog-actions"><button type="button" class="quiet-button" id="forget-token">Forget token</button><button type="button" class="primary-button" id="save-settings">Save settings</button></div>`);
 dialogAction('#save-settings',async()=>{const engine=$('#ai-engine').value,token=$('#hf-token').value,model=$('#hf-model').value;S.settings=await api('/settings',{token,model});if(engine==='hf'&&!S.settings.configured)throw new Error('Set both a model ID and token to enable Hugging Face.');S.engine=engine;sessionStorage.setItem('storyscene-engine',engine);closeModal();renderHeader();toast(engine==='hf'?'Configured. The next request will use Hugging Face.':'Sample walkthrough selected. No model calls will be made.');});
 dialogAction('#forget-token',async()=>{S.settings=await api('/settings',{clearToken:true});S.engine='demo';sessionStorage.setItem('storyscene-engine','demo');closeModal();renderHeader();toast('Token removed from server memory.');});
}
async function projectDialog(){
 S.projects=await api('/projects');modal(heading('YOUR WRITING DESK','Stories on this device')+`<div class="project-list">${S.projects.map(p=>`<button type="button" data-open-project="${esc(p.id)}"><span>${esc(p.title)}</span><small>${new Date(p.updated).toLocaleDateString()}</small></button>`).join('')}</div><div class="dialog-options"><button type="button" class="option-card" id="new-empty">${icon('file')}<h3>A fresh page</h3><p>Import a manuscript or create a new story from an approved outline.</p></button><button type="button" class="option-card" id="new-sample">${icon('book')}<h3>The Midnight Archive</h3><p>Explore six illustrated scenes and Rose's role in the story.</p></button></div>`);
 $$('[data-open-project]').forEach(b=>b.onclick=async()=>{closeModal();await openProject(b.dataset.openProject);});
 for(const [selector,demo]of [['#new-empty',false],['#new-sample',true]])dialogAction(selector,async()=>{await flushSave();const p=await api('/projects',{demo,mode:'edit'});closeModal();await openProject(p.id);});
}
function exportDialog(){modal(heading('TAKE YOUR WORK WITH YOU','Export your story','The project backup includes all versions, references and annotations. It never includes your API token.')+`<div class="dialog-options"><a class="option-card" href="/api/projects/${S.p.id}/export" download><h3>Manuscript</h3><p>Plain text · .txt</p></a><a class="option-card" href="/api/projects/${S.p.id}/export?format=json" download><h3>Project backup</h3><p>Story and full version history · .json</p></a></div><label for="restore-backup">Restore a Storyscene backup as a new project</label><input id="restore-backup" type="file" accept=".json"><p class="dialog-note">Your existing projects are preserved.</p>`);$('#restore-backup').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const data=JSON.parse(await file.text());const p=await api('/restore-backup',data);closeModal();await openProject(p.id);toast('Project backup restored.');}catch(error){errorInDialog(error);}};}
function scopeDialog(){
 const doc=S.p.document;
 modal(heading('MAKE THE SCOPE VISIBLE','Where should this request apply?','This is the write boundary. AI may read other passages to report consequences, but may not rewrite them.')+`<label for="scope-select">Scope</label><select id="scope-select"><option value="story|story">Whole story</option>${doc.chapters.map(c=>`<optgroup label="${esc(c.title)}"><option value="chapter|${esc(c.id)}">Chapter: ${esc(c.title)}</option>${c.sections.map(s=>`<option value="section|${esc(s.id)}">Section: ${esc(s.title)}</option>`).join('')}${doc.scenes.filter(s=>s.chapterId===c.id).map(s=>`<option value="scene|${esc(s.id)}">Scene: ${esc(s.title)}</option>`).join('')}</optgroup>`).join('')}</select><p class="dialog-note">When saved references are also included, their scopes are added to the permitted area.</p><div class="dialog-actions"><button type="button" class="primary-button" id="set-scope">Use this scope</button></div>`);
 if(S.scope)$('#scope-select').value=S.scope.level+'|'+S.scope.id;else if(S.scene)$('#scope-select').value='scene|'+S.scene;
 dialogAction('#set-scope',async()=>{const [level,id]=$('#scope-select').value.split('|');S.scope={level,id};closeModal();renderComposer();});
}
async function execute(recheck=false,checkedScopes=null){
 if(S.pendingRef)throw new Error('Resolve the scope of the selection first.');
 await flushSave();const refs=S.refs.map(id=>S.p.refs.find(r=>r.id===id)).filter(Boolean);
 if(refs.some(r=>!refIsValid(r)))throw new Error('One reference has changed. Reselect it before executing.');
 const prompt=$('#prompt').value.trim(),scopes=checkedScopes||[...refs.map(r=>r.scope),...(S.scope?[S.scope]:[])];
 if(!scopes.length){scopeDialog();return;}
 if(S.p.clarification&&!S.answer.trim())throw new Error('Answer the AI question before executing again.');
 await withBusy(async()=>{await updateProject('/execute',{prompt,scopes,references:refs,mode:S.p.mode,engine:S.engine,answer:S.answer,recheck});if(S.p.pending)toast('Provisional revision ready. Compare, accept or reject it.');else if(S.p.diagnostic)toast('Check complete. The story text is unchanged.');},S.p.mode==='check'?'Checking':'Revising');
}
async function review(decision){await updateProject('/review',{decision});await refreshVersions();render();toast(decision==='accept'?'Revision accepted. Earlier versions remain available.':'Previous manuscript restored. The unaccepted draft remains in Versions.');}
function diffHTML(before,after){
 let html='';const previous=new Map(before.blocks.map(b=>[b.id,b]));const next=new Map(after.blocks.map(b=>[b.id,b]));
 for(const b of before.blocks){const n=next.get(b.id);if(!n||n.text!==b.text)html+=`<div class="diff-title">Previous passage</div><div class="diff-item removed">${esc(b.text)}</div>${n?`<div class="diff-title">New passage</div><div class="diff-item added">${esc(n.text)}</div>`:''}`;}
 for(const b of after.blocks)if(!previous.has(b.id))html+=`<div class="diff-title">Added passage</div><div class="diff-item added">${esc(b.text)}</div>`;
 return html||'<p class="dialog-note">No prose differences. Structure, metadata or references may differ.</p>';
}
function reviewDiff(){const p=S.p.pending;if(!p)return;modal(heading('BEFORE YOU DECIDE',p.name,p.summary)+`<div class="diff-scroll">${diffHTML(p.before.document,S.p.document)}</div>${p.impacts?.length?`<h2>Outside-scope observations</h2>${p.impacts.map(i=>`<p class="dialog-note">${esc(i.note)}</p>`).join('')}`:''}<div class="dialog-actions"><button type="button" class="secondary-button" id="diff-reject">Reject</button><button type="button" class="primary-button" id="diff-accept">Accept</button></div>`);dialogAction('#diff-reject',async()=>{closeModal();await review('reject');});dialogAction('#diff-accept',async()=>{closeModal();await review('accept');});}
function replaceSceneDialog(){const sc=currentScene();if(!sc)return;if(S.p.mode!=='edit'){toast('In Check-in, edit the manuscript directly. Exact scene replacement is an Edit action.');return;}const text=S.p.document.blocks.filter(b=>sc.blockIds.includes(b.id)).map(b=>b.text).join('\n\n');modal(heading('YOUR OWN WORDS',`Replace “${sc.title}”`,'This is an exact replacement, not a prompt. Review the provisional result before keeping it.')+`<textarea id="replacement-text" rows="10">${esc(text)}</textarea><div class="dialog-actions"><button type="button" class="primary-button" id="apply-replacement">Preview replacement</button></div>`);dialogAction('#apply-replacement',async()=>{await updateProject('/replace-scene',{sceneId:sc.id,text:$('#replacement-text').value});closeModal();reviewDiff();});}
function sceneActionsDialog(id=S.scene){
 const sc=sceneById(id);if(!sc)return;S.scene=id;S.detail=id;
 modal(heading('DIRECT MANIPULATION',sc.title,'Drag a scene onto another scene to move it after that scene. These controls offer the same operation without dragging.')+`<div class="dialog-options"><button type="button" class="option-card" id="scene-replace-action"><h3>Replace text</h3><p>Write an exact replacement for this scene.</p></button><button type="button" class="option-card" id="scene-add-action"><h3>Add a scene</h3><p>Insert your own scene after this one.</p></button></div><label for="scene-target">Move relative to</label><select id="scene-target">${S.p.document.scenes.filter(s=>s.id!==id).map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}</select><div class="dialog-actions"><button type="button" class="danger-button" id="scene-delete-action">Remove scene</button><button type="button" class="secondary-button" id="scene-move-before">Move before</button><button type="button" class="primary-button" id="scene-move-after">Move after</button></div><p class="dialog-note">In Edit, operations produce a provisional revision. In Check-in, they only prepare a diagnostic request.</p>`);
 $('#scene-replace-action').onclick=()=>{closeModal();replaceSceneDialog();};$('#scene-add-action').onclick=()=>{closeModal();addSceneDialog();};
 dialogAction('#scene-delete-action',async()=>{closeModal();await sceneOperation({action:'delete',sceneId:id});});
 for(const position of ['before','after'])dialogAction('#scene-move-'+position,async()=>{const targetId=$('#scene-target').value;closeModal();await sceneOperation({action:'move',sceneId:id,targetId,position});});
}
async function sceneOperation(data){
 const sc=sceneById(data.sceneId);
 if(S.p.mode==='check'){
  S.scope=scopeFor('scene',sc);const target=sceneById(data.targetId);
  $('#prompt').value=data.action==='delete'?`Remove the scene “${sc.title}”.`:`Move “${sc.title}” ${data.position||'after'} “${target?.title}”.`;
  renderComposer();toast('Hypothetical change prepared. Execute to inspect consequences.');return;
 }
 await updateProject('/scene-operation',data);S.scene=S.p.document.scenes.some(s=>s.id===data.sceneId)?data.sceneId:S.p.document.scenes[0]?.id;render();reviewDiff();
}
function addSceneDialog(){
 const sc=currentScene();if(!sc)return;
 if(S.p.mode!=='edit'){S.scope=scopeFor('scene',sc);$('#prompt').value=`Consider inserting a scene after “${sc.title}”: `;renderComposer();toast('Describe the hypothetical scene, then Execute to check consequences.');return;}
 modal(heading('ANOTHER MOMENT','Add a scene',`Your scene will be inserted after “${sc.title}”.`)+`<label for="new-scene-title">Scene title</label><input id="new-scene-title" placeholder="A new discovery"><label for="new-scene-text">Scene text</label><textarea id="new-scene-text" rows="6" placeholder="Write the scene in your own words…"></textarea><label for="new-scene-chapter">New chapter title (optional)</label><input id="new-scene-chapter" placeholder="Leave blank to use the current chapter"><div class="dialog-actions"><button type="button" class="primary-button" id="insert-scene">Preview new scene</button></div>`);
 dialogAction('#insert-scene',async()=>{const data={action:'add',sceneId:sc.id,title:$('#new-scene-title').value,text:$('#new-scene-text').value,newChapter:$('#new-scene-chapter').value};await updateProject('/scene-operation',data);closeModal();reviewDiff();});
}
function deletionDialog(){const d=S.p.diagnostic;if(!d)return;modal(heading('CHECK-IN · EXACT DELETION','Review the precise excerpts','This recheck found no other remaining issues in the submitted text. That is not a guarantee of coherence. Only checked excerpts will be removed; no prose will be added.')+`<div class="diff-scroll">${d.findings.filter(f=>f.category==='remove').map(f=>`<label style="display:flex;gap:10px"><input type="checkbox" data-delete-id="${esc(f.id)}" checked style="width:auto"><span>${esc(f.quote)}</span></label>`).join('')}</div><div class="dialog-actions"><button type="button" class="danger-button" id="apply-deletion">Preview exact deletion</button></div>`);dialogAction('#apply-deletion',async()=>{await updateProject('/deletion-preview',{ids:$$('[data-delete-id]:checked').map(x=>x.dataset.deleteId)});closeModal();reviewDiff();});}

function createStoryDialog(){
 if(S.p.mode!=='edit'){toast('Switch to Edit to create a story.');return;}
 if(S.p.document.blocks.length){toast('Create a fresh project first.');return;}
 if(S.p.outline){outlineDialog();return;}
 modal(heading('START WITH A POSSIBILITY','What story would you like to tell?','The AI proposes characters and a chapter plan first. No prose is written until you approve it.')+`<textarea id="creation-prompt" rows="5" placeholder="A young archivist discovers that every lost letter changes a memory…"></textarea><label for="creation-counts">Structure</label><select id="creation-counts"><option value="auto">Let AI propose a structure</option><option value="custom">Choose chapter and scene counts</option></select><div id="creation-custom" class="dialog-inline" hidden><div><label for="creation-chapters">Chapters</label><input type="number" id="creation-chapters" min="1" max="10" value="3"></div><div><label for="creation-scenes">Scenes in total</label><input type="number" id="creation-scenes" min="1" max="30" value="9"></div></div><p class="dialog-note">Requires Hugging Face settings. The sample walkthrough cannot generate a new story.</p><div class="dialog-actions"><button type="button" class="primary-button" id="generate-outline">Generate outline</button></div>`);
 $('#creation-counts').onchange=e=>$('#creation-custom').hidden=e.target.value!=='custom';
 dialogAction('#generate-outline',async()=>{if(!$('#creation-prompt').value.trim())throw new Error('Describe your story first.');const custom=$('#creation-counts').value==='custom'?{chapters:+$('#creation-chapters').value,scenes:+$('#creation-scenes').value}:null;await withBusy(()=>updateProject('/outline',{prompt:$('#creation-prompt').value,custom}),'Planning');closeModal();outlineDialog();});
}
function outlineDialog(){
 const outline=clone(S.p.outline?.content);if(!outline)return createStoryDialog();
 function draw(){modal(heading('A PLAN YOU CAN CHANGE','Review your story outline','Edit titles, characters and scene premises. Approving this plan does not start drafting.')+`<label for="outline-title">Title</label><input id="outline-title" value="${esc(outline.title)}"><div class="outline-editor"><label>Characters</label>${outline.characters.map((c,i)=>`<div class="outline-character"><input data-outline-char="${i}" value="${esc(c.name)}" aria-label="Character name"><input data-outline-role="${i}" value="${esc(c.role)}" aria-label="Character role"><button type="button" data-outline-delete-char="${i}" aria-label="Remove character">×</button></div>`).join('')}<button type="button" class="quiet-button" id="outline-add-character">+ Add character</button>${outline.chapters.map((c,i)=>`<div class="outline-chapter"><div style="display:flex;gap:6px"><input data-outline-chapter="${i}" value="${esc(c.title)}" aria-label="Chapter title"><button type="button" data-outline-delete-chapter="${i}" aria-label="Remove chapter">×</button></div><textarea data-outline-summary="${i}" rows="2" aria-label="Chapter summary">${esc(c.summary)}</textarea>${(c.scenes||[]).map((s,j)=>`<div class="outline-scene"><input data-outline-scene-title="${i},${j}" value="${esc(s.title)}" aria-label="Scene title"><textarea data-outline-scene-summary="${i},${j}" rows="2" aria-label="Scene premise">${esc(s.summary)}</textarea><button type="button" data-outline-delete-scene="${i},${j}" aria-label="Remove scene">×</button></div>`).join('')}<button type="button" class="quiet-button" data-outline-add-scene="${i}">+ Add scene</button></div>`).join('')}<button type="button" class="quiet-button" id="outline-add-chapter">+ Add chapter</button></div><div class="dialog-actions"><button type="button" class="secondary-button" id="approve-plan">Approve outline</button><button type="button" class="primary-button" id="draft-story" ${S.p.outline.approved?'':'disabled'}>Draft story</button></div><p class="dialog-note" id="outline-state">${S.p.outline.approved?'Outline approved. Click Draft story when ready.':'Review and approve before drafting.'}</p>`);bind();}
 function collect(){outline.title=$('#outline-title').value;$$('[data-outline-char]').forEach(x=>outline.characters[+x.dataset.outlineChar].name=x.value);$$('[data-outline-role]').forEach(x=>outline.characters[+x.dataset.outlineRole].role=x.value);$$('[data-outline-chapter]').forEach(x=>outline.chapters[+x.dataset.outlineChapter].title=x.value);$$('[data-outline-summary]').forEach(x=>outline.chapters[+x.dataset.outlineSummary].summary=x.value);for(const key of ['Title','Summary'])$$(`[data-outline-scene-${key.toLowerCase()}]`).forEach(x=>{const [i,j]=x.dataset['outlineScene'+key].split(',').map(Number);outline.chapters[i].scenes[j][key.toLowerCase()]=x.value;});}
 function invalidated(){S.p.outline.approved=false;$('#draft-story').disabled=true;$('#outline-state').textContent='Plan edited. Approve these changes before drafting.';}
 function bind(){
  $$('#dialog-content input,#dialog-content textarea').forEach(x=>x.oninput=invalidated);
  dialogAction('#approve-plan',async()=>{collect();await updateProject('/approve-outline',{outline});$('#draft-story').disabled=false;$('#outline-state').textContent='Outline approved. Click Draft story when ready.';});
  dialogAction('#draft-story',async()=>{await withBusy(()=>updateProject('/draft',{}),'Drafting');closeModal();S.scene=S.p.document.scenes[0]?.id;render();toast('First draft ready for review.');});
  function edit(fn){collect();fn();S.p.outline.approved=false;closeModal();draw();}
  $('#outline-add-character').onclick=()=>edit(()=>outline.characters.push({name:'New character',role:''}));
  $('#outline-add-chapter').onclick=()=>edit(()=>outline.chapters.push({title:'New chapter',summary:'',scenes:[{title:'New scene',summary:''}]}));
  $$('[data-outline-delete-char]').forEach(b=>b.onclick=()=>edit(()=>outline.characters.splice(+b.dataset.outlineDeleteChar,1)));
  $$('[data-outline-delete-chapter]').forEach(b=>b.onclick=()=>edit(()=>outline.chapters.splice(+b.dataset.outlineDeleteChapter,1)));
  $$('[data-outline-add-scene]').forEach(b=>b.onclick=()=>edit(()=>outline.chapters[+b.dataset.outlineAddScene].scenes.push({title:'New scene',summary:''})));
  $$('[data-outline-delete-scene]').forEach(b=>b.onclick=()=>edit(()=>{const[i,j]=b.dataset.outlineDeleteScene.split(',').map(Number);outline.chapters[i].scenes.splice(j,1);}));
 }
 draw();
}

async function versionsView(){await flushSave();await refreshVersions();S.tab='versions';S.selectedVersion=S.p.head;render();renderVersionGraph();await showVersion(S.selectedVersion);}
function renderVersionGraph(){
 const depth=new Map();S.versions.forEach(v=>depth.set(v.id,v.parent?(depth.get(v.parent)||0)+1:0));
 $('#version-graph').innerHTML=S.versions.map(v=>`<article tabindex="0" role="button" class="version-node ${v.id===S.p.head?'active':''} ${v.id===S.selectedVersion?'selected':''}" data-version="${esc(v.id)}" style="margin-left:${Math.min(depth.get(v.id),5)*22}px">${icon(v.kind==='branch'?'branch':'file')}<div><h3>${esc(v.name)}</h3><p>${new Date(v.created).toLocaleString()} · ${esc(v.kind)}${v.point?' · From '+esc(v.point.label||v.point.level||'selection'):''}</p></div>${v.id===S.p.head?'<small>Current</small>':''}</article>`).join('');
 requestAnimationFrame(drawVersionLinks);
}
function drawVersionLinks(){
 const root=$('#version-graph'),rect=root.getBoundingClientRect();if(!rect.width)return;
 let paths='';
 for(const v of S.versions){if(!v.parent)continue;const child=root.querySelector('[data-version=\"'+CSS.escape(v.id)+'\"]'),parent=root.querySelector('[data-version=\"'+CSS.escape(v.parent)+'\"]');if(!child||!parent)continue;const a=parent.getBoundingClientRect(),b=child.getBoundingClientRect();const x1=a.left-rect.left,y1=a.top-rect.top+a.height/2,x2=b.left-rect.left,y2=b.top-rect.top+b.height/2;const lane=Math.max(2,Math.min(x1,x2)-12);paths+='<path d=\"M'+x1+','+y1+' C'+lane+','+y1+' '+lane+','+y2+' '+x2+','+y2+'\"/>'; }
 root.querySelector('svg.version-edges')?.remove();root.insertAdjacentHTML('afterbegin','<svg class=\"version-edges\" width=\"'+root.clientWidth+'\" height=\"'+root.scrollHeight+'\" aria-hidden=\"true\">'+paths+'</svg>');
}
async function showVersion(id){
 S.selectedVersion=id;renderVersionGraph();const v=await api(`/projects/${S.p.id}/versions/${id}`);if(S.selectedVersion!==id)return;
 const parent=S.versions.find(x=>x.id===v.parent);
 $('#version-detail').innerHTML=`<span class="eyebrow">SELECTED VERSION</span><h2>${esc(v.name)}</h2><p>${esc(v.snapshot.document.title)}<br>${v.snapshot.document.scenes.length} scenes · ${v.snapshot.document.blocks.length} passages<br>${parent?'Continues from '+esc(parent.name):'Original manuscript'}</p><div class="version-actions"><button class="primary-button" id="branch-version">${icon('branch')}Create variant</button><button class="secondary-button" id="restore-version">Restore</button><button class="quiet-button" id="rename-version">Rename</button></div><p>Compared with your current manuscript:</p><div class="diff-scroll">${diffHTML(S.p.document,v.snapshot.document)}</div>`;
 $('#branch-version').onclick=()=>variantDialog(v.id);$('#restore-version').onclick=async()=>{try{await updateProject(`/versions/${v.id}`,{action:'restore'});await refreshVersions();S.tab='workspace';S.scene=S.p.document.scenes[0]?.id;render();toast('Restored as a new continuation. Other versions are preserved.');}catch(e){handleError(e);}};
 $('#rename-version').onclick=()=>{modal(heading('A RECOGNIZABLE NAME','Rename this version')+`<input id="version-new-name" value="${esc(v.name)}" aria-label="Version name"><div class="dialog-actions"><button type="button" class="primary-button" id="rename-confirm">Save name</button></div>`);dialogAction('#rename-confirm',async()=>{await api(`/projects/${S.p.id}/versions/${v.id}`,{action:'rename',name:$('#version-new-name').value});closeModal();await refreshVersions();await showVersion(v.id);});};
}
async function variantDialog(versionId=S.p.head,point=null){
 if(S.p.pending){toast('Accept or reject the provisional revision before branching.');return;}
 const base=versionId===S.p.head?S.p.document:(await api(`/projects/${S.p.id}/versions/${versionId}`)).snapshot.document;
 modal(heading('EXPLORE ANOTHER DIRECTION','Create a variant','A complete copy of this version is kept. The selected point defines where your next exploration begins.')+`<label for="variant-name">Version name</label><input id="variant-name" value="${esc(point?.label?'Another path · '+point.label:'Another path')}"><label for="variant-point">Starting point</label><select id="variant-point"><option value="story|story">Whole story</option>${base.chapters.map(c=>`<option value="chapter|${esc(c.id)}">Chapter · ${esc(c.title)}</option>`).join('')}${base.chapters.flatMap(c=>c.sections).map(s=>`<option value="section|${esc(s.id)}">Section · ${esc(s.title)}</option>`).join('')}${base.scenes.map(s=>`<option value="scene|${esc(s.id)}">Scene · ${esc(s.title)}</option>`).join('')}</select><div class="dialog-actions"><button type="button" class="primary-button" id="confirm-variant">Create variant</button></div>`);
 if(point)$('#variant-point').value=point.level+'|'+point.id;
 dialogAction('#confirm-variant',async()=>{const[level,id]=$('#variant-point').value.split('|');const pt={level,id,label:$('#variant-point').selectedOptions[0].textContent};await updateProject(`/versions/${versionId}`,{action:'branch',name:$('#variant-name').value,point:pt});await refreshVersions();S.tab='workspace';S.scope=pt;S.scene=level==='scene'?id:S.p.document.scenes[0]?.id;S.refs=[];S.detail=null;closeModal();render();toast('A new path is ready. Earlier versions are unchanged.');});
}
function drawLinks(){
 const svg=$('#dependencies-svg');if(!svg)return;svg.innerHTML='';if(!S.showLinks||!S.scene)return;
 const sc=sceneById();if(!sc)return;const root=$('#story-board').getBoundingClientRect(),source=$(`[data-scene="${CSS.escape(sc.id)}"]`);if(!source)return;
 const a=source.getBoundingClientRect();const x=a.left-root.left+a.width/2,y=a.top-root.top+a.height/2;
 const edges=[...sc.inheritedBlockIds.map(id=>[id,'#a28bb8',true]),...sc.impactBlockIds.map(id=>[id,'#c0a46c',false])];
 svg.innerHTML=`<defs><marker id="arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10" fill="#b2a382"/></marker></defs>`;
 const seen=new Set();for(const[bid,color,reverse]of edges){const other=sourceScene(bid);if(!other||other.id===sc.id||seen.has(other.id))continue;seen.add(other.id);const target=$(`[data-scene="${CSS.escape(other.id)}"]`);if(!target)continue;const b=target.getBoundingClientRect(),xx=b.left-root.left+b.width/2,yy=b.top-root.top+5;const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',reverse?`M${xx},${yy} C${xx+70},${yy-30} ${x+70},${y-50} ${x},${y}`:`M${x},${y} C${x+70},${y+30} ${xx+70},${yy-40} ${xx},${yy}`);path.setAttribute('fill','none');path.setAttribute('stroke',color);path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-dasharray','4 4');path.setAttribute('marker-end','url(#arrow-end)');svg.append(path);}
}

// Freehand recognition is deliberately bounded: closed loops and a line ending in the composer.
let stroke=null;
function setPen(value){S.pen=value;$('#workspace').classList.toggle('pen-active',value);$('#pen-tool').classList.toggle('active',value);$('#select-tool').classList.toggle('active',!value);if(value)toast('Circle a character or passage. Then draw a line to the prompt to reuse its confirmed reference.');}
function anchorAt(x,y){return document.elementsFromPoint(x,y).find(e=>e.matches('[data-ink-anchor]'))||document.elementsFromPoint(x,y).map(e=>e.closest('[data-ink-anchor]')).find(Boolean);}
function drawInk(){
 const root=$('#workspace').getBoundingClientRect(),svg=$('#ink-layer');let html='';
 for(const a of S.p?.annotations||[]){const anchor=a.anchor?$(`[data-ink-anchor="${CSS.escape(a.anchor)}"]`):$('#workspace');if(!anchor)continue;const r=anchor.getBoundingClientRect();if(r.width===0||r.height===0)continue;const points=a.points.map(p=>`${r.left-root.left+p[0]*r.width},${r.top-root.top+p[1]*r.height}`).join(' ');html+=`<polyline class="ink-stroke" points="${points}"/>`;}
 svg.innerHTML=html;
 if(stroke){const poly=document.createElementNS('http://www.w3.org/2000/svg','polyline');poly.classList.add('ink-stroke');poly.setAttribute('points',stroke.points.map(p=>`${p.x-root.left},${p.y-root.top}`).join(' '));svg.append(poly);}
}
$('#ink-layer').addEventListener('pointerdown',e=>{if(!S.pen||S.busy)return;e.preventDefault();stroke={points:[{x:e.clientX,y:e.clientY}],anchor:anchorAt(e.clientX,e.clientY)};e.currentTarget.setPointerCapture(e.pointerId);});
$('#ink-layer').addEventListener('pointermove',e=>{if(!stroke)return;const previous=stroke.points.at(-1);if(Math.hypot(e.clientX-previous.x,e.clientY-previous.y)>2){stroke.points.push({x:e.clientX,y:e.clientY});drawInk();}});
$('#ink-layer').addEventListener('pointerup',async e=>{
 if(!stroke)return;const drawn=stroke;stroke=null;if(drawn.points.length<5){drawInk();return;}
 try{
  const pts=drawn.points,first=pts[0],last=pts.at(-1),xs=pts.map(p=>p.x),ys=pts.map(p=>p.y),box={left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
  const closed=Math.hypot(last.x-first.x,last.y-first.y)<Math.max(25,Math.max(box.right-box.left,box.bottom-box.top)*.32);
  const composer=$('#composer').getBoundingClientRect();
  if(!closed&&last.y>composer.top&&last.x>composer.left&&last.x<composer.right){if(S.lastRef)useReference(S.lastRef);else toast('Confirm a reference first, then draw a line to the prompt.');}
  else if(closed){
   const target=$$('[data-entity]').filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.left+r.width/2>=box.left&&r.left+r.width/2<=box.right&&r.top+r.height/2>=box.top&&r.top+r.height/2<=box.bottom;}).sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];
   if(target)startReference({label:target.dataset.name,entityId:target.dataset.entity,kind:'character',sceneId:target.dataset.sourceScene,blockId:target.dataset.sourceBlock});
   else if(drawn.anchor?.dataset.inkAnchor.startsWith('block-')){const id=drawn.anchor.dataset.inkAnchor.slice(6),b=S.p.document.blocks.find(b=>b.id===id);if(b)startReference({label:b.text.slice(0,45),kind:'passage',blockId:id,quote:b.text});}
   else if(drawn.anchor?.dataset.inkAnchor.startsWith('scene-')){const id=drawn.anchor.dataset.inkAnchor.slice(6),s=sceneById(id);if(s)startReference({label:s.title,kind:'scene',sceneId:id});}
   else toast('Ink saved. Select an element to attach meaning to this circle.');
  }else toast('Ink saved as an annotation. No story changes were made.');
  const anchor=drawn.anchor||$('#workspace'),r=anchor.getBoundingClientRect();const a={id:crypto.randomUUID(),anchor:drawn.anchor?.dataset.inkAnchor||null,points:pts.filter((_,i)=>i%2===0).map(p=>[(p.x-r.left)/r.width,(p.y-r.top)/r.height]),author:'human'};
  await updateProject('',{annotations:[...S.p.annotations,a]},'PATCH',false);drawInk();renderComposer();
 }catch(error){handleError(error);}
});
$('#ink-layer').addEventListener('pointercancel',()=>{stroke=null;drawInk();});

function helpDialog(){modal(heading('A SMALL GUIDE','Words on the left. Possibilities on the right.')+`<p class="description"><b>1. Select a scene.</b> Its source text is boxed in blue, inherited context in purple, and potential consequences in amber.</p><p class="description"><b>2. Select Rose, or use the pen.</b> Draw a circle around a character or a passage. Confirm scene, section, chapter or story scope. The result becomes a saved reference.</p><p class="description"><b>3. Reuse the reference.</b> Drag it into the prompt, click its arrow, or draw a line ending in the prompt after confirming it. Drag a character onto a scene to prepare an addition.</p><p class="description"><b>4. Choose the AI role.</b> Check-in only diagnoses. Edit proposes a revision that you accept or reject. Switching mode does not run a request.</p><p class="description"><b>5. Follow another path.</b> Open Versions to compare, branch, rename or restore. Your older drafts remain available.</p><p class="dialog-note">Prototype: freehand recognition uses geometric rules, not unrestricted handwriting understanding. Unrecognized strokes stay annotations. The sample engine is a prepared demonstration, not AI. Scene art is a symbolic vector illustration, not a generated image of your exact prose. Use buttons for accept/reject in this version.</p><div class="dialog-actions"><button class="primary-button" value="ok">Got it</button></div>`);}

// Delegated actions keep rendered scene and reference objects directly manipulable.
document.addEventListener('click',async e=>{
 try{
  const b=e.target.closest('button'),entity=e.target.closest('[data-entity]');
  if(entity&&!S.pen){e.stopPropagation();startReference({label:entity.dataset.name,entityId:entity.dataset.entity,kind:'character',sceneId:entity.dataset.sourceScene,blockId:entity.dataset.sourceBlock});return;}
  if(b?.dataset.resolveScope){await resolveReference(b.dataset.resolveScope);return;}
  if(b?.dataset.refUse){useReference(b.dataset.refUse);return;}
  if(b?.dataset.refRemove){await updateProject('/references',{remove:b.dataset.refRemove});S.refs=S.refs.filter(id=>id!==b.dataset.refRemove);renderComposer();return;}
  if(b?.dataset.refEdit){const r=S.p.refs.find(r=>r.id===b.dataset.refEdit);startReference({...r,sceneId:r.sceneId});return;}
  if(b?.dataset.refLocate){const r=S.p.refs.find(r=>r.id===b.dataset.refLocate);const ids=docIds(r.scope),sc=sourceScene(ids[0]);if(sc)await selectScene(sc.id);$('#block-'+CSS.escape(ids[0]||''))?.scrollIntoView({behavior:'smooth',block:'center'});return;}
  if(b?.dataset.chipRemove){S.refs=S.refs.filter(id=>id!==b.dataset.chipRemove);renderComposer();return;}
  if(b?.dataset.collapse){S.collapsed.has(b.dataset.collapse)?S.collapsed.delete(b.dataset.collapse):S.collapsed.add(b.dataset.collapse);renderBoard();drawInk();return;}
  if(b?.dataset.chapterRef){const c=chapter(b.dataset.chapterRef),sc=S.p.document.scenes.find(s=>s.chapterId===c.id);startReference({label:c.title,kind:'chapter',sceneId:sc?.id});return;}
  if(b?.dataset.decision){await review(b.dataset.decision);return;}
  if(b?.dataset.removeCharacter){const s=currentScene();S.scope=scopeFor('scene',s);$('#prompt').value=`Remove ${b.dataset.name} from “${s.title}”.`;renderComposer();toast('Removal prepared. Choose Check-in to inspect impacts or Edit to revise.');return;}
  if(b?.dataset.dismiss){await updateProject('/diagnostics',{id:b.dataset.dismiss});return;}
  if(b?.dataset.menuScene){sceneActionsDialog(b.dataset.menuScene);return;}
  const a=b?.dataset.action;
  if(a){
   const actions={import:importDialog,create:createStoryDialog,structure:structureDialog,outline:outlineDialog,'cancel-reference':()=>{S.pendingRef=null;renderClarification();renderComposer();},'scope-answer':()=>{const answer=$('#scope-answer').value.toLowerCase();const level=/whole|story|histoire/.test(answer)?'story':/chapter|chapitre/.test(answer)?'chapter':/section/.test(answer)?'section':/scene|scène/.test(answer)?'scene':/passage/.test(answer)?'passage':null;if(level)return resolveReference(level);toast('Please choose scene, section, chapter, passage or whole story.');},'clarify-answer':()=>{S.answer=$('#ai-answer').value;renderComposer();toast('Clarification added. Click Execute when ready.');},'close-detail':()=>{S.detail=null;renderBoard();},'scene-reference':()=>{const s=currentScene();startReference({label:s.title,kind:'scene',sceneId:s.id});},'replace-scene':replaceSceneDialog,'scene-variant':()=>variantDialog(S.p.head,{...scopeFor('scene'),label:currentScene()?.title}),'add-event':()=>{S.scope=scopeFor('scene');$('#prompt').value=`Add an event to “${currentScene().title}”: `;renderComposer();$('#prompt').focus();},recheck:async()=>{const d=S.p.diagnostic;if(d){S.refs=[];S.scope=d.scopes[0];$('#prompt').value=d.prompt;}await execute(true,d?.scopes);},'hide-findings':()=>$('#findings-panel').hidden=true,'review-diff':reviewDiff,'confirm-deletion':deletionDialog,'add-character':addCharacterDialog,sample:async()=>{const p=await api('/projects',{demo:true});await openProject(p.id);}};
   if(actions[a])await actions[a]();return;
  }
  const finding=e.target.closest('[data-finding]');if(finding){const f=S.p.diagnostic.findings.find(f=>f.id===finding.dataset.finding);const sc=sourceScene(f.blockId);if(sc)await selectScene(sc.id);$('#block-'+CSS.escape(f.blockId))?.scrollIntoView({behavior:'smooth',block:'center'});return;}
  const scene=e.target.closest('[data-scene]');if(scene&&!S.pen){await selectScene(scene.dataset.scene);return;}
  const version=e.target.closest('[data-version]');if(version)await showVersion(version.dataset.version);
 }catch(error){handleError(error);}
});
function addCharacterDialog(){modal(heading('A NEW FACE','Add a character reference','This adds a character to the cast. It does not write them into the manuscript. Drag them onto a scene to prepare that request.')+`<label for="character-name">Name</label><input id="character-name"><label for="character-role">Role</label><input id="character-role"><div class="dialog-actions"><button type="button" class="primary-button" id="save-character">Add to cast</button></div>`);dialogAction('#save-character',async()=>{const name=$('#character-name').value.trim();if(!name)throw new Error('Give the character a name.');const doc=clone(S.p.document);doc.characters.push({id:'char_'+crypto.randomUUID(),name,role:$('#character-role').value});await updateProject('',{document:doc},'PATCH');closeModal();});}

document.addEventListener('dragstart',e=>{const r=e.target.closest('[data-ref]'),c=e.target.closest('[data-entity]'),s=e.target.closest('[data-scene]');if(r){const ref=S.p.refs.find(x=>x.id===r.dataset.ref);if(!refIsValid(ref)){e.preventDefault();return;}e.dataTransfer.setData('application/storyscene',JSON.stringify({type:'reference',id:r.dataset.ref}));}else if(c)e.dataTransfer.setData('application/storyscene',JSON.stringify({type:'character',id:c.dataset.entity,name:c.dataset.name,sceneId:c.dataset.sourceScene}));else if(s)e.dataTransfer.setData('application/storyscene',JSON.stringify({type:'scene',id:s.dataset.scene}));else return;e.dataTransfer.effectAllowed='copyMove';});
for(const el of [$('#composer'),$('#story-board')]){
 el.addEventListener('dragover',e=>{if(![...e.dataTransfer.types].includes('application/storyscene'))return;e.preventDefault();(e.target.closest('[data-scene]')||el).classList.add('drag-over');});
 el.addEventListener('dragleave',e=>{(e.target.closest('[data-scene]')||el).classList.remove('drag-over');});
 el.addEventListener('drop',async e=>{e.preventDefault();$$('.drag-over').forEach(x=>x.classList.remove('drag-over'));try{const raw=e.dataTransfer.getData('application/storyscene');if(!raw)return;const d=JSON.parse(raw),scene=e.target.closest('[data-scene]');if(el.id==='composer'){if(d.type==='reference')useReference(d.id);else if(d.type==='character')startReference({label:d.name,entityId:d.id,kind:'character',sceneId:d.sceneId,use:true});else if(d.type==='scene'){const sc=sceneById(d.id);startReference({label:sc.title,kind:'scene',sceneId:sc.id,use:true});}}else if(scene){if(d.type==='scene'){await sceneOperation({action:'move',sceneId:d.id,targetId:scene.dataset.scene,position:'after'});return;}await selectScene(scene.dataset.scene);if(d.type==='character'){S.scope=scopeFor('scene',sceneById(scene.dataset.scene));$('#prompt').value=`Add ${d.name} to “${sceneById(scene.dataset.scene).title}”. Their action: `;renderComposer();$('#prompt').focus();toast('Character addition prepared. Describe their action, then Execute.');}else{useReference(d.id);S.scope=scopeFor('scene');renderComposer();}}}catch(error){handleError(error);}});
}

listen('#settings-button','click',settingsDialog);listen('#engine-button','click',settingsDialog);listen('#help-button','click',helpDialog);
listen('#project-menu','click',projectDialog);listen('#import-button','click',async()=>{await flushSave();importDialog();});listen('#export-button','click',async()=>{await flushSave();exportDialog();});
listen('#structure-button','click',async()=>{await flushSave();structureDialog();});listen('#scope-button','click',scopeDialog);
listen('#execute-button','click',()=>execute());listen('#prompt','input',renderComposer);listen('#reference-selection','click',referenceSelectedText);
listen('#new-reference','click',()=>{const s=currentScene();if(s)startReference({label:s.title,kind:'scene',sceneId:s.id});else toast('Structure your story to select a scene.');});
listen('#clear-request','click',()=>{S.refs=[];S.scope=null;S.answer='';$('#prompt').value='';S.pendingRef=null;renderComposer();renderClarification();});
listen('#pen-tool','click',()=>setPen(true));listen('#select-tool','click',()=>setPen(false));listen('#clear-ink','click',async()=>{await updateProject('',{annotations:[]},'PATCH',false);drawInk();toast('Ink cleared. Story text is unchanged.');});
listen('#links-toggle','click',()=>{S.showLinks=!S.showLinks;$('#links-toggle').setAttribute('aria-pressed',S.showLinks);$('#links-toggle').classList.toggle('active',S.showLinks);drawLinks();});
listen('#refs-toggle','click',()=>{const panel=$('#references-panel');if(innerWidth<=900)panel.classList.toggle('force-show');else panel.hidden=!panel.hidden;requestAnimationFrame(()=>{drawLinks();drawInk();});});
listen('#annotations-toggle','click',async()=>{await flushSave();S.showOverlays=!S.showOverlays;$('#annotations-toggle').textContent=S.showOverlays?'Hide':'Show';renderManuscript();});
for(const[id,delta]of[['#zoom-in',15],['#zoom-out',-15]])listen(id,'click',()=>{S.zoom=Math.max(65,Math.min(150,S.zoom+delta));$('#zoom-value').textContent=S.zoom+'%';renderBoard();drawInk();});
$$('[data-tab]').forEach(b=>b.onclick=async()=>{try{if(b.dataset.tab==='versions')await versionsView();else{await flushSave();S.tab='workspace';render();}}catch(e){handleError(e);}});
$$('[data-mode]').forEach(b=>b.onclick=async()=>{try{if(S.p.mode===b.dataset.mode)return;await updateProject('',{mode:b.dataset.mode},'PATCH');S.answer='';$('#prompt').value='';renderComposer();toast(`Switched to ${b.dataset.mode==='check'?'Check-in':'Edit'}. No action was executed.`);}catch(e){handleError(e);}});
listen('#new-variant','click',()=>variantDialog());
document.addEventListener('selectionchange',captureSelection);
$$('[data-format]').forEach(b=>{b.onmousedown=e=>e.preventDefault();b.onclick=()=>{if(S.busy)return;const saved=S.textSelection?.range;if(saved){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(saved);}document.execCommand(b.dataset.format,false,b.dataset.format==='hiliteColor'?'#fff0b6':null);queueSave();};});
$('#text-style').onchange=e=>{if(S.textSelection?.range){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(S.textSelection.range);}document.execCommand('formatBlock',false,e.target.value);queueSave();};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();flushSave().then(()=>toast('Saved on this device.')).catch(handleError);}if(e.key==='Escape'&&S.pen)setPen(false);const t=e.target;if((e.key==='Enter'||e.key===' ')&&t.matches('.scene-card,.version-node')){e.preventDefault();t.click();}});
let resizing=false;$('#splitter').addEventListener('pointerdown',e=>{resizing=true;e.currentTarget.setPointerCapture(e.pointerId);});$('#splitter').addEventListener('pointermove',e=>{if(!resizing)return;const rect=$('#studio').getBoundingClientRect();document.documentElement.style.setProperty('--left',Math.max(26,Math.min(57,(e.clientX-rect.left)/rect.width*100))+'%');drawInk();drawLinks();});$('#splitter').addEventListener('pointerup',()=>resizing=false);$('#splitter').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const value=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left'));document.documentElement.style.setProperty('--left',Math.max(26,Math.min(57,value+(e.key==='ArrowRight'?2:-2)))+'%');drawInk();drawLinks();});
$('#manuscript-scroll').addEventListener('scroll',()=>requestAnimationFrame(drawInk));$('#board-scroll').addEventListener('scroll',()=>requestAnimationFrame(drawInk));window.addEventListener('resize',()=>{drawInk();drawLinks();});window.addEventListener('beforeunload',e=>{if(S.dirty||S.saving){e.preventDefault();e.returnValue='';}});

async function boot(){
 icons();S.settings=await api('/settings');S.projects=await api('/projects');
 let id=localStorage.getItem('storyscene-project');if(!S.projects.some(p=>p.id===id))id=S.projects[0]?.id;
 if(!id){const p=await api('/projects',{demo:true});id=p.id;}
 if(S.engine==='hf'&&!S.settings.configured)S.engine='demo';await openProject(id);
}
boot().catch(e=>{saveStatus('Cannot connect to local server',true);$('#manuscript').innerHTML=`<div class="empty-manuscript"><h2>Start the local server</h2><p>Run start.bat on Windows, or start.sh on macOS / Linux, then open http://127.0.0.1:8000.</p><p>${esc(e.message)}</p></div>`;handleError(e);});
