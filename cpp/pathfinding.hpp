#pragma once

#include <string>
#include <unordered_map>
#include <vector>

namespace metro {

struct Point {
    std::string id;
    std::string name;
    double lat = 0.0;
    double lng = 0.0;
};

struct RailWay {
    std::string id;
    std::string name;
    std::string color;
    std::string routeId;
    std::vector<std::string> nodes;
    std::vector<double> segmentWeights;
};

struct Edge {
    std::string to;
    double weight = 0.0;
    std::string line;
    bool transfer = false;
};

struct Nearest {
    std::string id;
    double distance = 0.0;
    bool found = false;
};

struct PathResult {
    std::vector<std::string> path;
    double distance = 0.0;
    double costMinutes = 0.0;
    bool found = false;
};

struct AlgorithmResult {
    std::string algorithm;
    std::vector<std::string> path;
    double distance = 0.0;
    double costMinutes = 0.0;
    std::size_t nodesExpanded = 0;
    double runtimeMs = 0.0;
    double accuracyPct = 0.0;
    bool found = false;
    bool optimal = false;
};

struct RailNetwork {
    std::vector<Point> stations;
    std::unordered_map<std::string, Point> railNodes;
    std::vector<RailWay> railWays;
    std::unordered_map<std::string, std::vector<Edge>> railGraph;
};

double distanceMeters(const Point& a, const Point& b);
std::string formatDistance(double meters);

RailNetwork createFallbackNetwork();
std::unordered_map<std::string, std::vector<Edge>> buildRailGraph(
    const std::vector<RailWay>& railWays,
    const std::unordered_map<std::string, Point>& railNodes
);

Nearest nearestPoint(const Point& point, const std::vector<Point>& candidates);
Nearest nearestRailNode(const Point& point, const std::unordered_map<std::string, Point>& railNodes);

std::vector<AlgorithmResult> compareAlgorithms(
    const std::string& startNodeId,
    const std::string& endNodeId,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& railGraph
);

PathResult findRailPath(
    const std::string& startStationId,
    const std::string& endStationId,
    const std::vector<Point>& stations,
    const std::unordered_map<std::string, Point>& railNodes,
    const std::unordered_map<std::string, std::vector<Edge>>& railGraph,
    const std::string& algorithm = "dijkstra"
);

} // namespace metro
