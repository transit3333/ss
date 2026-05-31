#include "pathfinding.hpp"
#include "cta_fallback_data.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <deque>
#include <functional>
#include <iomanip>
#include <limits>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

namespace metro {
namespace {

constexpr double kEarthRadiusMeters = 6371000.0;
constexpr double kPi = 3.14159265358979323846;
constexpr double kTrainSpeedKmh = 70.0;
constexpr double kTransferWeight = 0.01;
constexpr double kMetersPerMinute = kTrainSpeedKmh * 1000.0 / 60.0;

const std::vector<double>& lpHeuristicPowers() {
    static const std::vector<double> powers = {2.0};
    return powers;
}

double radians(double degrees) {
    return degrees * kPi / 180.0;
}

const Point* findPoint(const std::vector<Point>& points, const std::string& id) {
    auto it = std::find_if(points.begin(), points.end(), [&](const Point& point) {
        return point.id == id;
    });
    return it == points.end() ? nullptr : &(*it);
}

double edgeCostMinutes(const Edge& edge) {
    return (edge.weight / kMetersPerMinute) + (edge.transfer ? kTransferWeight : 0.0);
}

double pathDistanceMeters(
    const std::vector<std::string>& path,
    const std::unordered_map<std::string, std::vector<Edge>>& graph
) {
    double total = 0.0;
    for (std::size_t i = 1; i < path.size(); ++i) {
        const std::string& from = path[i - 1];
        const std::string& to = path[i];
        auto edgeIt = graph.find(from);
        if (edgeIt == graph.end()) continue;
        for (const Edge& edge : edgeIt->second) {
            if (edge.to == to) {
                total += edge.weight;
                break;
            }
        }
    }
    return total;
}

double pathCostMinutes(
    const std::vector<std::string>& path,
    const std::unordered_map<std::string, std::vector<Edge>>& graph
) {
    std::unordered_map<std::string, double> stateCosts;
    stateCosts[""] = 0.0;
    for (std::size_t i = 1; i < path.size(); ++i) {
        const std::string& from = path[i - 1];
        const std::string& to = path[i];
        auto edgeIt = graph.find(from);
        if (edgeIt == graph.end()) return std::numeric_limits<double>::infinity();

        std::unordered_map<std::string, double> nextCosts;
        for (const Edge& edge : edgeIt->second) {
            if (edge.to != to) continue;
            for (const auto& state : stateCosts) {
                const std::string& previousLine = state.first;
                const double transferCost =
                    !previousLine.empty() && !edge.line.empty() && previousLine != edge.line
                        ? kTransferWeight
                        : 0.0;
                const double candidate = state.second + edgeCostMinutes(edge) + transferCost;
                auto nextIt = nextCosts.find(edge.line);
                if (nextIt == nextCosts.end() || candidate < nextIt->second) {
                    nextCosts[edge.line] = candidate;
                }
            }
        }
        if (nextCosts.empty()) return std::numeric_limits<double>::infinity();
        stateCosts.swap(nextCosts);
    }
    double best = std::numeric_limits<double>::infinity();
    for (const auto& state : stateCosts) best = std::min(best, state.second);
    return best;
}

std::vector<std::string> reconstruct(
    const std::unordered_map<std::string, std::string>& previous,
    const std::string& endId
) {
    std::vector<std::string> path;
    std::string cursor = endId;
    while (!cursor.empty()) {
        path.push_back(cursor);
        auto prevIt = previous.find(cursor);
        if (prevIt == previous.end()) break;
        cursor = prevIt->second;
    }
    std::reverse(path.begin(), path.end());
    return path;
}

std::string stateKey(const std::string& nodeId, const std::string& line) {
    return nodeId + "::" + line;
}

struct PreviousState {
    std::string previousKey;
    std::string nodeId;
};

std::vector<std::string> reconstructState(
    const std::unordered_map<std::string, PreviousState>& previous,
    const std::string& endKey
) {
    std::vector<std::string> path;
    std::string cursor = endKey;
    while (!cursor.empty()) {
        auto prevIt = previous.find(cursor);
        const std::string nodeId =
            prevIt == previous.end()
                ? cursor.substr(0, cursor.find("::"))
                : prevIt->second.nodeId;
        path.push_back(nodeId);
        cursor = prevIt == previous.end() ? "" : prevIt->second.previousKey;
    }
    std::reverse(path.begin(), path.end());
    path.erase(std::unique(path.begin(), path.end()), path.end());
    return path;
}

AlgorithmResult finalizeSearch(
    const std::string& algorithm,
    const std::string& startId,
    const std::string& endId,
    const std::vector<std::string>& path,
    std::size_t nodesExpanded,
    const std::unordered_map<std::string, std::vector<Edge>>& graph,
    const std::chrono::steady_clock::time_point& startedAt
) {
    const std::chrono::duration<double, std::milli> elapsed = std::chrono::steady_clock::now() - startedAt;
    AlgorithmResult result;
    result.algorithm = algorithm;
    result.nodesExpanded = nodesExpanded;
    result.runtimeMs = elapsed.count();

    if (path.empty() || path.front() != startId || path.back() != endId) {
        result.distance = std::numeric_limits<double>::infinity();
        result.costMinutes = std::numeric_limits<double>::infinity();
        return result;
    }

    result.found = true;
    result.path = path;
    result.distance = pathDistanceMeters(path, graph);
    result.costMinutes = pathCostMinutes(path, graph);
    return result;
}

AlgorithmResult bfs(
    const std::string& startId,
    const std::string& endId,
    const std::unordered_map<std::string, std::vector<Edge>>& graph
) {
    const std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();
    std::deque<std::string> queue;
    std::unordered_set<std::string> visited;
    std::unordered_map<std::string, std::string> previous;
    std::size_t nodesExpanded = 0;

    if (!graph.count(startId) || !graph.count(endId)) {
        return finalizeSearch("BFS", startId, endId, {}, nodesExpanded, graph, startedAt);
    }

    queue.push_back(startId);
    visited.insert(startId);

    while (!queue.empty()) {
        const std::string current = queue.front();
        queue.pop_front();
        ++nodesExpanded;
        if (current == endId) break;

        auto edgeIt = graph.find(current);
        if (edgeIt == graph.end()) continue;

        for (const Edge& edge : edgeIt->second) {
            if (visited.count(edge.to)) continue;
            visited.insert(edge.to);
            previous[edge.to] = current;
            queue.push_back(edge.to);
        }
    }

    return finalizeSearch(
        "BFS",
        startId,
        endId,
        visited.count(endId) ? reconstruct(previous, endId) : std::vector<std::string>(),
        nodesExpanded,
        graph,
        startedAt
    );
}

AlgorithmResult dfs(
    const std::string& startId,
    const std::string& endId,
    const std::unordered_map<std::string, std::vector<Edge>>& graph
) {
    const std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();
    std::vector<std::string> stack;
    std::unordered_set<std::string> visited;
    std::unordered_map<std::string, std::string> previous;
    std::size_t nodesExpanded = 0;

    if (!graph.count(startId) || !graph.count(endId)) {
        return finalizeSearch("DFS", startId, endId, {}, nodesExpanded, graph, startedAt);
    }

    stack.push_back(startId);

    while (!stack.empty()) {
        const std::string current = stack.back();
        stack.pop_back();
        if (visited.count(current)) continue;
        visited.insert(current);
        ++nodesExpanded;
        if (current == endId) break;

        auto edgeIt = graph.find(current);
        if (edgeIt == graph.end()) continue;

        for (std::vector<Edge>::const_reverse_iterator it = edgeIt->second.rbegin(); it != edgeIt->second.rend(); ++it) {
            if (visited.count(it->to)) continue;
            if (!previous.count(it->to)) previous[it->to] = current;
            stack.push_back(it->to);
        }
    }

    return finalizeSearch(
        "DFS",
        startId,
        endId,
        visited.count(endId) ? reconstruct(previous, endId) : std::vector<std::string>(),
        nodesExpanded,
        graph,
        startedAt
    );
}

AlgorithmResult weightedSearch(
    const std::string& startId,
    const std::string& endId,
    const std::unordered_map<std::string, std::vector<Edge>>& graph,
    const std::function<double(const std::string&)>& heuristic,
    const std::string& algorithm
) {
    const std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();
    struct SearchState {
        std::string nodeId;
        std::string line;
    };
    using QueueItem = std::pair<double, std::string>;
    std::priority_queue<QueueItem, std::vector<QueueItem>, std::greater<QueueItem>> queue;
    std::unordered_map<std::string, double> distance;
    std::unordered_map<std::string, SearchState> states;
    std::unordered_map<std::string, PreviousState> previous;
    std::unordered_set<std::string> closed;
    std::size_t nodesExpanded = 0;

    if (!graph.count(startId) || !graph.count(endId)) {
        return finalizeSearch(algorithm, startId, endId, {}, nodesExpanded, graph, startedAt);
    }

    const std::string startKey = stateKey(startId, "");
    std::string endKey;
    distance[startKey] = 0.0;
    states[startKey] = {startId, ""};
    queue.emplace(heuristic(startId), startKey);

    while (!queue.empty()) {
        const QueueItem top = queue.top();
        const std::string currentKey = top.second;
        queue.pop();

        if (closed.count(currentKey)) continue;
        closed.insert(currentKey);
        ++nodesExpanded;
        const SearchState current = states[currentKey];
        if (current.nodeId == endId) {
            endKey = currentKey;
            break;
        }

        auto edgeIt = graph.find(current.nodeId);
        if (edgeIt == graph.end()) continue;

        for (const Edge& edge : edgeIt->second) {
            const double transferCost =
                !current.line.empty() && !edge.line.empty() && current.line != edge.line
                    ? kTransferWeight
                    : 0.0;
            const double candidate = distance[currentKey] + edgeCostMinutes(edge) + transferCost;
            const std::string nextKey = stateKey(edge.to, edge.line);
            if (!distance.count(nextKey) || candidate < distance[nextKey]) {
                distance[nextKey] = candidate;
                states[nextKey] = {edge.to, edge.line};
                previous[nextKey] = {currentKey, edge.to};
                queue.emplace(candidate + heuristic(edge.to), nextKey);
            }
        }
    }

    const std::vector<std::string> path =
        !endKey.empty() && distance.count(endKey) && std::isfinite(distance[endKey])
            ? reconstructState(previous, endKey)
            : std::vector<std::string>();

    AlgorithmResult result = finalizeSearch(algorithm, startId, endId, path, nodesExpanded, graph, startedAt);
    if (result.found) result.costMinutes = distance[endKey];
    return result;
}

struct ProjectedDelta {
    double dx = 0.0;
    double dy = 0.0;
};

ProjectedDelta projectedDeltaMeters(const Point& a, const Point& b) {
    const double meanLat = radians((a.lat + b.lat) / 2.0);
    ProjectedDelta delta;
    delta.dx = std::abs(radians(b.lng - a.lng) * kEarthRadiusMeters * std::cos(meanLat));
    delta.dy = std::abs(radians(b.lat - a.lat) * kEarthRadiusMeters);
    return delta;
}

std::function<double(const std::string&)> lpHeuristic(
    const std::unordered_map<std::string, Point>& railNodes,
    const std::string& endId,
    double p
) {
    auto targetIt = railNodes.find(endId);
    if (targetIt == railNodes.end()) return [](const std::string&) { return 0.0; };
    const Point target = targetIt->second;

    return [railNodes, target, p](const std::string& nodeId) {
        auto nodeIt = railNodes.find(nodeId);
        if (nodeIt == railNodes.end()) return 0.0;
        const ProjectedDelta delta = projectedDeltaMeters(nodeIt->second, target);
        return std::pow(std::pow(delta.dx, p) + std::pow(delta.dy, p), 1.0 / p) / kMetersPerMinute;
    };
}

std::string formatPower(double p) {
    std::ostringstream out;
    if (std::abs(p - std::round(p)) < 1e-9) {
        out << static_cast<long long>(std::llround(p));
    } else {
        out << p;
    }
    return out.str();
}

AlgorithmResult astarLp(
    const std::string& startId,
    const std::string& endId,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& graph,
    double p
) {
    return weightedSearch(
        startId,
        endId,
        graph,
        lpHeuristic(railNodes, endId, p),
        "A* Lp(p=" + formatPower(p) + ")"
    );
}

std::function<double(const std::string&)> octileHeuristic(
    const std::unordered_map<std::string, Point>& railNodes,
    const std::string& endId
) {
    auto targetIt = railNodes.find(endId);
    if (targetIt == railNodes.end()) return [](const std::string&) { return 0.0; };
    const Point target = targetIt->second;

    return [railNodes, target](const std::string& nodeId) {
        auto nodeIt = railNodes.find(nodeId);
        if (nodeIt == railNodes.end()) return 0.0;
        const ProjectedDelta delta = projectedDeltaMeters(nodeIt->second, target);
        const double straight = std::abs(delta.dx - delta.dy);
        const double diagonal = std::sqrt(2.0) * std::min(delta.dx, delta.dy);
        return (straight + diagonal) / kMetersPerMinute;
    };
}

AlgorithmResult searchByName(
    const std::string& startId,
    const std::string& endId,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& graph,
    const std::string& algorithm
) {
    if (algorithm == "bfs") return bfs(startId, endId, graph);
    if (algorithm == "dfs") return dfs(startId, endId, graph);
    if (algorithm == "astar-lp") {
        return astarLp(startId, endId, railNodes, graph, 2.0);
    }
    const std::string astarLpPrefix = "astar-lp-";
    if (algorithm.compare(0, astarLpPrefix.size(), astarLpPrefix) == 0) {
        double p = 2.0;
        std::istringstream in(algorithm.substr(astarLpPrefix.size()));
        in >> p;
        if (!in || p <= 0.0) p = 2.0;
        return astarLp(startId, endId, railNodes, graph, p);
    }
    if (algorithm == "astar-octile") {
        return weightedSearch(startId, endId, graph, octileHeuristic(railNodes, endId), "A* Octile");
    }
    return weightedSearch(startId, endId, graph, [](const std::string&) { return 0.0; }, "Dijkstra");
}


} // namespace

double distanceMeters(const Point& a, const Point& b) {
    const double lat1 = radians(a.lat);
    const double lat2 = radians(b.lat);
    const double dLat = radians(b.lat - a.lat);
    const double dLng = radians(b.lng - a.lng);
    const double sinLat = std::sin(dLat / 2.0);
    const double sinLng = std::sin(dLng / 2.0);
    const double h = sinLat * sinLat + std::cos(lat1) * std::cos(lat2) * sinLng * sinLng;
    return kEarthRadiusMeters * 2.0 * std::atan2(std::sqrt(h), std::sqrt(1.0 - h));
}

std::string formatDistance(double meters) {
    std::ostringstream out;
    if (!std::isfinite(meters)) return "--";
    if (meters < 1000.0) {
        out << std::llround(meters) << " m";
    } else {
        out << std::fixed << std::setprecision(2) << (meters / 1000.0) << " km";
    }
    return out.str();
}

std::unordered_map<std::string, std::vector<Edge>> buildRailGraph(
    const std::vector<RailWay>& railWays,
    const std::unordered_map<std::string, Point>& railNodes
) {
    std::unordered_map<std::string, std::vector<Edge>> graph;

    for (const RailWay& way : railWays) {
        for (std::size_t i = 1; i < way.nodes.size(); ++i) {
            const std::string& fromId = way.nodes[i - 1];
            const std::string& toId = way.nodes[i];
            auto fromIt = railNodes.find(fromId);
            auto toIt = railNodes.find(toId);
            if (fromIt == railNodes.end() || toIt == railNodes.end()) continue;

            const double weight =
                i - 1 < way.segmentWeights.size() && std::isfinite(way.segmentWeights[i - 1])
                    ? way.segmentWeights[i - 1]
                    : distanceMeters(fromIt->second, toIt->second);
            const std::string line = way.routeId.empty() ? way.id : way.routeId;
            graph[fromId].push_back({toId, weight, line, false});
            graph[toId].push_back({fromId, weight, line, false});
        }
    }

    return graph;
}

RailNetwork createFallbackNetwork() {
    return createStaticCtaFallbackNetwork();
}

Nearest nearestPoint(const Point& point, const std::vector<Point>& candidates) {
    Nearest nearest;
    for (const Point& candidate : candidates) {
        const double distance = distanceMeters(point, candidate);
        if (!nearest.found || distance < nearest.distance) {
            nearest = {candidate.id, distance, true};
        }
    }
    return nearest;
}

Nearest nearestRailNode(const Point& point, const std::unordered_map<std::string, Point>& railNodes) {
    Nearest nearest;
    for (const auto& item : railNodes) {
        const double distance = distanceMeters(point, item.second);
        if (!nearest.found || distance < nearest.distance) {
            nearest = {item.first, distance, true};
        }
    }
    return nearest;
}

std::vector<AlgorithmResult> compareAlgorithms(
    const std::string& startNodeId,
    const std::string& endNodeId,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& railGraph
) {
    AlgorithmResult dijkstra = searchByName(startNodeId, endNodeId, railNodes, railGraph, "dijkstra");
    const double baseline = dijkstra.found ? dijkstra.costMinutes : std::numeric_limits<double>::infinity();

    std::vector<AlgorithmResult> results;
    results.push_back(bfs(startNodeId, endNodeId, railGraph));
    results.push_back(dfs(startNodeId, endNodeId, railGraph));
    results.push_back(dijkstra);
    for (double p : lpHeuristicPowers()) {
        results.push_back(astarLp(startNodeId, endNodeId, railNodes, railGraph, p));
    }
    results.push_back(searchByName(startNodeId, endNodeId, railNodes, railGraph, "astar-octile"));

    for (AlgorithmResult& result : results) {
        result.accuracyPct =
            result.found && std::isfinite(baseline) && result.costMinutes > 0.0
                ? std::min(100.0, (baseline / result.costMinutes) * 100.0)
                : 0.0;
        result.optimal = result.found && std::abs(result.costMinutes - baseline) < 1e-9;
    }

    return results;
}

PathResult findRailPath(
    const std::string& startStationId,
    const std::string& endStationId,
    const std::vector<Point>& stations,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& railGraph,
    const std::string& algorithm
) {
    const Point* startStation = findPoint(stations, startStationId);
    const Point* endStation = findPoint(stations, endStationId);
    if (!startStation || !endStation || railGraph.empty()) return {};

    const Nearest startNode = nearestRailNode(*startStation, railNodes);
    const Nearest endNode = nearestRailNode(*endStation, railNodes);
    if (!startNode.found || !endNode.found) return {};

    const AlgorithmResult search = searchByName(startNode.id, endNode.id, railNodes, railGraph, algorithm);
    if (!search.found) return {};

    PathResult result;
    result.found = true;
    result.path = search.path;
    result.distance = search.distance;
    result.costMinutes = search.costMinutes;
    result.distance += startNode.distance + endNode.distance;
    result.costMinutes += (startNode.distance + endNode.distance) / kMetersPerMinute;
    return result;
}

} // namespace metro
