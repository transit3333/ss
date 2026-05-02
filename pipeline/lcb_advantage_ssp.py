import math
import random


class LCBAdvantageSSP:
    def __init__(
        self,
        env,
        horizon: int,
        episodes: int,
        delta: float = 0.05,
        theta_star: int = 128,
        seed: int = 7,
    ):
        self.env = env
        self.horizon = max(2, int(horizon))
        self.episodes = max(1, int(episodes))
        self.delta = delta
        self.theta_star = theta_star
        self.rng = random.Random(seed)
        self.B = 1.0

        self.actions_by_state = {state: env.actions(state) for state in env.states}
        self.total_action_count = sum(len(actions) for actions in self.actions_by_state.values())
        self.max_steps_per_episode = max(self.horizon * 4, 8)
        self.stage_boundaries = self._build_stage_boundaries(self.episodes * self.max_steps_per_episode)

        self.N = {}
        self.M = {}
        self.Q = {}
        self.V = {}
        self.V_ref = {}
        self.Cb = {}
        self.mu_ref = {}
        self.sigma_ref = {}
        self.mu = {}
        self.sigma = {}
        self.v = {}
        self.best_scores = {}

        for state, actions in self.actions_by_state.items():
            self.V[state] = 0.0
            self.V_ref[state] = 0.0
            for edge in actions:
                action_id = edge.action_id
                self.N[(state, action_id)] = 0
                self.M[(state, action_id)] = 0
                self.Q[(state, action_id)] = 0.0
                self.Cb[(state, action_id)] = 0.0
                self.mu_ref[(state, action_id)] = 0.0
                self.sigma_ref[(state, action_id)] = 0.0
                self.mu[(state, action_id)] = 0.0
                self.sigma[(state, action_id)] = 0.0
                self.v[(state, action_id)] = 0.0

    def _build_stage_boundaries(self, max_visits: int) -> set[int]:
        boundaries = set()
        stage_length = self.horizon
        total = 0
        while total < max_visits:
            total += stage_length
            boundaries.add(total)
            next_length = math.floor((1 + 1 / self.horizon) * stage_length)
            stage_length = max(stage_length + 1, next_length)
        return boundaries

    def _is_power_of_two(self, value: int) -> bool:
        return value > 0 and (value & (value - 1)) == 0

    def _state_visit_total(self, state_key: str) -> int:
        return sum(self.N[(state_key, edge.action_id)] for edge in self.actions_by_state.get(state_key, []))

    def _compute_iota(self, n: int) -> float:
        scale = max(4 * max(1, len(self.env.states)) * max(1, self.total_action_count), 2)
        argument = max(scale * (max(self.B, 1.0) ** 8) * (max(n, 1) ** 5) / self.delta, math.e)
        return 256.0 * (math.log(argument) ** 6)

    def _argmin_action(self, state_key: str):
        actions = self.actions_by_state.get(state_key, [])
        if not actions:
            return None
        ranked = []
        for edge in actions:
            q_value = self.Q[(state_key, edge.action_id)]
            immediate_cost = self.env.cost_model.estimate_cost(state_key, edge)
            distance = self.env.distance_to_goal(edge.to_key)
            transfer_penalty = 1 if edge.via_transfer else 0
            same_station_transfer_penalty = 0
            if edge.via_transfer:
                current_name = self.env.topology.station_names.get(state_key, "")
                next_name = self.env.topology.station_names.get(edge.to_key, "")
                if current_name == next_name:
                    same_station_transfer_penalty = 1
            ranked.append(
                (
                    q_value,
                    same_station_transfer_penalty,
                    distance,
                    immediate_cost,
                    transfer_penalty,
                    edge.action_id,
                    edge,
                )
            )
        ranked.sort(key=lambda item: (item[0], item[1], item[2], item[3], item[4], item[5]))
        return ranked[0][-1]

    def _update_visit(self, state_key: str, edge, cost: float, next_state: str) -> None:
        action_id = edge.action_id
        key = (state_key, action_id)

        self.N[key] += 1
        self.M[key] += 1
        n = self.N[key]
        m = self.M[key]

        next_v_ref = self.V_ref.get(next_state, 0.0)
        next_v = self.V.get(next_state, 0.0)

        self.Cb[key] += cost
        self.mu_ref[key] += next_v_ref
        self.sigma_ref[key] += next_v_ref ** 2
        self.v[key] += next_v
        self.mu[key] += next_v - next_v_ref
        self.sigma[key] += (next_v - next_v_ref) ** 2

        if n not in self.stage_boundaries:
            return

        iota = self._compute_iota(n)
        bc = self.Cb[key] / n
        ref_mean = self.mu_ref[key] / n
        local_mean = self.mu[key] / m
        ref_var = max(self.sigma_ref[key] / n - ref_mean ** 2, 0.0)
        local_var = max(self.sigma[key] / m - local_mean ** 2, 0.0)

        b0 = 2.0 * math.sqrt((self.B ** 2) * iota / m) + math.sqrt(max(bc, 0.0) * iota / n) + (iota / n)
        b = (
            math.sqrt(ref_var * iota / n)
            + math.sqrt(local_var * iota / m)
            + (((4.0 * self.B) / n) + ((3.0 * self.B) / m)) * iota
            + math.sqrt(max(bc, 0.0) * iota / n)
        )

        self.Q[key] = max(bc + (self.v[key] / m) - b0, self.Q[key])
        self.Q[key] = max(bc + ref_mean + local_mean - b, self.Q[key])

        state_actions = self.actions_by_state.get(state_key, [])
        if state_actions:
            self.V[state_key] = min(self.Q[(state_key, item.action_id)] for item in state_actions)
            if self.V[state_key] > self.B:
                self.B = 2.0 * self.V[state_key]

        self.v[key] = 0.0
        self.mu[key] = 0.0
        self.sigma[key] = 0.0
        self.M[key] = 0

        total_state_visits = self._state_visit_total(state_key)
        if self._is_power_of_two(total_state_visits) and total_state_visits <= self.theta_star:
            self.V_ref[state_key] = self.V[state_key]

    def train(self) -> None:
        for _ in range(self.episodes):
            state_key = self.env.start_key
            steps = 0
            while state_key != self.env.goal_key and steps < self.max_steps_per_episode:
                action = self._argmin_action(state_key)
                if action is None:
                    break
                next_state, cost, done = self.env.sample_transition(state_key, action, self.rng)
                self._update_visit(state_key, action, cost, next_state)
                state_key = next_state
                steps += 1
                if done:
                    break

    def greedy_plan(self):
        state_key = self.env.start_key
        plan = []
        visited = set()
        steps = 0

        while state_key != self.env.goal_key and steps < self.max_steps_per_episode:
            if state_key in visited:
                break
            visited.add(state_key)

            action = self._argmin_action(state_key)
            if action is None:
                break

            plan.append(
                {
                    "from_key": state_key,
                    "to_key": action.to_key,
                    "route_code": action.route_code,
                    "color": action.color,
                    "via_transfer": action.via_transfer,
                    "estimated_cost": self.env.cost_model.estimate_cost(state_key, action),
                    "q_value": self.Q[(state_key, action.action_id)],
                }
            )
            state_key = action.to_key
            steps += 1

        return plan
