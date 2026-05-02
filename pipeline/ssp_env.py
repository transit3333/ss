import random
from collections import deque


class MetroSSPEnvironment:
    def __init__(self, topology, cost_model, start_key: str, goal_key: str):
        self.topology = topology
        self.cost_model = cost_model
        self.start_key = start_key
        self.goal_key = goal_key
        self.state_by_station = {
            station_key: (station_key, cost_model.state_profile(station_key, topology.graph.get(station_key, [])))
            for station_key in topology.graph.keys()
        }
        self.states = list(self.state_by_station.values())
        self.start_state = self.state_by_station[start_key]
        self.goal_state = self.state_by_station[goal_key]
        self.goal_distances = self._build_goal_distances()

    def station_key(self, state) -> str:
        return state[0]

    def actions(self, state):
        station_key = self.station_key(state)
        if station_key == self.goal_key:
            return []
        return self.topology.graph.get(station_key, [])

    def sample_transition(self, state, edge, rng: random.Random):
        station_key = self.station_key(state)
        cost = self.cost_model.sample_cost(station_key, edge, rng)
        next_state = self.state_by_station[edge.to_key]
        done = edge.to_key == self.goal_key
        return next_state, cost, done

    def distance_to_goal(self, state) -> int:
        return self.goal_distances.get(self.station_key(state), 10**6)

    def _build_goal_distances(self):
        reverse_graph = {station_key: [] for station_key in self.topology.graph.keys()}
        for station_key, edges in self.topology.graph.items():
            for edge in edges:
                reverse_graph.setdefault(edge.to_key, []).append(station_key)

        distances = {self.goal_key: 0}
        queue = deque([self.goal_key])
        while queue:
            current = queue.popleft()
            for prev_state in reverse_graph.get(current, []):
                if prev_state in distances:
                    continue
                distances[prev_state] = distances[current] + 1
                queue.append(prev_state)
        return distances
