from __future__ import annotations

import random
from dataclasses import dataclass, field
from math import exp, log, sqrt
from statistics import mean, pstdev
from typing import Dict, Hashable, List, Mapping, MutableMapping, Optional, Sequence, Tuple


Node = Hashable
EdgeKey = Tuple[Node, Node]


@dataclass
class LogNormalEdge:
    source: Node
    target: Node
    mu: float
    sigma: float
    metadata: MutableMapping[str, object] = field(default_factory=dict)

    @property
    def key(self) -> EdgeKey:
        return (self.source, self.target)

    def expected_travel_time(self) -> float:
        return exp(self.mu + (self.sigma**2) / 2.0)

    def variance(self) -> float:
        sigma_sq = self.sigma**2
        return (exp(sigma_sq) - 1.0) * exp((2.0 * self.mu) + sigma_sq)

    def stddev(self) -> float:
        return sqrt(self.variance())


class StochasticTDGraph:
    """
    Time-dependent stochastic graph with log-normal edge travel times.

    Core assumption:
    - For an edge e at departure time t, travel time T_e(t) follows a
      log-normal distribution.
    - log(T_e(t)) ~ Normal(mu_e(t), sigma_e(t)^2)

    By default, each edge uses constant mu and sigma. For time-dependent
    behaviour, store a callable in edge.metadata["time_function"] that takes
    departure_time and returns a `(mu, sigma)` pair.
    """

    def __init__(self) -> None:
        self.nodes: set[Node] = set()
        self.edges: Dict[EdgeKey, LogNormalEdge] = {}
        self.adjacency: Dict[Node, List[EdgeKey]] = {}
        self.edge_covariance: Dict[frozenset[EdgeKey], float] = {}

    def add_edge(
        self,
        source: Node,
        target: Node,
        mu: float,
        sigma: float,
        metadata: Optional[Mapping[str, object]] = None,
    ) -> LogNormalEdge:
        if sigma < 0:
            raise ValueError("sigma must be non-negative")

        edge = LogNormalEdge(
            source=source,
            target=target,
            mu=mu,
            sigma=sigma,
            metadata=dict(metadata or {}),
        )
        key = edge.key

        self.nodes.update((source, target))
        self.edges[key] = edge
        self.adjacency.setdefault(source, [])
        if key not in self.adjacency[source]:
            self.adjacency[source].append(key)
        self.adjacency.setdefault(target, [])
        return edge

    def get_edge(self, source: Node, target: Node) -> LogNormalEdge:
        return self.edges[(source, target)]

    def get_next_nodes(self, node: Node) -> List[Node]:
        return [target for _, target in self.adjacency.get(node, [])]

    def get_edge_parameters(self, edge: LogNormalEdge, departure_time: float) -> Tuple[float, float]:
        time_function = edge.metadata.get("time_function")
        if callable(time_function):
            mu, sigma = time_function(departure_time)
            if sigma < 0:
                raise ValueError("time-dependent sigma must be non-negative")
            return float(mu), float(sigma)
        return edge.mu, edge.sigma

    def set_edge_covariance(self, edge_a: EdgeKey, edge_b: EdgeKey, covariance: float) -> None:
        if edge_a not in self.edges:
            raise KeyError(f"unknown edge: {edge_a}")
        if edge_b not in self.edges:
            raise KeyError(f"unknown edge: {edge_b}")
        self.edge_covariance[frozenset((edge_a, edge_b))] = covariance

    def get_edge_covariance(self, edge_a: EdgeKey, edge_b: EdgeKey) -> float:
        if edge_a == edge_b:
            return self.edges[edge_a].variance()
        return self.edge_covariance.get(frozenset((edge_a, edge_b)), 0.0)

    def covariance_matrix(self, edge_order: Optional[Sequence[EdgeKey]] = None) -> List[List[float]]:
        ordered_edges = list(edge_order or self.edges.keys())
        return [
            [self.get_edge_covariance(edge_i, edge_j) for edge_j in ordered_edges]
            for edge_i in ordered_edges
        ]

    def fit_edge_parameters(
        self,
        source: Node,
        target: Node,
        observed_times: Sequence[float],
        metadata: Optional[Mapping[str, object]] = None,
    ) -> LogNormalEdge:
        mu, sigma = fit_lognormal_parameters(observed_times)
        return self.add_edge(source, target, mu, sigma, metadata=metadata)

    def fit_covariance_from_samples(
        self,
        edge_a: EdgeKey,
        edge_b: EdgeKey,
        paired_observations: Sequence[Tuple[float, float]],
        use_log_space: bool = True,
    ) -> float:
        if len(paired_observations) < 2:
            raise ValueError("at least two paired observations are required")

        xs: List[float] = []
        ys: List[float] = []
        for first, second in paired_observations:
            if first <= 0 or second <= 0:
                raise ValueError("all observations must be strictly positive")
            xs.append(log(first) if use_log_space else first)
            ys.append(log(second) if use_log_space else second)

        x_mean = mean(xs)
        y_mean = mean(ys)
        covariance = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys)) / len(xs)
        self.set_edge_covariance(edge_a, edge_b, covariance)
        return covariance

    def fit_from_real_life_data(
        self,
        edge_samples: Mapping[EdgeKey, Sequence[float]],
        covariance_samples: Optional[Mapping[Tuple[EdgeKey, EdgeKey], Sequence[Tuple[float, float]]]] = None,
        metadata_by_edge: Optional[Mapping[EdgeKey, Mapping[str, object]]] = None,
    ) -> None:
        metadata_by_edge = metadata_by_edge or {}

        for edge_key, samples in edge_samples.items():
            source, target = edge_key
            self.fit_edge_parameters(
                source,
                target,
                samples,
                metadata=metadata_by_edge.get(edge_key),
            )

        for (edge_a, edge_b), paired_samples in (covariance_samples or {}).items():
            self.fit_covariance_from_samples(edge_a, edge_b, paired_samples)


