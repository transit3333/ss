import argparse
import json
from collections import deque
from datetime import timedelta
from pathlib import Path

from pipeline.config import DATA_DIR
from pipeline.db import get_connection, init_db
from pipeline.live_model import _parse_time, build_live_cost_model
from pipeline.lcb_advantage_ssp import LCBAdvantageSSP
from pipeline.ssp_env import MetroSSPEnvironment
from pipeline.topology import build_topology, normalize_station_name, resolve_station_candidates, shortest_hops


def _resolution_details(topology, query: str, candidates: list[str]) -> dict:
    normalized_query = normalize_station_name(query)
    resolved = []
    exact = []
    for key in candidates:
        station_name = topology.station_names.get(key, key)
        normalized_station = normalize_station_name(station_name)
        item = {
            "key": key,
            "station": station_name,
            "normalized_station": normalized_station,
            "exact_match": normalized_station == normalized_query,
        }
        resolved.append(item)
        if item["exact_match"]:
            exact.append(item)
    return {
        "query": query,
        "normalized_query": normalized_query,
        "candidates": resolved,
        "exact_matches": exact,
    }


def _pick_station_pair(topology, from_query: str, to_query: str) -> tuple[str, str, dict]:
    from_candidates = resolve_station_candidates(topology, from_query)
    to_candidates = resolve_station_candidates(topology, to_query)
    best_pair = None
    best_hops = None

    for from_key in from_candidates:
        for to_key in to_candidates:
            hops = shortest_hops(topology, from_key, to_key)
            if hops is None:
                continue
            if best_hops is None or hops < best_hops:
                best_hops = hops
                best_pair = (from_key, to_key)

    if best_pair is None:
        raise ValueError(f"Could not resolve connected station pair for '{from_query}' -> '{to_query}'.")
    return (
        best_pair[0],
        best_pair[1],
        {
            "from": _resolution_details(topology, from_query, from_candidates),
            "to": _resolution_details(topology, to_query, to_candidates),
            "chosen_pair_hops": best_hops,
        },
    )


def _serialize_steps(topology, cost_model, start_key: str, edge_path) -> list[dict]:
    state_key = start_key
    steps = []
    for edge in edge_path:
        steps.append(
            {
                "from_key": state_key,
                "to_key": edge.to_key,
                "from_station": topology.station_names.get(state_key, state_key),
                "to_station": topology.station_names.get(edge.to_key, edge.to_key),
                "route_code": edge.route_code,
                "color": edge.color,
                "via_transfer": edge.via_transfer,
                "estimated_cost": cost_model.estimate_cost(state_key, edge),
            }
        )
        state_key = edge.to_key
    return steps


def _path_summary(steps: list[dict], goal_key: str, start_key: str) -> dict:
    end_key = steps[-1]["to_key"] if steps else start_key
    reaches_goal = end_key == goal_key
    return {
        "reaches_goal": reaches_goal,
        "step_count": len(steps),
        "transfer_count": sum(1 for step in steps if step["via_transfer"]),
        "end_key": end_key,
        "estimated_total_cost_minutes": round(sum(step["estimated_cost"] for step in steps), 3),
        "steps": steps,
    }


def _plain_bfs_edge_path(topology, start_key: str, goal_key: str):
    if start_key == goal_key:
        return []

    queue = deque([start_key])
    parents = {start_key: None}
    parent_edges = {}

    while queue:
        current = queue.popleft()
        for edge in topology.graph.get(current, []):
            if edge.to_key in parents:
                continue
            parents[edge.to_key] = current
            parent_edges[edge.to_key] = edge
            if edge.to_key == goal_key:
                path = []
                cursor = goal_key
                while cursor != start_key:
                    path.append(parent_edges[cursor])
                    cursor = parents[cursor]
                path.reverse()
                return path
            queue.append(edge.to_key)

    return []


def _history_stats():
    conn = get_connection()
    row = conn.execute(
        """
        SELECT
            MIN(collected_at) AS earliest,
            MAX(collected_at) AS latest,
            COUNT(*) AS arrival_rows
        FROM train_arrivals
        """
    ).fetchone()
    conn.close()

    earliest = _parse_time(row["earliest"]) if row and row["earliest"] else None
    latest = _parse_time(row["latest"]) if row and row["latest"] else None
    count = int(row["arrival_rows"]) if row and row["arrival_rows"] else 0
    return earliest, latest, count


