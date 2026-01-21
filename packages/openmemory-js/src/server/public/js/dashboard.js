/**
 * OpenMemory Dashboard Client
 * Handles API interactions, state management, and UI rendering.
 */
"use strict";

const API_BASE = ''; // Relative path because dashboard is served by same server
let API_KEY = localStorage.getItem('om_api_key') || '';

// State
const state = {
    stats: {
        totalMemories: 0,
        totalVectors: 0,
        vectorStore: 'loading...',
        dbSize: '0 MB'
    },
    recentMemories: [],
    searchResults: [],
    graph: {
        nodes: [],
        links: []
    },
    config: {},
    activeSection: 'tab-overview',
    isLoading: false,
    temporalMode: 'facts',
    temporalPage: 1
};

// --- API Client ---

async function apiCall(endpoint, options = {}) {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            signal: controller.signal,
            headers: {
                ...defaultHeaders,
                ...options.headers
            }
        });
        clearTimeout(timeoutId);

        if (res.status === 401) {
            showAuthModal();
            throw new Error('Unauthorized');
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || err.message || `Request failed: ${res.status}`);
        }

        return await res.json();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            showToast('Request timed out', 'error');
        } else if (error.message !== 'Unauthorized') {
            showToast(error.message, 'error');
        }
        console.error('API Error:', error);
        throw error;
    }
}

// --- Auth ---

function checkAuth() {
    if (!API_KEY) {
        showAuthModal();
        return false;
    }
    return true;
}

function showAuthModal() {
    document.getElementById('authModal').classList.add('active');
}

function bindAuth() {
    const form = document.getElementById('authForm');
    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const key = document.getElementById('apiKeyInput').value.trim();
            if (key) {
                API_KEY = key;
                localStorage.setItem('om_api_key', key);
                document.getElementById('authModal').classList.remove('active');
                initDashboard();
            }
        });
    }
}

// --- UI Rendering ---

function renderStats() {
    safeSetText('statTotal', state.stats.totalMemories?.toLocaleString() || '0');
    safeSetText('statHistorical', state.stats.historicalFacts?.toLocaleString() || '0');
    safeSetText('statQPS', state.stats.qps?.toFixed(1) || '0.0');

    // System metrics if available
    if (state.stats.metrics) {
        const m = state.stats.metrics;
        safeSetText('sysRam', `${m.memory.rss} MB`);
        safeSetText('sysUptime', `${(m.uptime / 3600).toFixed(1)} hrs`);
        safeSetText('sysJobs', m.jobs.active);
    }

    // Model info
    if (state.stats.model) {
        safeSetText('currentModel', state.stats.model);
        const badge = document.getElementById('modelBadge');
        if (badge) {
            badge.innerText = state.stats.model;
            badge.style.display = 'inline-flex';
        }
    }
}

function renderTimeline(data) {
    const c = document.getElementById('timelineChart');
    if (!c) return;
    c.innerHTML = '';

    if (!data || data.length === 0) {
        c.innerHTML = '<div class="text-muted text-xs text-center w-full">No activity data</div>';
        return;
    }

    const max = Math.max(...data.map(d => d.count), 1);
    data.forEach(d => {
        const el = document.createElement('div');
        el.className = 'bar';
        const h = (d.count / max) * 100;
        el.style.height = Math.max(h, 5) + '%';
        el.innerHTML = `<div class="bar-tooltip">${d.hour}: ${d.count}</div>`;
        c.appendChild(el);
    });
}

function renderMemoryTable(memories, containerId) {
    const tbody = document.getElementById(containerId);
    if (!tbody) return;

    if (!memories || memories.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="text-center text-muted py-8">
                    No memories found matching your criteria.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = memories.map(m => `
        <tr onclick="viewMemoryDetail('${m.id}')" class="cursor-pointer">
            <td class="font-mono text-xs text-muted">${m.id.substring(0, 8)}...</td>
            <td>
                <div class="truncate" style="max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(m.content || '')}</div>
                    <div class="text-xs text-muted">tags: ${(m.tags || []).join(', ')}</div>
                </div>
            </td>
            <td>
                <span class="badge badge-success">
                    ${m.primarySector || 'general'}
                </span>
            </td>
            <td class="text-sm font-mono text-muted">
                ${(m.salience || 0).toFixed(2)}
            </td>
        </tr>
    `).join('');
}

// --- Interactions ---

function switchSection(sectionId) {
    state.activeSection = sectionId;

    document.querySelectorAll('.nav-link').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === sectionId);
    });

    document.querySelectorAll('.section').forEach(el => {
        el.classList.remove('active');
        if (el.id === sectionId) {
            el.classList.add('active');
            refreshCurrentSection();
        }
    });
}

