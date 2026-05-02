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
    def __init__(self, station_aliases, station_route_samples, route_fallbacks, ride_minutes=2.0, transfer_minutes=3.0):
        self.station_aliases = station_aliases
        self.station_route_samples = station_route_samples
        self.route_fallbacks = route_fallbacks
        self.ride_minutes = ride_minutes
        self.transfer_minutes = transfer_minutes

    def sample_cost(self, state_key, edge, rng: random.Random) -> float:
        if edge.via_transfer:
            return self.transfer_minutes

        station_token = self.station_aliases.get(state_key)
        samples = self.station_route_samples.get((station_token, edge.route_code), [])
        if not samples:
            samples = self.route_fallbacks.get(edge.route_code, [])

        wait_minutes = rng.choice(samples) if samples else 8.0
        return max(0.25, wait_minutes) + self.ride_minutes

    def estimate_cost(self, state_key, edge) -> float:
        if edge.via_transfer:
            return self.transfer_minutes

        station_token = self.station_aliases.get(state_key)
        samples = self.station_route_samples.get((station_token, edge.route_code), [])
        if not samples:
            samples = self.route_fallbacks.get(edge.route_code, [])

        wait_minutes = statistics.median(samples) if samples else 8.0
        return max(0.25, wait_minutes) + self.ride_minutes


def _model_from_rows(topology, arrival_rows) -> EmpiricalLiveCostModel:
    live_station_tokens = {}
    station_route_samples = {}
    route_fallbacks = {}

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

    return EmpiricalLiveCostModel(
        station_aliases=station_aliases,
        station_route_samples=station_route_samples,
        route_fallbacks=route_fallbacks,
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
        SELECT station_name, route, collected_at, predicted_arrival
        FROM train_arrivals
        WHERE {where_sql}
        """,
        params,
    ).fetchall()
    conn.close()
    return _model_from_rows(topology, arrival_rows)
