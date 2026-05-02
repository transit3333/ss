// ======= ROUTE FINDER =======
// Dependencies: constants.js, state.js, cells.js, tracktable.js

// Graph caching with state hash
let cachedGraph = null;
let cachedGridStateHash = null;

function getGridStateHash() {
    let hash = '';
    const keys = Array.from(gridData.keys()).sort();
    keys.forEach(key => {
        const cell = gridData.get(key);
        for (const color in cell.layers) {
            hash += `${key}:${color}:${cell.layers[color].type}:${cell.layers[color].direction || 0};`;
        }
    });
    connections.forEach(conn => {
        hash += `conn:${conn.from}-${conn.to};`;
    });
    hash += `exc:${Array.from(excludedColors).sort().join(',')}`;
    return hash;
}

function getCachedGraph() {
    const currentHash = getGridStateHash();
    if (cachedGraph && cachedGridStateHash === currentHash) {
        return cachedGraph;
    }
    cachedGraph = buildStationGraph();
    cachedGridStateHash = currentHash;
    return cachedGraph;
}

function clearGraphCache() {
    cachedGraph = null;
    cachedGridStateHash = null;
}

let routeHighlightedKeys = [];

class MinPriorityQueue {
    constructor(compareFn) {
        this.items = [];
        this.compare = compareFn;
    }

    push(value) {
        this.items.push(value);
        this._bubbleUp(this.items.length - 1);
    }

    pop() {
        if (this.items.length === 0) return null;
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0) {
            this.items[0] = last;
            this._bubbleDown(0);
        }
        return top;
    }

    get size() {
        return this.items.length;
    }

    _bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.compare(this.items[index], this.items[parent]) >= 0) break;
            [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
            index = parent;
        }
    }

    _bubbleDown(index) {
        const length = this.items.length;
        while (true) {
            let smallest = index;
            const left = index * 2 + 1;
            const right = index * 2 + 2;

            if (left < length && this.compare(this.items[left], this.items[smallest]) < 0) {
                smallest = left;
            }
            if (right < length && this.compare(this.items[right], this.items[smallest]) < 0) {
                smallest = right;
            }
            if (smallest === index) break;
            [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
            index = smallest;
        }
    }
}

function compareRouteScores(a, b) {
    if (a.transfers !== b.transfers) return a.transfers - b.transfers;
    if (a.rideStops !== b.rideStops) return a.rideStops - b.rideStops;
    return a.totalSteps - b.totalSteps;
}

function nextRouteScore(score, edge) {
    return {
        transfers: score.transfers + (edge.viaTransfer ? 1 : 0),
        rideStops: score.rideStops + (edge.viaTransfer ? 0 : 1),
        totalSteps: score.totalSteps + 1
    };
}

function reconstructRoute(visited, toKey) {
    const path = [];
    let node = toKey;
    while (node !== null) {
        const info = visited.get(node);
        path.unshift({
            stationKey: node,
            edgeColor: info.edgeColor,
            viaTransfer: info.viaTransfer
        });
        node = info.prev;
    }
    return path;
}

function getAllStations() {
    const stations = [];
    gridData.forEach((cell, key) => {
        if (cell.hasStation && cell.stationName) {
            stations.push({ key, name: cell.stationName, color: cellFirstColor(cell) });
        }
    });
    stations.sort((a, b) => a.name.localeCompare(b.name));
    return stations;
}

function updateRouteDropdowns() {
    const fromSelect = document.getElementById('routeFrom');
    const toSelect = document.getElementById('routeTo');
    if (!fromSelect || !toSelect) return;
    const prevFrom = fromSelect.value, prevTo = toSelect.value;
    const stations = getAllStations();
    const build = (sel) => {
        let h = '<option value="" style="color:#94a3b8">-- Select Station --</option>';
        stations.forEach(st => { 
            h += `<option value="${st.key}" style="color:${st.color}; font-weight:600;"${st.key === sel ? ' selected' : ''}>${st.name}</option>`; 
        });
        return h;
    };
    fromSelect.innerHTML = build(prevFrom);
    toSelect.innerHTML = build(prevTo);
    syncSelectColor(fromSelect);
    syncSelectColor(toSelect);
}

