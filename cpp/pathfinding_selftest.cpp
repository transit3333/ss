#include "pathfinding.hpp"

#include <iostream>

int main() {
    const metro::RailNetwork network = metro::createFallbackNetwork();
    const metro::PathResult result = metro::findRailPath(
        "gtfs/station/41320",
        "gtfs/station/40380",
        network.stations,
        network.railNodes,
        network.railGraph
    );

    if (!result.found) {
        std::cerr << "No route found\n";
        return 1;
    }

    std::cout << "route_nodes=" << result.path.size() << "\n";
    std::cout << "distance=" << metro::formatDistance(result.distance) << "\n";
    std::cout << "cost_minutes=" << result.costMinutes << "\n";
    for (const std::string& node : result.path) {
        std::cout << node << "\n";
    }

    const metro::Nearest startNode = metro::nearestRailNode(
        {"", "", 41.9398, -87.6533},
        network.railNodes
    );
    const metro::Nearest endNode = metro::nearestRailNode(
        {"", "", 41.8857, -87.6309},
        network.railNodes
    );
    const std::vector<metro::AlgorithmResult> comparison = metro::compareAlgorithms(
        startNode.id,
        endNode.id,
        network.railNodes,
        network.railGraph
    );

    std::cout << "algorithm,cost_minutes,nodes_expanded,accuracy,optimal\n";
    for (const metro::AlgorithmResult& item : comparison) {
        if (!item.found) {
            std::cout << item.algorithm << ",not-found," << item.nodesExpanded << ",0,no\n";
            continue;
        }
        std::cout << item.algorithm << ","
                  << item.costMinutes << ","
                  << item.nodesExpanded << ","
                  << item.accuracyPct << ","
                  << (item.optimal ? "yes" : "no") << "\n";
    }

    return result.path.size() >= 2 ? 0 : 2;
}
