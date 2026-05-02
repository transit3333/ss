import random
from collections import deque


class MetroSSPEnvironment:
    def __init__(self, topology, cost_model, start_key: str, goal_key: str):
        self.topology = topology
        self.cost_model = cost_model
        self.start_key = start_key
        self.goal_key = goal_key
        self.states = list(topology.graph.keys())
        self.goal_distances = self._build_goal_distances()

    def actions(self, state_key: str):
        if state_key == self.goal_key:
            return []
        return self.topology.graph.get(state_key, [])

    def sample_transition(self, state_key: str, edge, rng: random.Random):
        cost = self.cost_model.sample_cost(state_key, edge, rng)
        next_state = edge.to_key
        done = next_state == self.goal_key
        return next_state, cost, done

    def distance_to_goal(self, state_key: str) -> int:
        return self.goal_distances.get(state_key, 10**6)

    def _build_goal_distances(self):
        reverse_graph = {state: [] for state in self.states}
        for state, edges in self.topology.graph.items():
            for edge in edges:
                reverse_graph.setdefault(edge.to_key, []).append(state)

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
