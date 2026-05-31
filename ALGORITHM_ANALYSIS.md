# Routing Algorithm and Graph Structure

This document describes the current real-map routing implementation in `js/pathfinding.js` and the matching C++ implementation in `cpp/pathfinding.cpp`.

## Data Source

The fallback rail network is built from CTA static GTFS data:

```text
data/cta_gtfs.zip
```

The compact graph used by the browser is:

```text
data/cta_rail_fallback.json
```

The native C++ build uses the same generated data embedded in:

```text
cpp/cta_fallback_data.hpp
```

Relevant GTFS files:

- `stops.txt`: stop and station coordinates.
- `trips.txt`: maps a trip to a rail route.
- `stop_times.txt`: ordered stops for each scheduled trip.

`shape_dist_traveled` in `stop_times.txt` is cumulative distance along a trip shape. It is not directly an edge distance. For consecutive stops A and B in the same trip:

```text
edge distance = shape_dist_traveled(B) - shape_dist_traveled(A)
```

CTA stores this value in feet, so the generated graph converts it to meters.

## Graph Structure

The rail network is represented as an adjacency list.

```text
Map<stationId, Edge[]>
```

Each station node is a CTA parent station:

```text
station = {
  id,
  name,
  lat,
  lng
}
```

The node coordinates are computed from the rail platform stops used in `stop_times.txt`, grouped by `parent_station`. This avoids mixing parent-station coordinates with platform-based edge distances.

Each edge is:

```text
edge = {
  to,
  weight,
  line,
  transfer
}
```

Where:

- `to`: destination station id.
- `weight`: distance in meters.
- `line`: CTA route id, such as `Red`, `Blue`, or `Brn`.
- `transfer`: reserved for explicit transfer edges; current route changes are handled by search state.

Edges are added between consecutive stations in each GTFS trip pattern. The graph is undirected for routing, so each segment is inserted in both directions.

## Edge Weight

The stored edge distance is:

```text
max(GTFS shape distance delta, projected Euclidean distance between node coordinates)
```

This keeps the graph physically consistent: no edge can be shorter than the coordinate lower bound used by the heuristic.

The edge cost used by weighted search is train travel time:

```text
travel_minutes = edge_distance_meters / (70000 / 60)
```

The train speed assumption is:

```text
70 km/h
```

When the route changes from one CTA line to another, the search adds:

```text
transfer_penalty = 0.01
```

So the full weighted transition cost is:

```text
cost = travel_minutes + transfer_penalty_if_line_changes
```

Walking is ignored. User-picked map points are snapped to their nearest station, then the algorithms compare rail-only routes between those two station nodes.

## State Space

For BFS and DFS, the state is only:

```text
stationId
```

For Dijkstra and A*, the state includes the previous line so transfer penalties can be charged correctly:

```text
state = (stationId, currentLine)
```

The initial state is:

```text
(startStationId, none)
```

The goal is reached when:

```text
stationId == endStationId
```

Any `currentLine` at the destination is acceptable. This is why the implementation keys weighted search states as station plus line.

## Algorithms

The app compares:

- BFS
- DFS
- Dijkstra
- A* with Lp heuristic, `p = 2`
- A* with octile heuristic

Dijkstra is the optimal baseline because all weighted edges are non-negative.

BFS and DFS are included for comparison. They do not optimize weighted travel time:

- BFS minimizes hop count.
- DFS follows one branch deeply before backtracking.

Therefore, BFS/DFS may find valid routes with worse cost than Dijkstra.

## A* Heuristic

For A* Lp, the heuristic estimates remaining train time from station coordinates:

```text
dx = projected east-west meters
dy = projected north-south meters

Lp = (dx^p + dy^p)^(1/p)
h(n) = Lp / (70000 / 60)
```

The current admissible Lp heuristic is:

```text
p = 2
```

This is Euclidean distance converted to train time.

The graph was checked across all reachable ordered station pairs. Results:

```text
p = 1      overestimates
p < 2      overestimates for tested fractional values
p = 2      no overestimation on the fixed graph
p > 2      also no overestimation, but not better than p=2 for this graph
```

The UI keeps only `A* Lp(p=2)` because it is admissible and avoids the overhead of non-integer exponentiation.

Octile is included only as a comparison heuristic. It can overestimate on this rail graph because octile distance assumes an 8-direction grid model, while this graph is a free-coordinate rail network.

## Metrics

The comparison table reports:

```text
Expanded / Time
```

`Expanded` means the number of search states popped from the frontier and processed.

For weighted search, this counts `(stationId, currentLine)` states, not just unique stations.

`Time` is the runtime of that algorithm call only. It includes:

- local algorithm setup
- search loop
- path reconstruction
- result finalization

It does not include:

- loading GTFS data
- building the graph
- rendering the map
- running other algorithms

`Accuracy` is measured against Dijkstra:

```text
accuracy = optimal_cost / algorithm_cost
```

So Dijkstra and admissible A* should report `100%` when they return the optimal route.

## Implementation Locations

Browser implementation:

```text
js/pathfinding.js
```

Important functions:

- `buildRailGraph(...)`
- `bfs(...)`
- `dfs(...)`
- `shortestPath(...)` for Dijkstra and A*
- `lpHeuristic(...)`
- `octileHeuristic(...)`
- `compareAlgorithms(...)`
- `findRailPath(...)`

UI integration:

```text
js/mapapp.js
```

Native C++ implementation:

```text
cpp/pathfinding.hpp
cpp/pathfinding.cpp
cpp/pathfinding_selftest.cpp
```

The browser and C++ versions use the same graph model, edge-cost model, and comparison logic.
