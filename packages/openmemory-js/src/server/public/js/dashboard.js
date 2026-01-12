// --- State ---
/** @type {string} */
let API_KEY = localStorage.getItem('om_api_key') || '';
/** @type {string|null} */
let CURRENT_USER_ID = null;
/** @type {boolean} */
let IS_ADMIN = false;

// Temporal State
/** @type {'facts'|'edges'} */
let TEMP_MODE = 'facts';
let TEMP_PAGE = 1;
let TEMP_LIMIT = 20;

// --- Init ---
const authModal = document.getElementById('authModal');
const authForm = document.getElementById('authForm');
const apiKeyInput = /** @type {HTMLInputElement} */ (document.getElementById('apiKeyInput'));
const authError = document.getElementById('authError');

if (API_KEY) { checkAuth(); }

if (authForm) {
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const key = apiKeyInput.value.trim();
        if (!key) return;
        API_KEY = key;
        if (await checkAuth()) {
            localStorage.setItem('om_api_key', key);
            authModal.classList.remove('active');
        } else {
            authError.innerText = "Connection failed. Please check your key.";
            authError.style.display = 'block';
            API_KEY = '';
        }
    });
}

/**
 * Universal fetch wrapper with RFC 7807 error handling.
 * @param {string} endpoint 
 * @param {string} [method='GET'] 
 * @param {any} [body=null] 
 * @returns {Promise<any>}
 */
async function fetchAPI(endpoint, method = 'GET', body = null) {
    const opts = { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } };
    if (method !== 'GET') { opts.method = method; if (body) opts.body = JSON.stringify(body); }

    const res = await fetch(endpoint, opts);

    // Handle Auth Failures Globally
    if (res.status === 401 || res.status === 403) {
        if (authModal) authModal.classList.add('active');
        throw new Error("Unauthorized: Please log in.");
    }

    // Try parsing JSON response
    let data;
    const text = await res.text();
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { title: text || res.statusText };
    }

    if (!res.ok) {
        // RFC 7807 Error Handling
        const msg = data.title || data.message || data.error || `Request failed with status ${res.status}`;
        throw new Error(msg);
    }

    return data;
}

/**
 * Validates the current API key and determines admin status.
 * @returns {Promise<boolean>}
 */
async function checkAuth() {
    try {
        await fetchAPI('/dashboard/stats');

        try {
            await fetchAPI('/admin/users'); // Will fail if not admin
            IS_ADMIN = true;
            const adminNav = document.getElementById('adminNav');
            if (adminNav) adminNav.style.display = 'block';
        } catch {
            IS_ADMIN = false;
        }

        startPolling();
        if (authModal) authModal.classList.remove('active');
        return true;
    } catch (e) {
        console.warn("Auth check failed:", e);
        return false;
    }
}

function startPolling() {
    updateOverview();
    setInterval(updateOverview, 3000);
}

// --- Navigation ---
document.addEventListener('DOMContentLoaded', () => {
    const links = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.section');

    links.forEach(l => {
        l.addEventListener('click', (e) => {
            e.preventDefault();
            links.forEach(x => x.classList.remove('active'));
            l.classList.add('active');
            const tab = l.getAttribute('data-tab');

            sections.forEach(s => s.classList.remove('active'));
            const target = document.getElementById(tab);
            if (target) target.classList.add('active');

            // Load Data on switch
            if (tab === 'tab-sources') loadSources();
            if (tab === 'tab-admin-users') fetchAllUsers();
            if (tab === 'tab-temporal') loadTemporal();
            if (tab === 'tab-config') updateOverview();
        });
    });
});

// --- Config Listeners ---
const modelSelect = document.getElementById('modelSelect');
if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
        const custom = document.getElementById('customModelInput');
        if (e.target.value === 'custom') custom.style.display = 'block';
        else custom.style.display = 'none';
    });
}

const modelConfigForm = document.getElementById('modelConfigForm');
if (modelConfigForm) {
    modelConfigForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const sel = document.getElementById('modelSelect').value;
        const custom = document.getElementById('customModelInput').value;
        const model = sel === 'custom' ? custom : sel;

        if (!model) return alert("Please select a model");

        try {
            await fetchAPI('/dashboard/settings', 'POST', {
                type: 'ollama',
                config: { model: model }
            });

            alert(`Configuration saved for ${model}. \nNote: You may need to restart the server or wait.`);
            updateOverview();
        } catch (e) {
            alert("Failed to save config: " + e.message);
        }
    });
}

