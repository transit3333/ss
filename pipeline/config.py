import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_DIR = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data" / "live"


def _load_local_env(env_path: Path) -> None:
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_local_env(PROJECT_ROOT / ".env")

CTA_TRAIN_API_KEY = os.getenv("CTA_TRAIN_API_KEY", "")

TRAIN_API_BASE = "http://lapi.transitchicago.com/api/1.0"
TRAIN_ARRIVALS_URL = f"{TRAIN_API_BASE}/ttarrivals.aspx"
TRAIN_POSITIONS_URL = f"{TRAIN_API_BASE}/ttpositions.aspx"

TRAIN_POLL_INTERVAL = 60
REQUEST_TIMEOUT = 15
MAX_RETRIES = 2

DB_PATH = PROJECT_ROOT / "cta_data.db"
DEFAULT_SNAPSHOT_PATH = DATA_DIR / "cta_train_snapshot.json"