function syncSelectColor(select) {
    const option = select.options[select.selectedIndex];
    if (option && option.value) {
        select.style.color = option.style.color;
    } else {
        select.style.color = '#94a3b8';
    }
}

function buildStationGraph() {
    const graph = new Map();
    gridData.forEach((cell, key) => { if (cell.hasStation && cell.stationName) { if (!graph.has(key)) graph.set(key, []); } });

    // For each color, build track adjacency and find connected stations
    const byColor = new Map();
    gridData.forEach((cell, key) => {
        for (const color in cell.layers) {
            if (excludedColors.has(color)) continue;
            if (!byColor.has(color)) byColor.set(color, new Map());
            byColor.get(color).set(key, { type: cell.layers[color].type, direction: cell.layers[color].direction, hasStation: cell.hasStation, stationName: cell.stationName });
        }
    });

    byColor.forEach((cellsMap, color) => {
        const getNeighbors = (k) => {
            const c = cellsMap.get(k); if (!c || c.type === 0) return [];
            const exits = TRACK_EXITS[c.type] || [];
            const [x, y] = k.split(',').map(Number);
            const nb = [];
            exits.forEach(d => {
                if (c.direction != null && c.direction !== d) return;
                const off = dirOffsets[d]; if (!off) return;
                const nk = `${x+off.x},${y+off.y}`;
                if (cellsMap.has(nk)) {
                    const nc = cellsMap.get(nk);
                    if (nc.type !== 0 && (TRACK_EXITS[nc.type]||[]).includes((d+4)%8)) {
                        if (nc.direction != null && nc.direction === (d+4)%8) return;
                        nb.push(nk);
                    }
                }
            });
            return nb;
        };

        const stationsInColor = [];
        cellsMap.forEach((c, k) => { if (c.hasStation && c.stationName) stationsInColor.push(k); });

        stationsInColor.forEach(sk => {
            const visited = new Set([sk]); const queue = [sk];
            while (queue.length > 0) {
                const curr = queue.shift();
                for (const nk of getNeighbors(curr)) {
                    if (visited.has(nk)) continue; visited.add(nk);
                    const nc = cellsMap.get(nk);
                    if (nc && nc.hasStation && nc.stationName && nk !== sk) {
                        if (!graph.has(sk)) graph.set(sk, []);
                        if (!graph.get(sk).some(e => e.to === nk && e.color === color))
                            graph.get(sk).push({ to: nk, color, viaTransfer: false });
                        // Stop at intermediate stations — don't expand through them
                    } else {
                        queue.push(nk);
                    }
                }
            }
        });
    });

    connections.forEach(conn => {
        const fc = gridData.get(conn.from), tc = gridData.get(conn.to);
        if (fc && tc && fc.hasStation && tc.hasStation) {
            if (!graph.has(conn.from)) graph.set(conn.from, []);
            if (!graph.has(conn.to)) graph.set(conn.to, []);
            if (!graph.get(conn.from).some(e => e.to === conn.to && e.viaTransfer)) graph.get(conn.from).push({ to: conn.to, color: null, viaTransfer: true });
            if (!graph.get(conn.to).some(e => e.to === conn.from && e.viaTransfer)) graph.get(conn.to).push({ to: conn.from, color: null, viaTransfer: true });
        }
    });
    return graph;
}

function findRoute(fromKey, toKey) {
    const graph = getCachedGraph();
    if (!graph.has(fromKey) || !graph.has(toKey)) return null;

    const visited = new Map();
    const processed = new Set();
    const bestScores = new Map();
    const queue = new MinPriorityQueue((a, b) => compareRouteScores(a.score, b.score));
    const startScore = { transfers: 0, rideStops: 0, totalSteps: 0 };

    bestScores.set(fromKey, startScore);
    visited.set(fromKey, { prev: null, edgeColor: null, viaTransfer: false });
    queue.push({ node: fromKey, score: startScore });

    while (queue.size > 0) {
        const current = queue.pop();
        const curr = current.node;

        if (processed.has(curr)) continue;
        processed.add(curr);

        if (curr === toKey) {
            return reconstructRoute(visited, toKey);
        }

        for (const edge of (graph.get(curr) || [])) {
            if (processed.has(edge.to)) continue;

            const candidateScore = nextRouteScore(bestScores.get(curr), edge);
            const existingScore = bestScores.get(edge.to);

            if (!existingScore || compareRouteScores(candidateScore, existingScore) < 0) {
                bestScores.set(edge.to, candidateScore);
                visited.set(edge.to, { prev: curr, edgeColor: edge.color, viaTransfer: edge.viaTransfer });
                queue.push({ node: edge.to, score: candidateScore });
            }
        }
    }

    return null;
}

