// @ts-check
import { dijkstra, PROFILE_WEIGHTS } from './routing.js';

/** @param {import('./domain.js').Nodes} nodes @param {import('./domain.js').Edge[]} edges
 * @param {string} start @param {string} end @param {import('./domain.js').Needs} needs
 * @param {import('./domain.js').Weather} weather */
export function diagnoseNoRoute(nodes, edges, start, end, needs, weather = {}) {
  if (dijkstra(nodes, edges, start, end, { ...needs, unknownPolicy: 'allow' }, weather, PROFILE_WEIGHTS.fastest)) {
    return { code: 'INSUFFICIENT_EVIDENCE', message: 'Missing evidence prevents confirmation of your selected requirements. Inspect your settings to explicitly allow unknown conditions, or choose endpoints with better documented access.' };
  }
  if (dijkstra(nodes, edges.map(edge => ({ ...edge, blocked: false })), start, end, {}, weather, PROFILE_WEIGHTS.fastest)) {
    return { code: 'NO_FEASIBLE_ROUTE', message: 'Mapped paths within the searched corridor violate a mandatory requirement. No feasible route was found within this coverage.' };
  }
  return { code: 'INCOMPLETE_COVERAGE', message: 'The searched map corridor does not contain a connected path. A route outside this coverage may exist.' };
}