// --- Overview ---
async function updateOverview() {
    if (document.hidden) return;
    try {
        const [sys, temp, metricsRes] = await Promise.all([
            fetchAPI('/dashboard/stats'),
            fetchAPI('/api/temporal/stats'),
            fetchAPI('/system/metrics').catch(() => ({ metrics: null }))
        ]);

        const setTxt = (id, txt) => {
            const el = document.getElementById(id);
            if (el) el.innerText = txt;
        };

        setTxt('statTotal', sys.totalMemories?.toLocaleString() || '0');
        setTxt('statHistorical', temp.historicalFacts?.toLocaleString() || '0');
        setTxt('statQPS', sys.qps?.toFixed(1) || '0.0');

        if (metricsRes && metricsRes.metrics) {
            const m = metricsRes.metrics;
            setTxt('sysRam', `${m.memory.rss} MB`);
            const upH = (m.uptime / 3600).toFixed(1);
            setTxt('sysUptime', `${upH} hrs`);
            setTxt('sysJobs', m.jobs.active);
            setTxt('sysCpu', "Active");
        }

        if (sys.model) {
            const modelBadge = document.getElementById('modelBadge');
            if (modelBadge) {
                modelBadge.innerText = sys.model;
                modelBadge.style.display = 'inline-flex';
            }
            setTxt('currentModel', sys.model);

            // Preselect
            const sel = document.getElementById('modelSelect');
            if (sel) {
                if (Array.from(sel.options).some(o => o.value === sys.model)) sel.value = sys.model;
                else sel.value = 'custom';
                // Trigger change to update input visibility
                sel.dispatchEvent(new Event('change'));
            }
        }

        if (sys.gpu !== undefined) {
            const gpuEl = document.getElementById('gpuBadge');
            const accEl = document.getElementById('currentAccel');
            if (gpuEl && accEl) {
                if (sys.gpu) {
                    gpuEl.innerText = "GPU Active";
                    gpuEl.style.background = "var(--success-bg)";
                    gpuEl.style.color = "var(--success)";
                    accEl.innerText = "Nvidia GPU";
                    accEl.style.color = "var(--success)";
                } else {
                    gpuEl.innerText = "CPU Only";
                    gpuEl.style.background = "#333";
                    gpuEl.style.color = "#aaa";
                    accEl.innerText = "CPU (Standard)";
                    accEl.style.color = "var(--text-secondary)";
                }
                gpuEl.style.display = 'inline-flex';
            }
        }

        const tl = await fetchAPI('/dashboard/sectors/timeline?hours=24');
        renderTimeline(tl.timeline);
    } catch { }
}

function renderTimeline(data) {
    const c = document.getElementById('timelineChart');
    if (!c) return;
    c.innerHTML = '';
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

// --- Sources ---
async function loadSources() {
    try {
        const res = await fetchAPI('/source-configs');
        const tbody = document.getElementById('sourcesTable');
        if (!tbody) return;
        tbody.innerHTML = '';

        (res.configs || []).forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight:600; text-transform:capitalize;">${s.type}</td>
                <td><span class="badge ${s.status === 'enabled' ? 'badge-success' : 'badge-error'}">${s.status}</span></td>
                <td class="text-secondary">${new Date(s.updatedAt).toLocaleDateString()}</td>
                <td><button class="btn btn-danger btn-sm" onclick="this.parentElement.innerHTML='Deleted...'; deleteSource('${s.type}')">Del</button></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) { console.error(e); }
}

async function deleteSource(type) {
    await fetchAPI(`/source-configs/${type}`, 'DELETE');
    loadSources();
}

function showAddSourceModal() {
    document.getElementById('addSourcePanel').style.display = 'block';
}

const addSourceForm = document.getElementById('addSourceForm');
if (addSourceForm) {
    addSourceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const type = document.getElementById('sourceType').value;
        try {
            const confStr = document.getElementById('sourceConfig').value;
            const config = JSON.parse(confStr); // Validate JSON
            await fetchAPI(`/source-configs/${type}`, 'POST', { config, status: 'enabled' });
            document.getElementById('addSourcePanel').style.display = 'none';
            loadSources();
        } catch (err) {
            alert("Invalid JSON or Save Failed: " + err.message);
        }
    });
}

