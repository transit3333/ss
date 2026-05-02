import argparse
import json
from pathlib import Path

from pipeline.config import DATA_DIR
from pipeline.db import init_db
from pipeline.live_model import build_live_cost_model
from pipeline.lcb_advantage_ssp import LCBAdvantageSSP
from pipeline.ssp_env import MetroSSPEnvironment
from pipeline.topology import build_topology, resolve_station_candidates, shortest_hops


def _pick_station_pair(topology, from_query: str, to_query: str) -> tuple[str, str]:
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
    return best_pair


def _serialize_plan(topology, plan, start_key: str, goal_key: str):
    total_cost = sum(step["estimated_cost"] for step in plan)
    return {
        "start_key": start_key,
        "goal_key": goal_key,
        "start_station": topology.station_names[start_key],
        "goal_station": topology.station_names[goal_key],
        "estimated_total_cost_minutes": total_cost,
        "steps": [
            {
                **step,
                "from_station": topology.station_names.get(step["from_key"], step["from_key"]),
                "to_station": topology.station_names.get(step["to_key"], step["to_key"]),
            }
            for step in plan
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run stochastic SSP route planning on live CTA data")
    parser.add_argument("--from-station", required=True, help="Origin station name")
    parser.add_argument("--to-station", required=True, help="Destination station name")
    parser.add_argument("--episodes", type=int, default=400, help="Number of training episodes")
    parser.add_argument("--horizon", type=int, default=12, help="Horizon parameter H for LCB-ADVANTAGE-SSP")
    parser.add_argument("--theta-star", type=int, default=128, help="Reference update threshold")
    parser.add_argument("--delta", type=float, default=0.05, help="Failure probability parameter")
    parser.add_argument("--output", help="Optional JSON output path")
    args = parser.parse_args()

    init_db()
    topology = build_topology()
    start_key, goal_key = _pick_station_pair(topology, args.from_station, args.to_station)
    live_model = build_live_cost_model(topology)
    env = MetroSSPEnvironment(topology, live_model, start_key, goal_key)
    planner = LCBAdvantageSSP(
        env,
        horizon=args.horizon,
        episodes=args.episodes,
        delta=args.delta,
        theta_star=args.theta_star,
    )
    planner.train()
    plan = planner.greedy_plan()
    payload = _serialize_plan(topology, plan, start_key, goal_key)

    output_path = Path(args.output) if args.output else DATA_DIR / "ssp_plan.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(json.dumps(payload, indent=2))
    print(f"[ssp] Plan written to {output_path}")


if __name__ == "__main__":
    main()