function refreshCurrentSection() {
    const id = state.activeSection;
    if (id === 'tab-overview') loadOverview();
    if (id === 'tab-explorer') searchMemories(); // Load default view
    if (id === 'tab-temporal') loadTemporal();
    if (id === 'tab-sources') loadSources();
    if (id === 'tab-admin-users') fetchAllUsers();
    if (id === 'tab-dynamics') loadDynamics();
    if (id === 'tab-security') {
        loadAuditLogs();
        loadWebhooks();
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'i';
    if (type === 'success') icon = '✓';
    if (type === 'error') icon = '!';

    toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-content">
            <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
    `;

    container.appendChild(toast);

    // Animation
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px) translateX(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// --- Data Loading ---

async function loadOverview() {
    try {
        const [statsData, timelineData, metricsData] = await Promise.all([
            apiCall('/dashboard/stats'),
            apiCall('/dashboard/sectors/timeline?hours=24').catch(() => ({ timeline: [] })),
            apiCall('/system/metrics').catch(() => ({ metrics: null }))
        ]);

        state.stats = { ...statsData, metrics: metricsData.metrics };
        renderStats();
        renderTimeline(timelineData.timeline);
    } catch (e) {
        // Silent fail for polling
    }
}

async function searchMemories() {
    const queryInput = document.getElementById('searchQuery');
    const query = queryInput ? queryInput.value : '';

    const btn = document.getElementById('btnSearch');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Searching...';
    }

    try {
        const res = await apiCall('/memory/query', {
            method: 'POST',
            body: JSON.stringify({
                query: query,
                k: 25
            })
        });
        state.searchResults = res.matches || [];
        renderMemoryTable(state.searchResults, 'explorerTable');
    } catch (e) {
        console.error("Search failed", e);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Search';
        }
    }
}

// --- Temporal Logic ---

function setTemporalMode(mode) {
    state.temporalMode = mode;
    state.temporalPage = 1;

    // UI Updates
    document.getElementById('btnModeFacts').className = mode === 'facts' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
    document.getElementById('btnModeEdges').className = mode === 'edges' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
    document.getElementById('btnModeGraph').className = mode === 'graph' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';

    document.getElementById('panelFacts').style.display = mode === 'facts' ? 'block' : 'none';
    document.getElementById('panelEdges').style.display = mode === 'edges' ? 'block' : 'none';
    document.getElementById('panelGraph').style.display = mode === 'graph' ? 'block' : 'none';

    loadTemporal();
}

async function loadTemporal() {
    const mode = state.temporalMode;
    const searchVal = document.getElementById('temporalSearch').value;

    if (mode === 'facts') {
        const endpoint = searchVal
            ? `/temporal/search?pattern=${encodeURIComponent(searchVal)}&type=all`
            : `/temporal/fact?limit=20&offset=${(state.temporalPage - 1) * 20}`;

        const res = await apiCall(endpoint);
        renderFactsTable(res.facts || []);
    } else if (mode === 'edges') {
        const endpoint = `/temporal/edge?limit=20&offset=${(state.temporalPage - 1) * 20}${searchVal ? '&sourceId=' + encodeURIComponent(searchVal) : ''}`;
        const res = await apiCall(endpoint);
        renderEdgesTable(res.edges || []);
    } else if (mode === 'graph') {
        loadGraphData();
    }
}

function renderFactsTable(facts) {
    const tbody = document.getElementById('factsTable');
    if (!tbody) return;

    if (facts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-muted">No facts found</td></tr>';
        return;
    }

    tbody.innerHTML = facts.map(f => `
        <tr>
            <td class="mono text-xs text-muted" title="${f.id}">${f.id.substring(0, 8)}...</td>
            <td>${escapeHtml(f.subject)}</td>
            <td><span class="badge" style="background: var(--accent-glow); color: var(--accent-primary);">${escapeHtml(f.predicate)}</span></td>
            <td>${escapeHtml(f.object)}</td>
            <td>${(f.confidence || 0).toFixed(2)}</td>
            <td><span class="text-xs text-muted">${new Date(f.validFrom).toLocaleDateString()}</span></td>
            <td class="text-xs text-muted">${new Date(f.lastUpdated || Date.now()).toLocaleDateString()}</td>
            <td>
                <button class="btn btn-danger btn-sm" onclick="deleteFact('${f.id}')">&times;</button>
            </td>
        </tr>
    `).join('');

    safeSetText('temporalPageNum', `Page ${state.temporalPage}`);
}

function renderEdgesTable(edges) {
    const tbody = document.getElementById('edgesTable');
    if (!tbody) return;

    if (edges.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-muted">No edges found</td></tr>';
        return;
    }

    tbody.innerHTML = edges.map(e => `
        <tr>
            <td class="mono text-xs text-muted" title="${e.id}">${e.id.substring(0, 8)}...</td>
            <td class="mono text-xs" title="${e.sourceId}">${e.sourceId.substring(0, 10)}...</td>
            <td class="mono text-xs" title="${e.targetId}">${e.targetId.substring(0, 10)}...</td>
            <td><span class="badge badge-success">${escapeHtml(e.relationType)}</span></td>
            <td>${(e.weight || 0).toFixed(2)}</td>
             <td><span class="text-xs text-muted">${new Date(e.validFrom).toLocaleDateString()}</span></td>
            <td class="text-xs text-muted">${new Date(e.lastUpdated || Date.now()).toLocaleDateString()}</td>
            <td>
                 <button class="btn btn-danger btn-sm" onclick="deleteEdge('${e.id}')">&times;</button>
            </td>
        </tr>
    `).join('');

    safeSetText('edgePageNum', `Page ${state.temporalPage}`);
}

async function loadGraphData() {
    const svg = document.getElementById('graphSvg');
    if (!svg) return;

    // Clear previous simulation if any
    if (simulation) {
        clearInterval(simulation);
        simulation = null;
    }

    svg.innerHTML = '<text x="50%" y="50%" fill="#777" text-anchor="middle" font-family="sans-serif">Loading graph data...</text>';

    try {
        const [fRes, eRes] = await Promise.all([
            apiCall('/temporal/fact?limit=50'),
            apiCall('/temporal/edge?limit=100')
        ]);

        if (!fRes.facts?.length) {
            svg.innerHTML = '<text x="50%" y="50%" fill="#777" text-anchor="middle" font-family="sans-serif">No temporal facts found</text>';
            return;
        }

        renderForceGraph(svg, fRes.facts, eRes.edges || []);
    } catch (e) {
        svg.innerHTML = `<text x="50%" y="50%" fill="#ef4444" text-anchor="middle" font-family="sans-serif">Error: ${escapeHtml(e.message)}</text>`;
    }
}

// --- Config / Admin ---

async function fetchAllUsers() {
    try {
        const data = await apiCall('/admin/users');
        const tbody = document.getElementById('usersTable');
        if (!tbody) return;

        tbody.innerHTML = (data.users || []).map(u => `
            <tr>
                <td class="mono">${u.id}</td>
                <td><span class="badge badge-neutral">${u.scopes?.join(', ') || 'user'}</span></td>
                <td><span class="badge badge-success">Active</span></td>
                <td>
                    <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')">Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error(e);
    }
}

