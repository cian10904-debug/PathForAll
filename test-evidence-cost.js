import assert from 'node:assert/strict';
import { assessEdge, inferKerbState, reverseEdge, summarizeEvidence } from './accessibility.js';
import { edgeCost, dijkstra, PROFILE_WEIGHTS, summarizeRoute } from './routing.js';
import { parseOverpassGraph, parseInclinePercent, connectRouteEndpoints } from './osm-network.js';
import { normalizeWalkingRoute, validateRouteOption } from './route-model.js';
import { diagnoseNoRoute } from './routing-diagnostics.js';

let checks = 0;
function test(name, action) { action(); checks++; console.log(`PASS ${name}`); }
const base = { id: 'edge', from: 'a', to: 'b', minutes: 10, distanceMeters: 750, slope: 4, stairs: false, surface: 'smooth', pedestrianEvidence: 'dedicated', roadCenterline: false, requiresCurbRamp: false, confidence: .8, lit: true };
const needs = { wheelchairMode: true, avoidStairs: true, maxSlope: 6, requireCurb: true };
for (const [left, right, expected] of [
  ['lowered','lowered','satisfied'], ['lowered','raised','violated'], ['lowered',null,'unknown'],
  ['raised',null,'violated'], [null,null,'unknown'], ['flush','no','satisfied'], ['rolled','lowered','violated']
]) test(`curb ${left}/${right}: ${expected}`, () => {
  const curb = inferKerbState([left ? { kerb: left } : {}, right ? { kerb: right } : {}], ['west','east']);
  assert.equal(curb.state, expected);
  assert.equal(assessEdge({ ...base, requiresCurbRamp: true, curbEvidence: curb }, needs).eligible, expected === 'satisfied');
  assert.equal(assessEdge({ ...base, requiresCurbRamp: true, curbEvidence: curb }, { ...needs, unknownPolicy: 'allow' }).eligible, expected !== 'violated');
});
test('conflicting and missing curb endpoints preserve reasons', () => {
  const conflict = inferKerbState([{ kerb: 'lowered', curb: 'raised' }, { kerb: 'lowered' }]);
  assert.equal(conflict.state, 'unknown'); assert.match(conflict.reason, /Conflicting/);
  assert.equal(inferKerbState([{ kerb: 'lowered' }]).state, 'unknown');
});
test('malformed provider evidence cannot bypass curb rules', () => {
  const malformed = {...base, requiresCurbRamp:true, curbEvidence:{state:'invalid',reason:'Invalid provider assertion'}};
  assert.equal(assessEdge(malformed,needs).eligible,false);
  const barrier = {...malformed,curbEvidence:{state:'violated',reason:'Known raised curb'}};
  assert.equal(assessEdge(reverseEdge(barrier),{...needs,unknownPolicy:'allow'}).eligible,false);
});
test('unknown slope cannot satisfy a maximum; allowed unknown remains identified', () => {
  assert.equal(assessEdge({ ...base, slope: null }, needs).eligible, false);
  const allowed = assessEdge({ ...base, slope: null }, { ...needs, unknownPolicy: 'allow' });
  assert.equal(allowed.eligible, true); assert.equal(allowed.requirements.slope.state, 'unknown');
});
test('hard violations cannot be bought off by preference costs', () => {
  for (const weights of Object.values(PROFILE_WEIGHTS)) for (const policy of ['strict','allow']) {
    assert.equal(edgeCost({ ...base, slope: 7, minutes: 0 }, { ...needs, unknownPolicy: policy }, {}, weights), Infinity);
  }
});
test('optional smooth surface remains optional', () => {
  assert.equal(assessEdge({ ...base, surface: 'rough' }, { preferSmooth: true }).eligible, true);
  assert.equal(assessEdge({ ...base, surface: 'rough' }, { requireSmooth: true }).eligible, false);
});
test('signed percent and degree slope parsing reject invalid input', () => {
  assert.equal(parseInclinePercent('-6%'), -6);
  assert.equal(parseInclinePercent('3,5%'), 3.5);
  assert.ok(Math.abs(parseInclinePercent('-45°') + 100) < 1e-10);
  for (const value of [null,'up','6garbage','90°','Infinity']) assert.equal(parseInclinePercent(value), null);
});
test('uphill and downhill limits follow reverse traversal', () => {
  const directional = { maxUphillSlope: 6, maxDownhillSlope: 3 };
  assert.equal(assessEdge(base, directional).eligible, true);
  assert.equal(assessEdge(reverseEdge(base), directional).eligible, false);
});
test('unknown stairs and expired elevators fail strict mode', () => {
  assert.equal(assessEdge({ ...base, stairs: undefined }, needs).eligible, false);
  const lift = { ...base, requiresElevator: true, elevator: { status: 'working', authoritative: true, freshness: 'current', updatedAt: new Date(Date.now() - 600_000).toISOString() } };
  assert.equal(assessEdge(lift, { requireElevator: true }).eligible, false);
  assert.equal(assessEdge({ ...lift, elevator: { ...lift.elevator, status: 'out' } }, { requireElevator: true, unknownPolicy: 'allow' }).eligible, false);
});
const nodes = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), { id: String(i), coordinates: [-74 + i * .001, 40.7] }]));
for (const [profile, weights] of Object.entries(PROFILE_WEIGHTS)) test(`segmentation invariance: ${profile}, with a repeated real crossing`, () => {
  const edge = { ...base, from: '0', to: '10', crossing: 1, crossingEventId: 'crossing-42', requiresCurbRamp: true, curbRamp: true, reports: 1, reportEventId: 'report-1', surface: 'rough', shade: .1, covered: false, lit: false };
  const split = Array.from({length:10}, (_, i) => ({ ...edge, id: `split-${i}`, from: String(i), to: String(i+1), minutes: 1, distanceMeters: 75, bidirectional: false }));
  const settings = { preferSmooth: true, preferShade: true, avoidRain: true };
  const weather = { isRaining: true, temperatureF: 90 };
  const whole = dijkstra(nodes, [edge], '0','10', settings, weather, weights);
  const pieces = dijkstra(nodes, split, '0','10', settings, weather, weights);
  assert.ok(Math.abs(whole.score - pieces.score) < 1e-9, 'generalized minutes tolerance is 1e-9');
  assert.equal(summarizeRoute(whole,[edge]).minutes, summarizeRoute(pieces,split).minutes);
});
test('hand-calculated cost and shortest path', () => {
  const weights = Object.fromEntries(Object.keys(PROFILE_WEIGHTS.fastest).map(key => [key, key === 'label' ? 'Time only' : key === 'time' ? 1 : 0]));
  const graphNodes = { a: {}, b: {}, c: {}, d: {} };
  const edges = [{...base,id:'ab',from:'a',to:'b',minutes:2}, {...base,id:'bd',from:'b',to:'d',minutes:3}, {...base,id:'ac',from:'a',to:'c',minutes:4}, {...base,id:'cd',from:'c',to:'d',minutes:2}];
  const result = dijkstra(graphNodes,edges,'a','d',{}, {},weights);
  assert.deepEqual(result.edgeIds,['ab','bd']); assert.equal(result.score,5);
  assert.equal(dijkstra({a:{}, b:{}},[], 'a','b',{}, {},weights),null);
});
test('adverse exposure monotonicity and constraint set containment', () => {
  for (let slope=0; slope<12; slope++) {
    assert.ok(edgeCost({...base,slope:slope+1},{},{},PROFILE_WEIGHTS.balanced) >= edgeCost({...base,slope},{},{},PROFILE_WEIGHTS.balanced));
    if (assessEdge({...base,slope},{maxSlope:3}).eligible) assert.equal(assessEdge({...base,slope},{maxSlope:6}).eligible,true);
  }
});
test('invalid numbers excluded and zero-length edges terminate', () => {
  for (const minutes of [-1,NaN,Infinity]) assert.equal(edgeCost({...base,minutes},{},{},PROFILE_WEIGHTS.fastest),Infinity);
  assert.equal(edgeCost({...base,distanceMeters:NaN},{},{},PROFILE_WEIGHTS.fastest),Infinity);
  const zero = [{...base,id:'z',from:'a',to:'b',minutes:0,distanceMeters:0}];
  assert.equal(dijkstra({a:{},b:{}},zero,'a','b',{},{}).score,0);
  assert.throws(()=>dijkstra({a:{},b:{}},[...zero,...zero],'a','b',{},{}),/Duplicate edge/);
});
const payload = { elements: [
  {type:'node',id:1,lon:-74,lat:40.7,tags:{kerb:'lowered'}},
  {type:'node',id:2,lon:-73.9995,lat:40.7},
  {type:'node',id:3,lon:-73.999,lat:40.7,tags:{kerb:'raised'}},
  {type:'way',id:5,nodes:[1,2,3],tags:{highway:'footway',footway:'crossing',incline:'-2%','oneway:foot':'-1'}}
]};
test('OSM crossing refers to physical ends across intermediate nodes', () => {
  const graph = parseOverpassGraph(payload);
  for (const edge of graph.edges) {
    assert.equal(edge.curbEvidence.state,'violated');
    assert.equal(edge.curbEvidence.endpoints[0].id,'osm-node-3');
    assert.equal(edge.slope,2); assert.equal(edge.bidirectional,false);
  }
  assert.equal(dijkstra(graph.nodes,graph.edges,'osm-node-1','osm-node-3',{},{}),null);
});
test('endpoint splits conserve metrics and metadata without mutating the source', () => {
  const graph = parseOverpassGraph(payload);
  const copy = JSON.stringify(graph);
  const attached = connectRouteEndpoints(graph.nodes,graph.edges,{coordinates:[-73.9992,40.7]},{coordinates:[-73.9998,40.7]});
  assert.equal(attached.failure,null);
  assert.ok(Math.abs(attached.edges.reduce((s,e)=>s+e.distanceMeters,0)-graph.edges.reduce((s,e)=>s+e.distanceMeters,0))<1e-9);
  assert.ok(Math.abs(attached.edges.reduce((s,e)=>s+e.minutes,0)-graph.edges.reduce((s,e)=>s+e.minutes,0))<1e-9);
  for (const edge of attached.edges) { assert.equal(edge.curbEvidence.state,'violated'); assert.equal(edge.crossingEventId,'crossing-way-5'); }
  assert.equal(JSON.stringify(graph),copy);
  assert.deepEqual(connectRouteEndpoints(graph.nodes,graph.edges,{coordinates:[-73.9992,40.7]},{coordinates:[-73.9998,40.7]}),attached);
});
test('bridge and street geometry do not join by 2D proximity', () => {
  const crossing = parseOverpassGraph({elements:[...payload.elements.slice(0,3),
    {type:'node',id:4,lon:-73.9995,lat:40.6995},{type:'node',id:6,lon:-73.9995,lat:40.7005},
    {type:'way',id:1,nodes:[1,3],tags:{highway:'footway'}},
    {type:'way',id:2,nodes:[4,6],tags:{highway:'footway',bridge:'yes',layer:'1'}}]});
  assert.equal(dijkstra(crossing.nodes,crossing.edges,'osm-node-1','osm-node-6',{},{}),null);
  const attached = connectRouteEndpoints(crossing.nodes,crossing.edges,{coordinates:[-73.9995,40.7002]},{coordinates:[-73.9995,40.7004]});
  assert.ok(attached.failure);
});
test('distance-weighted coverage is invariant under splitting', () => {
  const whole = summarizeEvidence([{...base,slope:null}],needs);
  const pieces = summarizeEvidence(Array.from({length:10},()=>({...base,slope:null,minutes:1,distanceMeters:75})),needs);
  assert.equal(whole.unknownDistanceMeters,pieces.unknownDistanceMeters); assert.equal(whole.knownFraction,0);
});
test('route model and navigation validation preserve reverse slope and uncertainty', () => {
  const edge = {...base, geometry:[[-74,40.7],[-73.99,40.7]], slope:null};
  const route = normalizeWalkingRoute({key:'test',route:{traversals:[{edgeId:'edge',reverse:true}]}},{edges:[edge],needs:{maxSlope:6,unknownPolicy:'allow'}});
  assert.equal(route.evidence.status,'unknown');
  assert.equal(route.legs[0].from.id,'b');
  assert.equal(validateRouteOption(route,{needs:{maxSlope:6}}).valid,false);
  assert.equal(validateRouteOption(route,{needs:{maxSlope:6,unknownPolicy:'allow'}}).valid,true);
});
test('distinct no-route diagnoses', () => {
  const n={a:{},b:{}};
  assert.equal(diagnoseNoRoute(n,[{...base,slope:null}],'a','b',{maxSlope:6}).code,'INSUFFICIENT_EVIDENCE');
  assert.equal(diagnoseNoRoute(n,[{...base,slope:9}],'a','b',{maxSlope:6}).code,'NO_FEASIBLE_ROUTE');
  assert.equal(diagnoseNoRoute(n,[],'a','b',{}).code,'INCOMPLETE_COVERAGE');
});
console.log(`${checks} evidence, cost, topology and contract regression groups passed.`);

