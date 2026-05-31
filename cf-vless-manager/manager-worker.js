// Cloudflare Worker control plane for the v2rayng-stable snippets proxy.
// Bindings: DB (D1), USAGE_METER (Durable Object namespace)
// Secrets/vars: ADMIN_TOKEN, EDGE_SECRET, PROXY_HOST

const H_JSON = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const H_TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const DAY = 86400;
const TZ_OFFSET = 8 * 3600;
const SESSION_ACTIVE_WINDOW = 120;
const SESSION_STALE_WINDOW = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/admin') return adminPage(env);
      if (url.pathname.startsWith('/sub/')) return handleSubscription(request, env);
      if (url.pathname.startsWith('/api/edge/')) return handleEdge(request, env);
      if (url.pathname.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        return handleAdmin(request, env);
      }
      return new Response('not found', { status: 404, headers: H_TEXT });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {},
};

export class UsageMeter {
  async fetch(request) {
    return json({ ok: true, disabled: true });
  }
}

async function handleSubscription(request, env) {
  const url = new URL(request.url);
  const token = decodeURIComponent(url.pathname.replace(/^\/sub\//, '').split('/')[0] || '');
  const now = unix();
  const user = await maybeResetUser(env, await first(env.DB, "SELECT * FROM users WHERE sub_token=?", token), now);
  const state = await checkUserOnly(user, now);
  if (!state.ok) return new Response(state.error, { status: 403, headers: H_TEXT });

  const nodes = await getSubscriptionNodes(env, user);
  const custom = parseCustomIps(url.searchParams.get('ips') || '', env);
  const allNodes = [...nodes, ...custom];
  if (!allNodes.length) return new Response('', { status: 204, headers: H_TEXT });

  const links = allNodes.map(n => buildVlessLink(user, n, env, request));
  const format = (url.searchParams.get('format') || 'base64').toLowerCase();
  const headers = {
    ...H_TEXT,
    'subscription-userinfo': `upload=0; download=0; total=0; expire=${user.expires_at || 0}`,
    'profile-update-interval': '12',
  };
  if (format === 'raw') return new Response(links.join('\n'), { headers });
  if (format === 'clash') return new Response(toClashYaml(user, allNodes, env, request), {
    headers: { ...headers, 'content-type': 'text/yaml; charset=utf-8' },
  });
  return new Response(btoa(links.join('\n')), { headers });
}

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
  const resource = parts[0] || 'summary';
  const id = parts[1] || '';

  if (resource === 'summary') return json({ ok: true, data: await summary(env) });
  if (resource === 'bootstrap' && request.method === 'POST') return json({ ok: true, data: await bootstrap(env, await readJson(request)) });
  if (resource === 'users') return usersApi(request, env, id, parts[2] || '');
  if (resource === 'nodes') return tableApi(request, env, 'nodes', id, nodeFields(), nodeDefaults);
  if (resource === 'plans') return json({ ok: false, error: 'plans_disabled' }, 404);
  if (resource === 'groups') return tableApi(request, env, '"groups"', id, groupFields(), groupDefaults);
  return json({ ok: false, error: 'not_found' }, 404);
}

async function usersApi(request, env, id, action) {
  if (id && action === 'node-limits') return userNodeLimitsApi(request, env, id);

  if (request.method === 'GET') {
    if (id) return json({ ok: true, data: await userDetail(env, id) });
    const rows = await all(env.DB,
      "SELECT u.*,(SELECT group_concat(g.name, ', ') FROM user_groups ug JOIN \"groups\" g ON g.id=ug.group_id WHERE ug.user_id=u.id) groups " +
      "FROM users u ORDER BY u.created_at DESC LIMIT 200");
    return json({ ok: true, data: rows });
  }

  if (request.method === 'POST' && !id) {
    const b = await readJson(request);
    const now = unix();
    const validDays = b.valid_days === undefined || b.valid_days === '' ? null : Number(b.valid_days);
    const user = {
      id: b.id || rid('usr'),
      email: b.email || '',
      name: b.name || '',
      uuid: (b.uuid || crypto.randomUUID()).toLowerCase(),
      sub_token: b.sub_token || token(28),
      plan_id: null,
      quota_bytes: 0,
      expires_at: validDays !== null ? daysToExpiry(validDays, now) : (toEpoch(b.expires_at) || 0),
      remaining_hours: numOr(b.remaining_hours, 0),
      hours_enabled: numOr(b.hours_enabled, 0),
      next_reset_at: 0,
      device_limit: 0,
      monthly_connection_limit: 0,
      status: b.status || 'active',
      note: b.note || '',
    };
    await env.DB.prepare(
      "INSERT INTO users(id,email,name,uuid,sub_token,plan_id,quota_bytes,expires_at,remaining_hours,hours_enabled,next_reset_at,device_limit,monthly_connection_limit,status,note,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(user.id, user.email, user.name, user.uuid, user.sub_token, user.plan_id, user.quota_bytes, user.expires_at,
      user.remaining_hours, user.hours_enabled, user.next_reset_at, user.device_limit, user.monthly_connection_limit, user.status, user.note, now, now).run();
    await setUserGroups(env, user.id, b.group_ids || []);
    return json({ ok: true, data: await userDetail(env, user.id) }, 201);
  }

  if (!id) return json({ ok: false, error: 'missing_id' }, 400);

  if (request.method === 'PATCH') {
    const b = await readJson(request);
    if ('valid_days' in b) b.expires_at = daysToExpiry(b.valid_days, unix());
    const allowed = ['email', 'name', 'uuid', 'sub_token', 'expires_at', 'remaining_hours', 'hours_enabled', 'next_reset_at', 'status', 'note'];
    await patchRow(env, 'users', id, allowed, b);
    if (Array.isArray(b.group_ids)) await setUserGroups(env, id, b.group_ids);
    return json({ ok: true, data: await userDetail(env, id) });
  }

  if (request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_groups WHERE user_id=?").bind(id),
      env.DB.prepare("DELETE FROM user_node_limits WHERE user_id=?").bind(id),
      env.DB.prepare("DELETE FROM usage_daily WHERE user_id=?").bind(id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
      env.DB.prepare("UPDATE orders SET user_id=NULL WHERE user_id=?").bind(id),
      env.DB.prepare("DELETE FROM users WHERE id=?").bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

async function userNodeLimitsApi(request, env, userId) {
  if (request.method === 'GET') return json({ ok: true, data: await nodeLimitsForUser(env, userId) });
  if (request.method === 'PATCH' || request.method === 'POST') {
    const b = await readJson(request);
    const rows = Array.isArray(b.limits) ? b.limits : [b];
    for (const row of rows) {
      const nodeId = String(row.node_id || row.nodeId || '').trim();
      if (!nodeId) continue;
      const now = unix();
      await env.DB.prepare(
        "INSERT INTO user_node_limits(user_id,node_id,quota_bytes,used_upload,used_download,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(user_id,node_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at"
      ).bind(userId, nodeId, 0, 0, 0, row.status || 'active', now, now).run();
    }
    return json({ ok: true, data: await nodeLimitsForUser(env, userId) });
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

async function tableApi(request, env, table, id, allowed, defaults) {
  if (request.method === 'GET') {
    if (id) return json({ ok: true, data: await first(env.DB, `SELECT * FROM ${table} WHERE id=?`, id) });
    return json({ ok: true, data: await all(env.DB, `SELECT * FROM ${table} ORDER BY sort_order,name,id LIMIT 500`) });
  }
  if (request.method === 'POST' && !id) {
    const b = { ...defaults(), ...(await readJson(request)) };
    b.id = b.id || rid(table.replace(/"/g, '').slice(0, 3));
    b.created_at = unix();
    b.updated_at = b.created_at;
    const fields = allowed.filter(k => b[k] !== undefined);
    await env.DB.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`)
      .bind(...fields.map(k => dbVal(k, b[k]))).run();
    return json({ ok: true, data: await first(env.DB, `SELECT * FROM ${table} WHERE id=?`, b.id) }, 201);
  }
  if (!id) return json({ ok: false, error: 'missing_id' }, 400);
  if (request.method === 'PATCH') {
    const b = await readJson(request);
    await patchRow(env, table, id, allowed, b);
    return json({ ok: true, data: await first(env.DB, `SELECT * FROM ${table} WHERE id=?`, id) });
  }
  if (request.method === 'DELETE') {
    const now = unix();
    if (table === 'nodes') {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_node_limits WHERE node_id=?").bind(id),
        env.DB.prepare("UPDATE sessions SET closed_at=?,status='closed',close_reason='node_deleted' WHERE node_id=? AND closed_at IS NULL").bind(now, id),
        env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(id),
      ]);
    } else if (table === '"groups"') {
      if (id === 'default') return json({ ok: false, error: 'default_group_protected' }, 400);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_groups WHERE group_id=?").bind(id),
        env.DB.prepare("UPDATE nodes SET group_id='default',updated_at=? WHERE group_id=?").bind(now, id),
        env.DB.prepare('DELETE FROM "groups" WHERE id=?').bind(id),
      ]);
    } else {
      await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run();
    }
    return json({ ok: true });
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

async function bootstrap(env, body) {
  const now = unix();
  const proxyHost = body.proxy_host || env.PROXY_HOST || 'replace-with-your-snippets-worker.workers.dev';
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO \"groups\"(id,name,sort_order,created_at,updated_at) VALUES('default','默认分组',0,?,?)").bind(now, now),
    env.DB.prepare("INSERT OR IGNORE INTO nodes(id,name,address,port,host,sni,path,fp,security,type,group_id,enabled,sort_order,created_at,updated_at) VALUES('native-us','US 原生域名',?,443,?,?,'/node/native-us','chrome','tls','ws','default',1,0,?,?)").bind(proxyHost, proxyHost, proxyHost, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO nodes(id,name,address,port,host,sni,path,fp,security,type,group_id,enabled,sort_order,created_at,updated_at) VALUES('custom','自定义优选 IP','104.17.147.116',443,?,?,'/node/custom','chrome','tls','ws','default',1,99,?,?)").bind(proxyHost, proxyHost, now, now),
  ]);

  let user = null;
  if (body.create_demo_user !== false) {
    user = await first(env.DB, "SELECT * FROM users WHERE email='demo@example.com'");
    if (!user) {
      const id = 'demo';
      const uuid = crypto.randomUUID();
      const sub = token(28);
      await env.DB.prepare(
        "INSERT INTO users(id,email,name,uuid,sub_token,plan_id,quota_bytes,expires_at,next_reset_at,device_limit,monthly_connection_limit,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, 'demo@example.com', '演示用户', uuid, sub, null, 0, now + 30 * DAY, 0, 0, 0, 'active', now, now).run();
      await setUserGroups(env, id, ['default']);
      user = await userDetail(env, id);
    }
  }
  return { proxyHost, demoUser: user };
}

async function summary(env) {
  const [users, active, nodes] = await Promise.all([
    first(env.DB, "SELECT COUNT(*) c FROM users"),
    first(env.DB, "SELECT COUNT(*) c FROM users WHERE status='active'"),
    first(env.DB, "SELECT COUNT(*) c FROM nodes WHERE enabled=1"),
  ]);
  return {
    users: Number(users?.c || 0),
    activeUsers: Number(active?.c || 0),
    activeNodes: Number(nodes?.c || 0),
  };
}

async function getSubscriptionNodes(env, user) {
  return all(env.DB,
    "SELECT n.*,g.name group_name FROM nodes n LEFT JOIN \"groups\" g ON g.id=n.group_id " +
    "WHERE n.enabled=1 AND (NOT EXISTS(SELECT 1 FROM user_groups WHERE user_id=?) OR n.group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)) " +
    "AND NOT EXISTS(SELECT 1 FROM user_node_limits l WHERE l.user_id=? AND l.node_id=n.id AND l.status!='active') " +
    "ORDER BY n.sort_order,n.name",
    user.id, user.id, user.id);
}

async function handleEdge(request, env) {
  if (!sameSecret(request.headers.get('x-edge-secret'), env.EDGE_SECRET)) {
    return json({ ok: false, error: 'bad_edge_secret' }, 401);
  }
  const url = new URL(request.url);
  if (!url.pathname.endsWith('/allow')) return json({ ok: true, disabled: true });
  const body = await readJson(request);
  const token = String(body.token || '').trim();
  const nodeId = nodeIdOf(body.nodeId || body.node || 'default');
  const now = unix();
  const user = await maybeResetUser(env, await first(env.DB, "SELECT * FROM users WHERE sub_token=?", token), now);
  const node = await getNodeForAccess(env, nodeId);
  const access = await checkAccess(env, user, node, now);
  if (!access.ok) return json(access, 403);
  await ensureNodeLimit(env, user.id, node.id);
  const nodeLimit = await nodeLimitOf(env, user.id, node.id);
  if (nodeLimit?.status && nodeLimit.status !== 'active') return json({ ok: false, error: 'node_user_disabled' }, 403);
  if (Number(user.hours_enabled || 0) > 0) {
    const left = Number(user.remaining_hours || 0);
    if (left <= 0) return json({ ok: false, error: 'hours_expired' }, 403);
    await env.DB.prepare("UPDATE users SET remaining_hours=remaining_hours-1,updated_at=? WHERE id=? AND remaining_hours>0")
      .bind(now, user.id).run();
  }
  return json({ ok: true });
}

function buildVlessLink(user, node, env, request) {
  const host = node.host || env.PROXY_HOST || new URL(request.url).hostname;
  const sni = node.sni || host;
  const rawPath = normalizePath(node.path || `/node/${node.id || 'default'}`);
  const regionPath = normalizeRegion(node.region) ? `/r/${normalizeRegion(node.region)}` : '';
  const path = `/t/${encodeURIComponent(user.sub_token)}${regionPath}${rawPath}`;
  const mismatch = certNameMismatch(node.address || host, sni);
  const strictCert = String(env.SUB_STRICT_CERT ?? '0') !== '0';
  const params = new URLSearchParams({
    encryption: 'none',
    security: node.security || 'tls',
    sni,
    type: node.type || 'ws',
    host,
    path,
  });
  if (mismatch && !strictCert) {
    params.set('allowInsecure', '1');
    params.set('alpn', 'http/1.1');
  }
  const target = strictCert && mismatch ? host : (node.address || host);
  const address = String(target).includes(':') && !String(target).startsWith('[') ? `[${target}]` : target;
  return `vless://${user.uuid}@${address}:${strictCert && mismatch ? 443 : (node.port || 443)}?${params.toString()}#${encodeURIComponent(nodeRemark(node))}`;
}

function toClashYaml(user, nodes, env, request) {
  const proxyLines = nodes.map(n => {
    const host = n.host || env.PROXY_HOST || new URL(request.url).hostname;
    const sni = n.sni || host;
    const rawPath = normalizePath(n.path || `/node/${n.id || 'default'}`);
    const regionPath = normalizeRegion(n.region) ? `/r/${normalizeRegion(n.region)}` : '';
    const path = `/t/${encodeURIComponent(user.sub_token)}${regionPath}${rawPath}`;
    const name = yaml(nodeRemark(n));
    const mismatch = certNameMismatch(n.address || host, sni);
    const strictCert = String(env.SUB_STRICT_CERT ?? '0') !== '0';
    const server = strictCert && mismatch ? host : (n.address || host);
    return [
      `  - name: ${name}`,
      `    type: vless`,
      `    server: ${yaml(server)}`,
      `    port: ${Number(strictCert && mismatch ? 443 : (n.port || 443))}`,
      `    uuid: ${user.uuid}`,
      `    tls: true`,
      `    servername: ${yaml(sni)}`,
      !strictCert && mismatch ? '    skip-cert-verify: true' : '',
      !strictCert && mismatch ? '    alpn: [http/1.1]' : '',
      `    network: ws`,
      `    ws-opts:`,
      `      path: ${yaml(path)}`,
      `      headers:`,
      `        Host: ${yaml(host)}`,
    ].join('\n');
  });
  const names = nodes.map(n => yaml(nodeRemark(n))).join(', ');
  return `mixed-port: 7890\nallow-lan: false\nmode: rule\nproxies:\n${proxyLines.join('\n')}\nproxy-groups:\n  - name: AUTO\n    type: select\n    proxies: [${names}]\nrules:\n  - MATCH,AUTO\n`;
}

function nodeRemark(node) {
  const base = String(node?.name || node?.id || 'node').trim();
  const region = normalizeRegion(node?.region);
  if (!region) return base;
  const upper = base.toUpperCase();
  if (upper === region || upper.startsWith(region + ' ') || upper.startsWith(region + '-') || upper.startsWith(`[${region}]`)) return base;
  return `${region}-${base}`;
}

function normalizeRegion(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
}

async function checkAccess(env, user, node, now, checkNodeGroup = true) {
  const u = await checkUserOnly(user, now);
  if (!u.ok) return u;
  if (!node || !node.enabled) return { ok: false, error: 'node_disabled' };
  if (checkNodeGroup && node.group_id) {
    const groups = await first(env.DB, "SELECT COUNT(*) c FROM user_groups WHERE user_id=?", user.id);
    if (Number(groups?.c || 0) > 0) {
      const allowed = await first(env.DB, "SELECT 1 ok FROM user_groups WHERE user_id=? AND group_id=?", user.id, node.group_id);
      if (!allowed) return { ok: false, error: 'node_group_forbidden' };
    }
  }
  return { ok: true };
}

async function checkUserOnly(user, now) {
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.status !== 'active') return { ok: false, error: 'user_disabled' };
  if (Number(user.expires_at || 0) > 0 && Number(user.expires_at) <= now) return { ok: false, error: 'expired' };
  if (Number(user.hours_enabled || 0) > 0 && Number(user.remaining_hours || 0) <= 0) return { ok: false, error: 'hours_expired' };
  return { ok: true };
}

async function activeDeviceCount(env, userId, now = unix()) {
  return first(env.DB,
    "SELECT COUNT(*) c FROM (" +
    "SELECT COALESCE(ip,'') ip,COALESCE(ua,'') ua FROM sessions " +
    "WHERE user_id=? AND closed_at IS NULL AND last_seen_at>? GROUP BY COALESCE(ip,''),COALESCE(ua,'')" +
    ")",
    userId, now - SESSION_ACTIVE_WINDOW);
}

async function userByUuid(env, uuid) {
  return first(env.DB, "SELECT * FROM users WHERE lower(uuid)=?", uuid);
}

async function getNodeForAccess(env, nodeId) {
  const node = await first(env.DB, "SELECT * FROM nodes WHERE id=?", nodeId || 'default');
  if (node) return node;
  if (nodeId === 'default') return { id: 'default', name: '默认节点', enabled: 1, default_user_quota_bytes: 0 };
  return null;
}

async function ensureNodeLimit(env, userId, nodeId) {
  const now = unix();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_node_limits(user_id,node_id,quota_bytes,used_upload,used_download,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)"
  ).bind(userId, nodeId, 0, 0, 0, now, now).run();
}

async function nodeLimitOf(env, userId, nodeId) {
  return first(env.DB, "SELECT * FROM user_node_limits WHERE user_id=? AND node_id=?", userId, nodeId);
}

async function userDetail(env, id) {
  const user = await maybeResetUser(env, await first(env.DB, "SELECT * FROM users WHERE id=?", id), unix());
  if (!user) return null;
  user.group_ids = (await all(env.DB, "SELECT group_id FROM user_groups WHERE user_id=?", id)).map(r => r.group_id);
  user.node_limits = await nodeLimitsForUser(env, id);
  return user;
}

async function resetDueUsers(env) {
  await closeStaleSessions(env, unix());
}

async function closeStaleSessions(env, now = unix()) {
  await env.DB.prepare(
    "UPDATE sessions SET closed_at=?,status='closed',close_reason='stale' WHERE closed_at IS NULL AND last_seen_at<?"
  ).bind(now, now - SESSION_STALE_WINDOW).run();
}

async function maybeResetUser(env, user, now = unix()) {
  return user;
}

async function resetUserUsageCycle(env, userId, now = unix(), resetDay = 1) {
  const next = nextMonthlyReset(now + DAY, resetDay);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET used_connections=0,last_reset_at=?,next_reset_at=?,updated_at=? WHERE id=?")
      .bind(now, next, now, userId),
  ]);
}

async function refreshUserResetSchedule(env, userId) {
  await env.DB.prepare("UPDATE users SET next_reset_at=0,updated_at=? WHERE id=?").bind(unix(), userId).run();
}

async function refreshPlanUsersResetSchedule(env, planId) {
  await env.DB.prepare("UPDATE users SET plan_id=NULL,next_reset_at=0,updated_at=? WHERE plan_id=?").bind(unix(), planId).run();
}

async function nodeLimitsForUser(env, userId) {
  return all(env.DB,
    "SELECT n.id node_id,n.name node_name,n.enabled node_enabled,COALESCE(l.status,'active') status " +
    "FROM nodes n LEFT JOIN user_node_limits l ON l.node_id=n.id AND l.user_id=? ORDER BY n.sort_order,n.name,n.id",
    userId);
}

async function setUserGroups(env, userId, groups) {
  await env.DB.prepare("DELETE FROM user_groups WHERE user_id=?").bind(userId).run();
  for (const groupId of groups || []) {
    if (groupId) await env.DB.prepare("INSERT OR IGNORE INTO user_groups(user_id,group_id) VALUES(?,?)").bind(userId, groupId).run();
  }
}

async function patchRow(env, table, id, allowed, body) {
  const fields = [];
  const vals = [];
  for (const k of allowed) {
    if (k === 'id' || !(k in body)) continue;
    fields.push(`${k}=?`);
    vals.push(dbVal(k, body[k]));
  }
  if (!fields.length) return;
  fields.push('updated_at=?');
  vals.push(unix(), id);
  await env.DB.prepare(`UPDATE ${table} SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
}

async function markClosed(env, sessionId, now, reason) {
  await env.DB.prepare("UPDATE sessions SET closed_at=?,status='closed',close_reason=? WHERE id=? AND closed_at IS NULL")
    .bind(now, reason, sessionId).run();
}

function nodeFields() {
  return ['id', 'name', 'address', 'port', 'host', 'sni', 'path', 'fp', 'security', 'type', 'group_id', 'region', 'tags', 'enabled', 'sort_order', 'created_at', 'updated_at'];
}
function nodeDefaults() {
  return { port: 443, fp: 'chrome', security: 'tls', type: 'ws', enabled: 1, sort_order: 0 };
}
function planFields() {
  return ['id', 'name', 'valid_days', 'price_cents', 'currency', 'enabled', 'sort_order', 'created_at', 'updated_at'];
}
function planDefaults() {
  return { valid_days: 30, price_cents: 0, currency: 'CNY', enabled: 1, sort_order: 0 };
}
function groupFields() {
  return ['id', 'name', 'sort_order', 'created_at', 'updated_at'];
}
function groupDefaults() {
  return { sort_order: 0 };
}

function parseCustomIps(input, env) {
  const host = env.PROXY_HOST || '';
  if (!input || !host) return [];
  const out = [];
  const seen = new Set();
  for (const raw of String(input).replace(/\r/g, '').split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const hash = line.indexOf('#');
    const addrText = hash >= 0 ? line.slice(0, hash).trim() : line;
    const name = hash >= 0 ? line.slice(hash + 1).trim() : '';
    const p = parseAddressPort(addrText);
    if (!p.address) continue;
    const key = `${p.address}:${p.port || 443}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: 'custom',
      name: name || `Custom-${out.length + 1}`,
      address: p.address,
      port: p.port || 443,
      host,
      sni: host,
      path: '/node/custom',
      fp: 'chrome',
      security: 'tls',
      type: 'ws',
    });
  }
  return out.slice(0, 50);
}

function parseAddressPort(input) {
  if (!input) return {};
  if (input.startsWith('[')) {
    const m = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (m) return { address: m[1], port: Number(m[2] || 443) };
  }
  const i = input.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(input.slice(i + 1))) return { address: input.slice(0, i), port: Number(input.slice(i + 1)) };
  return { address: input, port: 443 };
}

function certNameMismatch(address, sni) {
  const a = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const b = String(sni || '').replace(/^\[|\]$/g, '').toLowerCase();
  return Boolean(a && b && a !== b);
}

function effectiveMonthlyConnectionLimit(user) {
  return Math.max(0, Number(user?.monthly_connection_limit || 0) || 0);
}
function dbVal(k, v) {
  if (k === 'expires_at') return toEpoch(v);
  if (['quota_bytes', 'expires_at', 'last_reset_at', 'next_reset_at', 'device_limit', 'monthly_connection_limit', 'used_connections', 'price_cents', 'enabled', 'sort_order', 'port', 'default_user_quota_bytes', 'valid_days', 'reset_day'].includes(k)) {
    return numOr(v, 0);
  }
  return v === undefined ? null : v;
}
function daysToExpiry(days, now) {
  const n = Number(days || 0);
  return n > 0 ? now + Math.floor(n) * DAY : 0;
}
function monthlyPlan(plan) {
  return String(plan?.reset_cycle || '').toLowerCase() === 'monthly';
}
function nextMonthlyReset(now, resetDay = 1) {
  const d = new Date((now + TZ_OFFSET) * 1000);
  const day = Math.max(1, Math.min(28, Math.floor(Number(resetDay || 1))));
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  let next = Date.UTC(y, m, day, 0, 0, 0) / 1000 - TZ_OFFSET;
  if (next <= now) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    next = Date.UTC(y, m, day, 0, 0, 0) / 1000 - TZ_OFFSET;
  }
  return Math.floor(next);
}
function numOr(v, d) {
  if (v === '' || v === undefined || v === null) return Number(d || 0);
  const n = Number(v);
  return Number.isFinite(n) ? n : Number(d || 0);
}
function toEpoch(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
function nodeIdOf(v) {
  return String(v || 'default').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'default';
}
function normalizePath(path) {
  const p = String(path || '/');
  return p.startsWith('/') ? p : '/' + p;
}
function unix() {
  return Math.floor(Date.now() / 1000);
}
function rid(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
}
function token(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => (b % 36).toString(36)).join('');
}
function yaml(v) {
  return JSON.stringify(String(v ?? ''));
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: H_JSON });
}
async function readJson(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}
async function first(db, sql, ...binds) {
  const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  return stmt.first();
}
async function all(db, sql, ...binds) {
  const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}