async function loadSources() {
    try {
        const res = await apiCall('/source-configs');
        const tbody = document.getElementById('sourcesTable');
        if (!tbody) return;

        tbody.innerHTML = (res.configs || []).map(s => `
            <tr>
                <td style="font-weight:600; text-transform:capitalize;">${s.type}</td>
                <td><span class="badge ${s.status === 'enabled' ? 'badge-success' : 'badge-error'}">${s.status}</span></td>
                <td class="text-secondary">${new Date(s.updatedAt).toLocaleDateString()}</td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteSource('${s.type}')">Del</button></td>
            </tr>
        `).join('');
    } catch (e) {
        console.error(e);
    }
}

async function deleteSource(type) {
    if (confirm(`Delete source config for ${type}?`)) {
        await apiCall(`/source-configs/${type}`, { method: 'DELETE' });
        refreshCurrentSection();
        showToast('Source deleted', 'success');
    }
}

async function deleteUser(id) {
    if (confirm(`Delete user ${id} and ALL their data?`)) {
        await apiCall(`/admin/users/${id}`, { method: 'DELETE' });
        refreshCurrentSection();
        showToast('User deleted', 'success');
    }
}

async function deleteFact(id) {
    if (confirm('Delete this fact?')) {
        await apiCall(`/temporal/fact/${id}`, { method: 'DELETE' });
        refreshCurrentSection();
        showToast('Fact deleted', 'success');
    }
}