// Separate facility completeness regression: an explicit working label cannot
// compensate for an equipment record absent from a required station path.
const { normalizeAccessiblePath } = await import('./elevator-status.js');
const facilityTime = new Date().toISOString();
const incompletePath = normalizeAccessiblePath({id:'path',complete:true,status:'working',freshness:'current',updatedAt:facilityTime,equipmentCodes:['first','missing']},new Map([['first',{status:'working',freshness:'current',updatedAt:facilityTime}]]));
assert.equal(incompletePath.status,'unknown');
assert.notEqual(incompletePath.freshness,'current');
console.log('PASS missing required equipment cannot be promoted to working');

test('subdivision cannot reverse a meaningful route ranking', () => {
  for (const weights of Object.values(PROFILE_WEIGHTS)) {
    const n = {a:{}, b:{}, c:{}, d:{}};
    const preferred = {...base, id:'direct',from:'a',to:'d',minutes:5,distanceMeters:375,crossing:1,crossingEventId:'real-crossing'};
    const worse = {...preferred,id:'detour',minutes:12,distanceMeters:900,crossingEventId:'other-crossing'};
    const pieces = [{...preferred,id:'ab',to:'b',minutes:2,distanceMeters:150},{...preferred,id:'bc',from:'b',to:'c',minutes:1,distanceMeters:75},{...preferred,id:'cd',from:'c',minutes:2,distanceMeters:150}];
    const before = dijkstra(n,[preferred,worse],'a','d',{}, {},weights);
    const after = dijkstra(n,[...pieces,worse],'a','d',{}, {},weights);
    assert.deepEqual(before.edgeIds,['direct']); assert.deepEqual(after.edgeIds,['ab','bc','cd']);
    assert.ok(Math.abs(before.score-after.score)<1e-9);
    assert.equal(summarizeRoute(after,[...pieces,worse]).crossings,1);
  }
});