function getTrackCellsBetweenStations(fromKey, toKey, color) {
    const cells = new Set();
    const colorCells = new Map();
    gridData.forEach((cell, key) => { if (cell.layers[color] && (cell.layers[color].type !== 0 || cell.hasStation)) colorCells.set(key, cell.layers[color]); });

    const getNeighbors = (k) => {
        const c = colorCells.get(k); if (!c || c.type === 0) return [];
        const exits = TRACK_EXITS[c.type] || [];
        const [x, y] = k.split(',').map(Number); const nb = [];
        exits.forEach(d => {
            if (c.direction != null && c.direction !== d) return;
            const off = dirOffsets[d]; if (!off) return; 
            const nk = `${x+off.x},${y+off.y}`; 
            if (colorCells.has(nk)) {
                const nc = colorCells.get(nk); 
                if (nc.type !== 0 && (TRACK_EXITS[nc.type]||[]).includes((d+4)%8)) {
                    if (nc.direction != null && nc.direction === (d+4)%8) return;
                    nb.push(nk);
                }
            } 
        });
        return nb;
    };

    const visited = new Map([[fromKey, null]]); const queue = [fromKey];
    while (queue.length > 0) {
        const curr = queue.shift();
        if (curr === toKey) { let n = toKey; while (n !== null) { cells.add(n); n = visited.get(n); } return cells; }
        for (const nk of getNeighbors(curr)) { if (!visited.has(nk)) { visited.set(nk, curr); queue.push(nk); } }
    }
    cells.add(fromKey); cells.add(toKey); return cells;
}

function highlightLayer(cellNode, color) {
    if (!cellNode || !color) return;
    cellNode.querySelectorAll(`.track-layer[data-color="${color}"]`).forEach(g => {
        g.classList.add('layer-highlight');
    });
}

function highlightRoute(path) {
    clearRouteHighlight();
    const canvas = document.getElementById('grid-canvas');
    if (canvas) canvas.classList.add('has-route-active');

    if (path.length > 0) {
        const startStep = path[0];
        const endStep = path[path.length - 1];
        
        const addHighlight = (step, type, emoji) => {
            const [gx, gy] = step.stationKey.split(',').map(Number);
            const overlay = document.createElement('div');
            overlay.className = `route-endpoint-overlay ${type}`;
            overlay.style.width = `${CELL_SIZE * 2}px`;
            overlay.style.height = `${CELL_SIZE * 2}px`;
            overlay.style.left = `${(gx - 0.5) * CELL_SIZE}px`;
            overlay.style.top = `${(gy - 0.5) * CELL_SIZE}px`;
            
            if (emoji) {
                const emojiEl = document.createElement('div');
                emojiEl.className = 'route-endpoint-emoji';
                emojiEl.textContent = emoji;
                overlay.appendChild(emojiEl);
            }
            
            canvas.appendChild(overlay);
        };
        
        addHighlight(startStep, 'start');
        if (startStep.stationKey !== endStep.stationKey) {
            addHighlight(endStep, 'end', '🏁');
        }
    }

    for (let i = 0; i < path.length; i++) {
        const step = path[i]; const cell = gridData.get(step.stationKey);
        if (cell && cell.domNode) {
            cell.domNode.classList.add('route-highlight');
            routeHighlightedKeys.push(step.stationKey);
            
            // Highlight the layer used to reach this station
            if (step.edgeColor) highlightLayer(cell.domNode, step.edgeColor);
            
            // If there's a next step on the same line, highlight that too
            if (i + 1 < path.length && !path[i+1].viaTransfer) {
                highlightLayer(cell.domNode, path[i+1].edgeColor);
            }
        }
        
        if (i > 0 && step.viaTransfer) {
            const connKey = `conn-${path[i-1].stationKey}-${step.stationKey}`;
            document.querySelectorAll(`.${CSS.escape(connKey)}`).forEach(line => {
                line.classList.add('route-highlight-line');
            });
        }
        if (i > 0 && !step.viaTransfer && step.edgeColor) {
            getTrackCellsBetweenStations(path[i-1].stationKey, step.stationKey, step.edgeColor).forEach(tk => {
                const tc = gridData.get(tk);
                if (tc && tc.domNode) {
                    tc.domNode.classList.add('route-highlight');
                    highlightLayer(tc.domNode, step.edgeColor);
                    routeHighlightedKeys.push(tk);
                }
            });
        }
    }
}