def _window_row_count(since, until) -> int:
    conn = get_connection()
    count = conn.execute(
        """
        SELECT COUNT(*)
        FROM train_arrivals
        WHERE collected_at >= ? AND collected_at <= ?
        """,
        (since.isoformat(), until.isoformat()),
    ).fetchone()[0]
    conn.close()
    return int(count)


def _compare_window(
    topology,
    start_key: str,
    goal_key: str,
    latest,
    earliest,
    hours: int,
    episodes: int,
    horizon: int,
    theta_star: int,
    delta: float,
) -> dict:
    requested_since = latest - timedelta(hours=hours)
    effective_since = max(earliest, requested_since)
    enough_history = earliest <= requested_since
    arrival_rows = _window_row_count(effective_since, latest)

    live_model = build_live_cost_model(topology, since=effective_since, until=latest)

    env = MetroSSPEnvironment(topology, live_model, start_key, goal_key)
    planner = LCBAdvantageSSP(
        env,
        horizon=horizon,
        episodes=episodes,
        delta=delta,
        theta_star=theta_star,
    )
    planner.train()
    ssp_steps = planner.greedy_plan()
    bfs_edges = _plain_bfs_edge_path(topology, start_key, goal_key)
    bfs_steps = _serialize_steps(topology, live_model, start_key, bfs_edges)

    ssp_summary = _path_summary(ssp_steps, goal_key, start_key)
    bfs_summary = _path_summary(bfs_steps, goal_key, start_key)

    comparison_valid = ssp_summary["reaches_goal"] and bfs_summary["reaches_goal"]
    if comparison_valid:
        cost_delta = round(
            ssp_summary["estimated_total_cost_minutes"] - bfs_summary["estimated_total_cost_minutes"],
            3,
        )
        if cost_delta < 0:
            winner = "ssp"
        elif cost_delta > 0:
            winner = "bfs"
        else:
            winner = "tie"
    else:
        cost_delta = None
        winner = "invalid"

    return {
        "window_hours": hours,
        "enough_history": enough_history,
        "window_start_utc": effective_since.isoformat(),
        "window_end_utc": latest.isoformat(),
        "arrival_rows": arrival_rows,
        "history_hours_available": round((latest - earliest).total_seconds() / 3600.0, 3),
        "comparison_valid": comparison_valid,
        "ssp": ssp_summary,
        "bfs": bfs_summary,
        "winner_by_estimated_cost": winner,
        "estimated_cost_delta_minutes": cost_delta,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare live SSP routing against plain BFS over time windows")
    parser.add_argument("--from-station", default="Clark/Lake", help="Origin station name")
    parser.add_argument("--to-station", default="Midway", help="Destination station name")
    parser.add_argument("--windows", default="1,2,4,6,8", help="Comma-separated history windows in hours")
    parser.add_argument("--episodes", type=int, default=400, help="Number of training episodes")
    parser.add_argument("--horizon", type=int, default=12, help="Horizon parameter H for LCB-ADVANTAGE-SSP")
    parser.add_argument("--theta-star", type=int, default=128, help="Reference update threshold")
    parser.add_argument("--delta", type=float, default=0.05, help="Failure probability parameter")
    parser.add_argument("--output", help="Optional JSON output path")
    args = parser.parse_args()

    init_db()
    earliest, latest, arrival_count = _history_stats()
    if earliest is None or latest is None or arrival_count <= 0:
        raise SystemExit("No arrival history found in cta_data.db.")

    topology = build_topology()
    start_key, goal_key, resolution = _pick_station_pair(topology, args.from_station, args.to_station)
    windows = [int(item.strip()) for item in args.windows.split(",") if item.strip()]

    results = [
        _compare_window(
            topology=topology,
            start_key=start_key,
            goal_key=goal_key,
            latest=latest,
            earliest=earliest,
            hours=hours,
            episodes=args.episodes,
            horizon=args.horizon,
            theta_star=args.theta_star,
            delta=args.delta,
        )
        for hours in windows
    ]

    payload = {
        "start_key": start_key,
        "goal_key": goal_key,
        "start_station": topology.station_names[start_key],
        "goal_station": topology.station_names[goal_key],
        "resolution": resolution,
        "history": {
            "earliest_arrival_utc": earliest.isoformat(),
            "latest_arrival_utc": latest.isoformat(),
            "arrival_rows": arrival_count,
            "history_hours_available": round((latest - earliest).total_seconds() / 3600.0, 3),
        },
        "results": results,
    }

    output_path = Path(args.output) if args.output else DATA_DIR / "benchmark_results.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(json.dumps(payload, indent=2))
    print(f"[benchmark] Report written to {output_path}")


if __name__ == "__main__":
    main()
