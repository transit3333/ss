import json
import math
import re
import unicodedata
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from pipeline.config import PROJECT_ROOT


TRACK_EXITS = {
    1: [2, 6], 2: [0, 4], 3: [0, 2], 4: [2, 4], 5: [4, 6], 6: [6, 0],
    7: [3, 7], 8: [1, 5], 9: [3, 6], 10: [0, 5], 11: [2, 7], 12: [1, 4],
    13: [1, 6], 14: [0, 3], 15: [2, 5], 16: [4, 7],
    21: [0, 2, 4, 6], 22: [1, 3, 5, 7], 23: [0, 2, 6], 24: [0, 2, 4],
    25: [2, 4, 6], 26: [0, 4, 6]
}

DIR_OFFSETS = [
    {"x": 0, "y": -1}, {"x": 1, "y": -1}, {"x": 1, "y": 0}, {"x": 1, "y": 1},
    {"x": 0, "y": 1}, {"x": -1, "y": 1}, {"x": -1, "y": 0}, {"x": -1, "y": -1}
]

COLOR_TO_ROUTE = {
    "#ef4444": "red",
    "#0ea5e9": "blue",
    "#22c55e": "g",
    "#f97316": "org",
    "#ec4899": "pink",
    "#eab308": "y",
    "#6366f1": "p",
    "#94a3b8": "brn",
}

MANUAL_STATION_ALIASES = {
    "cotagegrove": "cottagegrove",
    "ciocero": "cicero",
    "ridgland": "ridgeland",
    "belmort": "belmont",
    "kimbal": "kimball",
    "merchmart": "merchandisemart",
    "westem": "western",
    "westtern": "western",
    "uichaisted": "uichalsted",
    "lasale": "lasalle",
    "lasalle": "lasalle",
    "thomdale": "thorndale",
    "clarklake": "clarklake",
    "cermakmccormickplace": "cermakmccormickplace",
    "96thdanryan": "95thdanryan",
    "sox36th": "sox35th",
}


@dataclass(frozen=True)
class Edge:
    to_key: str
    color: str | None
    route_code: str | None
    via_transfer: bool

    @property
    def action_id(self) -> str:
        edge_type = "transfer" if self.via_transfer else "ride"
        route = self.route_code or "transfer"
        color = self.color or "none"
        return f"{edge_type}:{route}:{color}:{self.to_key}"


@dataclass
class Topology:
    station_names: dict[str, str]
    graph: dict[str, list[Edge]]


def normalize_station_name(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "")
    text = text.replace("’", "'").replace("`", "'")
    text = text.replace("\r", " ").replace("\n", " ")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "", text)
    return MANUAL_STATION_ALIASES.get(text, text)


def _load_cells(map_path: Path) -> tuple[dict[str, dict], list[dict]]:
    data = json.loads(map_path.read_text(encoding="utf-8"))
    cells = {item["key"]: item for item in data.get("grid", [])}
    return cells, data.get("connections", [])


def _get_neighbors(cells_map: dict[str, dict], key: str) -> list[str]:
    cell = cells_map.get(key)
    if not cell or cell["type"] == 0:
        return []

    exits = TRACK_EXITS.get(cell["type"], [])
    x, y = map(int, key.split(","))
    neighbors = []

    for direction in exits:
        if cell.get("direction") is not None and cell["direction"] != direction:
            continue
        offset = DIR_OFFSETS[direction]
        neighbor_key = f"{x + offset['x']},{y + offset['y']}"
        if neighbor_key not in cells_map:
            continue
        neighbor = cells_map[neighbor_key]
        reverse = (direction + 4) % 8
        if neighbor["type"] == 0 or reverse not in TRACK_EXITS.get(neighbor["type"], []):
            continue
        if neighbor.get("direction") is not None and neighbor["direction"] == reverse:
            continue
        neighbors.append(neighbor_key)

    return neighbors


def build_topology(map_filename: str = "chicago.json") -> Topology:
    map_path = PROJECT_ROOT / map_filename
    raw_cells, transfer_connections = _load_cells(map_path)

    graph: dict[str, list[Edge]] = {}
    station_names: dict[str, str] = {}

    for key, cell in raw_cells.items():
        if cell.get("hasStation") and cell.get("stationName"):
            graph.setdefault(key, [])
            station_names[key] = cell["stationName"]

    by_color: dict[str, dict[str, dict]] = {}
    for key, cell in raw_cells.items():
        for color, layer in cell.get("layers", {}).items():
            by_color.setdefault(color, {})
            by_color[color][key] = {
                "type": layer.get("type", 0),
                "direction": layer.get("direction"),
                "hasStation": cell.get("hasStation", False),
                "stationName": cell.get("stationName"),
            }

    for color, cells_map in by_color.items():
        route_code = COLOR_TO_ROUTE.get(color)
        stations_in_color = [
            key for key, cell in cells_map.items() if cell.get("hasStation") and cell.get("stationName")
        ]
        for station_key in stations_in_color:
            visited = {station_key}
            queue = deque([station_key])
            while queue:
                current = queue.popleft()
                for neighbor_key in _get_neighbors(cells_map, current):
                    if neighbor_key in visited:
                        continue
                    visited.add(neighbor_key)
                    neighbor = cells_map[neighbor_key]
                    if neighbor.get("hasStation") and neighbor.get("stationName") and neighbor_key != station_key:
                        edge = Edge(
                            to_key=neighbor_key,
                            color=color,
                            route_code=route_code,
                            via_transfer=False,
                        )
                        existing = graph.setdefault(station_key, [])
                        if not any(item.to_key == edge.to_key and item.color == edge.color and not item.via_transfer for item in existing):
                            existing.append(edge)
                    else:
                        queue.append(neighbor_key)

    for conn in transfer_connections:
        from_key = conn.get("from")
        to_key = conn.get("to")
        if from_key not in station_names or to_key not in station_names:
            continue
        graph.setdefault(from_key, [])
        graph.setdefault(to_key, [])
        forward = Edge(to_key=to_key, color=None, route_code=None, via_transfer=True)
        reverse = Edge(to_key=from_key, color=None, route_code=None, via_transfer=True)
        if not any(item.to_key == to_key and item.via_transfer for item in graph[from_key]):
            graph[from_key].append(forward)
        if not any(item.to_key == from_key and item.via_transfer for item in graph[to_key]):
            graph[to_key].append(reverse)

    return Topology(station_names=station_names, graph=graph)


def shortest_hops(topology: Topology, from_key: str, to_key: str) -> int | None:
    if from_key == to_key:
        return 0
    queue = deque([(from_key, 0)])
    visited = {from_key}
    while queue:
        current, depth = queue.popleft()
        for edge in topology.graph.get(current, []):
            if edge.to_key == to_key:
                return depth + 1
            if edge.to_key not in visited:
                visited.add(edge.to_key)
                queue.append((edge.to_key, depth + 1))
    return None


def resolve_station_candidates(topology: Topology, station_query: str) -> list[str]:
    normalized_query = normalize_station_name(station_query)
    exact = [
        key for key, name in topology.station_names.items()
        if normalize_station_name(name) == normalized_query
    ]
    if exact:
        return exact

    scored = []
    for key, name in topology.station_names.items():
        normalized_name = normalize_station_name(name)
        common = len(set(normalized_query) & set(normalized_name))
        distance = abs(len(normalized_query) - len(normalized_name))
        score = common - distance
        scored.append((score, key))
    scored.sort(reverse=True)
    return [key for _, key in scored[:3]]