function clearRouteHighlight() {
    const canvas = document.getElementById('grid-canvas');
    if (canvas) canvas.classList.remove('has-route-active');

    document.querySelectorAll('.route-endpoint-overlay').forEach(el => el.remove());

    routeHighlightedKeys.forEach(key => {
        const cell = gridData.get(key);
        if (cell && cell.domNode) {
            cell.domNode.classList.remove('route-highlight');
            cell.domNode.querySelectorAll('.layer-highlight').forEach(l => l.classList.remove('layer-highlight'));
        }
    });
    document.querySelectorAll('.route-highlight-line').forEach(line => line.classList.remove('route-highlight-line'));
    routeHighlightedKeys = [];
}

function renderRouteResult(path) {
    if (!path || path.length === 0) return '';
    const legs = []; let currentLeg = null;
    for (let i = 0; i < path.length; i++) {
        const step = path[i]; const cell = gridData.get(step.stationKey);
        const name = cell ? cell.stationName : '?';
        if (i === 0) { currentLeg = { color: step.edgeColor || cellFirstColor(cell), stations: [name] }; }
        else if (step.viaTransfer) { if (currentLeg) legs.push(currentLeg); currentLeg = { color: cellFirstColor(cell), stations: [name], isTransfer: true }; }
        else {
            if (step.edgeColor && currentLeg && step.edgeColor !== currentLeg.color) {
                if (currentLeg) legs.push(currentLeg);
                const prev = gridData.get(path[i-1].stationKey);
                currentLeg = { color: step.edgeColor, stations: [prev ? prev.stationName : '?', name] };
            } else { currentLeg.stations.push(name); }
        }
    }
    if (currentLeg) legs.push(currentLeg);
    // Fix first leg color if it was null
    if (legs.length > 0 && !legs[0].color) {
        if (path.length > 1 && path[1].edgeColor) legs[0].color = path[1].edgeColor;
        else { const c = gridData.get(path[0].stationKey); legs[0].color = c ? cellFirstColor(c) : '#94a3b8'; }
    }

    let transfers = 0;
    for (let i = 1; i < legs.length; i++) if (legs[i].isTransfer) transfers++;
    let html = '<div class="route-success">';
    html += `<div class="route-summary"><span class="route-stations-count">${path.length} trạm</span><span class="route-transfers-count">${transfers > 0 ? transfers + ' chuyển tuyến' : 'Trực tiếp'}</span></div>`;
    legs.forEach((leg, idx) => {
        const cName = colorNames[leg.color] || 'Track';
        if (idx > 0 && leg.isTransfer) html += `<div class="route-transfer-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10M17 7L7 17"/></svg>Chuyển sang ${cName} Line</div>`;
        html += `<div class="route-leg"><div class="route-leg-header"><span class="route-leg-color" style="background:${leg.color};box-shadow:0 0 6px ${leg.color};"></span>${cName} Line</div><div class="route-leg-stations">`;
        leg.stations.forEach((st, si) => {
            let cls = 'route-stop';
            if (si === 0 && idx === 0) cls += ' route-stop-first';
            if (si === leg.stations.length - 1 && idx === legs.length - 1) cls += ' route-stop-last';
            html += `<div class="${cls}">${st}</div>`;
        });
        html += '</div></div>';
    });
    html += '</div>';
    return html;
}

function pickRandomStations() {
    const stations = getAllStations();
    if (stations.length < 2) return null;
    
    // Pick two distinct random stations using modular arithmetic (no loop)
    const idx1 = Math.floor(Math.random() * stations.length);
    const idx2 = (idx1 + 1 + Math.floor(Math.random() * (stations.length - 1))) % stations.length;
    
    return { from: stations[idx1].key, to: stations[idx2].key };
}

