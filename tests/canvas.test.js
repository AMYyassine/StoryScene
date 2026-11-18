import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomAt, fitBounds, readCanvas, freshCanvas} from '../web/canvas-math.js';

test('zoom keeps the world point under the cursor fixed, including negative pan',()=>{
  const view={x:-380,y:170,zoom:.65}, pointer={x:417,y:203};
  const next=zoomAt(view,pointer,1.72);
  for(const k of ['x','y']) assert.ok(Math.abs((pointer[k]-view[k])/view.zoom-(pointer[k]-next[k])/next.zoom)<1e-9);
});
test('zoom limits do not break cursor anchoring',()=>{
  const view={x:20,y:30,zoom:1},pointer={x:110,y:200};
  for(const requested of [.001,100]){
    const next=zoomAt(view,pointer,requested);
    assert.ok(next.zoom>=.2&&next.zoom<=2.5);
    assert.equal((pointer.x-next.x)/next.zoom,pointer.x-view.x);
  }
});
test('fit includes objects moved left and above the original board',()=>{
  const bounds={x:-300,y:-250,width:1100,height:800},size={width:800,height:650};
  const view=fitBounds(bounds,size);
  assert.ok(bounds.x*view.zoom+view.x>=31.999);
  assert.ok(bounds.y*view.zoom+view.y>=31.999);
  assert.ok((bounds.x+bounds.width)*view.zoom+view.x<=size.width-31.999);
  assert.ok((bounds.y+bounds.height)*view.zoom+view.y<=size.height-31.999);
});
test('saved visual positions and viewport survive a serialization round trip',()=>{
  const state={view:{x:-80,y:160,zoom:1.2},positions:{prompt:{x:30,y:-100},scene_key:{x:-180,y:240}}};
  assert.deepEqual(readCanvas(JSON.stringify(state)),state);
});
test('broken or invalid browser preferences cannot poison canvas coordinates',()=>{
  assert.deepEqual(readCanvas('not json'),freshCanvas());
  const state=readCanvas('{"view":{"x":null,"y":2,"zoom":0},"positions":{"bad":{"x":"NaN","y":0},"good":{"x":-45,"y":80}}}');
  assert.deepEqual(state.view,freshCanvas().view);
  assert.deepEqual(state.positions,{good:{x:-45,y:80}});
});
