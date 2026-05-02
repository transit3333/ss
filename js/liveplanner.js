// ======= LIVE DATA + SSP UI =======
// Dependencies: routing.js, state.js

function escapeLiveHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatLiveTimestamp(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeLiveHtml(value);
    return date.toLocaleString();
}

function convertSspPlanToPath(planData) {
    if (!planData || !Array.isArray(planData.steps) || planData.steps.length === 0) {
        return null;
    }

    const path = [{
        stationKey: planData.start_key,
        edgeColor: null,
        viaTransfer: false
    }];

    planData.steps.forEach(step => {
        path.push({
            stationKey: step.to_key,
            edgeColor: step.color || null,
            viaTransfer: !!step.via_transfer
        });
    });

    return path;
}

function renderLiveSnapshot(snapshot) {
    const statusDiv = document.getElementById('liveDataStatus');
    if (!statusDiv) return;

    const latestRun = Array.isArray(snapshot.recent_runs) && snapshot.recent_runs.length > 0
        ? snapshot.recent_runs[0]
        : null;

    statusDiv.innerHTML = `
        <div class="route-success live-summary">
            <div class="route-summary">
                <span class="route-stations-count">${snapshot.arrivals_count || 0} arrivals</span>
                <span class="route-transfers-count">${snapshot.positions_count || 0} positions</span>
            </div>
            <div class="live-summary-meta">
                <div><strong>Arrivals at:</strong> ${formatLiveTimestamp(snapshot.latest_arrivals_at)}</div>
                <div><strong>Positions at:</strong> ${formatLiveTimestamp(snapshot.latest_positions_at)}</div>
                <div><strong>Last run:</strong> ${latestRun ? escapeLiveHtml(latestRun.status) : 'N/A'}</div>
            </div>
        </div>
    `;
}

function renderSspPlan(planData) {
    const resultDiv = document.getElementById('sspPlanResult');
    const clearBtn = document.getElementById('clearLivePlanBtn');
    if (!resultDiv || !clearBtn) return;

    if (!planData || !Array.isArray(planData.steps) || planData.steps.length === 0) {
        resultDiv.innerHTML = '<div class="route-error">No stochastic plan available.</div>';
        clearBtn.style.display = 'none';
        clearRouteHighlight();
        return;
    }

    const path = convertSspPlanToPath(planData);
    if (path) {
        highlightRoute(path);
    }

    const legsHtml = planData.steps.map(step => {
        const lineName = step.route_code ? `${escapeLiveHtml(step.route_code.toUpperCase())} Line` : 'Transfer';
        const badge = step.via_transfer
            ? '<span class="live-plan-badge">Transfer</span>'
            : `<span class="live-plan-badge line" style="background:${escapeLiveHtml(step.color || '#94a3b8')}">${lineName}</span>`;
        return `
            <div class="route-leg">
                <div class="route-leg-header">
                    ${badge}
                    <span>${escapeLiveHtml(step.from_station)} → ${escapeLiveHtml(step.to_station)}</span>
                </div>
                <div class="route-leg-stations">
                    <div class="route-stop route-stop-first">${escapeLiveHtml(step.from_station)}</div>
                    <div class="route-stop route-stop-last">${escapeLiveHtml(step.to_station)}</div>
                    <div class="live-plan-cost">Estimated cost: ${Number(step.estimated_cost || 0).toFixed(1)} min</div>
                </div>
            </div>
        `;
    }).join('');

    resultDiv.innerHTML = `
        <div class="route-success">
            <div class="route-summary">
                <span class="route-stations-count">${escapeLiveHtml(planData.start_station)} → ${escapeLiveHtml(planData.goal_station)}</span>
                <span class="route-transfers-count">${Number(planData.estimated_total_cost_minutes || 0).toFixed(1)} min</span>
            </div>
            ${legsHtml}
        </div>
    `;
    clearBtn.style.display = 'block';
}

async function loadLatestLiveSnapshot() {
    const statusDiv = document.getElementById('liveDataStatus');
    if (statusDiv) {
        statusDiv.innerHTML = '<div class="route-summary"><span class="route-stations-count">Loading live data...</span></div>';
    }
    try {
        const response = await fetch('data/live/cta_train_snapshot.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json();
        renderLiveSnapshot(snapshot);
    } catch (error) {
        if (statusDiv) {
            statusDiv.innerHTML = `<div class="route-error">Failed to load live snapshot: ${escapeLiveHtml(error.message)}</div>`;
        }
    }
}

async function loadLatestSspPlan() {
    const resultDiv = document.getElementById('sspPlanResult');
    if (resultDiv) {
        resultDiv.innerHTML = '<div class="route-summary"><span class="route-stations-count">Loading SSP plan...</span></div>';
    }
    try {
        const response = await fetch('data/live/ssp_plan.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const planData = await response.json();
        renderSspPlan(planData);
    } catch (error) {
        if (resultDiv) {
            resultDiv.innerHTML = `<div class="route-error">Failed to load SSP plan: ${escapeLiveHtml(error.message)}</div>`;
        }
    }
}

function initLivePlanner() {
    const snapshotBtn = document.getElementById('loadLiveSnapshotBtn');
    const planBtn = document.getElementById('loadSspPlanBtn');
    const clearBtn = document.getElementById('clearLivePlanBtn');
    const resultDiv = document.getElementById('sspPlanResult');

    if (snapshotBtn) snapshotBtn.addEventListener('click', loadLatestLiveSnapshot);
    if (planBtn) planBtn.addEventListener('click', loadLatestSspPlan);
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearRouteHighlight();
            clearBtn.style.display = 'none';
            if (resultDiv) resultDiv.innerHTML = '';
        });
    }
}
