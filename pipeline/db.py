import sqlite3

from pipeline.config import DB_PATH


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS train_arrivals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collected_at TEXT NOT NULL,
            station_id INTEGER,
            station_name TEXT,
            stop_id INTEGER,
            stop_desc TEXT,
            route TEXT,
            run_number TEXT,
            destination_id INTEGER,
            destination_name TEXT,
            predicted_arrival TEXT,
            is_approaching INTEGER,
            is_scheduled INTEGER,
            is_delayed INTEGER,
            is_fault INTEGER,
            lat REAL,
            lon REAL,
            heading INTEGER,
            flags TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS train_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collected_at TEXT NOT NULL,
            route TEXT,
            run_number TEXT,
            dest_name TEXT,
            next_station TEXT,
            predicted_at TEXT,
            is_approaching INTEGER,
            is_delayed INTEGER,
            lat REAL,
            lon REAL,
            heading INTEGER
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS collection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collected_at TEXT NOT NULL,
            collector TEXT NOT NULL,
            status TEXT NOT NULL,
            records INTEGER DEFAULT 0,
            requests INTEGER DEFAULT 0,
            error TEXT,
            duration_ms INTEGER
        )
        """
    )

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_train_arrivals_collected_at ON train_arrivals(collected_at)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_train_arrivals_station_id ON train_arrivals(station_id)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_train_positions_collected_at ON train_positions(collected_at)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_collection_log_collected_at ON collection_log(collected_at)"
    )

    conn.commit()
    conn.close()
