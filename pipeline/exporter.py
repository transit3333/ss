import json
from pathlib import Path

from pipeline.config import DATA_DIR, DEFAULT_SNAPSHOT_PATH
from pipeline.db import get_connection


def _rows_to_dicts(rows):
    return [dict(row) for row in rows]


def export_latest_snapshot(output_path: str | Path | None = None) -> Path:
    conn = get_connection()

    latest_arrivals_at = conn.execute("SELECT MAX(collected_at) FROM train_arrivals").fetchone()[0]
    latest_positions_at = conn.execute("SELECT MAX(collected_at) FROM train_positions").fetchone()[0]

    arrivals = []
    positions = []

    if latest_arrivals_at:
        arrivals = _rows_to_dicts(
            conn.execute(
                """
                SELECT *
                FROM train_arrivals
                WHERE collected_at = ?
                ORDER BY station_name, route, predicted_arrival
                """,
                (latest_arrivals_at,),
            ).fetchall()
        )

    if latest_positions_at:
        positions = _rows_to_dicts(
            conn.execute(
                """
                SELECT *
                FROM train_positions
                WHERE collected_at = ?
                ORDER BY route, run_number
                """,
                (latest_positions_at,),
            ).fetchall()
        )

    log_rows = _rows_to_dicts(
        conn.execute(
            """
            SELECT collected_at, collector, status, records, requests, error, duration_ms
            FROM collection_log
            ORDER BY id DESC
            LIMIT 20
            """
        ).fetchall()
    )
    conn.close()

    payload = {
        "source": "CTA Train Tracker API",
        "latest_arrivals_at": latest_arrivals_at,
        "latest_positions_at": latest_positions_at,
        "arrivals_count": len(arrivals),
        "positions_count": len(positions),
        "arrivals": arrivals,
        "positions": positions,
        "recent_runs": log_rows,
    }

    target = Path(output_path) if output_path else DEFAULT_SNAPSHOT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return target
