import random
import statistics
from datetime import datetime, timedelta, timezone

from pipeline.db import get_connection
from pipeline.topology import normalize_station_name


ROUTE_CODE_ALIASES = {
    "red": "red",
    "blue": "blue",
    "brn": "brn",
    "brown": "brn",
    "g": "g",
    "green": "g",
    "org": "org",
    "orange": "org",
    "pink": "pink",
    "p": "p",
    "purple": "p",
    "y": "y",
    "yellow": "y",
}


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    formats = (
        "%Y%m%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
    )
    for fmt in formats:
        try:
            parsed = datetime.strptime(value, fmt)
            if parsed.tzinfo is not None:
                return parsed.astimezone(timezone.utc)
            return parsed
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None:
            return parsed.astimezone(timezone.utc)
        return parsed
    except ValueError:
        return None


def _normalize_route_code(value: str | None) -> str | None:
    if not value:
        return None
    token = value.strip().lower()
    return ROUTE_CODE_ALIASES.get(token, token)


def _compute_wait_minutes(collected_raw: str | None, predicted_raw: str | None) -> float | None:
    collected_at = _parse_time(collected_raw)
    predicted_local = _parse_time(predicted_raw)
    if not collected_at or not predicted_local:
        return None
    if collected_at.tzinfo is None:
        return None

    if predicted_local.tzinfo is not None:
        return (predicted_local - collected_at).total_seconds() / 60.0

    candidates = []
    for central_offset_hours in (-6, -5):
        central_tz = timezone(timedelta(hours=central_offset_hours))
        predicted_utc = predicted_local.replace(tzinfo=central_tz).astimezone(timezone.utc)
        wait_minutes = (predicted_utc - collected_at).total_seconds() / 60.0
        if -1.0 <= wait_minutes <= 120.0:
            candidates.append(wait_minutes)

    if not candidates:
        return None
    non_negative = [value for value in candidates if value >= 0]
    if non_negative:
        return min(non_negative)
    return max(candidates)


class EmpiricalLiveCostModel:
    def __init__(
        self,
        station_aliases,
        station_route_samples,
        route_fallbacks,
        edge_travel_samples,
        route_edge_fallbacks,
        ride_minutes=2.0,
        transfer_minutes=3.0,
    ):
        self.station_aliases = station_aliases
        self.station_route_samples = station_route_samples
        self.route_fallbacks = route_fallbacks
        self.edge_travel_samples = edge_travel_samples
        self.route_edge_fallbacks = route_edge_fallbacks
        self.ride_minutes = ride_minutes
        self.transfer_minutes = transfer_minutes

    def _edge_travel_series(self, state_key, edge):
        from_token = self.station_aliases.get(state_key)
        to_token = self.station_aliases.get(edge.to_key)
        samples = self.edge_travel_samples.get((from_token, to_token, edge.route_code), [])
        if not samples:
            samples = self.route_edge_fallbacks.get(edge.route_code, [])
        return samples

    def sample_edge_minutes(self, state_key, edge, rng: random.Random) -> float:
        if edge.via_transfer:
            return self.transfer_minutes
        samples = self._edge_travel_series(state_key, edge)
        return max(0.5, rng.choice(samples) if samples else self.ride_minutes)

    def estimate_edge_minutes(self, state_key, edge) -> float:
        if edge.via_transfer:
            return self.transfer_minutes
        samples = self._edge_travel_series(state_key, edge)
        return max(0.5, statistics.median(samples) if samples else self.ride_minutes)

    def sample_cost(self, state_key, edge, rng: random.Random) -> float:
        if edge.via_transfer:
            return self.transfer_minutes

        station_token = self.station_aliases.get(state_key)
        samples = self.station_route_samples.get((station_token, edge.route_code), [])
        if not samples:
            samples = self.route_fallbacks.get(edge.route_code, [])

        wait_minutes = rng.choice(samples) if samples else 8.0
        edge_minutes = self.sample_edge_minutes(state_key, edge, rng)
        return max(0.25, wait_minutes) + edge_minutes

    def estimate_cost(self, state_key, edge) -> float:
        if edge.via_transfer:
            return self.transfer_minutes

        station_token = self.station_aliases.get(state_key)
        samples = self.station_route_samples.get((station_token, edge.route_code), [])
        if not samples:
            samples = self.route_fallbacks.get(edge.route_code, [])

        wait_minutes = statistics.median(samples) if samples else 8.0
        edge_minutes = self.estimate_edge_minutes(state_key, edge)
        return max(0.25, wait_minutes) + edge_minutes

    def state_profile(self, station_key, edges) -> tuple:
        ride_estimates = [
            self.estimate_edge_minutes(station_key, edge)
            for edge in edges
            if not edge.via_transfer
        ]
        ride_estimates.sort()
        nearby = tuple(int(round(value * 2)) for value in ride_estimates[:3])
        transfer_count = sum(1 for edge in edges if edge.via_transfer)
        return nearby + (transfer_count,)


