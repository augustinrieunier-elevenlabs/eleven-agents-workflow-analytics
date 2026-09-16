// Talks to the Flask cache. Nothing here derives anything.

// Residency region for this session. Sent on every call so the backend reads and
// writes the right namespace even before a key has been connected (demo data and
// cached windows are region-scoped too).
let REGION = 'global';
export const setRegion = (region) => { REGION = region || 'global'; };
export const getRegion = () => REGION;

function withRegion(path) {
  if (!REGION) return path;
  return path + (path.indexOf('?') === -1 ? '?' : '&') + 'region=' + encodeURIComponent(REGION);
}

async function request(path, options = {}) {
  path = withRegion(path);
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || res.statusText || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const getSession = () => request('/api/session');

export const postKey = (apiKey, region) => request('/api/key', {
  method: 'POST', body: JSON.stringify({ api_key: apiKey, region }),
});

export const clearKey = () => request('/api/key', { method: 'DELETE' });

export const getKeys = () => request('/api/keys');

export const saveKey = (alias, apiKey, region) => request('/api/keys', {
  method: 'POST', body: JSON.stringify({ alias, api_key: apiKey, region }),
});

export const activateKey = (alias) =>
  request('/api/keys/' + encodeURIComponent(alias) + '/activate', { method: 'POST' });

export const forgetKey = (alias) =>
  request('/api/keys/' + encodeURIComponent(alias), { method: 'DELETE' });

export const getAgents = (refresh) => request('/api/agents' + (refresh ? '?refresh=1' : ''));

export const getAgent = (agentId, versionId) => {
  const qs = new URLSearchParams();
  if (versionId) qs.set('version_id', versionId);
  const tail = qs.toString();
  return request('/api/agents/' + encodeURIComponent(agentId) + (tail ? '?' + tail : ''));
};

export const getDependencies = (agentId) =>
  request('/api/agents/' + encodeURIComponent(agentId) + '/dependencies');

export const getBranches = (agentId) =>
  request('/api/agents/' + encodeURIComponent(agentId) + '/branches');

export const getVersion = (agentId, versionId) =>
  request('/api/agents/' + encodeURIComponent(agentId) + '/versions/' + encodeURIComponent(versionId));

export const getConversationIndex = (agentId, from, to) =>
  request('/api/conversations?' + new URLSearchParams({ agent_id: agentId, from, to }));

export const getConversation = (conversationId) =>
  request('/api/conversations/' + encodeURIComponent(conversationId));

export const getWindow = (agentId, from, to, versionId, branchId) => {
  const qs = new URLSearchParams({ agent_id: agentId, from, to });
  if (versionId) qs.set('version_id', versionId);
  if (branchId) qs.set('branch_id', branchId);
  return request('/api/window?' + qs);
};

export const startSync = (agentId, from, to, force, branchIds) => {
  const qs = new URLSearchParams({ agent_id: agentId, from, to });
  if (force) qs.set('force', '1');
  for (const id of branchIds || []) qs.append('branch_id', id);
  return request('/api/sync?' + qs, { method: 'POST' });
};

export const syncStatus = (jobId) =>
  request('/api/sync/status' + (jobId ? '?job_id=' + encodeURIComponent(jobId) : ''));

export const seedDemo = (days, perDay) => request('/api/demo', {
  method: 'POST', body: JSON.stringify({ days, per_day: perDay }),
});

const layoutQS = (agentId, branchId) => {
  const qs = new URLSearchParams({ agent_id: agentId });
  if (branchId) qs.set('branch_id', branchId);
  return qs;
};

export const getLayout = (agentId, branchId) =>
  request('/api/layout?' + layoutQS(agentId, branchId));

export const saveLayout = (agentId, branchId, nodes, view) =>
  request('/api/layout?' + layoutQS(agentId, branchId), {
    method: 'PUT', body: JSON.stringify({ nodes, view }),
  });

export const resetLayout = (agentId, branchId) =>
  request('/api/layout?' + layoutQS(agentId, branchId), { method: 'DELETE' });

export const wipeStore = () => request('/api/store', { method: 'DELETE' });
