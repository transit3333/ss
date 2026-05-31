// Pathfinding and rail-network helpers for the real-map UI.

(function () {
    const TRAIN_SPEED_KMH = 70;
    const TRANSFER_WEIGHT = 0.01;
    const METERS_PER_MINUTE = TRAIN_SPEED_KMH * 1000 / 60;
    const LP_HEURISTIC_POWERS = [2];

    function formatDistance(meters) {
        if (!Number.isFinite(meters)) return '--';
        if (meters < 1000) return `${Math.round(meters)} m`;
        return `${(meters / 1000).toFixed(2)} km`;
    }

    function formatMinutes(minutes) {
        if (!Number.isFinite(minutes)) return '--';
        return `${minutes.toFixed(2)} min`;
    }

    function distanceMeters(a, b) {
        const earthRadius = 6371000;
        const lat1 = a.lat * Math.PI / 180;
        const lat2 = b.lat * Math.PI / 180;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const sinLat = Math.sin(dLat / 2);
        const sinLng = Math.sin(dLng / 2);
        const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
        return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function edgeCostMinutes(edge) {
        return (edge.weight / METERS_PER_MINUTE) + (edge.transfer ? TRANSFER_WEIGHT : 0);
    }

    function pathDistanceMeters(path, railGraph) {
        let total = 0;
        for (let i = 1; i < path.length; i++) {
            const edge = (railGraph.get(path[i - 1]) || []).find(item => item.to === path[i]);
            if (edge) total += edge.weight;
        }
        return total;
    }

    function pathCostMinutes(path, railGraph) {
        let stateCosts = new Map([[null, 0]]);
        for (let i = 1; i < path.length; i++) {
            const edges = (railGraph.get(path[i - 1]) || []).filter(item => item.to === path[i]);
            const nextCosts = new Map();
            edges.forEach(edge => {
                stateCosts.forEach((cost, previousLine) => {
                    const transferCost = previousLine && edge.line && previousLine !== edge.line ? TRANSFER_WEIGHT : 0;
                    const candidate = cost + edgeCostMinutes(edge) + transferCost;
                    if (!nextCosts.has(edge.line) || candidate < nextCosts.get(edge.line)) {
                        nextCosts.set(edge.line, candidate);
                    }
                });
            });
            stateCosts = nextCosts;
            if (stateCosts.size === 0) return Infinity;
        }
        return Math.min(...stateCosts.values());
    }

    function railEdgeKey(line, fromId, toId) {
        return `${line || ''}:${[fromId, toId].sort().join('|')}`;
    }

    function buildRailGraph(railWays, railNodes, unusableEdgeKeys = new Set()) {
        const blocked = unusableEdgeKeys instanceof Set ? unusableEdgeKeys : new Set(unusableEdgeKeys || []);
        const graph = new Map();
        railWays.forEach(way => {
            for (let i = 1; i < way.nodes.length; i++) {
                const fromId = way.nodes[i - 1];
                const toId = way.nodes[i];
                const from = railNodes.get(fromId);
                const to = railNodes.get(toId);
                if (!from || !to) continue;

                const line = way.routeId || way.id;
                const key = railEdgeKey(line, fromId, toId);
                if (blocked.has(key)) continue;

                const weight = Number.isFinite(way.segmentWeights?.[i - 1])
                    ? way.segmentWeights[i - 1]
                    : distanceMeters(from, to);
                const edgeBase = { key, weight, line, transfer: false };
                if (!graph.has(fromId)) graph.set(fromId, []);
                if (!graph.has(toId)) graph.set(toId, []);
                graph.get(fromId).push({ to: toId, ...edgeBase });
                graph.get(toId).push({ to: fromId, ...edgeBase });
            }
        });
        return graph;
    }

    function createNetworkFromFallback(data) {
        const stations = (data.stations || [])
            .filter(station => station.id && Number.isFinite(station.lat) && Number.isFinite(station.lng));
        const railNodes = new Map((data.railNodes || stations)
            .filter(node => node.id && Number.isFinite(node.lat) && Number.isFinite(node.lng))
            .map(node => [node.id, node]));
        const railWays = (data.railWays || [])
            .filter(way => way.id && Array.isArray(way.nodes) && way.nodes.length > 1)
            .map(way => ({
                ...way,
                segmentWeights: Array.isArray(way.segmentWeights) ? way.segmentWeights : []
            }));
        return {
            stations,
            railNodes,
            railWays,
            railGraph: buildRailGraph(railWays, railNodes)
        };
    }

    function nearestPoint(latLng, points) {
        if (!points || points.length === 0) return null;
        return points
            .map(point => ({
                id: point.id,
                distance: distanceMeters(latLng, point)
            }))
            .sort((a, b) => a.distance - b.distance)[0];
    }

    function nearestRailNode(latLng, railNodes) {
        let nearest = null;
        railNodes.forEach(node => {
            const distance = distanceMeters(latLng, node);
            if (!nearest || distance < nearest.distance) {
                nearest = { nodeId: node.id, distance };
            }
        });
        return nearest;
    }

    function reconstruct(previous, endId) {
        const path = [];
        let cursor = endId;
        while (cursor) {
            path.unshift(cursor);
            cursor = previous.get(cursor);
        }
        return path;
    }

    function stateKey(nodeId, line) {
        return `${nodeId}::${line || ''}`;
    }

    function reconstructState(previous, endKey) {
        const path = [];
        let cursor = endKey;
        while (cursor) {
            const item = previous.get(cursor);
            path.unshift(item?.nodeId || cursor.split('::')[0]);
            cursor = item?.previousKey;
        }
        return path.filter((nodeId, index) => index === 0 || nodeId !== path[index - 1]);
    }

    function finalizeSearch({ algorithm, startId, endId, path, nodesExpanded, railGraph, startedAt }) {
        if (!path || path[0] !== startId || path[path.length - 1] !== endId) {
            return {
                algorithm,
                found: false,
                path: [],
                distance: Infinity,
                costMinutes: Infinity,
                nodesExpanded,
                runtimeMs: performance.now() - startedAt
            };
        }

        return {
            algorithm,
            found: true,
            path,
            distance: pathDistanceMeters(path, railGraph),
            costMinutes: pathCostMinutes(path, railGraph),
            nodesExpanded,
            runtimeMs: performance.now() - startedAt
        };
    }

    function bfs(startId, endId, railGraph) {
        const startedAt = performance.now();
        const queue = [startId];
        const visited = new Set([startId]);
        const previous = new Map();
        let nodesExpanded = 0;

        while (queue.length > 0) {
            const current = queue.shift();
            nodesExpanded++;
            if (current === endId) break;
            (railGraph.get(current) || []).forEach(edge => {
                if (visited.has(edge.to)) return;
                visited.add(edge.to);
                previous.set(edge.to, current);
                queue.push(edge.to);
            });
        }

        return finalizeSearch({
            algorithm: 'BFS',
            startId,
            endId,
            path: visited.has(endId) ? reconstruct(previous, endId) : null,
            nodesExpanded,
            railGraph,
            startedAt
        });
    }

    function dfs(startId, endId, railGraph) {
        const startedAt = performance.now();
        const stack = [startId];
        const visited = new Set();
        const previous = new Map();
        let nodesExpanded = 0;

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current);
            nodesExpanded++;
            if (current === endId) break;

            [...(railGraph.get(current) || [])].reverse().forEach(edge => {
                if (visited.has(edge.to)) return;
                if (!previous.has(edge.to)) previous.set(edge.to, current);
                stack.push(edge.to);
            });
        }

        return finalizeSearch({
            algorithm: 'DFS',
            startId,
            endId,
            path: visited.has(endId) ? reconstruct(previous, endId) : null,
            nodesExpanded,
            railGraph,
            startedAt
        });
    }

    function shortestPath(startId, endId, railGraph, heuristic = () => 0, algorithm = 'Dijkstra', greedyPriority = false) {
        const startedAt = performance.now();
        const distances = new Map();
        const previous = new Map();
        const startKey = stateKey(startId, null);
        const open = [{ id: startId, line: null, key: startKey, priority: heuristic(startId), cost: 0 }];
        const closed = new Set();
        let nodesExpanded = 0;
        let endKey = null;

        distances.set(startKey, 0);

        while (open.length > 0) {
            open.sort((a, b) => a.priority - b.priority);
            const current = open.shift();
            if (closed.has(current.key)) continue;
            closed.add(current.key);
            nodesExpanded++;

            if (current.id === endId) {
                endKey = current.key;
                break;
            }

            (railGraph.get(current.id) || []).forEach(edge => {
                const transferCost = current.line && edge.line && current.line !== edge.line ? TRANSFER_WEIGHT : 0;
                const candidate = distances.get(current.key) + edgeCostMinutes(edge) + transferCost;
                const nextKey = stateKey(edge.to, edge.line);
                if (!distances.has(nextKey) || candidate < distances.get(nextKey)) {
                    distances.set(nextKey, candidate);
                    previous.set(nextKey, { previousKey: current.key, nodeId: edge.to });
                    open.push({
                        id: edge.to,
                        line: edge.line,
                        key: nextKey,
                        cost: candidate,
                        priority: greedyPriority ? heuristic(edge.to) : candidate + heuristic(edge.to)
                    });
                }
            });
        }

        const path = endKey ? reconstructState(previous, endKey) : null;
        const result = finalizeSearch({
            algorithm,
            startId,
            endId,
            path,
            nodesExpanded,
            railGraph,
            startedAt
        });
        if (result.found) result.costMinutes = distances.get(endKey);
        return result;
    }

    function projectedDeltaMeters(a, b) {
        const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
        const dx = (b.lng - a.lng) * Math.PI / 180 * 6371000 * Math.cos(meanLat);
        const dy = (b.lat - a.lat) * Math.PI / 180 * 6371000;
        return { dx: Math.abs(dx), dy: Math.abs(dy) };
    }

    function lpHeuristic(railNodes, endId, p = 2) {
        const target = railNodes.get(endId);
        return nodeId => {
            const node = railNodes.get(nodeId);
            if (!node || !target) return 0;
            const { dx, dy } = projectedDeltaMeters(node, target);
            return ((dx ** p + dy ** p) ** (1 / p)) / METERS_PER_MINUTE;
        };
    }

    function astarLp(startId, endId, railNodes, railGraph, p) {
        return shortestPath(
            startId,
            endId,
            railGraph,
            lpHeuristic(railNodes, endId, p),
            `A* Lp(p=${p})`
        );
    }

    function greedyBestFirst(startId, endId, railNodes, railGraph) {
        return shortestPath(
            startId,
            endId,
            railGraph,
            lpHeuristic(railNodes, endId, 2),
            'Greedy Best-First',
            true
        );
    }

    function compareAlgorithms(startId, endId, railNodes, railGraph) {
        const dijkstra = shortestPath(startId, endId, railGraph, () => 0, 'Dijkstra');
        const baseline = dijkstra.found ? dijkstra.costMinutes : Infinity;
        const results = [
            bfs(startId, endId, railGraph),
            dfs(startId, endId, railGraph),
            dijkstra,
            ...LP_HEURISTIC_POWERS.map(p => astarLp(startId, endId, railNodes, railGraph, p)),
            greedyBestFirst(startId, endId, railNodes, railGraph)
        ];

        return results.map(result => {
            const accuracyPct = result.found && Number.isFinite(baseline) && result.costMinutes > 0
                ? Math.min(100, (baseline / result.costMinutes) * 100)
                : 0;
            return {
                ...result,
                accuracyPct,
                optimal: result.found && Math.abs(result.costMinutes - baseline) < 1e-9
            };
        });
    }

    function findRailPath(startStationId, endStationId, stations, railNodes, railGraph, algorithm = 'dijkstra') {
        const startStation = stations.find(station => station.id === startStationId);
        const endStation = stations.find(station => station.id === endStationId);
        if (!startStation || !endStation || railGraph.size === 0) return null;

        const startNode = nearestRailNode(startStation, railNodes);
        const endNode = nearestRailNode(endStation, railNodes);
        if (!startNode || !endNode) return null;

        const lpMatch = /^astar-lp(?:-(\d+(?:\.\d+)?))?$/.exec(algorithm);
        const search =
            algorithm === 'bfs' ? bfs(startNode.nodeId, endNode.nodeId, railGraph) :
            algorithm === 'dfs' ? dfs(startNode.nodeId, endNode.nodeId, railGraph) :
            lpMatch ? astarLp(startNode.nodeId, endNode.nodeId, railNodes, railGraph, Number(lpMatch[1] || 2)) :
            algorithm === 'greedy' ? greedyBestFirst(startNode.nodeId, endNode.nodeId, railNodes, railGraph) :
            shortestPath(startNode.nodeId, endNode.nodeId, railGraph, () => 0, 'Dijkstra');
        if (!search.found) return null;

        return {
            ...search,
            distance: search.distance + startNode.distance + endNode.distance,
            costMinutes: search.costMinutes + (startNode.distance + endNode.distance) / METERS_PER_MINUTE
        };
    }

    window.MetroPathfinding = {
        TRAIN_SPEED_KMH,
        TRANSFER_WEIGHT,
        LP_HEURISTIC_POWERS,
        formatDistance,
        formatMinutes,
        distanceMeters,
        railEdgeKey,
        buildRailGraph,
        createNetworkFromFallback,
        nearestPoint,
        nearestRailNode,
        findRailPath,
        compareAlgorithms
    };
})();
