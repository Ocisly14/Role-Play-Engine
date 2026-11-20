import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bluebirdWalls } from './bluebirdShell';
import { BLUEBIRD as B, buildingScenes } from './buildingInteriors';
import type { createInteriorLighting } from './interiorLighting';

export function createBluebirdInterior(light:ReturnType<typeof createInteriorLighting>) {
  const root=new THREE.Group(); root.name='bluebird-authored-interior';
  const floors=[new THREE.Group(),new THREE.Group()]; root.add(...floors);
  // Upper walls go into one group per outward normal, tagged userData.cutawayNormal so the cutaway controller can hide the sides facing the camera; sills, floors and props stay untagged.
  const sides=[0,1].map(()=>new Map<string,THREE.Group>());
  const side=(floor:0|1,normal:number[])=>{const key=normal.join(','),m=sides[floor];if(!m.has(key)){const g=new THREE.Group();g.name=`bluebird-wall-${floor}-${key}`;g.userData.cutawayNormal=[...normal];floors[floor].add(g);m.set(key,g);}return m.get(key)!;};
  const hits:THREE.Mesh[]=[];
  const lamps:THREE.PointLight[]=[];
  const pickMaterial=new THREE.MeshBasicMaterial({visible:false});
  const mat={plaster:light.material(0xd0c6ad),trim:light.material(0x685345,'bareWood'),wood:light.material(0xc9aa7c,'bareWood'),green:light.material(0x426354),red:light.material(0x985b4e),cream:light.material(0xe5decb),steel:light.material(0x899b9a,undefined,true),dark:light.material(0x343d37),tile:light.material(0xb0aea0),paper:light.material(0xdad0b4),brass:light.material(0xbaa16e,undefined,true)};
  const batches=new Map<THREE.Group,Map<THREE.Material,THREE.BufferGeometry[]>>();
  const add=(group:THREE.Group,geo:THREE.BufferGeometry,m:THREE.Material,x:number,y:number,z:number,rx=0,ry=0,rz=0)=>{
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromEuler(new THREE.Euler(rx,ry,rz)),new THREE.Vector3(1,1,1)));
    if(!batches.has(group))batches.set(group,new Map()); const b=batches.get(group)!; if(!b.has(m))b.set(m,[]); b.get(m)!.push(geo.index?geo.toNonIndexed():geo); if(geo.index)geo.dispose();
  };
  const box=(g:THREE.Group,w:number,h:number,d:number,m:THREE.Material,x:number,y:number,z:number,ry=0)=>add(g,new THREE.BoxGeometry(w,h,d),m,x,y,z,0,ry);
  const cyl=(g:THREE.Group,r:number,h:number,m:THREE.Material,x:number,y:number,z:number,rx=0)=>add(g,new THREE.CylinderGeometry(r,r,h,12),m,x,y,z,rx);
  const pick=(floor:0|1,scene:string,item:string|null,at:number[],size:number[],target?:string)=>{
    const m=new THREE.Mesh(new THREE.BoxGeometry(...size as [number,number,number]),pickMaterial);m.position.fromArray(at);m.userData={sceneId:scene,itemId:item,targetId:target,floor};floors[floor].add(m);hits.push(m);
  };
  const anchor=(floor:0|1,scene:string,item:string,x:number,y:number,z:number,w=1.1,h=.9,d=1.1)=>pick(floor,scene,`item.bluebird_${scene.split('_').at(-1)}.${item}`,[x,y,z],[w,h,d]);
  // Separate lower-storey support when viewing upstairs; its colour remains exterior siding.
  for(const floor of [0,1] as const) {
    const g=floors[floor], y=floor?B.upper:B.ground;
    for(const p of bluebirdWalls()) {
      if(p.floor>floor)continue;
      if(p.floor<floor) {box(g,...p.size,mat.plaster,...p.at);continue;}
      const lo=p.at[1]-p.size[1]/2, hi=p.at[1]+p.size[1]/2, sill=y+.95;
      if(Math.min(hi,sill)>lo)box(g,p.size[0],Math.min(hi,sill)-lo,p.size[2],mat.plaster,p.at[0],(Math.min(hi,sill)+lo)/2,p.at[2]);
      if(hi>Math.max(lo,sill))box(side(floor,p.normal),p.size[0],hi-Math.max(lo,sill),p.size[2],mat.plaster,p.at[0],(hi+Math.max(lo,sill))/2,p.at[2]);
    }
    // Nothing below is tagged, so the cutaway never touches floors or contents.
    if(floor===0) {
      box(g,13.7,.25,21.7,mat.tile,0,y-.125,0);
      // Old checkerboard linoleum only in the dining room, with a clear kitchen threshold.
      for(let x=-6;x<=6;x+=1.5)for(let z=-1.3;z<10.5;z+=1.5)if(Math.round((x+6+z+1.3)/1.5)%2===0)box(g,1.48,.012,1.48,mat.cream,x,y+.008,z);
    } else {
      box(g,11.7,.24,13.2,mat.wood,-1.15,y-.12,4.4);box(g,2.3,.24,9.3,mat.wood,5.85,y-.12,6.35);
      for(let x=-6.6;x<6.8;x+=.58)box(g,.018,.012,9.2,mat.trim,x,y+.01,6.3);
      box(g,4.5,.025,4.3,mat.red,2.4,y+.02,5.5);
      // Living room (right, where the stair lands) and the inner bedroom (left) are visual zones of the same SCN, with an open door at z 3.5.
      box(g,.22,1,4.4,mat.plaster,-1.2,y+.5,0);box(g,.22,1,5.3,mat.plaster,-1.2,y+.5,8.35);
      box(g,.28,.08,4.4,mat.trim,-1.2,y+1.04,0);box(g,.28,.08,5.3,mat.trim,-1.2,y+1.04,8.35);
      // Stairwell railing: an actual opening, no slab covering the flight.
      for(let z=-1.9;z<1.7;z+=.65)box(g,.1,1,.1,mat.trim,4.72,y+.5,z);
      box(g,.14,.12,4,mat.wood,4.72,y+1,-.2);
      box(g,1.8,.12,.14,mat.wood,5.6,y+1,1.72);
    }
  }
  const d=floors[0], u=floors[1], y=B.ground, uy=B.upper;
  const ds='SCN_bluebird_dining',ks='SCN_bluebird_kitchen',us='SCN_bluebird_upstairs';
  const prop=(g:THREE.Group,f:0|1,s:string,id:string,w:number,h:number,depth:number,m:THREE.Material,x:number,py:number,z:number)=>{box(g,w,h,depth,m,x,py,z);anchor(f,s,id,x,py,z,w+.15,h+.15,depth+.15);};
  // Dining/kitchen partition: porthole spring doors and a steel pass shelf under the order wheel.
  for(const [x,w] of [[-2.6,8.4],[5.9,1.8]]) {box(d,w,1,.25,mat.plaster,x,y+.5,-2.2);box(d,w,.1,.32,mat.trim,x,y+1.05,-2.2);}
  for(const x of [2.9,4.2]) {const ry=x===2.9?-.5:.5;box(d,.9,1.35,.1,mat.green,x,y+.68,-2.2,ry);const port=new THREE.CylinderGeometry(.15,.15,.14,12);port.rotateX(Math.PI/2);add(d,port,mat.steel,x,y+1.05,-2.2,0,ry);}
  box(d,2.4,.08,.55,mat.steel,.3,y+1.14,-2.2);
  pick(0,ds,null,[3.55,1.5,-2.2],[2.2,2.2,.6],ks);
  // Maple counter from near the street door to the kitchen door; red fixed swivel stools along it.
  box(d,1.65,1.15,9.6,mat.green,1.3,y+.575,4.2);box(d,2,.18,10,mat.wood,1.3,y+1.24,4.2);
  for(let z=.1;z<9;z+=1.45){cyl(d,.36,.12,mat.steel,-.4,y+.06,z);cyl(d,.09,.75,mat.steel,-.4,y+.42,z);cyl(d,.43,.18,mat.red,-.4,y+.88,z);}
  anchor(0,ds,'lunch_counter',1.3,y+.9,4.2,2,1.7,10);
  // Window-side booths: three differently occupied bays; tables have separate legs and tops.
  for(const z of [1,4.35,7.7]) {
    for(const side of [-1,1]) {box(d,2.3,.45,.68,mat.green,-4.7,y+.45,z+side*.9);box(d,2.3,1.18,.2,mat.green,-4.7,y+.75,z+side*1.2);}
    box(d,2.15,.13,1.1,mat.cream,-4.7,y+1.04,z);cyl(d,.12,.95,mat.steel,-4.7,y+.48,z);
    cyl(d,.12,.25,mat.paper,-4.65,y+1.23,z);cyl(d,.075,.2,mat.dark,-4.3,y+1.2,z);
  }
  anchor(0,ds,'booths',-4.7,y+.8,4.35,2.4,1.6,8.9);
  anchor(0,ds,'sugar_shakers',-4.55,y+1.2,4.35,.65,.4,.5);
  // Along the counter, street end to kitchen end: espresso machine in the corner, pastry case, register, radio.
  prop(d,0,ds,'espresso_machine',.9,.75,.65,mat.steel,1.3,y+1.75,8.2);cyl(d,.13,.4,mat.dark,1.3,y+1.6,7.7,Math.PI/2);
  // Pastry case: thin frame + clear open viewing face avoids a large opaque glass block.
  box(d,1.75,.1,1.1,mat.steel,1.3,y+1.4,4.8);box(d,1.75,.06,1.1,mat.cream,1.3,y+2.05,4.8);
  for(const x of [.46,2.14])box(d,.07,.65,1.05,mat.steel,x,y+1.7,4.8);
  for(const x of [.85,1.45,1.9])for(const z of [4.5,5])cyl(d,.17,.1,mat.brass,x,y+1.5,z);
  anchor(0,ds,'pastry_case',1.3,y+1.7,4.8,1.9,.8,1.2);
  // Chalk menu on the back-bar wall, facing the pastry case across the counter.
  box(d,.1,1.1,1.5,mat.dark,6.78,y+2.3,4.8);box(d,.14,.06,1.6,mat.trim,6.78,y+2.88,4.8);
  for(let i=0;i<4;i++)box(d,.02,.025,.7+i%2*.4,mat.paper,6.72,y+2.6-i*.2,4.8);
  anchor(0,ds,'menu_board',6.78,y+2.3,4.8,.3,1.25,1.65);
  prop(d,0,ds,'cash_register',.7,.5,.65,mat.brass,1.3,y+1.58,1.2);
  cyl(d,.16,.35,mat.paper,1.2,y+1.5,1.9);anchor(0,ds,'tip_jar',1.2,y+1.5,1.9,.4,.45,.4);
  prop(d,0,ds,'counter_radio',.8,.48,.4,mat.trim,2,y+1.6,-.1);box(d,.45,.25,.04,mat.dark,2,y+1.6,.12);
  box(d,1.25,2.9,.12,mat.wood,2,y+1.45,-2.16);
  cyl(d,.43,.12,mat.cream,2,y+2.65,-2.04,Math.PI/2);box(d,.03,.27,.03,mat.dark,2,y+2.74,-1.96);box(d,.22,.03,.03,mat.dark,2.1,y+2.65,-1.96);anchor(0,ds,'wall_clock',2,y+2.65,-2.04);
  prop(d,0,ds,'wall_phone',.4,.65,.2,mat.dark,6.6,y+1.7,0);
  // Newspaper rack in the corner beside the street door; the open/closed board hangs in the door at eye height.
  prop(d,0,ds,'newspaper_rack',.5,.9,1,mat.trim,-6.35,y+.45,10.2);box(d,.08,.6,.8,mat.paper,-6.35,y+.8,10.2);
  prop(d,0,ds,'door_sign',.6,.35,.08,mat.wood,-4.05,y+1.9,10.9);
  const shade=light.lampMaterial();
  const lamp=(floor:0|1,x:number,py:number,z:number,intensity:number,range:number)=>{
    const source=new THREE.PointLight(0xffd3a0,0,range,2);source.position.set(x,py,z);
    source.castShadow=true;source.shadow.mapSize.set(256,256);source.shadow.camera.near=.08;
    source.shadow.normalBias=.035;source.shadow.bias=-.00015;source.shadow.autoUpdate=false;source.shadow.needsUpdate=true;
    floors[floor].add(source);lamps.push(source);light.registerLamp(source,intensity);
  };
  // Suspended milk-glass lights cast local pools onto booths, counter and floor.
  lamp(0,-2.7,y+3.4,6.8,90,10);lamp(0,2.6,y+3.4,2,90,10);
  lamp(0,-1.1,y+3.5,-6.5,105,9);
  lamp(1,2.4,uy+3.2,5.5,70,8);lamp(1,-4.55,uy+1.25,9.6,25,5.5);
  add(d,new THREE.SphereGeometry(.32,10,6),shade,-1.1,y+3.6,-6.5);
  cyl(d,.025,1.3,mat.dark,-1.1,y+4.4,-6.5);
  add(u,new THREE.ConeGeometry(.42,.38,12,1,true),shade,2.4,uy+3.35,5.5);
  cyl(u,.025,1,mat.dark,2.4,uy+4,5.5);
  // Two rows of milk-glass shades, one over each booth bay; the two registered sources sit under the end shades.
  for(const x of [-2.7,2.6])for(const z of [2,4.4,6.8]) {add(d,new THREE.ConeGeometry(.4,.34,12,1,true),shade,x,y+3.5,z,Math.PI);cyl(d,.025,.7,mat.dark,x,y+4,z);}
  anchor(0,ds,'ceiling_lights',-2.7,y+3.5,6.8);
  // Kitchen: the hot wall on the left (range under its hood, oven, spice rack, tray rack), the cooler facing it from the right.
  prop(d,0,ks,'range',1.6,1.05,2.4,mat.cream,-5.85,y+.53,-9.2);
  for(const x of [-6.25,-5.5])for(const z of [-10,-9.2,-8.4])cyl(d,.25,.06,mat.dark,x,y+1.1,z);
  cyl(d,.38,.5,mat.dark,-6.25,y+1.4,-9.2);anchor(0,ks,'stew_pot',-6.25,y+1.4,-9.2);
  box(d,1.7,.55,2.6,mat.steel,-5.85,y+2.75,-9.2);box(d,.5,1.4,.5,mat.steel,-5.85,y+3.7,-9.2);
  prop(d,0,ks,'old_oven',1.5,1.2,1.8,mat.cream,-5.85,y+.6,-6.5);box(d,.06,.6,1.4,mat.dark,-5.04,y+.55,-6.5);
  prop(d,0,ks,'spice_rack',.5,.12,2,mat.trim,-6.4,y+2.2,-6.5);
  for(let i=0;i<6;i++)cyl(d,.12,.3,i%2?mat.brass:mat.paper,-6.4,y+2.4,-7.25+i*.3);
  for(const z of [-5.05,-4.35])for(const x of [-6.3,-5.4])box(d,.06,1.6,.06,mat.steel,x,y+.8,z);
  for(const py of [.45,.95,1.45]){box(d,1,.03,.8,mat.steel,-5.85,y+py,-4.7);for(let i=0;i<4;i++)cyl(d,.11,.06,mat.brass,-6.15+i%2*.6,y+py+.045,-4.9+Math.floor(i/2)*.4);}
  anchor(0,ks,'tart_tray',-5.85,y+.95,-4.7,1.1,1.7,.9);
  // Steel preparation run from the doorway end back toward the rear corner.
  prop(d,0,ks,'prep_table',1.65,.16,6.2,mat.steel,-1.6,y+1.15,-6.4);
  for(const x of [-2.25,-.95])for(const z of [-9.2,-3.6])box(d,.1,1.1,.1,mat.steel,x,y+.55,z);
  prop(d,0,ks,'knife_block',.45,.5,.4,mat.wood,-1.6,y+1.47,-3.7);
  // Triple sink under the rear window: open bowls on a steel base, taps against the wall, extinguisher above.
  box(d,2.9,.95,.8,mat.steel,-3.05,y+.5,-10.45);
  for(const x of [-3.95,-3.05,-2.15]) {box(d,.86,.08,.8,mat.steel,x,y+1.02,-10.45);box(d,.62,.02,.56,mat.dark,x,y+1.07,-10.45);box(d,.06,.45,.06,mat.steel,x,y+1.35,-10.75);}
  anchor(0,ks,'dish_sink',-3.05,y+1.05,-10.45,3,.6,.9);
  cyl(d,.19,.65,mat.red,-1.05,y+2.1,-10.62);anchor(0,ks,'extinguisher',-1.05,y+2.1,-10.62);
  // Cooler in the rear right corner facing the range, dry goods on open shelves beside it.
  prop(d,0,ks,'cooler',1.6,2.5,1.5,mat.cream,6.05,y+1.25,-10.08);box(d,.08,.7,.08,mat.steel,5.2,y+1.5,-9.6);
  for(const x of [3.2,4.5])for(const z of [-10.75,-9.75])box(d,.06,1.55,.06,mat.trim,x,y+.78,z);
  prop(d,0,ks,'pantry_shelf',1.4,.12,1.1,mat.trim,3.85,y+1.45,-10.25);
  for(const py of [.35,.9,1.45]){if(py<1.4)box(d,1.4,.12,1.1,mat.trim,3.85,y+py,-10.25);for(let j=0;j<3;j++)cyl(d,.16,.34,mat.paper,3.45+j*.4,y+py+.23,-10.05);}
  cyl(d,.45,.07,mat.steel,.2,y+1.9,-2.55);anchor(0,ks,'order_wheel',.2,y+1.9,-2.55);
  prop(d,0,ks,'kitchen_radio',.65,.4,.3,mat.trim,-.8,y+1.3,-2.55);
  prop(d,0,ks,'apron',.05,.9,.6,mat.paper,6.8,y+1.55,-8.4);
  // A steep single flight in the rear corner: fifteen risers over 6.3 m, landing in the upstairs opening.
  for(let i=0;i<15;i++){const h=(B.upper-y)*(i+1)/15,z=-8.9+i*.45;box(d,1.65,.15,.46,mat.wood,5.6,y+h-.075,z);if(i%2===0)box(d,.07,.9,.07,mat.trim,4.8,y+h+.45,z);}
  pick(0,ks,null,[5.6,3.1,-5.75],[1.9,6.2,6.7],us);pick(1,us,null,[5.6,uy+.05,-.3],[1.8,.3,3.5],ks);
  // Dolores's home. Living room: the stair lands here; the photo wall and the saint's shelf face the room from the solid right wall.
  cyl(u,1.25,.14,mat.paper,2.4,uy+1,5.5);cyl(u,.14,.95,mat.trim,2.4,uy+.48,5.5);anchor(1,us,'tablecloth',2.4,uy+1,5.5,2.5,.3,2.5);
  box(u,1.15,.2,1.2,mat.wood,4.3,uy+.55,9.4);box(u,1.15,1,.15,mat.wood,4.3,uy+1,8.9);
  for(const x of [3.8,4.8]){box(u,.09,.12,1.7,mat.trim,x,uy+.12,9.4);box(u,.09,.5,.09,mat.trim,x,uy+.35,9.4);box(u,.12,.12,1.1,mat.wood,x,uy+.94,9.4);}
  anchor(1,us,'rocking_chair',4.3,uy+.85,9.4,1.3,1.5,1.7);
  cyl(u,.4,.4,mat.wood,5.8,uy+.2,9.6);anchor(1,us,'sewing_basket',5.8,uy+.2,9.6);
  for(let i=0;i<8;i++){const big=i===3,z=3.2+i*.85,py=uy+1.8+i%2*.28;box(u,.08,big?1:.8,big?.9:.65,mat.trim,6.78,py,z);box(u,.02,big?.85:.65,big?.75:.51,big?mat.steel:mat.paper,6.72,py,z);}
  anchor(1,us,'photo_wall',6.75,uy+1.95,6.2,.4,1.5,7);
  box(u,.5,.08,.55,mat.wood,6.55,uy+1.4,2.4);cyl(u,.13,.5,mat.cream,6.55,uy+1.7,2.4);cyl(u,.06,.08,mat.brass,6.42,uy+1.48,2.66);cyl(u,.025,.12,mat.cream,6.42,uy+1.58,2.66);
  anchor(1,us,'saint_statue',6.55,uy+1.65,2.45,.6,.7,.7);
  prop(u,1,us,'dresser',1.9,1.5,.8,mat.trim,3.2,uy+.75,-1.6);
  for(let i=0;i<5;i++){box(u,1.75,.025,.03,mat.brass,3.2,uy+.2+i*.27,-1.17);cyl(u,.05,.08,mat.brass,3.2,uy+.3+i*.27,-1.11,Math.PI/2);}
  prop(u,1,us,'recipe_book',.6,.09,.45,mat.paper,2.9,uy+1.55,-1.55);prop(u,1,us,'letters',.4,.06,.3,mat.paper,3.65,uy+1.54,-1.55);
  prop(u,1,us,'calendar',.45,.65,.04,mat.paper,-1.9,uy+1.6,-2.01);
  // Bedroom, the inner room: narrow iron bed under the street window, nightstand lamp at its head, wardrobe at its foot.
  prop(u,1,us,'bed',1.6,.5,2.9,mat.cream,-5.9,uy+.75,8.15);box(u,1.6,.12,1.6,mat.green,-5.9,uy+1.06,7.5);box(u,1,.18,.5,mat.paper,-5.9,uy+1.12,9.3);
  for(const z of [6.7,9.6])for(let x=-6.6;x<-5.1;x+=.35){cyl(u,.035,1.35,mat.cream,x,uy+.7,z);}for(const z of [6.7,9.6])box(u,1.65,.06,.07,mat.cream,-5.9,uy+1.4,z);
  box(u,.8,.75,.8,mat.trim,-4.55,uy+.375,9.6);cyl(u,.06,.45,mat.brass,-4.55,uy+1,9.6);add(u,new THREE.ConeGeometry(.4,.45,12,1,true),shade,-4.55,uy+1.4,9.6);anchor(1,us,'bedside_lamp',-4.55,uy+1.25,9.6);
  prop(u,1,us,'wardrobe',1.9,2.6,.85,mat.trim,-5.9,uy+1.3,5.8);box(u,.03,2.35,.04,mat.brass,-5.9,uy+1.3,6.25);
  // Floor hits are behind props; the nearest visible item/door wins naturally.
  pick(0,ds,null,[0,y-.03,4.4],[13.6,.05,13]);pick(0,ks,null,[0,y-.03,-6.6],[13.6,.05,8.4]);pick(1,us,null,[-1.15,uy-.04,4.4],[11.7,.05,13.1]);pick(1,us,null,[5.85,uy-.04,6.35],[2.2,.05,9.2]);
  for(const [g,batch]of batches)for(const [material,geos]of batch){const geometry=mergeGeometries(geos);if(!geometry)throw Error('Interior mesh merge failed');for(const geo of geos)geo.dispose();const mesh=new THREE.Mesh(geometry,material);mesh.receiveShadow=true;mesh.castShadow=material!==shade;g.add(mesh);}
  // Reject broken source anchors during development/export tests.
  const ids=new Set(buildingScenes.flatMap(s=>s.references.items.map(i=>i.id)));
  for(const hit of hits)if(hit.userData.itemId&&!ids.has(hit.userData.itemId))throw Error(`Unknown room item ${hit.userData.itemId}`);
  return {root,hits,lamps,
    needsShadowUpdate(){return lamps.some(l=>l.parent!.visible&&l.shadow.needsUpdate);},
    setFloor(floor:0|1){floors.forEach((g,i)=>g.visible=i===floor);for(const l of lamps)if(l.parent!.visible)l.shadow.needsUpdate=true;}, dispose(){const geometries=new Set<THREE.BufferGeometry>();root.traverse(o=>{if((o as THREE.Mesh).geometry)geometries.add((o as THREE.Mesh).geometry);});geometries.forEach(g=>g.dispose());pickMaterial.dispose();for(const l of lamps)l.dispose();root.removeFromParent();}};
}
export type BluebirdInterior=ReturnType<typeof createBluebirdInterior>;
