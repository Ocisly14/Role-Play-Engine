/** Export only the places used by the visual overview. No runtime/session data. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'testmods/grayhaven/Grayhaven_Scenarios');
const places = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('VEH_'))
  .sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const roads = places.filter(p => p.id.startsWith('ROAD_')).map(p => {
  const connections = p.references.connections;
  return { id: p.id, name: p.name, minutes: p.travelTimeMinutes,
    driveMinutes: p.driveTimeMinutes,
    from: connections.find(c => c.role === 'endpointA').targetId,
    to: connections.find(c => c.role === 'endpointB').targetId,
    access: connections.filter(c => c.role === 'access').map(c => ({ id: c.targetId, position: c.position })) };
});
const nodeIds = new Set(places.filter(p => p.id.startsWith('SCN_') && !p.parentLocationId).map(p => p.id));
const accessIds = new Set(roads.flatMap(r => r.access.map(a => a.id)));
const locations = places.filter(p => nodeIds.has(p.id) || accessIds.has(p.id)).map(p => ({
  id: p.id, name: p.name, isNode: nodeIds.has(p.id),
  // Roadside interiors contribute names/references only to an exterior overview.
  ...(nodeIds.has(p.id) ? { description: p.setting.replace(/\s*\[[^\]]+\]/g, '') } : {}),
}));
const setup = JSON.parse(fs.readFileSync(path.join(root, 'testmods/grayhaven/module_setup.json'), 'utf8'));
const out = { source: 'testmods/grayhaven', date: setup.startDate, introduction: setup.introduction, locations, roads };
for (const r of roads) if (!nodeIds.has(r.from) || !nodeIds.has(r.to)) throw Error(`Missing endpoint: ${r.id}`);
const target = path.join(root, 'client/src/observer/grayhaven/grayhaven.generated.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Grayhaven: ${nodeIds.size} exterior nodes, ${roads.length} roads, ${accessIds.size} roadside places exported.`);

// Keep the detailed exterior's reading notes tied to the source scene's item references.
const dock = places.find(place => place.id === 'SCN_dock');
fs.writeFileSync(path.join(root, 'client/src/observer/grayhaven/beachScene.generated.json'), JSON.stringify({
  sceneId: dock.id, items: dock.references.items.map(({ id, name, description }) => ({ id, name, description })),
}, null, 2) + '\n');

const redwood = places.find(place => place.id === 'SCN_redwood_ring');
fs.writeFileSync(path.join(root, 'client/src/observer/grayhaven/redwoodRingScene.generated.json'), JSON.stringify({
  sceneId: redwood.id, items: redwood.references.items.map(({ id, name, description }) => ({ id, name, description })),
}, null, 2) + '\n');

// Exact authored room/item/connection records; upstairs visual zones remain one SCN.
fs.writeFileSync(path.join(root, 'client/src/observer/grayhaven/buildingScenes.generated.json'), JSON.stringify(
  ['SCN_bluebird_dining', 'SCN_bluebird_kitchen', 'SCN_bluebird_upstairs'].map(id => {
    const scene = places.find(p => p.id === id);
    if (!scene || scene.parentLocationId !== 'bluebird_diner' || !scene.indoor) throw Error(`Invalid interior: ${id}`);
    return scene;
  }), null, 2) + '\n');

// Sheriff rooms retain exact source IDs for room and object navigation.
fs.writeFileSync(path.join(root, 'client/src/observer/grayhaven/sheriffScenes.generated.json'), JSON.stringify(
  ['SCN_sheriff_front', 'SCN_sheriff_office', 'SCN_sheriff_cell'].map(id => {
    const scene = places.find(p => p.id === id);
    if (!scene || scene.parentLocationId !== 'sheriff_office' || !scene.indoor) throw Error(`Invalid interior: ${id}`);
    return scene;
  }), null, 2) + '\n');