async function deleteEdge(id) {
    if (confirm('Delete this edge?')) {
        await apiCall(`/temporal/edge/${id}`, { method: 'DELETE' });
        refreshCurrentSection();
        showToast('Edge deleted', 'success');
    }
}

// --- Audit Logs ---

async function loadAuditLogs() {
    try {
        const actionFilter = document.getElementById('auditFilterAction')?.value || '';
        const limit = 50;
        const res = await apiCall(`/audit-logs?limit=${limit}${actionFilter ? '&action=' + actionFilter : ''}`);

        const tbody = document.getElementById('auditLogsTable');
        if (!tbody) return;

        if (!res.logs || res.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No audit logs found</td></tr>';
            return;
        }

        tbody.innerHTML = res.logs.map(log => `
            <tr>
                <td class="text-xs text-muted font-mono">${new Date(log.timestamp).toLocaleString()}</td>
                <td><span class="badge badge-neutral">${escapeHtml(log.userId)}</span></td>
                <td><span class="badge badge-primary">${escapeHtml(log.action)}</span></td>
                <td class="text-xs font-mono">${escapeHtml(log.resourceType || '-')}</td>
                <td class="text-xs text-muted truncate" style="max-width: 200px;" title="${escapeHtml(JSON.stringify(log.details))}">${escapeHtml(JSON.stringify(log.details))}</td>
            </tr>
        `).join('');
    } catch (e) {
        console.error("Audit load failed", e);
        showToast("Failed to load audit logs", "error");
    }
}

// --- Webhooks ---