test('event-state search matches independent Bellman-Ford on 40 cyclic graphs', () => {
  let seed = 123456;
  const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; };
  const weights = Object.fromEntries(Object.keys(PROFILE_WEIGHTS.fastest).map(key => [key, key === 'label' ? 'Reference' : key === 'time' ? 1 : key === 'crossing' ? 5 : 0]));
  for (let run = 0; run < 40; run++) {
    const n = Object.fromEntries(Array.from({length:6},(_,i)=>[String(i),{}]));
    const e = Array.from({length:12},(_,i)=>({...base,id:`r${i}`,from:String(random(6)),to:String(random(6)),minutes:random(5),crossing:1,crossingEventId:`c${random(3)}`,bidirectional:Boolean(random(2))}));
    const dist = Array(48).fill(Infinity); dist[0]=0;
    for (let pass=0; pass<47; pass++) {
      let changed=false;
      for (const edge of e) for (const [a,b] of [[+edge.from,+edge.to],...(edge.bidirectional?[[+edge.to,+edge.from]]:[])]) for(let mask=0;mask<8;mask++) {
        const bit=1 << Number(edge.crossingEventId.slice(1));
        const from=a*8+mask, to=b*8+(mask|bit);
        const cost=edge.minutes + (mask&bit?0:5);
        if(dist[from]+cost<dist[to]) { dist[to]=dist[from]+cost; changed=true; }
      }
      if(!changed)break;
    }
    const expected=Math.min(...dist.slice(40,48));
    const actual=dijkstra(n,e,'0','5',{}, {},weights);
    assert.equal(actual?.score ?? Infinity,expected,`independent event graph ${run}`);
  }
});
