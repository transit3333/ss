import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pipeline.config import (
    CTA_TRAIN_API_KEY,
    MAX_RETRIES,
    REQUEST_TIMEOUT,
    TRAIN_ARRIVALS_URL,
    TRAIN_POSITIONS_URL,
)
from pipeline.db import get_connection


STATION_IDS = [
    40010, 40020, 40030, 40040, 40050, 40060, 40070, 40080, 40090, 40100,
    40120, 40130, 40140, 40150, 40160, 40170, 40180, 40190, 40210, 40220,
    40230, 40240, 40250, 40270, 40280, 40290, 40300, 40310, 40320, 40330,
    40340, 40350, 40360, 40370, 40380, 40390, 40400, 40420, 40430, 40440,
    40450, 40460, 40470, 40480, 40490, 40510, 40520, 40530, 40540, 40550,
    40560, 40570, 40580, 40590, 40600, 40610, 40630, 40650, 40660, 40670,
    40680, 40690, 40700, 40710, 40720, 40730, 40740, 40750, 40760, 40770,
    40780, 40790, 40800, 40810, 40820, 40830, 40840, 40850, 40870, 40880,
    40890, 40900, 40910, 40920, 40930, 40940, 40960, 40970, 40980, 40990,
    41000, 41010, 41020, 41030, 41040, 41050, 41060, 41070, 41080, 41090,
    41120, 41130, 41140, 41150, 41160, 41170, 41180, 41190, 41200, 41210,
    41220, 41230, 41240, 41250, 41260, 41270, 41280, 41290, 41300, 41310,
    41320, 41330, 41340, 41350, 41360, 41380, 41400, 41410, 41420, 41430,
    41440, 41450, 41460, 41480, 41490, 41500, 41510, 41660, 41670, 41680,
    41690, 41700, 41710,
]

TRAIN_ROUTES = ["red", "blue", "brn", "g", "org", "p", "pink", "y"]


def _get(url: str, params: dict, retries: int = MAX_RETRIES) -> str:
    for attempt in range(retries + 1):
        try:
            query = urlencode(params)
            request = Request(
                f"{url}?{query}",
                headers={"User-Agent": "metro36-ssp/1.0"},
            )
            with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception:
            if attempt == retries:
                raise
            time.sleep(1)
    raise RuntimeError("Request retries exhausted")


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _text(element: ET.Element, tag: str, default: str = "") -> str:
    child = element.find(tag)
    return child.text.strip() if child is not None and child.text else default


def _log_collection(
    conn,
    now: str,
    collector: str,
    records: int,
    requests_made: int,
    errors: list[str],
    started_at: float,
) -> None:
    error_msg = "; ".join(errors[:10]) if errors else None
    conn.execute(
        """
        INSERT INTO collection_log (
            collected_at, collector, status, records, requests, error, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now,
            collector,
            "error" if errors and records == 0 else "ok",
            records,
            requests_made,
            error_msg,
            int((time.time() - started_at) * 1000),
        ),
    )


def collect_arrivals() -> tuple[int, int, str | None]:
    started_at = time.time()
    if not CTA_TRAIN_API_KEY or CTA_TRAIN_API_KEY.startswith("your_"):
        return 0, 0, "No train API key configured"

    conn = get_connection()
    now = datetime.now(timezone.utc).isoformat()
    total_records = 0
    total_requests = 0
    errors: list[str] = []

    for station_id in STATION_IDS:
        try:
            response_text = _get(
                TRAIN_ARRIVALS_URL,
                {
                    "key": CTA_TRAIN_API_KEY,
                    "mapid": station_id,
                    "outputType": "XML",
                    "max": 50,
                },
            )
            total_requests += 1
            root = ET.fromstring(response_text)

            err_code = _text(root, "errCd")
            if err_code and err_code != "0":
                errors.append(f"Station {station_id}: {_text(root, 'errNm')}")
                continue

            rows = []
            for eta in root.findall(".//eta"):
                rows.append(
                    (
                        now,
                        _safe_int(_text(eta, "staId")),
                        _text(eta, "staNm"),
                        _safe_int(_text(eta, "stpId")),
                        _text(eta, "stpDe"),
                        _text(eta, "rt"),
                        _text(eta, "rn"),
                        _safe_int(_text(eta, "destSt")),
                        _text(eta, "destNm"),
                        _text(eta, "arrT"),
                        1 if _text(eta, "isApp") == "1" else 0,
                        1 if _text(eta, "isSch") == "1" else 0,
                        1 if _text(eta, "isDly") == "1" else 0,
                        1 if _text(eta, "isFlt") == "1" else 0,
                        _safe_float(_text(eta, "lat")),
                        _safe_float(_text(eta, "lon")),
                        _safe_int(_text(eta, "heading")),
                        _text(eta, "flags"),
                    )
                )

            if rows:
                conn.executemany(
                    """
                    INSERT INTO train_arrivals (
                        collected_at, station_id, station_name, stop_id, stop_desc,
                        route, run_number, destination_id, destination_name,
                        predicted_arrival, is_approaching, is_scheduled, is_delayed,
                        is_fault, lat, lon, heading, flags
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    rows,
                )
                total_records += len(rows)
        except Exception as exc:
            errors.append(f"Station {station_id}: {str(exc)[:120]}")

    conn.commit()
    _log_collection(conn, now, "train_arrivals", total_records, total_requests, errors, started_at)
    conn.commit()
    conn.close()
    return total_records, total_requests, "; ".join(errors[:10]) if errors else None


def collect_positions() -> tuple[int, int, str | None]:
    started_at = time.time()
    if not CTA_TRAIN_API_KEY or CTA_TRAIN_API_KEY.startswith("your_"):
        return 0, 0, "No train API key configured"

    conn = get_connection()
    now = datetime.now(timezone.utc).isoformat()
    total_records = 0
    total_requests = 0
    errors: list[str] = []

    try:
        response_text = _get(
            TRAIN_POSITIONS_URL,
            {
                "key": CTA_TRAIN_API_KEY,
                "rt": ",".join(TRAIN_ROUTES),
                "outputType": "XML",
            },
        )
        total_requests += 1
        root = ET.fromstring(response_text)

        err_code = _text(root, "errCd")
        if err_code and err_code != "0":
            errors.append(f"Positions: {_text(root, 'errNm')}")
        else:
            rows = []
            for route_element in root.findall(".//route"):
                route_name = route_element.attrib.get("name", "") or _text(route_element, "name")
                for train in route_element.findall(".//train"):
                    rows.append(
                        (
                            now,
                            route_name,
                            _text(train, "rn"),
                            _text(train, "destNm"),
                            _text(train, "nextStaNm"),
                            _text(train, "arrT"),
                            1 if _text(train, "isApp") == "1" else 0,
                            1 if _text(train, "isDly") == "1" else 0,
                            _safe_float(_text(train, "lat")),
                            _safe_float(_text(train, "lon")),
                            _safe_int(_text(train, "heading")),
                        )
                    )

            if rows:
                conn.executemany(
                    """
                    INSERT INTO train_positions (
                        collected_at, route, run_number, dest_name,
                        next_station, predicted_at, is_approaching,
                        is_delayed, lat, lon, heading
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    rows,
                )
                total_records += len(rows)
    except Exception as exc:
        errors.append(f"Positions: {str(exc)[:200]}")

    conn.commit()
    _log_collection(conn, now, "train_positions", total_records, total_requests, errors, started_at)
    conn.commit()
    conn.close()
    return total_records, total_requests, "; ".join(errors[:10]) if errors else None