def fit_lognormal_parameters(observed_times: Sequence[float]) -> Tuple[float, float]:
    if not observed_times:
        raise ValueError("observed_times must not be empty")
    if any(value <= 0 for value in observed_times):
        raise ValueError("log-normal fitting requires strictly positive observations")

    log_times = [log(value) for value in observed_times]
    mu = mean(log_times)
    sigma = pstdev(log_times) if len(log_times) > 1 else 0.0
    return mu, sigma


def sample_edge_time(edge: LogNormalEdge, departure_time: float, rng: random.Random) -> float:
    """
    Draw one travel-time sample for an edge.

    If edge.metadata["time_function"] exists, it is used to derive `(mu, sigma)`
    from the current departure time. Otherwise the edge's base parameters are
    used.
    """
    time_function = edge.metadata.get("time_function")
    if callable(time_function):
        mu, sigma = time_function(departure_time)
    else:
        mu, sigma = edge.mu, edge.sigma

    if sigma < 0:
        raise ValueError("sigma must be non-negative")
    return rng.lognormvariate(mu, sigma)


def simulate_path(
    graph: StochasticTDGraph,
    path: Sequence[Node],
    start_time: float,
    rng: random.Random,
) -> float:
    """
    Simulate total travel time along a path.

    `path` should be a node sequence like ["A", "B", "C"].
    """
    if len(path) < 2:
        return 0.0

    current_time = start_time
    total_travel_time = 0.0

    for source, target in zip(path, path[1:]):
        edge = graph.get_edge(source, target)
        travel_time = sample_edge_time(edge, current_time, rng)
        total_travel_time += travel_time
        current_time += travel_time

    return total_travel_time


def estimate_success_probability(
    graph: StochasticTDGraph,
    path: Sequence[Node],
    start_time: float,
    deadline: float,
    n_samples: int,
    seed: Optional[int],
) -> float:
    """
    Estimate P(arrival_time <= deadline) via Monte Carlo simulation.
    """
    if n_samples <= 0:
        raise ValueError("n_samples must be positive")
    if deadline < start_time:
        return 0.0

    rng = random.Random(seed)
    successes = 0

    for _ in range(n_samples):
        total_travel_time = simulate_path(graph, path, start_time, rng)
        arrival_time = start_time + total_travel_time
        if arrival_time <= deadline:
            successes += 1

    return successes / n_samples