// --- Admin ---
async function fetchAllUsers() {
    if (!IS_ADMIN) return;
    try {
        const data = await fetchAPI('/admin/users');
        const tbody = document.getElementById('usersTable');
        if (!tbody) return;
        tbody.innerHTML = '';

        (data.users || []).forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="mono">${u.id}</td>
                <td>${(u.scopes || []).join(', ')}</td>
                <td>Active</td>
                <td>
                    <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) { console.error(e); }
}

async function deleteUser(id) {
    if (!confirm(`Delete User ${id} and ALL data?`)) return;
    await fetchAPI(`/admin/users/${id}`, 'DELETE');
    fetchAllUsers();
}

const regUserForm = document.getElementById('regUserForm');
if (regUserForm) {
    regUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const uid = document.getElementById('regUserId').value;
        const scope = document.getElementById('regScope').value;
        const resDiv = document.getElementById('regResult');

        try {
            await fetchAPI('/admin/users', 'POST', { id: uid, scopes: [scope === 'admin' ? 'admin:all' : 'memory:read'] });
            const keyRes = await fetchAPI(`/admin/users/${uid}/keys`, 'POST', { name: 'Initial Key' });

            resDiv.innerHTML = `<div style="padding:10px; background:var(--success-bg); border-radius:6px; color:var(--success); margin-top:8px;">
                User Created!<br>API Key: <b class="mono">${keyRes.apiKey}</b><br>(Copy now, cannot view later)
            </div>`;
            fetchAllUsers();
        } catch (err) {
            resDiv.innerHTML = `<div style="color:var(--error); margin-top:8px;">Failed: ${err.message}</div>`;
        }
    });
}