function initRouteFinder() {
    const findBtn = document.getElementById('findRouteBtn');
    const randomBtn = document.getElementById('randomRouteBtn');
    const clearBtn = document.getElementById('clearRouteBtn');
    const swapBtn = document.getElementById('routeSwapBtn');
    const resultDiv = document.getElementById('routeResult');
    const fromSelect = document.getElementById('routeFrom');
    const toSelect = document.getElementById('routeTo');
    const pickFromBtn = document.getElementById('pickFromBtn');
    const pickToBtn = document.getElementById('pickToBtn');
    
    if (!findBtn) return;

    function updatePickModeUI() {
        document.querySelectorAll('.btn-pick').forEach(b => b.classList.remove('active'));
        viewport.classList.remove('picking-route');
        if (pickingRouteTarget) {
            const btnId = pickingRouteTarget === 'from' ? 'pickFromBtn' : 'pickToBtn';
            const btn = document.getElementById(btnId);
            if (btn) btn.classList.add('active');
            viewport.classList.add('picking-route');
        }
    }

    if (pickFromBtn) pickFromBtn.addEventListener('click', () => {
        pickingRouteTarget = pickingRouteTarget === 'from' ? null : 'from';
        updatePickModeUI();
    });

    if (pickToBtn) pickToBtn.addEventListener('click', () => {
        pickingRouteTarget = pickingRouteTarget === 'to' ? null : 'to';
        updatePickModeUI();
    });

    if (randomBtn) randomBtn.addEventListener('click', () => {
        const picked = pickRandomStations();
        if (!picked) {
            resultDiv.innerHTML = '<div class="route-error">Cần ít nhất 2 ga để dùng chức năng này.</div>';
            return;
        }
        fromSelect.value = picked.from;
        toSelect.value = picked.to;
        syncSelectColor(fromSelect);
        syncSelectColor(toSelect);
        findBtn.click(); // Trigger search immediately
    });

    findBtn.addEventListener('click', () => {
        const fk = fromSelect.value, tk = toSelect.value;
        if (!fk || !tk) { resultDiv.innerHTML = '<div class="route-error">Vui lòng chọn trạm đi và trạm đến.</div>'; return; }
        if (fk === tk) { resultDiv.innerHTML = '<div class="route-error">Trạm đi và trạm đến giống nhau!</div>'; return; }
        const path = findRoute(fk, tk);
        if (!path) { resultDiv.innerHTML = '<div class="route-error">Không tìm thấy đường đi giữa hai trạm này.</div>'; clearRouteHighlight(); clearBtn.style.display = 'none'; return; }
        resultDiv.innerHTML = renderRouteResult(path); highlightRoute(path); clearBtn.style.display = 'block';
    });
    if (clearBtn) clearBtn.addEventListener('click', () => { clearRouteHighlight(); resultDiv.innerHTML = ''; clearBtn.style.display = 'none'; });
    if (swapBtn) swapBtn.addEventListener('click', () => { 
        const tmp = fromSelect.value; 
        fromSelect.value = toSelect.value; 
        toSelect.value = tmp;
        syncSelectColor(fromSelect);
        syncSelectColor(toSelect);
    });

    fromSelect.addEventListener('change', () => syncSelectColor(fromSelect));
    toSelect.addEventListener('change', () => syncSelectColor(toSelect));
    
    initColorExcludePalette();
}

function initColorExcludePalette() {
    const palette = document.getElementById('routeExcludePalette');
    if (!palette) return;

    function render() {
        palette.innerHTML = '';
        METRO_COLORS.forEach(color => {
            const btn = document.createElement('div');
            btn.className = 'color-exclude-btn';
            btn.style.backgroundColor = color;
            const isExcluded = excludedColors.has(color);
            if (isExcluded) {
                btn.classList.add('excluded');
            } else {
                btn.classList.add('active');
            }
            btn.title = isExcluded ? `Include ${colorNames[color]} Line` : `Exclude ${colorNames[color]} Line`;
            
            btn.addEventListener('click', () => {
                if (excludedColors.has(color)) {
                    excludedColors.delete(color);
                } else {
                    excludedColors.add(color);
                }
                clearGraphCache();
                render();
            });
            palette.appendChild(btn);
        });
    }
    render();
}
