import argparse
import signal
import sys
import threading
import time
from datetime import datetime, timezone

from pipeline.config import TRAIN_POLL_INTERVAL
from pipeline.db import get_connection, init_db
from pipeline.exporter import export_latest_snapshot
from pipeline.train_collector import collect_arrivals, collect_positions


if hasattr(sys.stdout, "reconfigure"):
    stdout_kwargs = {"line_buffering": True, "write_through": True}
    stderr_kwargs = {"line_buffering": True, "write_through": True}
    if sys.platform == "win32":
        stdout_kwargs.update({"encoding": "utf-8", "errors": "replace"})
        stderr_kwargs.update({"encoding": "utf-8", "errors": "replace"})
    sys.stdout.reconfigure(**stdout_kwargs)
    sys.stderr.reconfigure(**stderr_kwargs)


_shutdown = threading.Event()


def _signal_handler(sig, frame):
    print("\n[pipeline] Shutting down gracefully...", flush=True)
    _shutdown.set()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def train_job(export_json: bool = False, output_path: str | None = None) -> None:
    started_at = time.time()
    print(f"  [{_now()}] [..] TRAIN  collection started", flush=True)
    arrivals_records, arrivals_requests, arrivals_error = collect_arrivals()
    positions_records, positions_requests, positions_error = collect_positions()
    total_records = arrivals_records + positions_records
    total_requests = arrivals_requests + positions_requests
    errors = [error for error in (arrivals_error, positions_error) if error]
    status = "[OK]" if not errors else "[!!]"
    elapsed_ms = int((time.time() - started_at) * 1000)

    export_target = None
    if export_json:
        export_target = export_latest_snapshot(output_path)

    message = (
        f"  [{_now()}] {status} TRAIN  {total_records:>5} records | "
        f"{total_requests:>4} reqs | {elapsed_ms:>5}ms"
    )
    if errors:
        message += f" | errors: {len(errors)}"
    if export_target:
        message += f" | snapshot: {export_target}"
    print(message, flush=True)


def cmd_collect(export_json: bool = False, output_path: str | None = None) -> None:
    init_db()
    print("=" * 70)
    print("  CTA Train Data Pipeline")
    print("=" * 70)
    print(f"  Train polling: every {TRAIN_POLL_INTERVAL}s")
    print(f"  Started at:    {_now()}")
    print("  Press Ctrl+C to stop")
    print("=" * 70)
    print()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    print("[pipeline] Running initial collection...", flush=True)
    train_job(export_json=export_json, output_path=output_path)

    next_run = time.monotonic() + TRAIN_POLL_INTERVAL
    while not _shutdown.is_set():
        now = time.monotonic()
        if now >= next_run:
            train_job(export_json=export_json, output_path=output_path)
            next_run = time.monotonic() + TRAIN_POLL_INTERVAL
            continue
        _shutdown.wait(timeout=min(1.0, max(0.0, next_run - now)))

    print("[pipeline] Stopped.", flush=True)


def cmd_once(export_json: bool = False, output_path: str | None = None) -> None:
    init_db()
    print("[pipeline] Running single train collection cycle...", flush=True)
    train_job(export_json=export_json, output_path=output_path)
    print("[pipeline] Done.", flush=True)


def cmd_status() -> None:
    init_db()
    conn = get_connection()

    print("=" * 70)
    print("  CTA Train Pipeline Status")
    print("=" * 70)

    tables = [
        ("train_arrivals", "Live train arrivals"),
        ("train_positions", "Live train positions"),
        ("collection_log", "Collection run logs"),
    ]
    print(f"\n  {'Table':<25} {'Rows':>12}")
    print(f"  {'-' * 25} {'-' * 12}")
    for table, label in tables:
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {label:<25} {count:>12,}")

    print(f"\n  Recent Collection Runs:")
    print(f"  {'-' * 78}")
    rows = conn.execute(
        """
        SELECT collected_at, collector, status, records, requests, duration_ms, error
        FROM collection_log
        ORDER BY id DESC
        LIMIT 20
        """
    ).fetchall()
    for row in rows:
        err_flag = " !!" if row["error"] else ""
        duration = row["duration_ms"] if row["duration_ms"] is not None else 0
        print(
            f"  {row['collected_at'][:19]}  {row['collector']:<16} "
            f"{row['records']:>5} recs  {row['requests']:>3} reqs  "
            f"{duration:>6}ms  {row['status']}{err_flag}"
        )
    conn.close()
    print("=" * 70)


def cmd_export(output_path: str | None = None) -> None:
    init_db()
    target = export_latest_snapshot(output_path)
    print(f"[pipeline] Exported snapshot to {target}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="CTA train data pipeline for metro36")
    parser.add_argument("--collect", action="store_true", help="Start continuous train collection")
    parser.add_argument("--once", action="store_true", help="Run one train collection cycle")
    parser.add_argument("--status", action="store_true", help="Show pipeline status")
    parser.add_argument("--export-json", action="store_true", help="Export the latest collected snapshot as JSON")
    parser.add_argument("--output", help="Override the JSON snapshot output path")
    args = parser.parse_args()

    if not any([args.collect, args.once, args.status, args.export_json]):
        parser.print_help()
        raise SystemExit(1)

    if args.status:
        cmd_status()
    if args.once:
        cmd_once(export_json=args.export_json, output_path=args.output)
    if args.collect:
        cmd_collect(export_json=args.export_json, output_path=args.output)
    if args.export_json and not args.once and not args.collect:
        cmd_export(args.output)


if __name__ == "__main__":
    main()
