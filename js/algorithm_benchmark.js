
const fs = require('fs');
const path = require('path');

global.window = {};
global.performance = {
    now: () => Number(process.hrtime.bigint()) / 1e6
};

const projectRoot = path.resolve(__dirname, '..');
const pathfindingSource = fs.readFileSync(path.join(projectRoot, 'js', 'pathfinding.js'), 'utf8');
eval(pathfindingSource);

const Pathfinding = window.MetroPathfinding;
const fallbackData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'cta_rail_fallback.json'), 'utf8'));
const network = Pathfinding.createNetworkFromFallback(fallbackData);
const algorithms = ['BFS', 'DFS', 'Dijkstra', 'A* Lp(p=2)', 'Greedy Best-First'];

function stationName(id) {
    const station = network.stations.find(candidate => candidate.id === id);
    return station ? station.name : id;
}

function emptyStats() {
    return {
        pairs: 0,
        found: 0,
        failed: 0,
        optimal: 0,
        totalAccuracy: 0,
        totalCostRatio: 0,
        totalExtraMinutes: 0,
        totalExpanded: 0,
        totalRuntime: 0,
        totalExpandedVsDijkstra: 0,
        totalRuntimeVsDijkstra: 0,
        totalExpandedRatioVsDijkstra: 0,
        totalRuntimeRatioVsDijkstra: 0,
        worstAccuracy: Infinity,
        worstPair: null
    };
}

function addResult(stats, result, dijkstra, start, end) {
    stats.pairs++;
    if (!result.found || !Number.isFinite(result.costMinutes)) {
        stats.failed++;
        return;
    }

    const accuracy = Math.min(100, (dijkstra.costMinutes / result.costMinutes) * 100);
    const costRatio = result.costMinutes / dijkstra.costMinutes;
    const extraMinutes = result.costMinutes - dijkstra.costMinutes;

    stats.found++;
    stats.totalAccuracy += accuracy;
    stats.totalCostRatio += costRatio;
    stats.totalExtraMinutes += extraMinutes;
    stats.totalExpanded += result.nodesExpanded;
    stats.totalRuntime += result.runtimeMs;
    stats.totalExpandedVsDijkstra += result.nodesExpanded - dijkstra.nodesExpanded;
    stats.totalRuntimeVsDijkstra += result.runtimeMs - dijkstra.runtimeMs;
    stats.totalExpandedRatioVsDijkstra += result.nodesExpanded / dijkstra.nodesExpanded;
    stats.totalRuntimeRatioVsDijkstra += dijkstra.runtimeMs > 0 ? result.runtimeMs / dijkstra.runtimeMs : 1;

    if (Math.abs(result.costMinutes - dijkstra.costMinutes) < 1e-9) {
        stats.optimal++;
    }

    if (accuracy < stats.worstAccuracy) {
        stats.worstAccuracy = accuracy;
        stats.worstPair = {
            from: stationName(start.id),
            to: stationName(end.id),
            optimalMinutes: Number(dijkstra.costMinutes.toFixed(4)),
            resultMinutes: Number(result.costMinutes.toFixed(4)),
            dijkstraExpanded: dijkstra.nodesExpanded,
            resultExpanded: result.nodesExpanded
        };
    }
}

function summarize(name, stats) {
    return {
        algorithm: name,
        found: stats.found,
        failed: stats.failed,
        optimalPct: Number((stats.optimal / stats.found * 100).toFixed(2)),
        avgAccuracyPct: Number((stats.totalAccuracy / stats.found).toFixed(2)),
        avgCostRatio: Number((stats.totalCostRatio / stats.found).toFixed(4)),
        avgExtraMinutes: Number((stats.totalExtraMinutes / stats.found).toFixed(4)),
        avgExpanded: Number((stats.totalExpanded / stats.found).toFixed(2)),
        avgExpandedVsDijkstra: Number((stats.totalExpandedVsDijkstra / stats.found).toFixed(2)),
        avgExpandedRatioVsDijkstra: Number((stats.totalExpandedRatioVsDijkstra / stats.found).toFixed(4)),
        avgRuntimeMs: Number((stats.totalRuntime / stats.found).toFixed(4)),
        avgRuntimeVsDijkstraMs: Number((stats.totalRuntimeVsDijkstra / stats.found).toFixed(4)),
        avgRuntimeRatioVsDijkstra: Number((stats.totalRuntimeRatioVsDijkstra / stats.found).toFixed(4)),
        worstAccuracyPct: Number(stats.worstAccuracy.toFixed(2)),
        worstPair: stats.worstPair
    };
}

function runBenchmark() {
    const statsByAlgorithm = new Map(algorithms.map(name => [name, emptyStats()]));
    let orderedPairs = 0;
    let reachablePairs = 0;
    const startedAt = performance.now();

    for (const start of network.stations) {
        for (const end of network.stations) {
            if (start.id === end.id) continue;
            orderedPairs++;

            const startNode = Pathfinding.nearestRailNode(start, network.railNodes);
            const endNode = Pathfinding.nearestRailNode(end, network.railNodes);
            if (!startNode || !endNode) continue;

            const results = Pathfinding.compareAlgorithms(
                startNode.nodeId,
                endNode.nodeId,
                network.railNodes,
                network.railGraph
            );
            const dijkstra = results.find(result => result.algorithm === 'Dijkstra');
            if (!dijkstra || !dijkstra.found || !Number.isFinite(dijkstra.costMinutes)) continue;

            reachablePairs++;
            results
                .filter(result => statsByAlgorithm.has(result.algorithm))
                .forEach(result => addResult(statsByAlgorithm.get(result.algorithm), result, dijkstra, start, end));
        }
    }

    return {
        stations: network.stations.length,
        orderedPairs,
        reachablePairs,
        unreachablePairs: orderedPairs - reachablePairs,
        runtimeMs: Number((performance.now() - startedAt).toFixed(2)),
        rows: algorithms.map(name => summarize(name, statsByAlgorithm.get(name)))
    };
}

console.log(JSON.stringify(runBenchmark(), null, 2));