async function loadWebhooks() {
    try {
        const res = await apiCall('/webhooks');
        const tbody = document.getElementById('webhooksTable');
        if (!tbody) return;

        if (!res.hooks || res.hooks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No webhooks configured</td></tr>';
            return;
        }

        tbody.innerHTML = res.hooks.map(hook => `
            <tr>
                <td class="font-mono text-xs">${hook.id}</td>
                <td><div class="truncate" style="max-width:300px">${escapeHtml(hook.url)}</div></td>
                <td>${(hook.events || []).map(e => `<span class="badge badge-xs">${e}</span>`).join(' ')}</td>
                <td>${hook.active ? '<span class="text-success">Active</span>' : '<span class="text-error">Inactive</span>'}</td>
                <td>
                    <button class="btn btn-sm btn-ghost" onclick="testWebhook('${hook.id}')">Test</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteWebhook('${hook.id}')">&times;</button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error("Webhook load failed", e);
    }
}

function openWebhookModal() {
    document.getElementById('webhookUrl').value = '';
    document.getElementById('webhookEvents').value = '';
    document.getElementById('webhookModal').classList.add('active');
}

async function saveWebhook() {
    const url = document.getElementById('webhookUrl').value;
    if (!url) return showToast("URL required", "error");

    const eventsInput = document.getElementById('webhookEvents').value;
    const events = eventsInput.split(',').map(s => s.trim()).filter(Boolean);

    if (events.length === 0) return showToast("At least one event required", "error");

    try {
        await apiCall('/webhooks', {
            method: 'POST',
            body: JSON.stringify({ url, events })
        });
        showToast("Webhook created", "success");
        closeModal('webhookModal');
        loadWebhooks();
    } catch (e) {
        showToast(e.message, "error");
    }
}

async function deleteWebhook(id) {
    if (!confirm("Delete this webhook?")) return;
    try {
        await apiCall(`/webhooks/${id}`, { method: 'DELETE' });
        loadWebhooks();
        showToast("Webhook deleted", "success");
    } catch (e) {
        showToast(e.message, "error");
    }
}

async function testWebhook(id) {
    try {
        showToast("Sending test event...", "info");
        const res = await apiCall(`/webhooks/${id}/test`, { method: 'POST' });
        if (res.result.success) {
            showToast(`Delivery Success: ${res.result.status}`, "success");
        } else {
            showToast(`Delivery Failed: ${res.result.status} ${res.result.error}`, "error");
        }
    } catch (e) {
        showToast(e.message, "error");
    }
}

// --- Portability ---

async function exportData() {
    try {
        showToast('Starting export...', 'info');
        const btn = document.getElementById('btnExport');
        const originalText = btn ? btn.innerHTML : 'Export';
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'Exporting...';
        }

        const res = await fetch(`${API_BASE}/admin/export`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || err.message || `Export failed: ${res.status}`);
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `openmemory-backup-${new Date().toISOString().split('T')[0]}.jsonl`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        showToast('Export complete', 'success');
    } catch (e) {
        console.error(e);
        showToast('Export failed: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

async function importData() {
    const input = document.getElementById('importFile');
    const file = input.files?.[0];
    if (!file) {
        showToast('Please select a file first', 'error');
        return;
    }

    if (!confirm(`Importing "${file.name}" will update system data. Continue?`)) {
        return;
    }

    const btn = document.getElementById('btnConfirmImport');
    const originalText = btn ? btn.innerHTML : 'Confirm Import';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Importing...';
    }

    try {
        showToast('Streaming import data...', 'info');

        // Use FileReader to handle large text files for NDJSON
        const reader = new FileReader();
        reader.onload = async function (e) {
            try {
                const text = e.target.result;
                const res = await apiCall('/admin/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-ndjson' },
                    body: text
                });

                if (res.success) {
                    showToast(`Import Success: ${res.stats.imported} records imported.`, 'success');
                    setTimeout(() => refreshCurrentSection(), 1500);
                } else {
                    showToast("Import finished with issues.", "warning");
                }
            } catch (err) {
                showToast("Import process failed: " + err.message, "error");
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        };
        reader.onerror = () => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalText;
            }
            showToast("Error reading file", 'error');
        };
        reader.readAsText(file);
    } catch (e) {
        console.error(e);
        showToast('Import failed: ' + e.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    } finally {
        input.value = '';
    }
}

// --- Graph Viz Helper ---
let simulation = null;
function renderForceGraph(svg, facts, edges) {
    // D3.js Force Directed Graph
    if (!window.d3) {
        svg.innerHTML = '<text x="50%" y="50%" fill="red" text-anchor="middle">D3.js Library Missing</text>';
        return;
    }

    svg.innerHTML = ''; // Clear
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;

    // Prepare Data
    const nodeMap = new Map();
    facts.forEach(f => {
        if (!nodeMap.has(f.subject)) nodeMap.set(f.subject, { id: f.subject, group: 'subject' });
        if (!nodeMap.has(f.object)) nodeMap.set(f.object, { id: f.object, group: 'object' });
    });
    const nodes = Array.from(nodeMap.values());

    const links = [];
    // Fact links
    facts.forEach(f => {
        links.push({ source: f.subject, target: f.object, type: 'fact', label: f.predicate });
    });
    // Edge links
    edges.forEach(e => {
        if (nodeMap.has(e.sourceId) && nodeMap.has(e.targetId)) {
            links.push({ source: e.sourceId, target: e.targetId, type: 'edge', label: e.relationType });
        }
    });

    // Color scale
    const color = d3.scaleOrdinal(d3.schemeCategory10);

    // Simulation
    if (simulation) simulation.stop();

    simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(100))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collide", d3.forceCollide(30));

    const svgSel = d3.select(svg);

    // Markers
    const defs = svgSel.append("defs");
    defs.append("marker")
        .attr("id", "arrowhead")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 18) // Offset for node radius
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "#666");

    // Links
    const link = svgSel.append("g")
        .attr("stroke", "#999")
        .attr("stroke-opacity", 0.6)
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke-width", d => Math.sqrt(d.value || 1) + 1)
        .attr("marker-end", "url(#arrowhead)");

    // Nodes
    // SVG Helper
    const node = svgSel.append("g")
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("r", 8)
        .attr("fill", d => color(d.group))
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    node.append("title")
        .text(d => d.id);

    // Labels
    const label = svgSel.append("g")
        .attr("class", "labels")
        .selectAll("text")
        .data(nodes)
        .join("text")
        .attr("dx", 12)
        .attr("dy", ".35em")
        .attr("fill", "#ccc")
        .text(d => d.id)
        .style("font-size", "10px")
        .style("pointer-events", "none");

    // Ticks
    simulation.on("tick", () => {
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        label
            .attr("x", d => d.x)
            .attr("y", d => d.y);
    });

    function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
    }

    function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
    }

    function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
    }
}

// --- Skeleton Helpers ---
function getSkeletonRows(cols = 4, rows = 5) {
    return Array(rows).fill(0).map(() => `
        <tr class="skeleton-row">
            ${Array(cols).fill(0).map(() => `
                <td><div class="skeleton skeleton-text" style="width: ${Math.random() * 50 + 40}%"></div></td>
            `).join('')}
        </tr>
    `).join('');
}

function safeSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function escapeHtml(text) {
    if (!text) return '';
    if (typeof text !== 'string') text = String(text);
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// --- Initialization ---

async function initDashboard() {
    if (!checkAuth()) return;

    // Initial Render
    // Show skeletons on metrics
    safeSetText('statTotal', '...');
    safeSetText('statHistorical', '...');

    // Bind UI
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = link.dataset.tab;
            if (sectionId) switchSection(sectionId);
        });
    });

    const menuToggle = document.getElementById('menuToggle');
    const aside = document.querySelector('aside');
    const overlay = document.getElementById('mobileOverlay');

    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            aside.classList.toggle('active');
            overlay.classList.toggle('active');
        });
    }

    if (overlay) {
        overlay.addEventListener('click', () => {
            aside.classList.remove('active');
            overlay.classList.remove('active');
        });
    }

    bindAuth();
    loadOverview();

    // Poll for stats every 5s if on overview
    setInterval(() => {
        if (state.activeSection === 'tab-overview' && API_KEY) {
            loadOverview();
        }
    }, 5000);

    // Check admin status for nav
    checkAdminStatus();
}

// Global scope
window.setTemporalMode = setTemporalMode;
window.changeTemporalPage = (delta) => {
    state.temporalPage = Math.max(1, state.temporalPage + delta);
    loadTemporal();
};
window.viewMemoryDetail = async (id) => {
    try {
        const res = await apiCall(`/memory/${id}`);
        // Populate modal
        safeSetText('memModalTitle', `Memory ${id.substring(0, 8)}`);
        safeSetText('memContent', res.content || '');
        safeSetText('memSector', res.primarySector || 'unknown');
        safeSetText('memSalience', (res.salience || 0).toFixed(2));
        safeSetText('memCreated', new Date(res.createdAt).toLocaleString());
        safeSetText('memUpdated', new Date(res.lastAccessed).toLocaleString());

        const tags = document.getElementById('memTags');
        tags.innerHTML = (res.tags || []).map(t => `<span class="badge badge-neutral">#${t}</span>`).join('');

        // Delete button
        const btnDel = document.getElementById('btnDeleteMemory');
        if (btnDel) {
            btnDel.onclick = () => deleteMemory(id);
        }

        document.getElementById('memoryModal').classList.add('active');
    } catch (e) {
        showToast("Failed to load memory details", "error");
    }
};

window.onload = initDashboard;



/**
 * Deletes a memory permanently.
 * Common entry point for both table and detail view.
 */
async function deleteMemory(id) {
    if (confirm("Are you sure you want to delete this memory? This cannot be undone.")) {
        try {
            await apiCall(`/memory/${id}`, { method: 'DELETE' });
            showToast("Memory deleted", "success");
            closeModal('memoryModal');
            refreshCurrentSection();
        } catch (e) {
            showToast("Failed to delete memory: " + e.message, "error");
        }
    }
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function changeTemporalPage(delta) {
    if (state.temporalPage + delta > 0) {
        state.temporalPage += delta;
        loadTemporal();
    }
}


// --- Dynamics Visualization ---

async function loadDynamics() {
    try {
        const [constants, graphData] = await Promise.all([
            apiCall('/dynamics/constants'),
            apiCall('/dynamics/waypoints/graph?limit=500')
        ]);

        if (constants && constants.success) {
            const c = constants.constants;
            safeSetText('dynEntropy', (c.lambdaOneFastDecay || 0).toFixed(4)); // Placeholder for entropy
            safeSetText('dynResonance', (c.thetaConsolidationCoefficient || 0).toFixed(4));
        }

        if (graphData && graphData.success) {
            safeSetText('dynWaypoints', graphData.stats.totalNodes);
            renderDynamicsGraph(graphData.nodes);
        }
    } catch (e) {
        console.error("Dynamics Load Error", e);
        showToast("Failed to load dynamics", "error");
    }
}

function renderDynamicsGraph(nodesData) {
    const container = document.getElementById('dynamicsGraphBox');
    container.innerHTML = '';
    const w = container.offsetWidth;
    const h = container.offsetHeight;

    const svg = d3.select(container).append("svg")
        .attr("width", w)
        .attr("height", h)
        .call(d3.zoom().on("zoom", (event) => g.attr("transform", event.transform)))
        .append("g");

    const g = svg.append("g");

    // Process Data
    const nodes = nodesData.map(n => ({ id: n.memoryId, ...n }));
    const links = [];
    nodes.forEach(n => {
        if (n.connections) {
            n.connections.forEach(c => {
                links.push({ source: n.id, target: c.targetId, weight: c.weight });
            });
        }
    });

    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(100))
        .force("charge", d3.forceManyBody().strength(-200))
        .force("center", d3.forceCenter(w / 2, h / 2));

    const link = g.append("g")
        .attr("stroke", "rgba(255,255,255,0.1)")
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke-width", d => Math.max(1, d.weight * 5));

    const node = g.append("g")
        .attr("fill", "var(--accent-secondary)")
        .selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("r", 6)
        .call(drag(simulation));

    node.append("title")
        .text(d => d.id);

    simulation.on("tick", () => {
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
    });

    function drag(sim) {
        function dragstarted(event) {
            if (!event.active) sim.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
        }

        function dragged(event) {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
        }

        function dragended(event) {
            if (!event.active) sim.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
        }

        return d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended);
    }
}