// --- Explorer ---
async function searchMemories() {
    const q = document.getElementById('searchQuery').value;
    const res = await fetchAPI('/memory/query', 'POST', { query: q, k: 25 });
    const tbody = document.getElementById('explorerTable');
    if (!tbody) return;
    tbody.innerHTML = '';
    (res.matches || []).forEach(m => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="mono text-muted text-xs">${m.id.substring(0, 8)}</td>
            <td style="max-width: 400px;">
                <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(m.content || '')}</div>
                <div class="text-xs text-muted">tags: ${(m.metadata?.tags || []).join(', ')}</div>
            </td>
            <td><span class="badge badge-success">${m.primarySector || 'raw'}</span></td>
            <td class="mono">${(m.salience || 0).toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function updateStats() {
    updateOverview();
}

// --- Temporal Graph Manager ---
function setTemporalMode(mode) {
    TEMP_MODE = mode;
    const btnFacts = document.getElementById('btnModeFacts');
    const btnEdges = document.getElementById('btnModeEdges');
    if (btnFacts) btnFacts.className = mode === 'facts' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
    if (btnEdges) btnEdges.className = mode === 'edges' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';

    const pFacts = document.getElementById('panelFacts');
    const pEdges = document.getElementById('panelEdges');
    if (pFacts) pFacts.style.display = mode === 'facts' ? 'block' : 'none';
    if (pEdges) pEdges.style.display = mode === 'edges' ? 'block' : 'none';

    TEMP_PAGE = 1;
    loadTemporal();
}

async function loadTemporal() {
    const el = document.getElementById('temporalSearch');
    if (!el) return;
    const query = el.value;
    if (TEMP_MODE === 'facts') return loadFacts(query);
    if (TEMP_MODE === 'edges') return loadEdges(query);
}

function changeTemporalPage(delta) {
    TEMP_PAGE = Math.max(1, TEMP_PAGE + delta);
    loadTemporal();
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatValidity(from, to) {
    const f = new Date(from).toLocaleDateString();
    const t = to ? new Date(to).toLocaleDateString() : 'Present';
    return `<span style="font-size:0.85em">${f} <br>→ ${t}</span>`;
}

async function loadFacts(query) {
    const tbody = document.getElementById('factsTable');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">Loading...</td></tr>';

    try {
        let endpoint = '/temporal/fact';
        const params = { limit: TEMP_LIMIT, offset: (TEMP_PAGE - 1) * TEMP_LIMIT };

        if (query) {
            endpoint = '/temporal/search';
            params.pattern = query;
            params.type = 'all';
        }

        const qs = new URLSearchParams(params).toString();
        const res = await fetchAPI(endpoint + '?' + qs);
        const list = res.facts || [];
        tbody.innerHTML = '';

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--text-tertiary);">No facts found</td></tr>';
            return;
        }

        list.forEach(f => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="mono text-xs text-muted" title="${f.id}">${f.id.substring(0, 8)}...</td>
                <td>${escapeHtml(f.subject)}</td>
                <td><span class="badge" style="background: var(--accent-glow); color: var(--accent-primary);">${escapeHtml(f.predicate)}</span></td>
                <td>${escapeHtml(f.object)}</td>
                <td>${(f.confidence || 0).toFixed(2)}</td>
                <td>${formatValidity(f.validFrom, f.validTo)}</td>
                <td class="text-xs text-muted">${new Date(f.lastUpdated || Date.now()).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-ghost btn-sm" onclick='editFact(${JSON.stringify(f).replace(/'/g, "&#39;")})'>Edit</button>
                    <button class="btn btn-danger btn-sm" style="padding: 2px 6px;" onclick="killFact('${f.id}')">&times;</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        const pgNum = document.getElementById('temporalPageNum');
        if (pgNum) pgNum.innerText = `Page ${TEMP_PAGE}`;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--error); text-align:center;">Error: ${e.message}</td></tr>`;
    }
}

async function loadEdges(query) {
    const tbody = document.getElementById('edgesTable');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px;">Loading...</td></tr>';

    try {
        const params = { limit: TEMP_LIMIT, offset: (TEMP_PAGE - 1) * TEMP_LIMIT };
        if (query) {
            params.sourceId = query;
        }

        const qs = new URLSearchParams(params).toString();
        const res = await fetchAPI('/temporal/edge?' + qs);
        const list = res.edges || [];
        tbody.innerHTML = '';

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--text-tertiary);">No edges found</td></tr>';
            return;
        }

        list.forEach(e => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="mono text-xs text-muted" title="${e.id}">${e.id.substring(0, 8)}...</td>
                <td class="mono text-xs">${escapeHtml(e.sourceId.substring(0, 12))}...</td>
                <td class="mono text-xs">${escapeHtml(e.targetId.substring(0, 12))}...</td>
                <td><span class="badge" style="background: var(--success-bg); color: var(--success);">${escapeHtml(e.relationType)}</span></td>
                <td>${(e.weight || 0).toFixed(2)}</td>
                <td>${formatValidity(e.validFrom, e.validTo)}</td>
                <td class="text-xs text-muted">${new Date(e.lastUpdated || Date.now()).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-ghost btn-sm" onclick='editEdge(${JSON.stringify(e).replace(/'/g, "&#39;")})'>Edit</button>
                    <button class="btn btn-danger btn-sm" style="padding: 2px 6px;" onclick="killEdge('${e.id}')">&times;</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        const pgNum = document.getElementById('edgePageNum');
        if (pgNum) pgNum.innerText = `Page ${TEMP_PAGE}`;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--error); text-align:center;">Error: ${e.message}</td></tr>`;
    }
}

// --- Modals & CRUD ---
function openTemporalModal() {
    if (TEMP_MODE === 'facts') openFactModal();
    else openEdgeModal();
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function openFactModal(fact = null) {
    const m = document.getElementById('factModal');
    if (!m) return;
    m.classList.add('active');
    if (fact) {
        document.getElementById('factModalTitle').innerText = "Edit Temporal Fact";
        document.getElementById('factId').value = fact.id;
        document.getElementById('factSubject').value = fact.subject;
        document.getElementById('factSubject').disabled = true;
        document.getElementById('factPredicate').value = fact.predicate;
        document.getElementById('factPredicate').disabled = true;
        document.getElementById('factObject').value = fact.object;
        document.getElementById('factObject').disabled = true;
        document.getElementById('factConfidence').value = fact.confidence;
        document.getElementById('factMetadata').value = fact.metadata ? JSON.stringify(fact.metadata, null, 2) : '';
    } else {
        document.getElementById('factModalTitle').innerText = "New Temporal Fact";
        document.getElementById('factId').value = '';
        document.getElementById('factSubject').value = '';
        document.getElementById('factSubject').disabled = false;
        document.getElementById('factPredicate').value = '';
        document.getElementById('factPredicate').disabled = false;
        document.getElementById('factObject').value = '';
        document.getElementById('factObject').disabled = false;
        document.getElementById('factConfidence').value = '1.0';
        document.getElementById('factMetadata').value = '';
    }
}

const factForm = document.getElementById('factForm');
if (factForm) {
    factForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('factId').value;
        const body = {
            subject: document.getElementById('factSubject').value,
            predicate: document.getElementById('factPredicate').value,
            object: document.getElementById('factObject').value,
            confidence: parseFloat(document.getElementById('factConfidence').value),
            metadata: document.getElementById('factMetadata').value ? JSON.parse(document.getElementById('factMetadata').value) : undefined
        };

        try {
            if (id) {
                await fetchAPI(`/temporal/fact/${id}`, 'PATCH', { confidence: body.confidence, metadata: body.metadata });
            } else {
                await fetchAPI('/temporal/fact', 'POST', body);
            }
            closeModal('factModal');
            loadFacts();
        } catch (err) {
            alert("Operation failed: " + err.message);
        }
    });
}

