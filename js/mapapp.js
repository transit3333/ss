// Real map app with rail overlay, nearest-station snapping, and shortest-path search.

const TILE_SIZE = 256;
const MIN_ZOOM = 11;
const MAX_ZOOM = 19;
const CHICAGO = { lat: 41.8781, lng: -87.6298 };
const CHICAGO_BOUNDS = {
    south: 41.6,
    west: -87.96,
    north: 42.09,
    east: -87.48
};
const FALLBACK_NETWORK_URL = 'data/cta_rail_fallback.json';
const Pathfinding = window.MetroPathfinding;

const mapCanvas = document.getElementById('mapCanvas');
const tileLayer = document.getElementById('tileLayer');
const railTileLayer = document.getElementById('railTileLayer');
const edgeLayer = document.getElementById('edgeLayer');
const stationLayer = document.getElementById('stationLayer');
const markerLayer = document.getElementById('markerLayer');
const chicagoBtn = document.getElementById('chicagoBtn');
const clearPinsBtn = document.getElementById('clearPinsBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const pickStartBtn = document.getElementById('pickStartBtn');
const pickEndBtn = document.getElementById('pickEndBtn');
const findPathBtn = document.getElementById('findPathBtn');
const closeEdgeBtn = document.getElementById('closeEdgeBtn');
const openEdgeBtn = document.getElementById('openEdgeBtn');
const clearClosedEdgesBtn = document.getElementById('clearClosedEdgesBtn');
const edgeEditStatus = document.getElementById('edgeEditStatus');
const pathResult = document.getElementById('pathResult');
const selectedLabel = document.getElementById('selectedLabel');
const selectedCoords = document.getElementById('selectedCoords');
const locationStatus = document.getElementById('locationStatus');
const pinList = document.getElementById('pinList');

const mapState = {
    center: { ...CHICAGO },
    zoom: 13,
    endpoints: { start: null, end: null },
    stations: [],
    railNodes: new Map(),
    railWays: [],
    railGraph: new Map(),
    routeRailPath: [],
    nearest: { start: null, end: null },
    selectedEndpoint: null,
    pickMode: 'start',
    edgeEditMode: null,
    unusableEdgeKeys: new Set(),
    pointer: null,
    stationLoadTimer: null,
    usingFallbackNetwork: false,
    fallbackLoadPromise: null
};

window.metroMapDebug = {
    state: mapState,
    loadFallbackRailNetwork,
    setEndpoint,
    runPathfinding,
    centerMap,
    rebuildRailGraph,
    findRailPath: Pathfinding.findRailPath
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clampLat(lat) {
    return clamp(lat, -85.05112878, 85.05112878);
}

function clampToChicago(latLng) {
    return {
        lat: clamp(clampLat(latLng.lat), CHICAGO_BOUNDS.south, CHICAGO_BOUNDS.north),
        lng: clamp(latLng.lng, CHICAGO_BOUNDS.west, CHICAGO_BOUNDS.east)
    };
}

function boundsIntersect(a, b) {
    return a.west <= b.east &&
        a.east >= b.west &&
        a.south <= b.north &&
        a.north >= b.south;
}

function project(latLng, zoom) {
    const scale = TILE_SIZE * 2 ** zoom;
    const lat = clampLat(latLng.lat);
    const sin = Math.sin(lat * Math.PI / 180);
    return {
        x: (latLng.lng + 180) / 360 * scale,
        y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
    };
}

function unproject(point, zoom) {
    const scale = TILE_SIZE * 2 ** zoom;
    const lng = point.x / scale * 360 - 180;
    const n = Math.PI - 2 * Math.PI * point.y / scale;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
}

function tileBounds(zoom, x, y) {
    const nw = unproject({ x: x * TILE_SIZE, y: y * TILE_SIZE }, zoom);
    const se = unproject({ x: (x + 1) * TILE_SIZE, y: (y + 1) * TILE_SIZE }, zoom);
    return {
        south: Math.min(nw.lat, se.lat),
        west: Math.min(nw.lng, se.lng),
        north: Math.max(nw.lat, se.lat),
        east: Math.max(nw.lng, se.lng)
    };
}

function getTopLeft() {
    const centerWorld = project(mapState.center, mapState.zoom);
    return {
        x: centerWorld.x - mapCanvas.clientWidth / 2,
        y: centerWorld.y - mapCanvas.clientHeight / 2
    };
}

function getViewportBounds() {
    const topLeft = getTopLeft();
    const nw = unproject(topLeft, mapState.zoom);
    const se = unproject({
        x: topLeft.x + mapCanvas.clientWidth,
        y: topLeft.y + mapCanvas.clientHeight
    }, mapState.zoom);
    return {
        south: Math.min(nw.lat, se.lat),
        west: Math.min(nw.lng, se.lng),
        north: Math.max(nw.lat, se.lat),
        east: Math.max(nw.lng, se.lng)
    };
}

function clientPoint(clientX, clientY) {
    const rect = mapCanvas.getBoundingClientRect();
    return {
        x: clientX - rect.left,
        y: clientY - rect.top
    };
}

function clientToLatLng(clientX, clientY) {
    const point = clientPoint(clientX, clientY);
    const topLeft = getTopLeft();
    return unproject({
        x: topLeft.x + point.x,
        y: topLeft.y + point.y
    }, mapState.zoom);
}

function latLngToScreen(latLng) {
    const world = project(latLng, mapState.zoom);
    const topLeft = getTopLeft();
    return {
        x: world.x - topLeft.x,
        y: world.y - topLeft.y
    };
}

function formatCoords(latLng) {
    return `${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`;
}

function setStatus(message) {
    locationStatus.textContent = message;
}

function setSelectedEndpoint(kind) {
    mapState.selectedEndpoint = kind;
    const endpoint = kind ? mapState.endpoints[kind] : null;
    selectedLabel.textContent = endpoint ? `${kind === 'start' ? 'Start' : 'Destination'} point` : 'No point selected';
    selectedCoords.textContent = endpoint ? formatCoords(endpoint) : '--';
    renderMarkers();
}

function setPickMode(mode) {
    mapState.pickMode = mode;
    pickStartBtn.classList.toggle('active', mode === 'start');
    pickEndBtn.classList.toggle('active', mode === 'end');
    if (mode) setEdgeEditMode(null);
    setStatus(mode === 'start' ? 'Click the map to set the start point.' : 'Click the map to set the destination.');
}

function setEdgeEditMode(mode) {
    mapState.edgeEditMode = mode;
    mapCanvas.classList.toggle('edge-editing', Boolean(mode));
    closeEdgeBtn.classList.toggle('active', mode === 'close');
    openEdgeBtn.classList.toggle('active', mode === 'open');
    pickStartBtn.classList.toggle('active', !mode && mapState.pickMode === 'start');
    pickEndBtn.classList.toggle('active', !mode && mapState.pickMode === 'end');
    renderEdgeEditStatus();
}

function renderEdgeEditStatus(message) {
    const count = mapState.unusableEdgeKeys.size;
    if (message) {
        edgeEditStatus.textContent = `${message} ${count} unusable edge${count === 1 ? '' : 's'}.`;
        return;
    }
    const action =
        mapState.edgeEditMode === 'close' ? 'Click a rail segment to mark it unusable.' :
        mapState.edgeEditMode === 'open' ? 'Click a red rail segment to mark it usable.' :
        'Choose a tool, then click a rail segment.';
    edgeEditStatus.textContent = `${action} ${count} unusable edge${count === 1 ? '' : 's'}.`;
}

function centerMap(latLng, zoom = mapState.zoom) {
    mapState.center = clampToChicago(latLng);
    mapState.zoom = clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
    renderMap();
    scheduleStationLoad();
}

function renderBaseTiles() {
    renderTilesInto(tileLayer, (zoom, x, y) => `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`);
    railTileLayer.innerHTML = '';
}

function renderTilesInto(layer, urlForTile) {
    const zoom = mapState.zoom;
    const topLeft = getTopLeft();
    const startX = Math.floor(topLeft.x / TILE_SIZE) - 1;
    const startY = Math.floor(topLeft.y / TILE_SIZE) - 1;
    const endX = Math.floor((topLeft.x + mapCanvas.clientWidth) / TILE_SIZE) + 1;
    const endY = Math.floor((topLeft.y + mapCanvas.clientHeight) / TILE_SIZE) + 1;
    const tileCount = 2 ** zoom;
    const fragment = document.createDocumentFragment();

    layer.innerHTML = '';

    for (let x = startX; x <= endX; x++) {
        const wrappedX = ((x % tileCount) + tileCount) % tileCount;
        for (let y = startY; y <= endY; y++) {
            if (y < 0 || y >= tileCount) continue;
            if (!boundsIntersect(tileBounds(zoom, wrappedX, y), CHICAGO_BOUNDS)) continue;

            const img = document.createElement('img');
            img.className = 'map-tile';
            img.alt = '';
            img.draggable = false;
            img.width = TILE_SIZE;
            img.height = TILE_SIZE;
            img.src = urlForTile(zoom, wrappedX, y);
            img.style.left = `${x * TILE_SIZE - topLeft.x}px`;
            img.style.top = `${y * TILE_SIZE - topLeft.y}px`;
            fragment.appendChild(img);
        }
    }

    layer.appendChild(fragment);
}

function rebuildRailGraph() {
    mapState.railGraph = Pathfinding.buildRailGraph(mapState.railWays, mapState.railNodes, mapState.unusableEdgeKeys);
}

function applyRailNetwork(network, usingFallback) {
    mapState.stations = network.stations;
    mapState.railNodes = network.railNodes;
    mapState.railWays = network.railWays;
    rebuildRailGraph();
    mapState.usingFallbackNetwork = usingFallback;
    refreshNearestStations();
    renderEdgeEditStatus();
    renderMap();
}

async function loadFallbackRailNetwork() {
    if (!mapState.fallbackLoadPromise) {
        mapState.fallbackLoadPromise = fetch(FALLBACK_NETWORK_URL)
            .then(response => {
                if (!response.ok) throw new Error(`Fallback network returned ${response.status}`);
                return response.json();
            })
            .then(data => Pathfinding.createNetworkFromFallback(data));
    }

    const network = await mapState.fallbackLoadPromise;
    applyRailNetwork(network, true);
    return network;
}

function stationById(id) {
    return mapState.stations.find(station => station.id === id);
}

function appendRouteLine(points, className) {
    const screenPoints = points
        .filter(Boolean)
        .map(point => latLngToScreen(point))
        .map(point => `${point.x},${point.y}`)
        .join(' ');
    if (!screenPoints) return;

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', screenPoints);
    polyline.classList.add(className);
    edgeLayer.appendChild(polyline);
}

function renderEdges() {
    edgeLayer.innerHTML = '';

    const bounds = getViewportBounds();
    const visibleMargin = 0.04;

    const drawnSegments = new Set();
    mapState.railWays.forEach(way => {
        for (let i = 1; i < way.nodes.length; i++) {
            const fromId = way.nodes[i - 1];
            const toId = way.nodes[i];
            const from = mapState.railNodes.get(fromId);
            const to = mapState.railNodes.get(toId);
            if (!from || !to) continue;

            const visible =
                (from.lat >= bounds.south - visibleMargin &&
                    from.lat <= bounds.north + visibleMargin &&
                    from.lng >= bounds.west - visibleMargin &&
                    from.lng <= bounds.east + visibleMargin) ||
                (to.lat >= bounds.south - visibleMargin &&
                    to.lat <= bounds.north + visibleMargin &&
                    to.lng >= bounds.west - visibleMargin &&
                    to.lng <= bounds.east + visibleMargin);
            if (!visible) continue;

            const line = way.routeId || way.id;
            const segmentKey = Pathfinding.railEdgeKey(line, fromId, toId);
            if (drawnSegments.has(segmentKey)) continue;
            drawnSegments.add(segmentKey);

            const fromScreen = latLngToScreen(from);
            const toScreen = latLngToScreen(to);
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', `${fromScreen.x},${fromScreen.y} ${toScreen.x},${toScreen.y}`);
            polyline.classList.add('graph-edge');
            if (mapState.unusableEdgeKeys.has(segmentKey)) polyline.classList.add('unusable');
            polyline.dataset.edgeKey = segmentKey;
            if (way.color) polyline.style.stroke = way.color;
            polyline.addEventListener('pointerdown', (event) => {
                if (!mapState.edgeEditMode) return;
                event.preventDefault();
                event.stopPropagation();
            });
            polyline.addEventListener('click', (event) => {
                if (!mapState.edgeEditMode) return;
                event.preventDefault();
                event.stopPropagation();
                editRailEdge(fromId, toId, from, to, line);
            });
            edgeLayer.appendChild(polyline);
        }
    });

    if (mapState.routeRailPath.length > 1) {
        const railPoints = mapState.routeRailPath
            .map(nodeId => mapState.railNodes.get(nodeId))
            .filter(Boolean);
        appendRouteLine(railPoints, 'rail-route-line');
    }
}

function railSegmentKeys(fromId, toId) {
    const keys = new Set();
    mapState.railWays.forEach(way => {
        const line = way.routeId || way.id;
        for (let i = 1; i < way.nodes.length; i++) {
            const a = way.nodes[i - 1];
            const b = way.nodes[i];
            if ((a === fromId && b === toId) || (a === toId && b === fromId)) {
                keys.add(Pathfinding.railEdgeKey(line, a, b));
            }
        }
    });
    return [...keys];
}

function editRailEdge(fromId, toId, from, to, line) {
    const segmentKeys = railSegmentKeys(fromId, toId);
    const closedCount = segmentKeys.filter(key => mapState.unusableEdgeKeys.has(key)).length;
    if (mapState.edgeEditMode === 'close') {
        if (closedCount === segmentKeys.length) {
            renderEdgeEditStatus('That segment is already unusable.');
            return;
        }
        segmentKeys.forEach(key => mapState.unusableEdgeKeys.add(key));
        applyEdgeEdits(`${line || 'Rail'} segment ${from.name || from.id} -> ${to.name || to.id} marked unusable across ${segmentKeys.length} edge pattern${segmentKeys.length === 1 ? '' : 's'}.`);
        return;
    }

    if (mapState.edgeEditMode === 'open') {
        if (closedCount === 0) {
            renderEdgeEditStatus('That segment is already usable.');
            return;
        }
        segmentKeys.forEach(key => mapState.unusableEdgeKeys.delete(key));
        applyEdgeEdits(`${line || 'Rail'} segment ${from.name || from.id} -> ${to.name || to.id} marked usable across ${segmentKeys.length} edge pattern${segmentKeys.length === 1 ? '' : 's'}.`);
    }
}

function applyEdgeEdits(message) {
    rebuildRailGraph();
    mapState.routeRailPath = [];
    renderMap();
    renderEdgeEditStatus(message);
    if (mapState.endpoints.start && mapState.endpoints.end) runPathfinding();
}

function renderStations() {
    const fragment = document.createDocumentFragment();
    stationLayer.innerHTML = '';
    const bounds = getViewportBounds();
    const visibleMargin = 0.02;

    mapState.stations.forEach(station => {
        if (
            station.lat < bounds.south - visibleMargin ||
            station.lat > bounds.north + visibleMargin ||
            station.lng < bounds.west - visibleMargin ||
            station.lng > bounds.east + visibleMargin
        ) {
            return;
        }

        const screen = latLngToScreen(station);
        const marker = document.createElement('button');
        marker.className = 'station-marker';
        marker.type = 'button';
        marker.title = station.name;
        marker.style.left = `${screen.x}px`;
        marker.style.top = `${screen.y}px`;
        marker.addEventListener('pointerdown', event => event.stopPropagation());
        marker.addEventListener('click', (event) => {
            event.stopPropagation();
            setStatus(`${station.name}: ${formatCoords(station)}`);
        });
        fragment.appendChild(marker);
    });

    stationLayer.appendChild(fragment);
}

function renderMarkers() {
    markerLayer.innerHTML = '';
    const fragment = document.createDocumentFragment();

    ['start', 'end'].forEach(kind => {
        const endpoint = mapState.endpoints[kind];
        if (!endpoint) return;

        const screen = latLngToScreen(endpoint);
        const marker = document.createElement('div');
        marker.className = `map-marker endpoint ${kind} ${mapState.selectedEndpoint === kind ? 'selected' : ''}`;
        marker.style.left = `${screen.x}px`;
        marker.style.top = `${screen.y}px`;

        const markerText = document.createElement('span');
        markerText.textContent = kind === 'start' ? 'A' : 'B';
        marker.appendChild(markerText);
        fragment.appendChild(marker);

        const nearest = mapState.routeRailPath.length > 1 ? null : mapState.nearest[kind];
        if (nearest) {
            const station = stationById(nearest.stationId);
            if (station) {
                const stationScreen = latLngToScreen(station);
                const snap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                snap.classList.add('snap-line-svg');
                snap.setAttribute('viewBox', `0 0 ${mapCanvas.clientWidth} ${mapCanvas.clientHeight}`);
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', screen.x);
                line.setAttribute('y1', screen.y);
                line.setAttribute('x2', stationScreen.x);
                line.setAttribute('y2', stationScreen.y);
                line.classList.add('snap-line');
                snap.appendChild(line);
                fragment.appendChild(snap);
            }
        }
    });

    markerLayer.appendChild(fragment);
}

function renderNearestList() {
    pinList.innerHTML = '';
    const items = ['start', 'end']
        .map(kind => ({ kind, nearest: mapState.nearest[kind] }))
        .filter(item => item.nearest);

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pin-empty';
        empty.textContent = 'Pick start and destination to snap to train stations.';
        pinList.appendChild(empty);
        return;
    }

    items.forEach(({ kind, nearest }) => {
        const station = stationById(nearest.stationId);
        if (!station) return;

        const item = document.createElement('button');
        item.className = `pin-item ${kind}`;
        item.type = 'button';

        const dot = document.createElement('span');
        dot.className = 'pin-dot';
        dot.textContent = kind === 'start' ? 'A' : 'B';

        const body = document.createElement('span');
        const title = document.createElement('span');
        title.className = 'pin-title';
        title.textContent = station.name;

        const coords = document.createElement('span');
        coords.className = 'pin-coords';
        coords.textContent = `${kind === 'start' ? 'Start' : 'Destination'} snap: ${Pathfinding.formatDistance(nearest.distance)}`;

        body.appendChild(title);
        body.appendChild(coords);
        item.appendChild(dot);
        item.appendChild(body);
        item.addEventListener('click', () => {
            centerMap(station, Math.max(mapState.zoom, 15));
            setStatus(`${station.name}: ${formatCoords(station)}`);
        });

        pinList.appendChild(item);
    });
}

function renderAlgorithmComparison(summary, comparison) {
    pathResult.innerHTML = '';

    const summaryEl = document.createElement('div');
    summaryEl.className = 'path-summary';
    summaryEl.textContent = summary;
    pathResult.appendChild(summaryEl);

    const table = document.createElement('div');
    table.className = 'algorithm-table';

    ['Algorithm', 'Cost', 'Expanded / Time', 'Accuracy'].forEach(label => {
        const cell = document.createElement('div');
        cell.className = 'algorithm-head';
        cell.textContent = label;
        table.appendChild(cell);
    });

    comparison.forEach(result => {
        const name = document.createElement('div');
        name.className = 'algorithm-cell algorithm-name';
        name.textContent = result.algorithm + (result.optimal ? ' *' : '');

        const cost = document.createElement('div');
        cost.className = 'algorithm-cell';
        cost.textContent = result.found ? Pathfinding.formatMinutes(result.costMinutes) : '--';

        const expanded = document.createElement('div');
        expanded.className = 'algorithm-cell';
        expanded.textContent = `${result.nodesExpanded} / ${result.runtimeMs.toFixed(2)} ms`;

        const accuracy = document.createElement('div');
        accuracy.className = 'algorithm-cell';
        accuracy.textContent = result.found ? `${result.accuracyPct.toFixed(1)}%` : '0%';

        table.appendChild(name);
        table.appendChild(cost);
        table.appendChild(expanded);
        table.appendChild(accuracy);
    });

    pathResult.appendChild(table);
}

function refreshNearestStations() {
    ['start', 'end'].forEach(kind => {
        const endpoint = mapState.endpoints[kind];
        const nearest = endpoint ? Pathfinding.nearestPoint(endpoint, mapState.stations) : null;
        mapState.nearest[kind] = nearest ? { stationId: nearest.id, distance: nearest.distance } : null;
    });
    renderNearestList();
    renderMarkers();
}

function setEndpoint(kind, latLng) {
    mapState.endpoints[kind] = clampToChicago(latLng);
    mapState.routeRailPath = [];
    setSelectedEndpoint(kind);
    refreshNearestStations();
    renderEdges();
    pathResult.textContent = 'Ready to snap endpoints to the nearest train stations.';
    setPickMode(kind === 'start' ? 'end' : 'start');
}

async function loadStationsForViewport() {
    try {
        await loadFallbackRailNetwork();
        setStatus(`Loaded CTA rail network: ${mapState.stations.length} stations, ${mapState.railWays.length} route patterns.`);
    } catch (error) {
        setStatus(`CTA rail network failed: ${error.message}`);
    }
}

function scheduleStationLoad() {
    window.clearTimeout(mapState.stationLoadTimer);
    mapState.stationLoadTimer = window.setTimeout(loadStationsForViewport, 450);
}

function runPathfinding() {
    if (!mapState.endpoints.start || !mapState.endpoints.end) {
        pathResult.textContent = 'Pick both start and destination points first.';
        return;
    }

    refreshNearestStations();
    const startNearest = mapState.nearest.start;
    const endNearest = mapState.nearest.end;
    if (!startNearest || !endNearest) {
        pathResult.textContent = 'No train stations are loaded near the picked points.';
        return;
    }

    if (startNearest.stationId === endNearest.stationId) {
        const station = stationById(startNearest.stationId);
        mapState.routeRailPath = [];
        renderEdges();
        pathResult.textContent = `Both points snap to ${station?.name || 'the same station'}.`;
        return;
    }

    const railResult = Pathfinding.findRailPath(
        startNearest.stationId,
        endNearest.stationId,
        mapState.stations,
        mapState.railNodes,
        mapState.railGraph
    );
    if (!railResult) {
        mapState.routeRailPath = [];
        renderEdges();
        pathResult.textContent = 'No connected rail path found. Try picking points closer to the displayed rail network.';
        return;
    }

    mapState.routeRailPath = railResult.path;
    renderEdges();

    const startStation = stationById(startNearest.stationId);
    const endStation = stationById(endNearest.stationId);
    const startNode = Pathfinding.nearestRailNode(startStation, mapState.railNodes);
    const endNode = Pathfinding.nearestRailNode(endStation, mapState.railNodes);
    const comparison = startNode && endNode
        ? Pathfinding.compareAlgorithms(startNode.nodeId, endNode.nodeId, mapState.railNodes, mapState.railGraph)
        : [];
    const names = [
        startStation?.name || 'Start station',
        endStation?.name || 'Destination station'
    ];
    renderAlgorithmComparison(
        `${Pathfinding.formatDistance(railResult.distance)} rail only: ${names.join(' -> ')}`,
        comparison
    );
}

function renderMap() {
    renderBaseTiles();
    renderEdges();
    renderStations();
    renderMarkers();
}

function zoomAround(clientX, clientY, delta) {
    const nextZoom = clamp(mapState.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === mapState.zoom) return;

    const point = clientPoint(clientX, clientY);
    const anchor = clientToLatLng(clientX, clientY);
    const anchorWorld = project(anchor, nextZoom);
    const centerWorld = {
        x: anchorWorld.x - (point.x - mapCanvas.clientWidth / 2),
        y: anchorWorld.y - (point.y - mapCanvas.clientHeight / 2)
    };

    mapState.zoom = nextZoom;
    mapState.center = clampToChicago(unproject(centerWorld, nextZoom));
    renderMap();
    scheduleStationLoad();
}

function initPointerEvents() {
    mapCanvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        mapCanvas.setPointerCapture(event.pointerId);
        mapState.pointer = {
            id: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startCenterWorld: project(mapState.center, mapState.zoom),
            dragged: false
        };
        mapCanvas.classList.add('dragging');
    });

    mapCanvas.addEventListener('pointermove', (event) => {
        const pointer = mapState.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;

        const dx = event.clientX - pointer.startClientX;
        const dy = event.clientY - pointer.startClientY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pointer.dragged = true;

        if (pointer.dragged) {
            const centerWorld = {
                x: pointer.startCenterWorld.x - dx,
                y: pointer.startCenterWorld.y - dy
            };
            mapState.center = clampToChicago(unproject(centerWorld, mapState.zoom));
            renderMap();
        }
    });

    mapCanvas.addEventListener('pointerup', (event) => {
        const pointer = mapState.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;

        mapCanvas.releasePointerCapture(event.pointerId);
        mapCanvas.classList.remove('dragging');
        mapState.pointer = null;

        if (pointer.dragged) {
            scheduleStationLoad();
            return;
        }

        if (mapState.edgeEditMode) {
            renderEdgeEditStatus('Click directly on a rail segment to edit it.');
            return;
        }

        setEndpoint(mapState.pickMode, clientToLatLng(event.clientX, event.clientY));
    });

    mapCanvas.addEventListener('pointercancel', () => {
        mapState.pointer = null;
        mapCanvas.classList.remove('dragging');
    });

    mapCanvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomAround(event.clientX, event.clientY, event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
}