// --- Offline Mode Handling ---

window.addEventListener('offline', () => {
    showToast('Network connection lost. Offline mode active.', 'error');
    document.body.classList.add('offline-mode');
    const badge = document.querySelector('.status-text span');
    if (badge) {
        badge.innerText = 'Offline';
        badge.style.color = 'var(--error)';
        badge.parentElement.innerHTML = 'Status: <span style="color: var(--error);">Offline</span>';
    }
});

window.addEventListener('online', () => {
    showToast('Network connection restored.', 'success');
    document.body.classList.remove('offline-mode');
    // Refresh data to ensure sync
    const badge = document.querySelector('.status-text span');
    if (badge) {
        badge.innerText = 'Online';
        badge.style.color = 'var(--success)';
        badge.parentElement.innerHTML = 'Status: <span style="color: var(--success);">Online</span> <span id="connTime" class="mono" style="margin-left: 8px; opacity: 0.5;">0ms</span>';
    }
    if (state.activeSection) refreshCurrentSection();
});

// --- Init ---



async function checkAdminStatus() {
    try {
        const res = await apiCall('/admin/users?l=1');
        if (res && res.users) {
            const adminNav = document.getElementById('adminNav');
            if (adminNav) adminNav.style.display = 'block';
        }
    } catch {
        // Not admin or auth failed
    }
}

// Ensure global exposure
window.loadDynamics = loadDynamics;

