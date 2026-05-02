# Routing Algorithm Analysis

## Current Route Search

The app no longer uses plain BFS for station-to-station routing.

`findRoute()` in [js/routing.js](/C:/Users/admin/Downloads/transit/metro36/js/routing.js) now uses a **priority-queue shortest-path search** with a **lexicographic cost model**:

1. minimize transfer count
2. then minimize in-line ride stops
3. then minimize total station-to-station steps

This is a deterministic multi-criteria shortest-path algorithm. It is a better fit than BFS for this app because transfers and track travel do not have the same meaning.

## Why BFS Was Removed

Plain BFS assumes every edge has the same cost.

That assumption is weak here because the graph has two different edge types:

- normal rail continuation
- manual transfer connection

If both are treated equally, the app can return routes that are technically short in hops but poor in rider terms.

## Current Cost Model

For each candidate route state, the search tracks:

- `transfers`
- `rideStops`
- `totalSteps`

Edge expansion rules:

- transfer edge: `transfers + 1`, `rideStops + 0`, `totalSteps + 1`
- track edge: `transfers + 0`, `rideStops + 1`, `totalSteps + 1`

Priority comparison is lexicographic:

```text
(transfers, rideStops, totalSteps)
```

So the algorithm prefers:

- fewer transfers first
- fewer in-line travel stops second
- fewer overall graph hops last

## Supporting Structures

- `buildStationGraph()` still builds the station graph from grid geometry.
- `getCachedGraph()` avoids rebuilding the graph when the grid state has not changed.
- `MinPriorityQueue` replaces the previous `queue.sort(...).shift()` pattern in `findRoute()`.

## Complexity

Let:

- `V` = number of stations
- `E` = number of edges in the station graph

Route search:

- previous approach: array-backed pseudo-Dijkstra with repeated sort
- current approach: heap-backed priority queue

Asymptotically:

- search: `O((V + E) log V)`

Graph building still dominates on large maps if the cache is invalidated often.

## Practical Effect

Compared to the old route search, the current version:

- removes the old BFS-style equal-cost assumption
- gives more stable results when transfer edges exist
- scales better than repeatedly sorting the frontier array

## Limitations

This is still a deterministic client-side graph search, not a stochastic or learning-based algorithm.

It does not model:

- expected wait times
- train frequency
- congestion
- uncertainty

If those become product requirements, the graph and cost model need to change first. Replacing the search routine alone would not be enough.