function isAdmin(request, env) {
  const url = new URL(request.url);
  const tokenValue = env.ADMIN_TOKEN || '';
  if (!tokenValue) return false;
  const auth = request.headers.get('authorization') || '';
  return sameSecret(auth.replace(/^Bearer\s+/i, ''), tokenValue) ||
    sameSecret(request.headers.get('x-admin-token'), tokenValue) ||
    sameSecret(url.searchParams.get('token'), tokenValue);
}
function sameSecret(a, b) {
  return Boolean(a && b && String(a) === String(b));
}

function adminPage(env = {}) {
  const defaultProxyHost = env.PROXY_HOST || 'your-snippet-domain.example.com';
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>VLESS 订阅管理</title>
<style>
body{margin:0;font:14px Arial;background:#0f1115;color:#e7e9ee}.wrap{max-width:1180px;margin:auto;padding:20px}input,select,textarea,button{background:#171b22;color:#e7e9ee;border:1px solid #303644;border-radius:6px;padding:9px;box-sizing:border-box}textarea{width:100%;min-height:120px}button{cursor:pointer;background:#23344d}button:hover{background:#2d4364}table{width:100%;border-collapse:collapse;margin:12px 0;table-layout:auto}td,th{border-bottom:1px solid #242a35;padding:8px;text-align:left;vertical-align:top}th{color:#b8c1d1;font-weight:600}section{margin:18px 0;padding:14px;background:#151922;border:1px solid #242a35;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:#171b22;border:1px solid #303644;border-radius:8px;padding:12px}.muted{color:#9aa3b2}.row{display:flex;gap:8px;flex-wrap:wrap}.ok{color:#67e08b}.bad{color:#ff8d8d}.wide{min-width:320px}.mono{font-family:Consolas,monospace;word-break:break-all}.mini{font-size:12px;color:#9aa3b2}.ops button{margin:0 5px 5px 0}.editpanel{background:#101722;border:1px solid #33415a;border-radius:8px;padding:12px;margin:4px 0 10px}.editgrid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.editgrid label{display:flex;flex-direction:column;gap:5px;color:#9aa3b2;font-size:12px}.editgrid input,.editgrid select{width:100%}.editactions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}.nowrap{white-space:nowrap}pre{white-space:pre-wrap;word-break:break-all;background:#090b0f;padding:10px;border-radius:6px}
</style><div class=wrap><h2>VLESS 订阅管理</h2><section><div class=row><input id=t class=wide placeholder="管理员 Token / ADMIN_TOKEN"><button onclick=save()>保存 Token</button><button onclick=boot()>初始化默认数据</button><button onclick=loadAll()>刷新数据</button></div><p class=muted id=msg></p></section><div class=cards id=sum></div>
<section><h3>用户管理</h3><div class=grid><input id=uid placeholder="用户 ID，留空自动生成"><input id=uemail placeholder="邮箱 / 账号"><input id=uname placeholder="用户名称"><input id=uuid placeholder="UUID，留空自动生成"><input id=usub placeholder="订阅 Token，留空自动生成"><input id=ugroups placeholder="分组 ID，多个用逗号分隔"><input id=udays placeholder="到期天数，0 永不过期"><input id=uexp placeholder="到期时间戳，0 永不过期"><input id=uhours placeholder="剩余小时，0 断网"><select id=uhen><option value=0>剩余小时不生效</option><option value=1>剩余小时生效</option></select><select id=ustatus><option value=active>正常</option><option value=disabled>禁用</option><option value=expired>过期</option></select></div><textarea id=unote placeholder="备注"></textarea><p class=row><button id=usave onclick=saveUser()>保存用户</button><button onclick=resetUserForm()>清空表单</button></p></section>
<section><h3>用户列表</h3><div id=users></div></section>
<section><h3>单用户节点权限</h3><div class=row><select id=limitUser></select><button onclick=loadNodeLimits()>加载用户节点</button><button onclick=saveNodeLimits()>保存节点权限</button></div><div id=nodeLimits></div></section>
<section><h3>自定义节点管理</h3><div class=grid><input id=nid placeholder="节点 ID，例如 us-01"><input id=nname placeholder="节点名称"><input id=nregion placeholder="地区，例如 US/HK/JP"><input id=naddr placeholder="入口地址 / 优选 IP / 域名"><input id=nport placeholder="端口，默认 443"><input id=nhost placeholder="代理 Worker 域名，默认 your-snippet-domain.example.com"><input id=ngroup placeholder="所属分组 ID，默认 default"><input id=npath placeholder="/node/us-01"><input id=nsort placeholder="排序，数字越小越靠前"><select id=nenabled><option value=1>启用</option><option value=0>禁用</option></select></div><p class=row><button id=nsave onclick=saveNode()>保存节点</button><button onclick=resetNodeForm()>清空表单</button></p><p class=mini>入口地址可以是优选 IP，也可以是域名；Host/SNI 应保持为你的代理 Worker 域名：${defaultProxyHost}。地区会写入订阅名称，便于 v2rayNG 显示。</p><textarea id=nbulk placeholder="批量导入，每行一个：&#10;104.17.147.116:443#US-优选1&#10;104.19.146.223:443#US-优选2&#10;custom-sg,104.18.1.1:443,SG-自定义,default,US"></textarea><p class=row><button onclick=importNodes()>批量导入节点</button></p><div id=nodes></div></section>
<section><h3>分组管理</h3><div class=row><input id=gid placeholder="分组 ID，留空自动生成"><input id=gname placeholder="分组名称"><input id=gsort placeholder="排序，数字越小越靠前"><button id=gsave onclick=saveGroup()>保存分组</button><button onclick=resetGroupForm()>清空表单</button></div><div id=groups></div></section>
</div>
<script>
const $=id=>document.getElementById(id),DH=${JSON.stringify(defaultProxyHost)};let userRows=[],nodeRows=[],groupRows=[],limitRows=[],editingUser='',editingNode='',inlineNode='',editingGroup='';const L={users:'用户总数',activeUsers:'正常用户',activeNodes:'启用节点',email:'账号',name:'名称',status:'状态',groups:'分组',expire:'到期时间',hours:'剩余小时',sub:'订阅链接 / 操作',id:'ID',address:'入口地址',port:'端口',host:'Host',path:'路径',group_id:'分组',region:'地区',enabled:'启用',node_ops:'节点操作',group_ops:'分组操作',sort_order:'排序',node_name:'节点'};
const api=(p,o={})=>fetch('/api/admin/'+p,{...o,headers:{'content-type':'application/json','authorization':'Bearer '+localStorage.token,...(o.headers||{})}}).then(async r=>{let j=await r.json().catch(()=>({ok:false,error:r.statusText}));if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j});
t.value=localStorage.token||'';function save(){localStorage.token=t.value.trim();msg.textContent='Token 已保存'}function dt(x){return x?new Date(x*1000).toLocaleString():'永不过期'}
async function loadAll(){try{msg.textContent='正在加载...';let s=await api('summary');sum.innerHTML=Object.entries(s.data).map(([k,v])=>'<div class=card><b>'+h(L[k]||k)+'</b><br>'+h(v)+'</div>').join('');let [us,ns,gs]=await Promise.all([api('users'),api('nodes'),api('groups')]);userRows=us.data||[];nodeRows=ns.data||[];groupRows=gs.data||[];fillLimitUsers();users.innerHTML=tbl(userRows,['email','name','status','groups','expire','hours','sub']);nodes.innerHTML=nodesTable();groups.innerHTML=tbl(groupRows,['id','name','sort_order','group_ops']);msg.textContent='数据已刷新';}catch(e){msg.textContent='错误：'+e.message}}
function tbl(rows,cols){if(!rows||!rows.length)return '<p class=muted>暂无数据</p>';return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+cell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function nodesTable(){let cols=['id','name','region','address','port','host','path','group_id','enabled','node_ops'];if(!nodeRows.length)return '<p class=muted>暂无数据</p>';return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+nodeRows.map(r=>nodeReadRow(r,cols)+(inlineNode===r.id?nodeEditPanel(r,cols.length):'')).join('')+'</table>'}
function nodeReadRow(r,cols){return '<tr>'+cols.map(c=>'<td class="'+(c==='id'||c==='region'||c==='port'||c==='enabled'?'nowrap':'')+'">'+cell(r,c)+'</td>').join('')+'</tr>'}
function nodeEditPanel(r,colspan){let k=safeDom(r.id);return '<tr><td colspan="'+colspan+'"><div class=editpanel><div class=mini>正在编辑：<span class=mono>'+h(r.id)+'</span></div><div class=editgrid>'+nodeEditField(k,'名称','name',r.name||'')+nodeEditField(k,'地区','region',r.region||'')+nodeEditField(k,'入口地址','address',r.address||'')+nodeEditField(k,'端口','port',r.port||443)+nodeEditField(k,'Host','host',r.host||DH)+nodeEditField(k,'路径','path',r.path||('/node/'+r.id))+nodeEditField(k,'分组','group_id',r.group_id||'default')+'<label>启用<select id="en_enabled_'+k+'"><option value=1 '+(r.enabled?'selected':'')+'>启用</option><option value=0 '+(!r.enabled?'selected':'')+'>禁用</option></select></label></div><div class=editactions><button onclick="cancelInlineNode()">取消</button><button onclick="saveInlineNode(\\''+h(r.id)+'\\')">保存</button></div></div></td></tr>'}
function nodeEditField(k,label,name,value){return '<label>'+label+'<input id="en_'+name+'_'+k+'" value="'+h(value)+'"></label>'}
function cell(r,c){if(c==='expire')return dt(r.expires_at);if(c==='hours')return r.hours_enabled?'<span class=mono>'+h(r.remaining_hours||0)+' 小时</span>':'不生效';if(c==='sub'){let u=subUrl(r);return '<div class=mono>'+h(u)+'</div><p class=ops><button onclick="editUser(\\''+r.id+'\\')">编辑</button><button onclick="copySub(\\''+r.sub_token+'\\')">复制订阅</button><button onclick="selectLimitUser(\\''+r.id+'\\')">节点权限</button><button onclick="deleteUser(\\''+r.id+'\\')">删除用户</button></p>'}if(c==='node_ops')return '<span class=ops><button onclick="editNode(\\''+h(r.id)+'\\')">编辑</button><button onclick="toggleNode(\\''+h(r.id)+'\\','+(r.enabled?0:1)+')">'+(r.enabled?'禁用':'启用')+'</button><button onclick="copyPath(\\''+h(r.path||('/node/'+r.id))+'\\')">复制路径</button><button onclick="deleteNode(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='group_ops')return '<span class=ops><button onclick="editGroup(\\''+h(r.id)+'\\')">编辑</button><button onclick="deleteGroup(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='enabled')return r.enabled?'<span class=ok>是</span>':'<span class=bad>否</span>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function subUrl(r){return location.origin+'/sub/'+r.sub_token}
async function copySub(tok){let u=location.origin+'/sub/'+tok;await navigator.clipboard.writeText(u);msg.textContent='订阅链接已复制：'+u}
async function deleteUser(id){if(!confirm('确定删除这个用户吗？该用户的订阅和节点权限都会删除。'))return;await api('users/'+id,{method:'DELETE'});msg.textContent='用户已删除';loadAll()}
function userBody(){let id=safeId(uid.value||uemail.value||uname.value||('user-'+Date.now()));uid.value=id;let body={id,email:uemail.value,name:uname.value,uuid:uuid.value.trim()||undefined,sub_token:usub.value.trim()||undefined,group_ids:ugroups.value.split(',').map(x=>x.trim()).filter(Boolean),remaining_hours:Number(uhours.value||0),hours_enabled:Number(uhen.value||0),status:ustatus.value,note:unote.value};if(uexp.value!=='')body.expires_at=Number(uexp.value||0);else if(udays.value!=='')body.valid_days=udays.value;return body}
async function saveUser(){let b=userBody();if(!b.id)throwMsg('用户 ID 不能为空');if(editingUser){b.id=editingUser;await api('users/'+editingUser,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='用户已保存'}else{await api('users',{method:'POST',body:JSON.stringify(b)});msg.textContent='用户已创建'}resetUserForm();loadAll()}
async function editUser(id){let res=await api('users/'+id),r=res.data;if(!r)return;uid.value=r.id;uid.readOnly=true;uemail.value=r.email||'';uname.value=r.name||'';uuid.value=r.uuid||'';usub.value=r.sub_token||'';ugroups.value=(r.group_ids||[]).join(',');udays.value='';uexp.value=r.expires_at||0;uhours.value=r.remaining_hours||0;uhen.value=r.hours_enabled?1:0;ustatus.value=r.status||'active';unote.value=r.note||'';editingUser=id;usave.textContent='保存修改';msg.textContent='正在编辑用户：'+id;uid.scrollIntoView({behavior:'smooth',block:'center'})}
function resetUserForm(){editingUser='';uid.readOnly=false;for(const x of [uid,uemail,uname,uuid,usub,ugroups,udays,uexp,uhours,unote])x.value='';uhen.value=0;ustatus.value='active';usave.textContent='保存用户'}
function fillLimitUsers(){limitUser.innerHTML=userRows.map(u=>'<option value="'+h(u.id)+'">'+h((u.email||u.name||u.id)+' ｜ '+u.id)+'</option>').join('');if(!limitRows.length)nodeLimits.innerHTML='<p class=muted>请选择用户后加载节点权限。</p>'}
async function selectLimitUser(id){limitUser.value=id;await loadNodeLimits();document.getElementById('nodeLimits').scrollIntoView({behavior:'smooth',block:'start'})}
async function loadNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先创建或选择用户';let res=await api('users/'+id+'/node-limits');limitRows=res.data||[];nodeLimits.innerHTML=limitRows.length?nodeLimitTable(limitRows):'<p class=muted>暂无节点。</p>';msg.textContent='已加载该用户的节点权限'}
async function saveNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先选择用户';let limits=limitRows.map(r=>({node_id:r.node_id,status:$('st_'+limId(r.node_id)).value||'active'}));await api('users/'+id+'/node-limits',{method:'PATCH',body:JSON.stringify({limits})});msg.textContent='用户节点权限已保存';loadNodeLimits()}
function nodeLimitCell(r,c){if(c==='status')return '<select id="st_'+limId(r.node_id)+'"><option value=active '+(r.status==='active'?'selected':'')+'>启用</option><option value=disabled '+(r.status==='disabled'?'selected':'')+'>禁用</option></select>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function nodeLimitTable(rows){let cols=['node_id','node_name','status'];return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+nodeLimitCell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function limId(v){return 'lim_'+String(v).replace(/[^a-zA-Z0-9_-]/g,'_')}
function nodeBody(){let id=safeId(nid.value||nname.value||naddr.value);nid.value=id;let host=(nhost.value||DH).trim(),region=cleanRegion(nregion.value),addr=naddr.value.trim();return{id,name:nname.value||id,region,address:addr,port:Number(nport.value||443),host,sni:host,path:npath.value||('/node/'+id),group_id:ngroup.value||'default',sort_order:Number(nsort.value||0),enabled:Number(nenabled.value)}} 
async function saveNode(){let b=nodeBody();if(!b.id||!b.address)throwMsg('节点 ID 和入口地址不能为空');if(editingNode){b.id=editingNode;await api('nodes/'+editingNode,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='节点已更新'}else{await api('nodes',{method:'POST',body:JSON.stringify(b)});msg.textContent='节点已创建'}resetNodeForm();loadAll()}
function editNode(id){inlineNode=id;nodes.innerHTML=nodesTable();msg.textContent='正在原地编辑节点：'+id}
function cancelInlineNode(){inlineNode='';nodes.innerHTML=nodesTable();msg.textContent='已取消节点编辑'}
async function saveInlineNode(id){let k=safeDom(id),r=nodeRows.find(x=>x.id===id);if(!r)return;let region=cleanRegion($('en_region_'+k).value),addr=$('en_address_'+k).value.trim();let body={name:$('en_name_'+k).value||id,region,address:addr,port:Number($('en_port_'+k).value||443),host:($('en_host_'+k).value||DH).trim(),path:$('en_path_'+k).value||('/node/'+id),group_id:$('en_group_id_'+k).value||'default',enabled:Number($('en_enabled_'+k).value),sort_order:Number(r.sort_order||0)};body.sni=body.host;if(!body.address)throwMsg('入口地址不能为空');await api('nodes/'+id,{method:'PATCH',body:JSON.stringify(body)});inlineNode='';msg.textContent='节点已保存';loadAll()}
function resetNodeForm(){editingNode='';for(const x of [nid,nname,nregion,naddr,nport,nhost,ngroup,npath,nsort])x.value='';nenabled.value=1;nsave.textContent='保存节点'}
async function toggleNode(id,en){await api('nodes/'+id,{method:'PATCH',body:JSON.stringify({enabled:en})});msg.textContent=en?'节点已启用':'节点已禁用';loadAll()}
async function deleteNode(id){if(!confirm('确定删除节点 '+id+' 吗？该节点会从订阅中移除，并清理所有用户在该节点的独立权限。'))return;await api('nodes/'+id,{method:'DELETE'});if(editingNode===id)resetNodeForm();msg.textContent='节点已删除';loadAll()}
async function copyPath(p){await navigator.clipboard.writeText(p);msg.textContent='节点路径已复制：'+p}
async function importNodes(){let lines=nbulk.value.replace(/\\r/g,'').split('\\n').map(x=>x.trim()).filter(Boolean);let ok=0;for(const line of lines){let n=parseNodeLine(line,ok+1);if(!n)continue;try{let exists=nodeRows.some(x=>x.id===n.id);await api(exists?('nodes/'+n.id):'nodes',{method:exists?'PATCH':'POST',body:JSON.stringify(n)});ok++}catch(e){msg.textContent='导入失败：'+line+' '+e.message;return}}msg.textContent='已导入 '+ok+' 个节点';nbulk.value='';loadAll()}
function parseNodeLine(line,i){let a=line.split(',').map(x=>x.trim());let id='',addr='',name='',group='default',region='';if(a.length>=3){id=safeId(a[0]);addr=a[1];name=a[2];group=a[3]||'default';region=cleanRegion(a[4]||inferRegion(name||id))}else{let h=line.indexOf('#');addr=(h>=0?line.slice(0,h):line).trim();name=(h>=0?line.slice(h+1):'自定义节点-'+i).trim();id=safeId(name||addr);region=inferRegion(name)}let p=parseAddr(addr),host=DH;return p.address?{id,name:name||id,region,address:p.address,port:p.port||443,host,sni:host,path:'/node/'+id,group_id:group||'default',sort_order:50+i,enabled:1}:null}
function parseAddr(v){if(!v)return{};if(v[0]=='['){let m=v.match(/^\\[([^\\]]+)\\](?::(\\d+))?$/);if(m)return{address:m[1],port:Number(m[2]||443)}}let i=v.lastIndexOf(':');return i>0&&/^\\d+$/.test(v.slice(i+1))?{address:v.slice(0,i),port:Number(v.slice(i+1))}:{address:v,port:443}}
function safeId(v){return String(v||'node').toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||('node-'+Date.now())}
function safeDom(v){return String(v||'').replace(/[^a-zA-Z0-9_-]/g,'_')}
function cleanRegion(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,16)}
function inferRegion(v){let m=String(v||'').toUpperCase().match(/\\b(US|HK|JP|SG|KR|DE|NL|GB|FI|SE)\\b/);return m?m[1]:''}
function throwMsg(t){msg.textContent=t;throw new Error(t)}
function groupBody(){let id=safeId(gid.value||gname.value||('group-'+Date.now()));gid.value=id;return{id,name:gname.value||id,sort_order:Number(gsort.value||0)}}
async function saveGroup(){let b=groupBody();if(!b.id||!b.name)throwMsg('分组 ID 和名称不能为空');if(editingGroup){b.id=editingGroup;await api('groups/'+editingGroup,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='分组已保存'}else{await api('groups',{method:'POST',body:JSON.stringify(b)});msg.textContent='分组已创建'}resetGroupForm();loadAll()}
function editGroup(id){let r=groupRows.find(x=>x.id===id);if(!r)return;gid.value=r.id;gid.readOnly=true;gname.value=r.name||'';gsort.value=r.sort_order||0;editingGroup=id;gsave.textContent='保存修改';msg.textContent='正在编辑分组：'+id;gid.scrollIntoView({behavior:'smooth',block:'center'})}
function resetGroupForm(){editingGroup='';gid.readOnly=false;for(const x of [gid,gname,gsort])x.value='';gsave.textContent='保存分组'}
async function deleteGroup(id){if(!confirm('确定删除分组 '+id+' 吗？用户分组绑定会删除，节点会移到默认分组。'))return;await api('groups/'+id,{method:'DELETE'});if(editingGroup===id)resetGroupForm();msg.textContent='分组已删除';loadAll()}
async function boot(){let proxy=prompt('请输入代理 Worker 域名，例如 proxy.example.com');if(!proxy)return;await api('bootstrap',{method:'POST',body:JSON.stringify({proxy_host:proxy,create_demo_user:true})});msg.textContent='默认数据已初始化';loadAll()}
function h(v){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
loadAll();
</script>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