function editFact(fact) {
    openFactModal(fact);
}

async function killFact(id) {
    if (!confirm("Invalidate this fact? It will be marked as historical.")) return;
    await fetchAPI(`/temporal/fact/${id}`, 'DELETE', { validTo: new Date().toISOString() });
    loadFacts();
}

function openEdgeModal(edge = null) {
    const m = document.getElementById('edgeModal');
    if (!m) return;
    m.classList.add('active');
    if (edge) {
        document.getElementById('edgeModalTitle').innerText = "Edit Temporal Edge";
        document.getElementById('edgeId').value = edge.id;
        document.getElementById('edgeSource').value = edge.sourceId;
        document.getElementById('edgeTarget').value = edge.targetId;
        document.getElementById('edgeRelation').value = edge.relationType;
        document.getElementById('edgeSource').disabled = true;
        document.getElementById('edgeTarget').disabled = true;
        document.getElementById('edgeRelation').disabled = true;
        document.getElementById('edgeWeight').value = edge.weight;
    } else {
        document.getElementById('edgeModalTitle').innerText = "New Temporal Edge";
        document.getElementById('edgeId').value = '';
        document.getElementById('edgeSource').value = '';
        document.getElementById('edgeTarget').value = '';
        document.getElementById('edgeRelation').value = '';
        document.getElementById('edgeSource').disabled = false;
        document.getElementById('edgeTarget').disabled = false;
        document.getElementById('edgeRelation').disabled = false;
        document.getElementById('edgeWeight').value = '1.0';
    }
}

const edgeForm = document.getElementById('edgeForm');
if (edgeForm) {
    edgeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('edgeId').value;
        const body = {
            sourceId: document.getElementById('edgeSource').value,
            targetId: document.getElementById('edgeTarget').value,
            relationType: document.getElementById('edgeRelation').value,
            weight: parseFloat(document.getElementById('edgeWeight').value)
        };
        try {
            if (id) {
                await fetchAPI(`/temporal/edge/${id}`, 'PATCH', { weight: body.weight });
            } else {
                await fetchAPI('/temporal/edge', 'POST', body);
            }
            closeModal('edgeModal');
            loadEdges();
        } catch (err) {
            alert("Operation failed: " + err.message);
        }
    });
}

function editEdge(edge) {
    openEdgeModal(edge);
}

async function killEdge(id) {
    if (!confirm("Invalidate this edge? It will be marked as historical.")) return;
    await fetchAPI(`/temporal/edge/${id}`, 'DELETE', { validTo: new Date().toISOString() });
    loadEdges();
}

// Window Exports
window.editFact = editFact;
window.editEdge = editEdge;
window.killFact = killFact;
window.killEdge = killEdge;
window.deleteSource = deleteSource;
window.deleteUser = deleteUser;
window.searchMemories = searchMemories;
window.updateStats = updateStats;
window.showAddSourceModal = showAddSourceModal;
window.loadTemporal = loadTemporal;
window.setTemporalMode = setTemporalMode;
window.changeTemporalPage = changeTemporalPage;
window.closeModal = closeModal;
window.openTemporalModal = openTemporalModal;
window.fetchAllUsers = fetchAllUsers;