def _model_from_rows(topology, arrival_rows) -> EmpiricalLiveCostModel:
    live_station_tokens = {}
    station_route_samples = {}
    route_fallbacks = {}
    grouped_arrivals = {}

    for row in arrival_rows:
        station_name = row["station_name"]
        route_code = _normalize_route_code(row["route"])
        if not station_name or not route_code:
            continue

        wait_minutes = _compute_wait_minutes(row["collected_at"], row["predicted_arrival"])
        if wait_minutes is None:
            continue
        if wait_minutes < 0 or wait_minutes > 60:
            continue

        token = normalize_station_name(station_name)
        live_station_tokens[token] = station_name
        station_route_samples.setdefault((token, route_code), []).append(wait_minutes)
        route_fallbacks.setdefault(route_code, []).append(wait_minutes)

        run_number = (row["run_number"] or "").strip() if "run_number" in row.keys() else ""
        predicted_at = _parse_time(row["predicted_arrival"])
        collected_at = _parse_time(row["collected_at"])
        if not run_number or not predicted_at or not collected_at:
            continue

        grouped_key = (row["collected_at"], route_code, run_number)
        station_map = grouped_arrivals.setdefault(grouped_key, {})
        existing = station_map.get(token)
        if existing is None or predicted_at < existing:
            station_map[token] = predicted_at

    station_aliases = {}
    for station_key, station_name in topology.station_names.items():
        token = normalize_station_name(station_name)
        if token in live_station_tokens:
            station_aliases[station_key] = token
            continue

        best_token = None
        best_score = -1
        for candidate in live_station_tokens:
            common = len(set(token) & set(candidate))
            score = common - abs(len(token) - len(candidate))
            if score > best_score:
                best_score = score
                best_token = candidate
        station_aliases[station_key] = best_token or token

    valid_edge_tokens = {}
    for station_key, edges in topology.graph.items():
        from_token = station_aliases.get(station_key)
        if not from_token:
            continue
        for edge in edges:
            if edge.via_transfer or not edge.route_code:
                continue
            to_token = station_aliases.get(edge.to_key)
            if not to_token:
                continue
            valid_edge_tokens[(from_token, to_token, edge.route_code)] = True

    edge_travel_samples = {}
    route_edge_fallbacks = {}
    for (collected_at_raw, route_code, run_number), station_map in grouped_arrivals.items():
        del collected_at_raw, run_number
        if len(station_map) < 2:
            continue
        for from_token, predicted_from in station_map.items():
            for to_token, predicted_to in station_map.items():
                if from_token == to_token:
                    continue
                edge_key = (from_token, to_token, route_code)
                if edge_key not in valid_edge_tokens:
                    continue
                travel_minutes = (predicted_to - predicted_from).total_seconds() / 60.0
                if 0.25 <= travel_minutes <= 45.0:
                    edge_travel_samples.setdefault(edge_key, []).append(travel_minutes)
                    route_edge_fallbacks.setdefault(route_code, []).append(travel_minutes)

    return EmpiricalLiveCostModel(
        station_aliases=station_aliases,
        station_route_samples=station_route_samples,
        route_fallbacks=route_fallbacks,
        edge_travel_samples=edge_travel_samples,
        route_edge_fallbacks=route_edge_fallbacks,
    )


def build_live_cost_model(
    topology,
    since: datetime | None = None,
    until: datetime | None = None,
) -> EmpiricalLiveCostModel:
    conn = get_connection()

    clauses = ["station_name IS NOT NULL", "route IS NOT NULL"]
    params: list[str] = []
    if since is not None:
        clauses.append("collected_at >= ?")
        params.append(since.isoformat())
    if until is not None:
        clauses.append("collected_at <= ?")
        params.append(until.isoformat())

    where_sql = " AND ".join(clauses)
    arrival_rows = conn.execute(
        f"""
        SELECT station_name, route, collected_at, predicted_arrival, run_number
        FROM train_arrivals
        WHERE {where_sql}
        """,
        params,
    ).fetchall()
    conn.close()
    return _model_from_rows(topology, arrival_rows)
