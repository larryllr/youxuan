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
      if (url.pathname.startsWith('/light-sub/')) return handleLightSubscription(request, env);
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

  const regionOverride = normalizeRegion(url.searchParams.get('region') || url.searchParams.get('r'));
  const links = allNodes.map(n => buildVlessLink(user, n, env, request, regionOverride));
  const format = (url.searchParams.get('format') || 'base64').toLowerCase();
  const headers = {
    ...H_TEXT,
    'subscription-userinfo': `upload=0; download=0; total=0; expire=${user.expires_at || 0}`,
    'profile-update-interval': '12',
  };
  if (format === 'raw') return new Response(links.join('\n'), { headers });
  if (format === 'clash') return new Response(toClashYaml(user, allNodes, env, request, regionOverride), {
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
  if (resource === 'users') return usersApi(request, env, id, parts[2] || '', parts[3] || '');
  if (resource === 'nodes') return tableApi(request, env, 'nodes', id, nodeFields(), nodeDefaults);
  if (resource === 'node-order' && request.method === 'PATCH') return nodeOrderApi(request, env);
  if (resource === 'light-settings') return lightSettingsApi(request, env, id);
  if (resource === 'restart-project' && request.method === 'POST') return restartProjectApi(request, env);
  if (resource === 'plans') {
    await ensurePlanColumns(env);
    return tableApi(request, env, 'plans', id, planFields(), planDefaults);
  }
  if (resource === 'groups') return tableApi(request, env, '"groups"', id, groupFields(), groupDefaults);
  return json({ ok: false, error: 'not_found' }, 404);
}

async function restartProjectApi(request, env) {
  const b = await readJson(request);
  const project = projectFromHostOrName(b.project || b.host || env.PROXY_HOST || '');
  if (!project) return json({ ok: false, error: 'missing_project' }, 400);
  if (b.dry_run) return json({ ok: true, data: { project, configured: Boolean(env.SNIPPET_ZONE_ID && env.CF_SNIPPET_TOKEN) } });
  const result = await restartSnippetProject(env, project);
  return json({ ok: true, data: result });
}

async function lightSettingsApi(request, env, id) {
  const key = lightSettingsKey(id);
  if (!key) return json({ ok: false, error: 'missing_project' }, 400);
  await ensureSettingsTable(env);
  if (request.method === 'GET') {
    const row = await first(env.DB, "SELECT value FROM app_settings WHERE key=?", key);
    return json({ ok: true, data: row?.value ? JSON.parse(row.value) : { ips: '', region: '' } });
  }
  if (request.method === 'PATCH' || request.method === 'POST') {
    const b = await readJson(request);
    const data = { ips: String(b.ips || ''), region: normalizeRegion(b.region || '') };
    const now = unix();
    await env.DB.prepare(
      "INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
    ).bind(key, JSON.stringify(data), now).run();
    return json({ ok: true, data });
  }
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

async function handleLightSubscription(request, env) {
  const url = new URL(request.url);
  const project = projectFromHostOrName(decodeURIComponent(url.pathname.replace(/^\/light-sub\//, '').split('/')[0] || ''));
  const host = project ? `${project}.freelx.net` : (env.PROXY_HOST || new URL(request.url).hostname);
  const regionOverride = normalizeRegion(url.searchParams.get('region') || url.searchParams.get('r'));
  await ensureUserNodeColumn(env);
  const saved = await all(env.DB, "SELECT * FROM nodes WHERE enabled=1 AND COALESCE(owner_user_id,'')='' ORDER BY sort_order,name,id");
  const custom = parseCustomIpsForHost(url.searchParams.get('ips') || '', host);
  const nodes = [...saved, ...custom];
  const links = nodes.map(n => buildLightVlessLink(n, host, env.PROXY_UUID || 'f6eddc57-0f54-4705-bf75-cfd646d98c06', regionOverride));
  return new Response(btoa(links.join('\n')), { headers: H_TEXT });
}

async function usersApi(request, env, id, action, subId = '') {
  if (id && action === 'node-limits') return userNodeLimitsApi(request, env, id);
  if (id && action === 'nodes') return userNodesApi(request, env, id, subId);

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
      plan_id: b.plan_id || null,
      quota_bytes: 0,
      expires_at: validDays !== null ? daysToExpiry(validDays, now) : (toEpoch(b.expires_at) || 0),
      remaining_hours: numOr(b.remaining_hours, 0),
      hours_enabled: numOr(b.hours_enabled, 0),
      next_reset_at: 0,
      device_limit: numOr(b.device_limit, 0),
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
    const allowed = ['email', 'name', 'uuid', 'sub_token', 'plan_id', 'expires_at', 'remaining_hours', 'hours_enabled', 'next_reset_at', 'device_limit', 'status', 'note'];
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
  if (request.method !== 'GET' && arguments.length > 3) return userNodesApi(request, env, userId, arguments[3] || '');
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

async function nodeOrderApi(request, env) {
  const b = await readJson(request);
  const ids = Array.isArray(b.ids) ? b.ids.map(x => String(x || '').trim()).filter(x => /^[A-Za-z0-9_.-]{1,80}$/.test(x)) : [];
  if (!ids.length) return json({ ok: false, error: 'missing_ids' }, 400);
  const now = unix();
  await env.DB.batch(ids.map((id, i) => env.DB.prepare("UPDATE nodes SET sort_order=?,updated_at=? WHERE id=?").bind((i + 1) * 10, now, id)));
  return json({ ok: true, data: { count: ids.length } });
}

async function userNodesApi(request, env, userId, nodeId = '') {
  if (!userId) return json({ ok: false, error: 'missing_user' }, 400);
  await ensureUserNodeColumn(env);
  if (request.method === 'GET') {
    return json({ ok: true, data: await all(env.DB, "SELECT * FROM nodes WHERE owner_user_id=? ORDER BY sort_order,name,id", userId) });
  }
  if (request.method === 'POST' && !nodeId) {
    const b = await readJson(request);
    const user = await first(env.DB, "SELECT * FROM users WHERE id=?", userId);
    if (user?.plan_id) {
      const plan = await first(env.DB, "SELECT * FROM plans WHERE id=?", user.plan_id);
      if (plan && Number(plan.allow_dedicated || 0) === 0) return json({ ok: false, error: 'plan_no_dedicated_nodes' }, 403);
    }
    const now = unix();
    const id = safeNodeId(b.id || b.name || b.address || rid('node'));
    const host = String(b.host || env.PROXY_HOST || '').trim();
    await env.DB.prepare(
      "INSERT INTO nodes(id,name,address,port,host,sni,path,fp,security,type,group_id,region,tags,enabled,sort_order,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, b.name || id, b.address || '', numOr(b.port, 443), host, b.sni || host, b.path || `/node/${id}`, b.fp || 'chrome', b.security || 'tls', b.type || 'ws', b.group_id || 'default', normalizeRegion(b.region), b.tags || '', numOr(b.enabled, 1), numOr(b.sort_order, 0), userId, now, now).run();
    await ensureNodeLimit(env, userId, id);
    return json({ ok: true, data: await first(env.DB, "SELECT * FROM nodes WHERE id=?", id) }, 201);
  }
  if (!nodeId) return json({ ok: false, error: 'missing_node' }, 400);
  const existing = await first(env.DB, "SELECT * FROM nodes WHERE id=? AND owner_user_id=?", nodeId, userId);
  if (!existing) return json({ ok: false, error: 'node_not_found' }, 404);
  if (request.method === 'PATCH') {
    const b = await readJson(request);
    const allowed = ['name', 'address', 'port', 'host', 'sni', 'path', 'fp', 'security', 'type', 'group_id', 'region', 'tags', 'enabled', 'sort_order'];
    if (b.host && !b.sni) b.sni = b.host;
    await patchRow(env, 'nodes', nodeId, allowed, b);
    return json({ ok: true, data: await first(env.DB, "SELECT * FROM nodes WHERE id=?", nodeId) });
  }
  if (request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_node_limits WHERE node_id=?").bind(nodeId),
      env.DB.prepare("DELETE FROM nodes WHERE id=? AND owner_user_id=?").bind(nodeId, userId),
    ]);
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
  await ensureUserNodeColumn(env);
  await ensurePlanColumns(env);
  let rows = await all(env.DB,
    "SELECT n.*,g.name group_name FROM nodes n LEFT JOIN \"groups\" g ON g.id=n.group_id " +
    "WHERE n.enabled=1 AND (COALESCE(n.owner_user_id,'')='' OR n.owner_user_id=?) " +
    "AND (n.owner_user_id=? OR NOT EXISTS(SELECT 1 FROM user_groups WHERE user_id=?) OR n.group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)) " +
    "AND NOT EXISTS(SELECT 1 FROM user_node_limits l WHERE l.user_id=? AND l.node_id=n.id AND l.status!='active') " +
    "ORDER BY n.sort_order,n.name",
    user.id, user.id, user.id, user.id, user.id);
  if (user?.plan_id) {
    const plan = await first(env.DB, "SELECT * FROM plans WHERE id=? AND enabled=1", user.plan_id);
    if (plan) {
      const regions = csvSet(plan.allowed_regions);
      const groups = csvSet(plan.group_ids);
      if (regions.size) rows = rows.filter(n => !normalizeRegion(n.region) || regions.has(normalizeRegion(n.region)) || n.owner_user_id === user.id);
      if (groups.size) rows = rows.filter(n => !n.group_id || groups.has(String(n.group_id)) || n.owner_user_id === user.id);
      const max = Number(plan.max_nodes || 0);
      if (max > 0) {
        const owned = rows.filter(n => n.owner_user_id === user.id);
        const shared = rows.filter(n => n.owner_user_id !== user.id).slice(0, max);
        rows = [...shared, ...owned];
      }
    }
  }
  return rows;
}

async function handleEdge(request, env) {
  if (!sameSecret(request.headers.get('x-edge-secret'), env.EDGE_SECRET)) {
    return json({ ok: false, error: 'bad_edge_secret' }, 401);
  }
  const url = new URL(request.url);
  if (!url.pathname.endsWith('/allow') && !url.pathname.endsWith('/open')) return json({ ok: true, disabled: true });
  const body = await readJson(request);
  const token = String(body.token || body.sub_token || body.subToken || '').trim();
  const uuid = String(body.uuid || '').trim().toLowerCase();
  const nodeId = nodeIdOf(body.nodeId || body.node || 'default');
  const now = unix();
  await closeStaleSessions(env, now);
  const user = await maybeResetUser(env, token
    ? await first(env.DB, "SELECT * FROM users WHERE sub_token=?", token)
    : await userByUuid(env, uuid), now);
  const node = await getNodeForAccess(env, nodeId);
  const access = await checkAccess(env, user, node, now);
  if (!access.ok) return json(access, 403);
  await ensureNodeLimit(env, user.id, node.id);
  const nodeLimit = await nodeLimitOf(env, user.id, node.id);
  if (nodeLimit?.status && nodeLimit.status !== 'active') return json({ ok: false, error: 'node_user_disabled' }, 403);
  const device = await enforceDeviceLimit(env, user, node.id, body, now);
  if (!device.ok) return json(device, 403);
  if (Number(user.hours_enabled || 0) > 0) {
    const left = Number(user.remaining_hours || 0);
    if (left <= 0) return json({ ok: false, error: 'hours_expired' }, 403);
    await env.DB.prepare("UPDATE users SET remaining_hours=remaining_hours-1,updated_at=? WHERE id=? AND remaining_hours>0")
      .bind(now, user.id).run();
  }
  return json({ ok: true });
}

async function enforceDeviceLimit(env, user, nodeId, body, now) {
  const limit = Number(user.device_limit || 0);
  const ip = String(body.ip || '').slice(0, 96);
  const ua = String(body.ua || '').slice(0, 256);
  const sessionId = String(body.sessionId || rid('sess')).slice(0, 80);
  if (!ip && !ua) return { ok: true };
  const existing = await first(env.DB,
    "SELECT id FROM sessions WHERE user_id=? AND closed_at IS NULL AND last_seen_at>? AND COALESCE(ip,'')=? AND COALESCE(ua,'')=? LIMIT 1",
    user.id, now - SESSION_ACTIVE_WINDOW, ip, ua);
  if (existing) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").bind(now, existing.id).run();
    return { ok: true };
  }
  if (limit > 0) {
    const used = await activeDeviceCount(env, user.id, now);
    if (Number(used?.c || 0) >= limit) return { ok: false, error: 'device_limit' };
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions(id,user_id,node_id,ip,ua,colo,country,opened_at,last_seen_at,status) VALUES(?,?,?,?,?,?,?,?,?,'open')"
  ).bind(sessionId, user.id, nodeId, ip, ua, String(body.colo || '').slice(0, 32), String(body.country || '').slice(0, 32), now, now).run();
  return { ok: true };
}

function buildVlessLink(user, node, env, request, regionOverride = '') {
  const host = node.host || env.PROXY_HOST || new URL(request.url).hostname;
  const sni = node.sni || host;
  const rawPath = normalizePath(node.path || `/node/${node.id || 'default'}`);
  const region = normalizeRegion(regionOverride) || normalizeRegion(node.region);
  const path = rawPath;
  const uuid = env.PROXY_UUID || user.uuid;
  const params = new URLSearchParams({
    encryption: 'none',
    security: node.security || 'tls',
    sni,
    fp: node.fp || 'chrome',
    type: node.type || 'ws',
    host,
    path,
  });
  const target = node.address || host;
  const address = String(target).includes(':') && !String(target).startsWith('[') ? `[${target}]` : target;
  return `vless://${uuid}@${address}:${node.port || 443}?${params.toString()}#${encodeURIComponent(nodeRemark(node, region))}`;
}

function buildLightVlessLink(node, host, uuid, regionOverride = '') {
  const region = normalizeRegion(regionOverride) || normalizeRegion(node.region) || 'US';
  const entry = node.address || node.domain || host;
  const address = String(entry).includes(':') && !String(entry).startsWith('[') ? `[${entry}]` : entry;
  const params = new URLSearchParams({
    encryption: 'none',
    security: node.security || 'tls',
    sni: host,
    fp: node.fp || 'chrome',
    type: node.type || 'ws',
    host,
    path: `/r/${region}/`,
  });
  return `vless://${uuid}@${address}:${node.port || 443}?${params.toString()}#${encodeURIComponent(nodeRemark(node, region))}`;
}

function toClashYaml(user, nodes, env, request, regionOverride = '') {
  const proxyLines = nodes.map(n => {
    const host = n.host || env.PROXY_HOST || new URL(request.url).hostname;
    const sni = n.sni || host;
    const rawPath = normalizePath(n.path || `/node/${n.id || 'default'}`);
    const region = normalizeRegion(regionOverride) || normalizeRegion(n.region);
    const path = rawPath;
    const name = yaml(nodeRemark(n, region));
    const mismatch = certNameMismatch(n.address || host, sni);
    const strictCert = String(env.SUB_STRICT_CERT ?? '0') !== '0';
    const server = strictCert && mismatch ? host : (n.address || host);
    return [
      `  - name: ${name}`,
      `    type: vless`,
      `    server: ${yaml(server)}`,
      `    port: ${Number(strictCert && mismatch ? 443 : (n.port || 443))}`,
      `    uuid: ${env.PROXY_UUID || user.uuid}`,
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
  const names = nodes.map(n => yaml(nodeRemark(n, normalizeRegion(regionOverride) || normalizeRegion(n.region)))).join(', ');
  return `mixed-port: 7890\nallow-lan: false\nmode: rule\nproxies:\n${proxyLines.join('\n')}\nproxy-groups:\n  - name: AUTO\n    type: select\n    proxies: [${names}]\nrules:\n  - MATCH,AUTO\n`;
}

function nodeRemark(node, regionValue = '') {
  const base = String(node?.name || node?.id || 'node').trim();
  const region = normalizeRegion(regionValue) || normalizeRegion(node?.region);
  if (!region) return base;
  const upper = base.toUpperCase();
  if (upper === region || upper.startsWith(region + ' ') || upper.startsWith(region + '-') || upper.startsWith(`[${region}]`)) return base;
  return `${region}-${base}`;
}

function normalizeRegion(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
}
function inferNodeRegion(value) {
  const m = String(value || '').toUpperCase().match(/\b(US|HK|JP|SG|KR|DE|NL|GB|FI|SE)\b/);
  return m ? m[1] : '';
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
  await ensureUserNodeColumn(env);
  return all(env.DB,
    "SELECT n.id node_id,n.name node_name,n.enabled node_enabled,COALESCE(l.status,'active') status " +
    "FROM nodes n LEFT JOIN user_node_limits l ON l.node_id=n.id AND l.user_id=? " +
    "WHERE COALESCE(n.owner_user_id,'')='' OR n.owner_user_id=? ORDER BY n.sort_order,n.name,n.id",
    userId, userId);
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
  return ['id', 'name', 'address', 'port', 'host', 'sni', 'path', 'fp', 'security', 'type', 'group_id', 'region', 'tags', 'enabled', 'sort_order', 'owner_user_id', 'created_at', 'updated_at'];
}
function nodeDefaults() {
  return { port: 443, fp: 'chrome', security: 'tls', type: 'ws', enabled: 1, sort_order: 0 };
}
function planFields() {
  return ['id', 'name', 'valid_days', 'price_cents', 'currency', 'allowed_regions', 'group_ids', 'max_nodes', 'allow_dedicated', 'device_limit', 'enabled', 'sort_order', 'note', 'created_at', 'updated_at'];
}
function planDefaults() {
  return { valid_days: 30, price_cents: 0, currency: 'CNY', max_nodes: 0, allow_dedicated: 1, device_limit: 0, enabled: 1, sort_order: 0 };
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
function parseCustomIpsForHost(input, host) {
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
      path: '/',
      fp: 'chrome',
      security: 'tls',
      type: 'ws',
      region: inferNodeRegion(name) || 'US',
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
  if (['quota_bytes', 'expires_at', 'last_reset_at', 'next_reset_at', 'device_limit', 'monthly_connection_limit', 'used_connections', 'price_cents', 'enabled', 'sort_order', 'port', 'default_user_quota_bytes', 'valid_days', 'reset_day', 'max_nodes', 'allow_dedicated'].includes(k)) {
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
async function ensureSettingsTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)").run();
}
async function ensureUserNodeColumn(env) {
  try { await env.DB.prepare("ALTER TABLE nodes ADD COLUMN owner_user_id TEXT").run(); } catch {}
}
async function ensurePlanColumns(env) {
  for (const sql of [
    "ALTER TABLE plans ADD COLUMN allowed_regions TEXT",
    "ALTER TABLE plans ADD COLUMN group_ids TEXT",
    "ALTER TABLE plans ADD COLUMN max_nodes INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE plans ADD COLUMN allow_dedicated INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE plans ADD COLUMN note TEXT"
  ]) { try { await env.DB.prepare(sql).run(); } catch {} }
}
function safeNodeId(v) {
  return String(v || 'node').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || rid('node');
}
function lightSettingsKey(id) {
  const clean = String(id || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 80);
  return clean ? `light_${clean}` : '';
}
function projectFromHostOrName(value) {
  const v = String(value || '').trim().toLowerCase();
  const m = v.match(/^(111|222|333|444)(?:\.|$)/) || v.match(/\b(111|222|333|444)\b/);
  return m ? m[1] : '';
}
async function restartSnippetProject(env, project) {
  const zone = String(env.SNIPPET_ZONE_ID || env.CF_ZONE_ID || '').trim();
  const token = String(env.CF_SNIPPET_TOKEN || env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!zone || !token) return { restarted: false, project, error: 'cloudflare_token_not_configured' };
  const base = `https://api.cloudflare.com/client/v4/zones/${zone}/snippets`;
  const auth = { Authorization: `Bearer ${token}` };
  const contentRes = await cfApi(`${base}/${project}/content`, { headers: auth });
  const snippetCode = extractSnippetCode(await contentRes.text());
  if (!snippetCode || !snippetCode.includes('export default')) throw new Error('snippet_content_unreadable');
  const rulesRes = await cfApi(`${base}/snippet_rules`, { headers: auth });
  const rulesJson = await rulesRes.json();
  const originalRules = Array.isArray(rulesJson.result) ? rulesJson.result.map(cleanSnippetRule) : [];
  if (!originalRules.length) throw new Error('snippet_rules_unreadable');
  await putSnippetRules(base, auth, []);
  let created = false;
  try {
    await cfApi(`${base}/${project}`, { method: 'DELETE', headers: auth });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ main_module: 'snippet.js' })], { type: 'application/json' }));
    form.append('files', new Blob([snippetCode], { type: 'application/javascript+module' }), 'snippet.js');
    await cfApi(`${base}/${project}`, { method: 'PUT', headers: auth, body: form });
    created = true;
  } finally {
    await putSnippetRules(base, auth, originalRules).catch(() => {});
  }
  return { restarted: created, project, at: unix() };
}
async function putSnippetRules(base, auth, rules) {
  await cfApi(`${base}/snippet_rules`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}
async function cfApi(url, init) {
  const res = await fetch(url, init);
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  throw new Error(`cloudflare_api_${res.status}: ${text.slice(0, 180)}`);
}
function cleanSnippetRule(rule) {
  return {
    description: rule.description || `${rule.snippet_name} snippets`,
    enabled: rule.enabled !== false,
    expression: rule.expression,
    snippet_name: rule.snippet_name,
  };
}
function extractSnippetCode(body) {
  const text = String(body || '');
  const m = text.match(/\r?\n\r?\n(import[\s\S]*?)\r?\n--[A-Za-z0-9_-]+/);
  return (m ? m[1] : text).trim();
}
function csvSet(v) {
  return new Set(String(v || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
}
function isAdmin(request, env) {
  const url = new URL(request.url);
  const tokenValue = env.ADMIN_TOKEN || '';
  const passwordValue = env.ADMIN_PASSWORD || '';
  const auth = request.headers.get('authorization') || '';
  return sameSecret(request.headers.get('x-admin-password'), passwordValue) ||
    sameSecret(url.searchParams.get('password'), passwordValue) ||
    sameSecret(auth.replace(/^Bearer\s+/i, ''), tokenValue) ||
    sameSecret(request.headers.get('x-admin-token'), tokenValue) ||
    sameSecret(url.searchParams.get('token'), tokenValue);
}
function sameSecret(a, b) {
  return Boolean(a && b && String(a) === String(b));
}

function adminPage(env = {}) {
  const defaultProxyHost = env.PROXY_HOST || 'your-snippet-domain.example.com';
  const projectName = env.PROJECT_NAME || defaultProxyHost;
  const projects = parseProjects(env.PROJECTS_JSON, projectName);
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>VLESS 订阅管理</title>
<style>
body{margin:0;font:14px Arial;background:#0f1115;color:#e7e9ee}.wrap{max-width:1180px;margin:auto;padding:20px}input,select,textarea,button{background:#171b22;color:#e7e9ee;border:1px solid #303644;border-radius:6px;padding:9px;box-sizing:border-box}textarea{width:100%;min-height:120px}button{cursor:pointer;background:#23344d}button:hover{background:#2d4364}table{width:100%;border-collapse:collapse;margin:12px 0;table-layout:auto}td,th{border-bottom:1px solid #242a35;padding:8px;text-align:left;vertical-align:top}th{color:#b8c1d1;font-weight:600}section{margin:18px 0;padding:14px;background:#151922;border:1px solid #242a35;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.field{display:flex;flex-direction:column;gap:5px;color:#9aa3b2;font-size:12px}.field input,.field select,.field textarea{width:100%}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:#171b22;border:1px solid #303644;border-radius:8px;padding:12px}.project{border-color:#3b5278;background:#121b29}.project b{color:#d5e5ff}.login{position:fixed;inset:0;display:grid;place-items:center;background:#0f1115;z-index:9}.loginbox{width:min(360px,calc(100vw - 36px));background:#151922;border:1px solid #303644;border-radius:8px;padding:18px}.loginbox input{width:100%;margin:10px 0}.hidden{display:none}.muted{color:#9aa3b2}.row{display:flex;gap:8px;flex-wrap:wrap}.ok{color:#67e08b}.bad{color:#ff8d8d}.wide{min-width:320px}.mono{font-family:Consolas,monospace;word-break:break-all}.mini{font-size:12px;color:#9aa3b2}.ops button{margin:0 5px 5px 0}.editpanel{background:#101722;border:1px solid #33415a;border-radius:8px;padding:12px;margin:4px 0 10px}.editgrid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}.editgrid label{display:flex;flex-direction:column;gap:5px;color:#9aa3b2;font-size:12px}.editgrid input,.editgrid select{width:100%}.editactions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}.nowrap{white-space:nowrap}.dragcell{width:34px;text-align:center;color:#9aa3b2}.draghandle{cursor:grab;display:inline-block;padding:4px 7px;border:1px solid #303644;border-radius:6px;background:#111722}.dragging{opacity:.45;background:#20304a}tr[draggable=true]{cursor:grab}pre{white-space:pre-wrap;word-break:break-all;background:#090b0f;padding:10px;border-radius:6px}
</style><div id=login class=login><div class=loginbox><h2>进入管理页面</h2><input id=pw type=password placeholder="输入管理密码"><div class=row><button onclick=loginNow()>进入</button></div><p class=muted id=loginMsg></p></div></div><div class=wrap id=app><h2>VLESS 订阅管理</h2><section class=project><div class=row><select id=projectSelect onchange=openProject()></select><button onclick=openProject()>切换项目</button><button onclick=restartProject()>一键重启当前项目</button><button onclick=logout()>退出登录</button></div><div class=cards><div class=card><b>当前项目</b><br><span class=mono id=projectName>${projectName}</span></div><div class=card><b>默认代理 Host</b><br><span class=mono id=proxyHost>${defaultProxyHost}</span></div><div class=card><b>管理域名</b><br><span class=mono id=managerHost></span></div></div><p class=mini>重启会原样重部署当前项目 Snippet，使旧连接断开后由客户端自动重连；正常使用时不会增加任何检测请求。</p></section><section id=toolbar><div class=row><button onclick=loadAll()>刷新数据</button></div><p class=muted id=msg></p></section><section id=lightPanel class=hidden><h3>222/333 简洁订阅</h3><textarea id=lightIps placeholder="可以粘贴完整订阅链接，或每行一个自定义节点：&#10;https://222.freelx.net/llr/sub?ips=104.17.147.116%2Cwww.visa.cn%23visa中国优选&#10;&#10;104.17.147.116:443#优选1&#10;104.19.146.223:443#优选2"></textarea><p class=row><button onclick=extractLightIps()>从链接提取 ips</button><button onclick=saveLightIps()>保存自定义节点</button><button onclick=copyLightSub()>复制 /llr/sub</button><button onclick=openLightSub()>打开 /llr/sub</button><button onclick=clearLightIps()>清空</button></p><pre id=lightOut></pre><div id=lightNodeSort></div></section><div class=cards fullOnly id=sum></div>
<section class=fullOnly><h3>用户管理</h3><div class=grid><label class=field>用户 ID<input id=uid></label><label class=field>邮箱 / 账号<input id=uemail></label><label class=field>用户名称<input id=uname></label><label class=field>套餐<select id=uplan onchange=applyPlanToUser()></select></label><label class=field>最多设备数<input id=udevices type=number min=0></label><label class=field>UUID<input id=uuid></label><label class=field>订阅 Token<input id=usub></label><label class=field>分组 ID<input id=ugroups></label><label class=field>到期天数<input id=udays type=number min=0 oninput=daysToDateInput()></label><label class=field>到期日期<input id=uexpDate type=date onchange=dateToDaysInput()></label><label class=field>到期时间戳<input id=uexp></label><label class=field>剩余小时<input id=uhours type=number min=0></label><label class=field>剩余小时规则<select id=uhen><option value=0>不生效</option><option value=1>生效</option></select></label><label class=field>状态<select id=ustatus><option value=active>正常</option><option value=disabled>禁用</option><option value=expired>过期</option></select></label></div><label class=field>备注<textarea id=unote></textarea></label><p class=row><button id=usave onclick=saveUser()>保存用户</button><button onclick=resetUserForm()>清空表单</button></p></section>
<section class=fullOnly><h3>用户列表</h3><div id=users></div></section>
<section class=fullOnly><h3>套餐管理</h3><div class=grid><label class=field>套餐 ID<input id=pid></label><label class=field>套餐名称<input id=pname></label><label class=field>有效天数<input id=pdays type=number min=0></label><label class=field>价格（分）<input id=pprice type=number min=0></label><label class=field>货币<input id=pcurrency></label><label class=field>可用地区<input id=pregions></label><label class=field>可用分组<input id=pgroups></label><label class=field>最大公共节点数<input id=pmaxnodes type=number min=0></label><label class=field>允许专属节点<select id=pdedicated><option value=1>允许</option><option value=0>不允许</option></select></label><label class=field>单订阅可用数量<input id=pdevices type=number min=0></label><label class=field>启用<select id=penabled><option value=1>启用</option><option value=0>禁用</option></select></label><label class=field>排序<input id=psort type=number></label></div><label class=field>备注<textarea id=pnote></textarea></label><p class=row><button id=psave onclick=savePlan()>保存套餐</button><button onclick=resetPlanForm()>清空套餐</button><button onclick=createDefaultPlans()>生成推荐套餐</button></p><div id=plans></div></section>
<section class=fullOnly><h3>单用户节点权限</h3><div class=row><select id=limitUser></select><button onclick=loadNodeLimits()>加载用户节点</button><button onclick=saveNodeLimits()>保存节点权限</button></div><div id=nodeLimits></div><h3>用户专属节点</h3><div class=grid><label class=field>节点 ID<input id=unid></label><label class=field>节点名称<input id=unname></label><label class=field>地区<select id=unregion></select></label><label class=field>入口地址<input id=unaddr></label><label class=field>端口<input id=unport type=number min=1></label><label class=field>Host<input id=unhost></label><label class=field>路径<input id=unpath></label><label class=field>排序<input id=unsort type=number></label><label class=field>启用<select id=unenabled><option value=1>启用</option><option value=0>禁用</option></select></label></div><p class=row><button id=unsave onclick=saveUserNode()>保存专属节点</button><button onclick=resetUserNodeForm()>清空专属节点</button></p><div id=userNodes></div></section>
<section class=fullOnly><h3>自定义节点管理</h3><div class=grid><label class=field>节点 ID<input id=nid></label><label class=field>节点名称<input id=nname></label><label class=field>地区<select id=nregion></select></label><label class=field>入口地址<input id=naddr></label><label class=field>端口<input id=nport type=number min=1></label><label class=field>Host<input id=nhost></label><label class=field>所属分组 ID<input id=ngroup></label><label class=field>路径<input id=npath></label><label class=field>排序<input id=nsort type=number></label><label class=field>启用<select id=nenabled><option value=1>启用</option><option value=0>禁用</option></select></label></div><p class=row><button id=nsave onclick=saveNode()>保存节点</button><button onclick=resetNodeForm()>清空表单</button></p><p class=mini>入口地址可以是优选 IP，也可以是域名；Host/SNI 应保持为你的代理 Worker 域名：${defaultProxyHost}。地区会写入订阅名称，便于 v2rayNG 显示。</p><label class=field>批量导入<textarea id=nbulk></textarea></label><p class=row><button onclick=importNodes()>批量导入节点</button></p><div id=nodes></div></section>
<section class=fullOnly><h3>分组管理</h3><div class=row><input id=gid placeholder="分组 ID，留空自动生成"><input id=gname placeholder="分组名称"><input id=gsort placeholder="排序，数字越小越靠前"><button id=gsave onclick=saveGroup()>保存分组</button><button onclick=resetGroupForm()>清空表单</button></div><div id=groups></div></section>
</div>
<script>
const $=id=>document.getElementById(id),DH=${JSON.stringify(defaultProxyHost)},PROJECTS=${JSON.stringify(projects)},REGIONS=['','US','HK','JP','SG','KR','DE','NL','GB','SE','FI'];document.querySelectorAll('[id]').forEach(el=>{try{globalThis[el.id]=el}catch(e){}});let userRows=[],nodeRows=[],groupRows=[],planRows=[],limitRows=[],userNodeRows=[],editingUser='',editingNode='',inlineNode='',editingGroup='',inlineUserNode='',inlinePlan='',CUR=null;const L={users:'用户总数',activeUsers:'正常用户',activeNodes:'启用节点',email:'账号',name:'名称',status:'状态',groups:'分组',expire:'到期时间',hours:'剩余小时',sub:'订阅链接 / 操作',id:'ID',address:'入口地址',port:'端口',host:'Host',path:'路径',group_id:'分组',region:'地区',enabled:'启用',node_ops:'节点操作',group_ops:'分组操作',sort_order:'排序',node_name:'节点',plan_id:'套餐',device_limit:'最多设备数'};
let memPassword='';
function getPw(){try{return localStorage.getItem('adminPassword')||memPassword||''}catch(e){return memPassword||''}}
function setPw(v){memPassword=v||'';try{localStorage.setItem('adminPassword',memPassword)}catch(e){}}
function clearPw(){memPassword='';try{localStorage.removeItem('adminPassword')}catch(e){}}
const api=(p,o={})=>fetch('/api/admin/'+p,{...o,headers:{'content-type':'application/json','x-admin-password':getPw(),...(o.headers||{})}}).then(async r=>{let j=await r.json().catch(()=>({ok:false,error:r.statusText}));if(r.status===401){clearPw();showApp();let m=$('loginMsg');if(m)m.textContent='密码失效或错误，请重新输入';throw new Error('请重新登录')}if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j});
function dt(x){return x?new Date(x*1000).toLocaleString():'永不过期'}
function dateVal(ts){return ts?new Date(ts*1000).toISOString().slice(0,10):''}
function daysToDateInput(){let d=Number(udays.value||0);if(d>0){let x=new Date(Date.now()+d*864e5);uexpDate.value=x.toISOString().slice(0,10);uexp.value=Math.floor(x.getTime()/1000)}else{uexpDate.value='';uexp.value=0}}
function dateToDaysInput(){if(!uexpDate.value){udays.value=0;uexp.value=0;return}let t=Math.floor(new Date(uexpDate.value+'T23:59:59').getTime()/1000);uexp.value=t;udays.value=Math.max(1,Math.ceil((t-Date.now()/1000)/86400))}
function regionOptions(v=''){let r=cleanRegion(v);return REGIONS.map(x=>'<option value="'+x+'" '+(x===r?'selected':'')+'>'+(x||'按默认')+'</option>').join('')}
function initRegionSelect(){nregion.innerHTML=regionOptions('')}
function initUserNodeRegionSelect(){unregion.innerHTML=regionOptions('')}
async function loginNow(){let pwEl=$('pw'),msgEl=$('loginMsg');setPw((pwEl?.value||'').trim());if(msgEl)msgEl.textContent='正在验证...';try{await api('summary');showApp();renderMode()}catch(e){clearPw();showApp();msgEl=$('loginMsg');if(msgEl)msgEl.textContent='登录失败：'+(e.message||'请检查当前管理域名和密码')}}
function logout(){clearPw();location.reload()}
function showApp(){let ok=!!getPw(),loginEl=$('login'),appEl=$('app'),pwEl=$('pw');if(loginEl)loginEl.classList.toggle('hidden',ok);if(appEl)appEl.classList.toggle('hidden',!ok);if(ok&&pwEl)pwEl.value=''}
function initProjects(){projectSelect.innerHTML=PROJECTS.map(p=>'<option value="'+h(p.url)+'">'+h(p.name)+'</option>').join('');let cur=location.origin+location.pathname+location.search;CUR=PROJECTS.find(p=>p.url===cur||p.url===location.href)||PROJECTS[0];if(CUR){projectSelect.value=CUR.url;projectName.textContent=CUR.name;proxyHost.textContent=CUR.host||DH}}
function openProject(){let u=projectSelect.value;if(u&&u!==location.href)location.href=u}
async function restartProject(){let host=(CUR?.host||DH||'').trim();if(!host)return msg.textContent='当前项目没有 Host，无法重启';if(!confirm('确定重启 '+host+' 吗？当前连接会被强制断开，客户端会自动重连。'))return;msg.textContent='正在重启 '+host+' ...';let r=await api('restart-project',{method:'POST',body:JSON.stringify({host})});msg.textContent=r.data?.restarted?('已重启 '+host):('重启未执行：'+(r.data?.error||'未知原因'))}
function isLight(){return CUR&&CUR.light}
function renderMode(){let light=isLight();document.querySelectorAll('.fullOnly').forEach(x=>x.classList.toggle('hidden',light));let lp=$('lightPanel'),tb=$('toolbar');if(lp)lp.classList.toggle('hidden',!light);if(tb)tb.classList.toggle('hidden',light);if(light)loadLightSettings();else loadAll()}





managerHost.textContent=location.host;
function lightKey(){return 'light_ips_'+(CUR?.host||'default')}
function lightProject(){return encodeURIComponent(CUR?.host||'default')}
function lightBase(){let h=CUR?.host||DH;return h==='444.freelx.net'?location.origin+'/light-sub/444':'https://'+h+'/llr/sub'}
function lightList(){return lightIps.value.replace(/\\r/g,'').split(/\\n|,/).map(x=>x.trim()).filter(Boolean)}
function lightUrl(){let ips=lightList().join(','),q=[];if(ips)q.push('ips='+encodeURIComponent(ips));return lightBase()+(q.length?'?'+q.join('&'):'')}
async function loadLightSettings(){try{let r=await api('light-settings/'+lightProject());let d=r.data||{};lightIps.value=d.ips||localStorage.getItem(lightKey())||'';renderLight();await loadLightNodeSort()}catch(e){lightIps.value=localStorage.getItem(lightKey())||'';renderLight();await loadLightNodeSort().catch(()=>{});msg.textContent='读取保存节点失败：'+e.message}}
function renderLight(){lightOut.textContent='订阅地址:\\n'+lightUrl()+'\\n\\n当前只生成 /llr/sub 链接，不改变 '+(CUR?.host||DH)+' 的连接逻辑；自定义节点会保存到管理 Worker。'}
function extractLightIps(){let v=lightIps.value.trim();try{let u=new URL(v);let ips=u.searchParams.get('ips')||'';if(ips)lightIps.value=ips.split(',').map(x=>x.trim()).filter(Boolean).join('\\n')}catch(e){}renderLight();msg.textContent='已按一行一个整理'}
async function saveLightIps(){localStorage.setItem(lightKey(),lightIps.value);await api('light-settings/'+lightProject(),{method:'PATCH',body:JSON.stringify({ips:lightIps.value})});renderLight();msg.textContent='自定义节点已保存到管理 Worker'}
async function clearLightIps(){localStorage.removeItem(lightKey());lightIps.value='';await api('light-settings/'+lightProject(),{method:'PATCH',body:JSON.stringify({ips:''})});renderLight();msg.textContent='已清空并保存'}
async function copyLightSub(){let u=lightUrl();await navigator.clipboard.writeText(u);lightOut.textContent='已复制:\\n'+u}
function openLightSub(){location.href=lightUrl()}
async function loadAll(){try{msg.textContent='正在加载...';let s=await api('summary');sum.innerHTML=Object.entries(s.data).map(([k,v])=>'<div class=card><b>'+h(L[k]||k)+'</b><br>'+h(v)+'</div>').join('');let [us,ns,gs,ps]=await Promise.all([api('users'),api('nodes'),api('groups'),api('plans')]);userRows=us.data||[];nodeRows=ns.data||[];groupRows=gs.data||[];planRows=ps.data||[];fillPlans();fillLimitUsers();users.innerHTML=tbl(userRows,['email','name','plan_id','device_limit','status','groups','expire','hours','sub']);nodes.innerHTML=nodesTable();initNodeDrag('nodes');groups.innerHTML=tbl(groupRows,['id','name','sort_order','group_ops']);plans.innerHTML=plansTable();msg.textContent='数据已刷新';}catch(e){msg.textContent='错误：'+e.message}}
function tbl(rows,cols){if(!rows||!rows.length)return '<p class=muted>暂无数据</p>';return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+cell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function nodesTable(){let cols=['drag','id','name','region','address','port','host','path','group_id','enabled','node_ops'];if(!nodeRows.length)return '<p class=muted>暂无数据</p>';return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+nodeRows.map(r=>nodeReadRow(r,cols)+(inlineNode===r.id?nodeEditPanel(r,cols.length):'')).join('')+'</table><p class=mini>拖拽左侧把手可快速调整订阅节点顺序，松开后自动保存。</p>'}
function nodeReadRow(r,cols){return '<tr draggable=true data-node-id="'+h(r.id)+'">'+cols.map(c=>'<td class="'+(c==='drag'?'dragcell ': '')+(c==='id'||c==='region'||c==='port'||c==='enabled'?'nowrap':'')+'">'+cell(r,c)+'</td>').join('')+'</tr>'}
async function loadLightNodeSort(){let box=$('lightNodeSort');if(!box)return;if((CUR?.host||'')!=='444.freelx.net'){box.innerHTML='';return}let ns=await api('nodes');nodeRows=ns.data||[];box.innerHTML=lightNodeSortTable();initNodeDrag('lightNodeSort')}
function lightNodeSortTable(){let cols=['drag','name','region','address','enabled'];if(!nodeRows.length)return '<h3>444 节点快速排序</h3><p class=muted>暂无管理节点。</p>';return '<h3>444 节点快速排序</h3><table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+nodeRows.map(r=>'<tr draggable=true data-node-id="'+h(r.id)+'">'+cols.map(c=>'<td class="'+(c==='drag'?'dragcell ': '')+(c==='region'||c==='enabled'?'nowrap':'')+'">'+cell(r,c)+'</td>').join('')+'</tr>').join('')+'</table><p class=mini>拖拽左侧把手调整 444 管理订阅里的节点顺序，松开后自动保存。</p>'}
function initNodeDrag(containerId){let root=$(containerId);if(!root)return;let rows=[...root.querySelectorAll('tr[data-node-id]')];rows.forEach(row=>{row.ondragstart=e=>{row.classList.add('dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.nodeId)}};row.ondragend=()=>{row.classList.remove('dragging');saveNodeOrderFromDom(containerId)};row.ondragover=e=>{e.preventDefault();let dragging=root.querySelector('tr.dragging');if(!dragging||dragging===row)return;let box=row.getBoundingClientRect(),after=e.clientY>box.top+box.height/2;row.parentNode.insertBefore(dragging,after?row.nextSibling:row)}})}
async function saveNodeOrderFromDom(containerId){let root=$(containerId);if(!root)return;let ids=[...root.querySelectorAll('tr[data-node-id]')].map(r=>r.dataset.nodeId);if(!ids.length)return;nodeRows=ids.map((id,i)=>{let r=nodeRows.find(x=>x.id===id);return r?{...r,sort_order:(i+1)*10}:null}).filter(Boolean);try{await api('node-order',{method:'PATCH',body:JSON.stringify({ids})});msg.textContent='节点排序已保存'}catch(e){msg.textContent='排序保存失败：'+e.message}}
function nodeEditPanel(r,colspan){let k=safeDom(r.id);return '<tr><td colspan="'+colspan+'"><div class=editpanel><div class=mini>正在编辑：<span class=mono>'+h(r.id)+'</span></div><div class=editgrid>'+nodeEditField(k,'名称','name',r.name||'')+nodeEditSelect(k,'地区','region',r.region||'')+nodeEditField(k,'入口地址','address',r.address||'')+nodeEditField(k,'端口','port',r.port||443)+nodeEditField(k,'Host','host',r.host||DH)+nodeEditField(k,'路径','path',r.path||('/node/'+r.id))+nodeEditField(k,'分组','group_id',r.group_id||'default')+'<label>启用<select id="en_enabled_'+k+'"><option value=1 '+(r.enabled?'selected':'')+'>启用</option><option value=0 '+(!r.enabled?'selected':'')+'>禁用</option></select></label></div><div class=editactions><button onclick="cancelInlineNode()">取消</button><button onclick="saveInlineNode(\\''+h(r.id)+'\\')">保存</button></div></div></td></tr>'}
function nodeEditField(k,label,name,value){return '<label>'+label+'<input id="en_'+name+'_'+k+'" value="'+h(value)+'"></label>'}
function nodeEditSelect(k,label,name,value){return '<label>'+label+'<select id="en_'+name+'_'+k+'">'+regionOptions(value)+'</select></label>'}
function cell(r,c){if(c==='drag')return '<span class=draghandle title="拖拽排序">::</span>';if(c==='expire')return dt(r.expires_at);if(c==='hours')return r.hours_enabled?'<span class=mono>'+h(r.remaining_hours||0)+' 小时</span>':'不生效';if(c==='plan_id')return planName(r.plan_id);if(c==='device_limit')return r.device_limit?'<span class=mono>'+h(r.device_limit)+'</span>':'无限制';if(c==='sub'){let u=subUrl(r);return '<div class=mono>'+h(u)+'</div><p class=ops><button onclick="editUser(\\''+r.id+'\\')">编辑</button><button onclick="copySub(\\''+r.sub_token+'\\')">复制订阅</button><button onclick="selectLimitUser(\\''+r.id+'\\')">节点权限</button><button onclick="deleteUser(\\''+r.id+'\\')">删除用户</button></p>'}if(c==='node_ops')return '<span class=ops><button onclick="editNode(\\''+h(r.id)+'\\')">编辑</button><button onclick="toggleNode(\\''+h(r.id)+'\\','+(r.enabled?0:1)+')">'+(r.enabled?'禁用':'启用')+'</button><button onclick="copyPath(\\''+h(r.path||('/node/'+r.id))+'\\')">复制路径</button><button onclick="deleteNode(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='group_ops')return '<span class=ops><button onclick="editGroup(\\''+h(r.id)+'\\')">编辑</button><button onclick="deleteGroup(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='enabled')return r.enabled?'<span class=ok>是</span>':'<span class=bad>否</span>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function planName(id){let p=planRows.find(x=>x.id===id);return p?'<span class=mono>'+h(p.name)+'</span>':'无'}
function fillPlans(){uplan.innerHTML='<option value="">无套餐</option>'+planRows.map(p=>'<option value="'+h(p.id)+'">'+h(p.name)+'</option>').join('')}
function applyPlanToUser(){let p=planRows.find(x=>x.id===uplan.value);if(!p)return;if(p.valid_days!==undefined){udays.value=p.valid_days;daysToDateInput()}if(p.group_ids)ugroups.value=p.group_ids;if(p.device_limit!==undefined)udevices.value=p.device_limit}
function subUrl(r){return location.origin+'/sub/'+r.sub_token}
async function copySub(tok){let u=location.origin+'/sub/'+tok;await navigator.clipboard.writeText(u);msg.textContent='已复制 '+DH+' 项目的订阅链接：'+u}
async function deleteUser(id){if(!confirm('确定删除这个用户吗？该用户的订阅和节点权限都会删除。'))return;await api('users/'+id,{method:'DELETE'});msg.textContent='用户已删除';loadAll()}
function userBody(){if(uexpDate.value&&!uexp.value)dateToDaysInput();let id=safeId(uid.value||uemail.value||uname.value||('user-'+Date.now()));uid.value=id;let body={id,email:uemail.value,name:uname.value,uuid:uuid.value.trim()||undefined,sub_token:usub.value.trim()||undefined,plan_id:uplan.value||null,device_limit:Number(udevices.value||0),group_ids:ugroups.value.split(',').map(x=>x.trim()).filter(Boolean),remaining_hours:Number(uhours.value||0),hours_enabled:Number(uhen.value||0),status:ustatus.value,note:unote.value};if(uexp.value!=='')body.expires_at=Number(uexp.value||0);else if(udays.value!=='')body.valid_days=udays.value;return body}
async function saveUser(){let b=userBody();if(!b.id)throwMsg('用户 ID 不能为空');if(editingUser){b.id=editingUser;await api('users/'+editingUser,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='用户已保存'}else{await api('users',{method:'POST',body:JSON.stringify(b)});msg.textContent='用户已创建'}resetUserForm();loadAll()}
async function editUser(id){let res=await api('users/'+id),r=res.data;if(!r)return;uid.value=r.id;uid.readOnly=true;uemail.value=r.email||'';uname.value=r.name||'';uplan.value=r.plan_id||'';udevices.value=r.device_limit||0;uuid.value=r.uuid||'';usub.value=r.sub_token||'';ugroups.value=(r.group_ids||[]).join(',');udays.value='';uexp.value=r.expires_at||0;uexpDate.value=dateVal(r.expires_at||0);if(r.expires_at)dateToDaysInput();uhours.value=r.remaining_hours||0;uhen.value=r.hours_enabled?1:0;ustatus.value=r.status||'active';unote.value=r.note||'';editingUser=id;usave.textContent='保存修改';msg.textContent='正在编辑用户：'+id;uid.scrollIntoView({behavior:'smooth',block:'center'})}
function resetUserForm(){editingUser='';uid.readOnly=false;for(const x of [uid,uemail,uname,uuid,usub,ugroups,udays,uexp,uexpDate,uhours,unote,udevices])x.value='';uplan.value='';uhen.value=0;ustatus.value='active';usave.textContent='保存用户'}
function fillLimitUsers(){limitUser.innerHTML=userRows.map(u=>'<option value="'+h(u.id)+'">'+h((u.email||u.name||u.id)+' ｜ '+u.id)+'</option>').join('');if(!limitRows.length)nodeLimits.innerHTML='<p class=muted>请选择用户后加载节点权限。</p>'}
async function selectLimitUser(id){limitUser.value=id;await loadNodeLimits();document.getElementById('nodeLimits').scrollIntoView({behavior:'smooth',block:'start'})}
async function loadNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先创建或选择用户';let [res,un]=await Promise.all([api('users/'+id+'/node-limits'),api('users/'+id+'/nodes')]);limitRows=res.data||[];userNodeRows=un.data||[];nodeLimits.innerHTML=limitRows.length?nodeLimitTable(limitRows):'<p class=muted>暂无节点。</p>';userNodes.innerHTML=userNodesTable();msg.textContent='已加载该用户的节点权限'}
async function saveNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先选择用户';let limits=limitRows.map(r=>({node_id:r.node_id,status:$('st_'+limId(r.node_id)).value||'active'}));await api('users/'+id+'/node-limits',{method:'PATCH',body:JSON.stringify({limits})});msg.textContent='用户节点权限已保存';loadNodeLimits()}
function nodeLimitCell(r,c){if(c==='status')return '<select id="st_'+limId(r.node_id)+'"><option value=active '+(r.status==='active'?'selected':'')+'>启用</option><option value=disabled '+(r.status==='disabled'?'selected':'')+'>禁用</option></select>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function nodeLimitTable(rows){let cols=['node_id','node_name','status'];return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+nodeLimitCell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function limId(v){return 'lim_'+String(v).replace(/[^a-zA-Z0-9_-]/g,'_')}
function userNodesTable(){if(!userNodeRows.length)return '<p class=muted>暂无专属节点。</p>';let cols=['id','name','region','address','port','host','path','enabled','node_ops'];return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+userNodeRows.map(r=>'<tr>'+cols.map(c=>'<td>'+userNodeCell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function userNodeCell(r,c){if(c==='node_ops')return '<span class=ops><button onclick="editUserNode(\\''+h(r.id)+'\\')">编辑</button><button onclick="deleteUserNode(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='enabled')return r.enabled?'<span class=ok>是</span>':'<span class=bad>否</span>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function userNodeBody(){let id=safeId(unid.value||unname.value||unaddr.value);unid.value=id;let host=(unhost.value||DH).trim();return{id,name:unname.value||id,region:cleanRegion(unregion.value),address:unaddr.value.trim(),port:Number(unport.value||443),host,sni:host,path:unpath.value||('/node/'+id),group_id:'default',sort_order:Number(unsort.value||0),enabled:Number(unenabled.value)}}
async function saveUserNode(){let u=limitUser.value;if(!u)return msg.textContent='请先选择用户';let b=userNodeBody();if(!b.id||!b.address)return msg.textContent='专属节点 ID 和入口地址不能为空';if(inlineUserNode){b.id=inlineUserNode;await api('users/'+u+'/nodes/'+inlineUserNode,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='专属节点已更新'}else{await api('users/'+u+'/nodes',{method:'POST',body:JSON.stringify(b)});msg.textContent='专属节点已创建'}resetUserNodeForm();loadNodeLimits()}
function editUserNode(id){let r=userNodeRows.find(x=>x.id===id);if(!r)return;inlineUserNode=id;unid.value=r.id;unid.readOnly=true;unname.value=r.name||'';unregion.value=cleanRegion(r.region||'');unaddr.value=r.address||'';unport.value=r.port||443;unhost.value=r.host||DH;unpath.value=r.path||('/node/'+r.id);unsort.value=r.sort_order||0;unenabled.value=r.enabled?1:0;unsave.textContent='保存专属节点修改'}
function resetUserNodeForm(){inlineUserNode='';unid.readOnly=false;for(const x of [unid,unname,unaddr,unport,unhost,unpath,unsort])x.value='';unregion.value='';unenabled.value=1;unsave.textContent='保存专属节点'}
async function deleteUserNode(id){let u=limitUser.value;if(!u)return;if(!confirm('确定删除该用户专属节点 '+id+' 吗？'))return;await api('users/'+u+'/nodes/'+id,{method:'DELETE'});msg.textContent='专属节点已删除';loadNodeLimits()}
function plansTable(){if(!planRows.length)return '<p class=muted>暂无套餐。</p>';let cols=['id','name','valid_days','price_cents','allowed_regions','group_ids','max_nodes','device_limit','enabled','node_ops'];return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+planRows.map(r=>planRow(r,cols)+(inlinePlan===r.id?planEditPanel(r,cols.length):'')).join('')+'</table>'}
function planRow(r,cols){return '<tr>'+cols.map(c=>'<td>'+planCell(r,c)+'</td>').join('')+'</tr>'}
function planCell(r,c){if(c==='node_ops')return '<span class=ops><button onclick="editPlanInline(\\''+h(r.id)+'\\')">编辑</button><button onclick="deletePlan(\\''+h(r.id)+'\\')">删除</button></span>';if(c==='enabled')return r.enabled?'<span class=ok>是</span>':'<span class=bad>否</span>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function planEditPanel(r,colspan){let k=safeDom(r.id);return '<tr><td colspan="'+colspan+'"><div class=editpanel><div class=mini>正在编辑套餐：<span class=mono>'+h(r.id)+'</span></div><div class=editgrid>'+planField(k,'名称','name',r.name||'')+planField(k,'有效天数','valid_days',r.valid_days||0)+planField(k,'价格分','price_cents',r.price_cents||0)+planField(k,'货币','currency',r.currency||'CNY')+planField(k,'地区','allowed_regions',r.allowed_regions||'')+planField(k,'分组','group_ids',r.group_ids||'')+planField(k,'最大节点','max_nodes',r.max_nodes||0)+planField(k,'单订阅数量','device_limit',r.device_limit||0)+'<label>专属节点<select id="pl_allow_dedicated_'+k+'"><option value=1 '+(r.allow_dedicated?'selected':'')+'>允许</option><option value=0 '+(!r.allow_dedicated?'selected':'')+'>不允许</option></select></label><label>启用<select id="pl_enabled_'+k+'"><option value=1 '+(r.enabled?'selected':'')+'>启用</option><option value=0 '+(!r.enabled?'selected':'')+'>禁用</option></select></label>'+planField(k,'排序','sort_order',r.sort_order||0)+planField(k,'备注','note',r.note||'')+'</div><div class=editactions><button onclick="cancelPlanInline()">取消</button><button onclick="savePlanInline(\\''+h(r.id)+'\\')">保存</button></div></div></td></tr>'}
function planField(k,label,name,value){return '<label>'+label+'<input id="pl_'+name+'_'+k+'" value="'+h(value)+'"></label>'}
function planBody(prefix='p'){let get=id=>$(prefix+id).value;return{id:safeId(get('id')||get('name')),name:get('name')||get('id'),valid_days:Number(get('days')||0),price_cents:Number(get('price')||0),currency:get('currency')||'CNY',allowed_regions:get('regions'),group_ids:get('groups'),max_nodes:Number(get('maxnodes')||0),allow_dedicated:Number($(prefix+'dedicated').value),device_limit:Number(get('devices')||0),enabled:Number($(prefix+'enabled').value),sort_order:Number(get('sort')||0),note:get('note')}}
async function savePlan(){let b=planBody('p');if(!b.id||!b.name)return msg.textContent='套餐 ID 和名称不能为空';await api(planRows.some(x=>x.id===b.id)?'plans/'+b.id:'plans',{method:planRows.some(x=>x.id===b.id)?'PATCH':'POST',body:JSON.stringify(b)});resetPlanForm();loadAll()}
function editPlanInline(id){inlinePlan=id;plans.innerHTML=plansTable()}
function cancelPlanInline(){inlinePlan='';plans.innerHTML=plansTable()}
async function savePlanInline(id){let k=safeDom(id),body={name:$('pl_name_'+k).value||id,valid_days:Number($('pl_valid_days_'+k).value||0),price_cents:Number($('pl_price_cents_'+k).value||0),currency:$('pl_currency_'+k).value||'CNY',allowed_regions:$('pl_allowed_regions_'+k).value,group_ids:$('pl_group_ids_'+k).value,max_nodes:Number($('pl_max_nodes_'+k).value||0),device_limit:Number($('pl_device_limit_'+k).value||0),allow_dedicated:Number($('pl_allow_dedicated_'+k).value),enabled:Number($('pl_enabled_'+k).value),sort_order:Number($('pl_sort_order_'+k).value||0),note:$('pl_note_'+k).value};await api('plans/'+id,{method:'PATCH',body:JSON.stringify(body)});inlinePlan='';loadAll()}
async function deletePlan(id){if(!confirm('确定删除套餐 '+id+' 吗？'))return;await api('plans/'+id,{method:'DELETE'});loadAll()}
function resetPlanForm(){inlinePlan='';for(const x of [pid,pname,pdays,pprice,pcurrency,pregions,pgroups,pmaxnodes,pdevices,psort,pnote])x.value='';pdedicated.value=1;penabled.value=1;psave.textContent='保存套餐'}
async function createDefaultPlans(){let defaults=[{id:'trial',name:'免费体验',valid_days:1,price_cents:0,allowed_regions:'US',group_ids:'default',max_nodes:3,device_limit:1,allow_dedicated:0,enabled:1,sort_order:1,note:'1天体验，只开放US和3个公共节点'},{id:'basic-month',name:'基础月卡',valid_days:30,price_cents:990,allowed_regions:'US',group_ids:'default',max_nodes:0,device_limit:2,allow_dedicated:0,enabled:1,sort_order:2,note:'US公共节点'},{id:'premium-month',name:'高级月卡',valid_days:30,price_cents:1990,allowed_regions:'US,HK,JP,SG',group_ids:'default',max_nodes:0,device_limit:5,allow_dedicated:1,enabled:1,sort_order:3,note:'多地区和专属节点'},{id:'dedicated-month',name:'独享月卡',valid_days:30,price_cents:3990,allowed_regions:'US,HK,JP,SG',group_ids:'default',max_nodes:0,device_limit:8,allow_dedicated:1,enabled:1,sort_order:4,note:'适合绑定用户专属节点'}];for(const p of defaults){let exists=planRows.some(x=>x.id===p.id);await api(exists?'plans/'+p.id:'plans',{method:exists?'PATCH':'POST',body:JSON.stringify(p)})}loadAll()}
function nodeBody(){let id=safeId(nid.value||nname.value||naddr.value);nid.value=id;let host=(nhost.value||DH).trim(),region=cleanRegion(nregion.value),addr=naddr.value.trim();return{id,name:nname.value||id,region,address:addr,port:Number(nport.value||443),host,sni:host,path:npath.value||('/node/'+id),group_id:ngroup.value||'default',sort_order:Number(nsort.value||0),enabled:Number(nenabled.value)}} 
async function saveNode(){let b=nodeBody();if(!b.id||!b.address)throwMsg('节点 ID 和入口地址不能为空');if(editingNode){b.id=editingNode;await api('nodes/'+editingNode,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='节点已更新'}else{await api('nodes',{method:'POST',body:JSON.stringify(b)});msg.textContent='节点已创建'}resetNodeForm();loadAll()}
function editNode(id){inlineNode=id;nodes.innerHTML=nodesTable();initNodeDrag('nodes');msg.textContent='正在原地编辑节点：'+id}
function cancelInlineNode(){inlineNode='';nodes.innerHTML=nodesTable();initNodeDrag('nodes');msg.textContent='已取消节点编辑'}
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
Object.assign(globalThis,{loginNow,logout,openProject,restartProject,loadAll,extractLightIps,saveLightIps,copyLightSub,openLightSub,clearLightIps,applyPlanToUser,daysToDateInput,dateToDaysInput,saveUser,resetUserForm,editUser,copySub,selectLimitUser,deleteUser,loadNodeLimits,saveNodeLimits,saveUserNode,resetUserNodeForm,editUserNode,deleteUserNode,savePlan,resetPlanForm,createDefaultPlans,editPlanInline,cancelPlanInline,savePlanInline,deletePlan,saveNode,resetNodeForm,editNode,cancelInlineNode,saveInlineNode,toggleNode,deleteNode,copyPath,importNodes,saveGroup,resetGroupForm,editGroup,deleteGroup,boot});
initProjects();initRegionSelect();initUserNodeRegionSelect();showApp();if(getPw())renderMode();
</script>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function parseProjects(raw, fallbackName) {
  if (raw) {
    try {
      const rows = JSON.parse(raw);
      if (Array.isArray(rows) && rows.length) return rows.map(p => ({ name: String(p.name || p.host || '项目'), url: String(p.url || ''), host: String(p.host || ''), light: Boolean(p.light) })).filter(p => p.url);
    } catch {}
  }
  return [
    { name: fallbackName || '111', url: 'https://admin.freelx.net/admin', host: '111.freelx.net', light: false },
    { name: '222', url: 'https://admin.freelx.net/admin?project=222', host: '222.freelx.net', light: true },
    { name: '333', url: 'https://admin.freelx.net/admin?project=333', host: '333.freelx.net', light: true },
    { name: '444', url: 'https://admin.freelx.net/admin?project=444', host: '444.freelx.net', light: true },
  ];
}