function initControls() {
    chicagoBtn.addEventListener('click', () => {
        centerMap(CHICAGO, 13);
        setStatus('Centered on Chicago.');
    });

    clearPinsBtn.addEventListener('click', () => {
        mapState.endpoints = { start: null, end: null };
        mapState.nearest = { start: null, end: null };
        mapState.routeRailPath = [];
        setSelectedEndpoint(null);
        renderNearestList();
        renderMap();
        setPickMode('start');
        pathResult.textContent = 'Click the map to set start and destination points.';
    });

    pickStartBtn.addEventListener('click', () => setPickMode('start'));
    pickEndBtn.addEventListener('click', () => setPickMode('end'));
    findPathBtn.addEventListener('click', runPathfinding);
    closeEdgeBtn.addEventListener('click', () => setEdgeEditMode(mapState.edgeEditMode === 'close' ? null : 'close'));
    openEdgeBtn.addEventListener('click', () => setEdgeEditMode(mapState.edgeEditMode === 'open' ? null : 'open'));
    clearClosedEdgesBtn.addEventListener('click', () => {
        if (mapState.unusableEdgeKeys.size === 0) {
            renderEdgeEditStatus('No unusable edges to clear.');
            return;
        }
        mapState.unusableEdgeKeys.clear();
        applyEdgeEdits('All rail segments marked usable.');
    });

    zoomInBtn.addEventListener('click', () => {
        const rect = mapCanvas.getBoundingClientRect();
        zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, 1);
    });

    zoomOutBtn.addEventListener('click', () => {
        const rect = mapCanvas.getBoundingClientRect();
        zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, -1);
    });
}

function initMapApp() {
    initPointerEvents();
    initControls();
    setPickMode('start');
    renderNearestList();
    renderMap();
    loadFallbackRailNetwork()
        .then(() => setStatus(`Loaded full CTA fallback network: ${mapState.stations.length} stations, ${mapState.railWays.length} route patterns.`))
        .catch(error => setStatus(`Fallback rail network failed: ${error.message}`));
    scheduleStationLoad();
    window.addEventListener('resize', () => {
        renderMap();
        scheduleStationLoad();
    });

    if (new URLSearchParams(window.location.search).has('selftest')) {
        window.setTimeout(async () => {
            await loadFallbackRailNetwork();
            setEndpoint('start', { lat: 41.9398, lng: -87.6533 });
            setEndpoint('end', { lat: 41.8857, lng: -87.6309 });
            runPathfinding();
            const result = document.createElement('div');
            result.id = 'selfTestResult';
            result.dataset.routeNodes = String(mapState.routeRailPath.length);
            result.dataset.pathText = pathResult.textContent;
            document.body.appendChild(result);
        }, 50);
    }
}

initMapApp();
