// Cloudflare Worker control plane for the v2rayng-stable snippets proxy.
// Bindings: DB (D1), USAGE_METER (Durable Object namespace)
// Secrets/vars: ADMIN_TOKEN, EDGE_SECRET, PROXY_HOST

const H_JSON = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const H_TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const DAY = 86400;

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
};

export class UsageMeter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await readJson(request);
    try {
      if (url.pathname.endsWith('/open')) return json(await this.open(body));
      if (url.pathname.endsWith('/usage')) return json(await this.usage(body));
      if (url.pathname.endsWith('/close')) return json(await this.close(body));
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  }

  async open(data) {
    const now = unix();
    const uuid = String(data.uuid || '').toLowerCase();
    const nodeId = nodeIdOf(data.nodeId || data.node || 'default');
    const sessionId = data.sessionId || rid('sess');
    const user = await userByUuid(this.env, uuid);
    const node = await getNodeForAccess(this.env, nodeId);
    const access = await checkAccess(this.env, user, node, now);
    if (!access.ok) return access;

    if (user.device_limit > 0) {
      const active = await first(this.env.DB,
        "SELECT COUNT(*) c FROM sessions WHERE user_id=? AND closed_at IS NULL AND last_seen_at>?",
        user.id, now - 120);
      if (Number(active?.c || 0) >= Number(user.device_limit)) {
        return { ok: false, error: 'device_limit' };
      }
    }

    await ensureNodeLimit(this.env, user.id, node.id, node.default_user_quota_bytes || 0);
    const nodeLimit = await nodeLimitOf(this.env, user.id, node.id);
    if (nodeLimit?.status && nodeLimit.status !== 'active') return { ok: false, error: 'node_user_disabled' };
    if (!quotaOk(nodeLimit, 0)) return { ok: false, error: 'node_quota_exceeded' };

    await this.env.DB.prepare(
      "INSERT INTO sessions(id,user_id,node_id,ip,ua,colo,country,opened_at,last_seen_at,status) VALUES(?,?,?,?,?,?,?,?,?,'open') " +
      "ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,status='open',closed_at=NULL"
    ).bind(
      sessionId, user.id, node.id, String(data.ip || ''), String(data.ua || '').slice(0, 300),
      String(data.colo || ''), String(data.country || ''), now, now
    ).run();

    return {
      ok: true,
      sessionId,
      userId: user.id,
      nodeId: node.id,
      expire: user.expires_at || 0,
      total: user.quota_bytes || 0,
      used: usedOf(user),
      nodeTotal: nodeLimit?.quota_bytes || 0,
      nodeUsed: nodeLimit ? usedOf(nodeLimit) : 0,
    };
  }

  async usage(data) {
    const now = unix();
    const sessionId = String(data.sessionId || '');
    const up = Math.max(0, Number(data.up || data.upload || 0) || 0);
    const down = Math.max(0, Number(data.down || data.download || 0) || 0);
    const delta = up + down;
    if (!sessionId || !delta) return { ok: true, cut: false };

    const session = await first(this.env.DB, "SELECT * FROM sessions WHERE id=?", sessionId);
    if (!session || session.closed_at) return { ok: false, cut: true, error: 'session_closed' };

    const user = await first(this.env.DB, "SELECT * FROM users WHERE id=?", session.user_id);
    const node = await getNodeForAccess(this.env, session.node_id || 'default');
    const access = await checkAccess(this.env, user, node, now, false);
    if (!access.ok) {
      await markClosed(this.env, sessionId, now, access.error);
      return { ...access, cut: true };
    }

    await ensureNodeLimit(this.env, user.id, node.id, node.default_user_quota_bytes || 0);
    const nodeLimit = await nodeLimitOf(this.env, user.id, node.id);
    const cutUser = !quotaOk(user, delta);
    const cutNodeStatus = nodeLimit?.status && nodeLimit.status !== 'active';
    const cutNode = !quotaOk(nodeLimit, delta);
    const reason = cutUser ? 'quota_exceeded' : (cutNodeStatus ? 'node_user_disabled' : (cutNode ? 'node_quota_exceeded' : ''));
    const day = new Date(now * 1000).toISOString().slice(0, 10);

    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE users SET used_upload=used_upload+?,used_download=used_download+?,updated_at=? WHERE id=?")
        .bind(up, down, now, user.id),
      this.env.DB.prepare("UPDATE user_node_limits SET used_upload=used_upload+?,used_download=used_download+?,updated_at=? WHERE user_id=? AND node_id=?")
        .bind(up, down, now, user.id, node.id),
      this.env.DB.prepare("UPDATE sessions SET upload_bytes=upload_bytes+?,download_bytes=download_bytes+?,last_seen_at=? WHERE id=?")
        .bind(up, down, now, sessionId),
      this.env.DB.prepare(
        "INSERT INTO usage_daily(user_id,node_id,day,upload_bytes,download_bytes) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(user_id,node_id,day) DO UPDATE SET upload_bytes=usage_daily.upload_bytes+excluded.upload_bytes,download_bytes=usage_daily.download_bytes+excluded.download_bytes"
      ).bind(user.id, node.id, day, up, down),
    ]);

    if (reason) await markClosed(this.env, sessionId, now, reason);
    return { ok: !reason, cut: Boolean(reason), error: reason || undefined };
  }

  async close(data) {
    const sessionId = String(data.sessionId || '');
    if (sessionId) await markClosed(this.env, sessionId, unix(), String(data.reason || 'client_closed'));
    return { ok: true };
  }
}

async function handleEdge(request, env) {
  if (!sameSecret(request.headers.get('x-edge-secret'), env.EDGE_SECRET)) {
    return json({ ok: false, error: 'bad_edge_secret' }, 401);
  }
  const url = new URL(request.url);
  const body = await readJson(request);
  const uuid = String(body.uuid || '').toLowerCase() || 'anonymous';
  if (!env.USAGE_METER) return json({ ok: false, error: 'missing_usage_meter_binding' }, 500);
  const id = env.USAGE_METER.idFromName(uuid);
  const stub = env.USAGE_METER.get(id);
  const action = url.pathname.split('/').pop();
  return stub.fetch(new Request(url.origin + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function handleSubscription(request, env) {
  const url = new URL(request.url);
  const token = decodeURIComponent(url.pathname.replace(/^\/sub\//, '').split('/')[0] || '');
  const user = await first(env.DB, "SELECT * FROM users WHERE sub_token=?", token);
  const now = unix();
  const state = await checkUserOnly(user, now);
  if (!state.ok) return new Response(state.error, { status: 403, headers: H_TEXT });

  const nodes = await getSubscriptionNodes(env, user);
  const custom = parseCustomIps(url.searchParams.get('ips') || '', env);
  const allNodes = [...nodes, ...custom];
  if (!allNodes.length) return new Response('', { status: 204, headers: H_TEXT });

  const links = allNodes.map(n => buildVlessLink(user.uuid, n, env, request));
  const format = (url.searchParams.get('format') || 'base64').toLowerCase();
  const headers = {
    ...H_TEXT,
    'subscription-userinfo': `upload=${user.used_upload || 0}; download=${user.used_download || 0}; total=${user.quota_bytes || 0}; expire=${user.expires_at || 0}`,
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
  if (resource === 'plans') return tableApi(request, env, 'plans', id, planFields(), planDefaults);
  if (resource === 'groups') return tableApi(request, env, '"groups"', id, groupFields(), groupDefaults);
  if (resource === 'sessions') return listSessions(env, url);
  if (resource === 'usage') return listUsage(env, url);
  return json({ ok: false, error: 'not_found' }, 404);
}

async function usersApi(request, env, id, action) {
  if (id && action === 'node-limits') return userNodeLimitsApi(request, env, id);

  if (request.method === 'GET') {
    if (id) return json({ ok: true, data: await userDetail(env, id) });
    const rows = await all(env.DB,
      "SELECT u.*,p.name plan_name,(SELECT group_concat(g.name, ', ') FROM user_groups ug JOIN \"groups\" g ON g.id=ug.group_id WHERE ug.user_id=u.id) groups " +
      "FROM users u LEFT JOIN plans p ON p.id=u.plan_id ORDER BY u.created_at DESC LIMIT 200");
    return json({ ok: true, data: rows });
  }

  if (request.method === 'POST' && !id) {
    const b = await readJson(request);
    const now = unix();
    const plan = b.plan_id ? await first(env.DB, "SELECT * FROM plans WHERE id=?", b.plan_id) : null;
    const validDays = b.valid_days === undefined || b.valid_days === '' ? null : Number(b.valid_days);
    const user = {
      id: b.id || rid('usr'),
      email: b.email || '',
      name: b.name || '',
      uuid: (b.uuid || crypto.randomUUID()).toLowerCase(),
      sub_token: b.sub_token || token(28),
      plan_id: b.plan_id || null,
      quota_bytes: quotaValue(b, plan?.quota_bytes || 0),
      expires_at: validDays !== null ? daysToExpiry(validDays, now) : (toEpoch(b.expires_at) || daysToExpiry(plan?.valid_days || 0, now)),
      device_limit: numOr(b.device_limit, plan?.device_limit || 0),
      speed_limit_bps: numOr(b.speed_limit_bps, plan?.speed_limit_bps || 0),
      status: b.status || 'active',
      note: b.note || '',
    };
    await env.DB.prepare(
      "INSERT INTO users(id,email,name,uuid,sub_token,plan_id,quota_bytes,expires_at,device_limit,speed_limit_bps,status,note,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(user.id, user.email, user.name, user.uuid, user.sub_token, user.plan_id, user.quota_bytes, user.expires_at,
      user.device_limit, user.speed_limit_bps, user.status, user.note, now, now).run();
    await setUserGroups(env, user.id, b.group_ids || []);
    return json({ ok: true, data: await userDetail(env, user.id) }, 201);
  }

  if (!id) return json({ ok: false, error: 'missing_id' }, 400);

  if (request.method === 'PATCH') {
    const b = await readJson(request);
    if ('quota_gb' in b) b.quota_bytes = gbToBytes(b.quota_gb);
    if ('valid_days' in b) b.expires_at = daysToExpiry(b.valid_days, unix());
    const allowed = ['email', 'name', 'uuid', 'sub_token', 'plan_id', 'quota_bytes', 'expires_at', 'device_limit', 'speed_limit_bps', 'status', 'note'];
    await patchRow(env, 'users', id, allowed, b);
    if (Array.isArray(b.group_ids)) await setUserGroups(env, id, b.group_ids);
    return json({ ok: true, data: await userDetail(env, id) });
  }

  if (request.method === 'POST' && action === 'reset-usage') {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET used_upload=0,used_download=0,status='active',updated_at=? WHERE id=?").bind(unix(), id),
      env.DB.prepare("UPDATE user_node_limits SET used_upload=0,used_download=0,updated_at=? WHERE user_id=?").bind(unix(), id),
    ]);
    return json({ ok: true, data: await userDetail(env, id) });
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare("UPDATE users SET status='disabled',updated_at=? WHERE id=?").bind(unix(), id).run();
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
      const quota = 'quota_gb' in row ? gbToBytes(row.quota_gb) : numOr(row.quota_bytes, 0);
      await env.DB.prepare(
        "INSERT INTO user_node_limits(user_id,node_id,quota_bytes,used_upload,used_download,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(user_id,node_id) DO UPDATE SET quota_bytes=excluded.quota_bytes,status=excluded.status,updated_at=excluded.updated_at"
      ).bind(userId, nodeId, quota, 0, 0, row.status || 'active', now, now).run();
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
    if ('quota_gb' in b) b.quota_bytes = gbToBytes(b.quota_gb);
    if ('default_user_quota_gb' in b) b.default_user_quota_bytes = gbToBytes(b.default_user_quota_gb);
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
    if ('quota_gb' in b) b.quota_bytes = gbToBytes(b.quota_gb);
    if ('default_user_quota_gb' in b) b.default_user_quota_bytes = gbToBytes(b.default_user_quota_gb);
    await patchRow(env, table, id, allowed, b);
    return json({ ok: true, data: await first(env.DB, `SELECT * FROM ${table} WHERE id=?`, id) });
  }
  if (request.method === 'DELETE') {
    if (table === 'nodes' || table === 'plans') {
      await env.DB.prepare(`UPDATE ${table} SET enabled=0,updated_at=? WHERE id=?`).bind(unix(), id).run();
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
    env.DB.prepare("INSERT OR IGNORE INTO plans(id,name,quota_bytes,valid_days,device_limit,price_cents,currency,enabled,sort_order,created_at,updated_at) VALUES('monthly-100g','月付 100G',107374182400,30,2,0,'CNY',1,0,?,?)").bind(now, now),
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
        "INSERT INTO users(id,email,name,uuid,sub_token,plan_id,quota_bytes,expires_at,device_limit,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, 'demo@example.com', '演示用户', uuid, sub, 'monthly-100g', 107374182400, now + 30 * DAY, 2, 'active', now, now).run();
      await setUserGroups(env, id, ['default']);
      user = await userDetail(env, id);
    }
  }
  return { proxyHost, demoUser: user };
}

async function summary(env) {
  const [users, active, nodes, sessions, traffic] = await Promise.all([
    first(env.DB, "SELECT COUNT(*) c FROM users"),
    first(env.DB, "SELECT COUNT(*) c FROM users WHERE status='active'"),
    first(env.DB, "SELECT COUNT(*) c FROM nodes WHERE enabled=1"),
    first(env.DB, "SELECT COUNT(*) c FROM sessions WHERE closed_at IS NULL AND last_seen_at>?", unix() - 120),
    first(env.DB, "SELECT COALESCE(SUM(used_upload+used_download),0) total FROM users"),
  ]);
  return {
    users: Number(users?.c || 0),
    activeUsers: Number(active?.c || 0),
    activeNodes: Number(nodes?.c || 0),
    activeSessions: Number(sessions?.c || 0),
    trafficBytes: Number(traffic?.total || 0),
  };
}

async function listSessions(env, url) {
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
  const rows = await all(env.DB,
    "SELECT s.*,u.email,u.name user_name,n.name node_name FROM sessions s " +
    "LEFT JOIN users u ON u.id=s.user_id LEFT JOIN nodes n ON n.id=s.node_id ORDER BY s.opened_at DESC LIMIT ?",
    limit);
  return json({ ok: true, data: rows });
}

async function listUsage(env, url) {
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
  const rows = await all(env.DB,
    "SELECT d.*,u.email,u.name user_name,n.name node_name FROM usage_daily d " +
    "LEFT JOIN users u ON u.id=d.user_id LEFT JOIN nodes n ON n.id=d.node_id ORDER BY day DESC LIMIT ?",
    limit);
  return json({ ok: true, data: rows });
}

async function getSubscriptionNodes(env, user) {
  return all(env.DB,
    "SELECT n.*,g.name group_name FROM nodes n LEFT JOIN \"groups\" g ON g.id=n.group_id " +
    "WHERE n.enabled=1 AND (NOT EXISTS(SELECT 1 FROM user_groups WHERE user_id=?) OR n.group_id IN (SELECT group_id FROM user_groups WHERE user_id=?)) " +
    "ORDER BY n.sort_order,n.name",
    user.id, user.id);
}

function buildVlessLink(uuid, node, env, request) {
  const host = node.host || env.PROXY_HOST || new URL(request.url).hostname;
  const path = normalizePath(node.path || `/node/${node.id || 'default'}`);
  const params = new URLSearchParams({
    encryption: 'none',
    security: node.security || 'tls',
    sni: node.sni || host,
    fp: node.fp || 'chrome',
    type: node.type || 'ws',
    host,
    path,
  });
  const address = String(node.address || host).includes(':') && !String(node.address || host).startsWith('[')
    ? `[${node.address}]`
    : (node.address || host);
  return `vless://${uuid}@${address}:${node.port || 443}?${params.toString()}#${encodeURIComponent(node.name || node.id || 'node')}`;
}

function toClashYaml(user, nodes, env, request) {
  const proxyLines = nodes.map(n => {
    const host = n.host || env.PROXY_HOST || new URL(request.url).hostname;
    const path = normalizePath(n.path || `/node/${n.id || 'default'}`);
    const name = yaml(n.name || n.id || 'node');
    return [
      `  - name: ${name}`,
      `    type: vless`,
      `    server: ${yaml(n.address || host)}`,
      `    port: ${Number(n.port || 443)}`,
      `    uuid: ${user.uuid}`,
      `    tls: true`,
      `    servername: ${yaml(n.sni || host)}`,
      `    network: ws`,
      `    client-fingerprint: ${yaml(n.fp || 'chrome')}`,
      `    ws-opts:`,
      `      path: ${yaml(path)}`,
      `      headers:`,
      `        Host: ${yaml(host)}`,
    ].join('\n');
  });
  const names = nodes.map(n => yaml(n.name || n.id || 'node')).join(', ');
  return `mixed-port: 7890\nallow-lan: false\nmode: rule\nproxies:\n${proxyLines.join('\n')}\nproxy-groups:\n  - name: AUTO\n    type: select\n    proxies: [${names}]\nrules:\n  - MATCH,AUTO\n`;
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
  if (!quotaOk(user, 0)) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
}

async function checkUserOnly(user, now) {
  if (!user) return { ok: false, error: 'user_not_found' };
  if (user.status !== 'active') return { ok: false, error: 'user_disabled' };
  if (Number(user.expires_at || 0) > 0 && Number(user.expires_at) <= now) return { ok: false, error: 'expired' };
  if (!quotaOk(user, 0)) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
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

async function ensureNodeLimit(env, userId, nodeId, defaultQuota) {
  const now = unix();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO user_node_limits(user_id,node_id,quota_bytes,used_upload,used_download,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)"
  ).bind(userId, nodeId, Number(defaultQuota || 0), 0, 0, now, now).run();
}

async function nodeLimitOf(env, userId, nodeId) {
  return first(env.DB, "SELECT * FROM user_node_limits WHERE user_id=? AND node_id=?", userId, nodeId);
}

async function userDetail(env, id) {
  const user = await first(env.DB, "SELECT * FROM users WHERE id=?", id);
  if (!user) return null;
  user.group_ids = (await all(env.DB, "SELECT group_id FROM user_groups WHERE user_id=?", id)).map(r => r.group_id);
  user.node_limits = await nodeLimitsForUser(env, id);
  return user;
}

async function nodeLimitsForUser(env, userId) {
  return all(env.DB,
    "SELECT n.id node_id,n.name node_name,n.enabled node_enabled,n.default_user_quota_bytes default_quota_bytes," +
    "COALESCE(l.quota_bytes,n.default_user_quota_bytes,0) quota_bytes,COALESCE(l.used_upload,0) used_upload,COALESCE(l.used_download,0) used_download,COALESCE(l.status,'active') status " +
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
  return ['id', 'name', 'address', 'port', 'host', 'sni', 'path', 'fp', 'security', 'type', 'group_id', 'region', 'tags', 'enabled', 'sort_order', 'default_user_quota_bytes', 'created_at', 'updated_at'];
}
function nodeDefaults() {
  return { port: 443, fp: 'chrome', security: 'tls', type: 'ws', enabled: 1, sort_order: 0, default_user_quota_bytes: 0 };
}
function planFields() {
  return ['id', 'name', 'quota_bytes', 'valid_days', 'device_limit', 'speed_limit_bps', 'price_cents', 'currency', 'enabled', 'sort_order', 'created_at', 'updated_at'];
}
function planDefaults() {
  return { quota_bytes: 0, valid_days: 30, device_limit: 0, speed_limit_bps: 0, price_cents: 0, currency: 'CNY', enabled: 1, sort_order: 0 };
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

function quotaOk(row, add) {
  if (!row) return true;
  const total = Number(row.quota_bytes || 0);
  return !total || usedOf(row) + Number(add || 0) <= total;
}
function usedOf(row) {
  return Number(row.used_upload || 0) + Number(row.used_download || 0);
}
function dbVal(k, v) {
  if (k === 'expires_at') return toEpoch(v);
  if (['quota_bytes', 'expires_at', 'device_limit', 'speed_limit_bps', 'price_cents', 'enabled', 'sort_order', 'port', 'default_user_quota_bytes', 'valid_days'].includes(k)) {
    return numOr(v, 0);
  }
  return v === undefined ? null : v;
}
function quotaValue(body, fallback = 0) {
  return 'quota_gb' in body ? gbToBytes(body.quota_gb) : numOr(body.quota_bytes, fallback);
}
function gbToBytes(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1073741824) : 0;
}
function daysToExpiry(days, now) {
  const n = Number(days || 0);
  return n > 0 ? now + Math.floor(n) * DAY : 0;
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
  const defaultProxyHost = env.PROXY_HOST || '111.freelx.net';
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>VLESS 订阅管理</title>
<style>
body{margin:0;font:14px Arial;background:#0f1115;color:#e7e9ee}.wrap{max-width:1180px;margin:auto;padding:20px}input,select,textarea,button{background:#171b22;color:#e7e9ee;border:1px solid #303644;border-radius:6px;padding:9px}textarea{box-sizing:border-box;width:100%;min-height:120px}button{cursor:pointer;background:#23344d}button:hover{background:#2d4364}table{width:100%;border-collapse:collapse;margin:12px 0;table-layout:auto}td,th{border-bottom:1px solid #242a35;padding:8px;text-align:left;vertical-align:top}th{color:#b8c1d1;font-weight:600}section{margin:18px 0;padding:14px;background:#151922;border:1px solid #242a35;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:#171b22;border:1px solid #303644;border-radius:8px;padding:12px}.muted{color:#9aa3b2}.row{display:flex;gap:8px;flex-wrap:wrap}.ok{color:#67e08b}.bad{color:#ff8d8d}.wide{min-width:320px}.mono{font-family:Consolas,monospace;word-break:break-all}.mini{font-size:12px;color:#9aa3b2}.ops button{margin:0 5px 5px 0}pre{white-space:pre-wrap;word-break:break-all;background:#090b0f;padding:10px;border-radius:6px}
</style><div class=wrap><h2>VLESS 订阅管理</h2><section><div class=row><input id=t class=wide placeholder="管理员 Token / ADMIN_TOKEN"><button onclick=save()>保存 Token</button><button onclick=boot()>初始化默认数据</button><button onclick=loadAll()>刷新数据</button></div><p class=muted id=msg></p></section><div class=cards id=sum></div>
<section><h3>创建用户</h3><div class=grid><input id=uemail placeholder="邮箱 / 账号"><input id=uname placeholder="用户名称"><select id=uplan></select><input id=ugroups placeholder="分组 ID，多个用逗号分隔"><input id=uq placeholder="总流量 GB，留空使用套餐"><input id=udays placeholder="到期天数，0 永不过期，留空使用套餐"><input id=udev placeholder="设备并发数"></div><p><button onclick=createUser()>创建用户</button></p></section>
<section><h3>用户列表</h3><div id=users></div></section>
<section><h3>单用户节点流量限制</h3><div class=row><select id=limitUser></select><button onclick=loadNodeLimits()>加载用户节点</button><button onclick=saveNodeLimits()>保存节点上限</button></div><p class=mini>这里设置的是“某个用户在某个节点”的独立 GB 上限。0 表示不限；超过后该用户访问该节点会断开。</p><div id=nodeLimits></div></section>
<section><h3>自定义节点管理</h3><div class=grid><input id=nid placeholder="节点 ID，例如 us-01"><input id=nname placeholder="节点名称"><input id=naddr placeholder="入口地址 / 优选 IP / 域名"><input id=nport placeholder="端口，默认 443"><input id=nhost placeholder="代理 Worker 域名，默认 111.freelx.net"><input id=ngroup placeholder="所属分组 ID，默认 default"><input id=npath placeholder="/node/us-01"><input id=nquota placeholder="默认单用户节点上限 GB，0 不限"><input id=nsort placeholder="排序，数字越小越靠前"><select id=nenabled><option value=1>启用</option><option value=0>禁用</option></select></div><p class=row><button id=nsave onclick=saveNode()>保存节点</button><button onclick=resetNodeForm()>清空表单</button></p><p class=mini>入口地址可以是优选 IP，也可以是域名；Host/SNI 应保持为你的代理 Worker 域名：${defaultProxyHost}。</p><textarea id=nbulk placeholder="批量导入，每行一个：&#10;104.17.147.116:443#US-优选1&#10;104.19.146.223:443#US-优选2&#10;custom-sg,104.18.1.1:443,SG-自定义,default,10"></textarea><p class=row><button onclick=importNodes()>批量导入节点</button></p><div id=nodes></div></section>
<section><h3>套餐和分组</h3><div class=row><input id=pname placeholder="套餐名称"><input id=pquota placeholder="套餐总流量 GB"><input id=pdays placeholder="有效天数，0 永不过期"><button onclick=createPlan()>创建套餐</button><input id=gname placeholder="分组名称"><button onclick=createGroup()>创建分组</button></div><div id=plans></div><div id=groups></div></section>
<section><h3>最近连接</h3><div id=sessions></div></section></div>
<script>
const $=id=>document.getElementById(id),DH=${JSON.stringify(defaultProxyHost)};let userRows=[],nodeRows=[],limitRows=[],editingNode='';const L={users:'用户总数',activeUsers:'正常用户',activeNodes:'启用节点',activeSessions:'在线连接',trafficBytes:'已用流量',email:'账号',name:'名称',status:'状态',plan_name:'套餐',groups:'分组',used:'已用/总量',expire:'到期时间',sub:'订阅链接 / 操作',id:'ID',address:'入口地址',port:'端口',host:'Host',path:'路径',group_id:'分组',enabled:'启用',node_ops:'节点操作',default_user_quota_bytes:'节点默认上限',quota_bytes:'总流量',valid_days:'有效天数',device_limit:'设备数',node_name:'节点',quota_limit:'节点上限',node_used:'节点已用',upload:'上传',download:'下载',reason:'断开原因'};
const api=(p,o={})=>fetch('/api/admin/'+p,{...o,headers:{'content-type':'application/json','authorization':'Bearer '+localStorage.token,...(o.headers||{})}}).then(async r=>{let j=await r.json().catch(()=>({ok:false,error:r.statusText}));if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j});
t.value=localStorage.token||'';function save(){localStorage.token=t.value.trim();msg.textContent='Token 已保存'}function b(x){return (Number(x||0)/1073741824).toFixed(2)+' GB'}function gbv(x){let n=Number(x||0)/1073741824;return n?Number(n.toFixed(3)):0}function dt(x){return x?new Date(x*1000).toLocaleString():'永不过期'}
async function loadAll(){try{msg.textContent='正在加载...';let s=await api('summary');sum.innerHTML=Object.entries(s.data).map(([k,v])=>'<div class=card><b>'+h(L[k]||k)+'</b><br>'+(/Bytes/.test(k)?b(v):h(v))+'</div>').join('');let [us,ns,ps,gs,ss]=await Promise.all([api('users'),api('nodes'),api('plans'),api('groups'),api('sessions')]);userRows=us.data||[];nodeRows=ns.data||[];uplan.innerHTML='<option value="">不绑定套餐</option>'+ps.data.map(p=>'<option value="'+h(p.id)+'">'+h(p.name)+'</option>').join('');fillLimitUsers();users.innerHTML=tbl(userRows,['email','name','status','plan_name','groups','used','expire','sub']);nodes.innerHTML=tbl(nodeRows,['id','name','address','port','host','path','group_id','default_user_quota_bytes','enabled','node_ops']);plans.innerHTML=tbl(ps.data,['id','name','quota_bytes','valid_days','device_limit','enabled']);groups.innerHTML=tbl(gs.data,['id','name']);sessions.innerHTML=tbl(ss.data,['id','email','node_name','status','upload','download','reason']);msg.textContent='数据已刷新';}catch(e){msg.textContent='错误：'+e.message}}
function tbl(rows,cols){if(!rows||!rows.length)return '<p class=muted>暂无数据</p>';return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+cell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function cell(r,c){if(c==='used')return b((r.used_upload||0)+(r.used_download||0))+' / '+(r.quota_bytes?b(r.quota_bytes):'不限');if(c==='expire')return dt(r.expires_at);if(c==='sub'){let u=subUrl(r);return '<div class=mono>'+h(u)+'</div><p class=ops><button onclick="copySub(\\''+r.sub_token+'\\')">复制订阅</button><button onclick="selectLimitUser(\\''+r.id+'\\')">节点限额</button><button onclick="resetU(\\''+r.id+'\\')">重置流量</button></p>'}if(c==='node_ops')return '<span class=ops><button onclick="editNode(\\''+h(r.id)+'\\')">编辑</button><button onclick="toggleNode(\\''+h(r.id)+'\\','+(r.enabled?0:1)+')">'+(r.enabled?'禁用':'启用')+'</button><button onclick="copyPath(\\''+h(r.path||('/node/'+r.id))+'\\')">复制路径</button></span>';if(c==='upload')return b(r.upload_bytes);if(c==='download')return b(r.download_bytes);if(c==='reason')return h(r.close_reason||'');if(c==='enabled')return r.enabled?'<span class=ok>是</span>':'<span class=bad>否</span>';if(c==='default_user_quota_bytes'||c==='quota_bytes')return r[c]?b(r[c]):'不限';if(c==='valid_days')return Number(r[c]||0)?h(r[c]):'永不过期';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function subUrl(r){return location.origin+'/sub/'+r.sub_token}
async function copySub(tok){let u=location.origin+'/sub/'+tok;await navigator.clipboard.writeText(u);msg.textContent='订阅链接已复制：'+u}
async function resetU(id){await api('users/'+id+'/reset-usage',{method:'POST'});msg.textContent='流量已重置';loadAll()}
async function createUser(){await api('users',{method:'POST',body:JSON.stringify({email:uemail.value,name:uname.value,plan_id:uplan.value,group_ids:ugroups.value.split(',').map(x=>x.trim()).filter(Boolean),quota_gb:uq.value||undefined,valid_days:udays.value===''?undefined:udays.value,device_limit:udev.value||undefined})});msg.textContent='用户已创建';loadAll()}
function fillLimitUsers(){limitUser.innerHTML=userRows.map(u=>'<option value="'+h(u.id)+'">'+h((u.email||u.name||u.id)+' ｜ '+u.id)+'</option>').join('');if(!limitRows.length)nodeLimits.innerHTML='<p class=muted>请选择用户后加载节点限额。</p>'}
async function selectLimitUser(id){limitUser.value=id;await loadNodeLimits();document.getElementById('nodeLimits').scrollIntoView({behavior:'smooth',block:'start'})}
async function loadNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先创建或选择用户';let res=await api('users/'+id+'/node-limits');limitRows=res.data||[];nodeLimits.innerHTML=limitRows.length?nodeLimitTable(limitRows):'<p class=muted>暂无节点。</p>';msg.textContent='已加载该用户的节点限额'}
async function saveNodeLimits(){let id=limitUser.value;if(!id)return msg.textContent='请先选择用户';let limits=limitRows.map(r=>({node_id:r.node_id,quota_gb:$(limId(r.node_id)).value||0,status:$('st_'+limId(r.node_id)).value||'active'}));await api('users/'+id+'/node-limits',{method:'PATCH',body:JSON.stringify({limits})});msg.textContent='用户节点限额已保存';loadNodeLimits()}
function nodeLimitCell(r,c){if(c==='quota_limit')return '<input id="'+limId(r.node_id)+'" value="'+gbv(r.quota_bytes)+'" placeholder="GB，0 不限">';if(c==='node_used')return b((r.used_upload||0)+(r.used_download||0));if(c==='status')return '<select id="st_'+limId(r.node_id)+'"><option value=active '+(r.status==='active'?'selected':'')+'>启用</option><option value=disabled '+(r.status==='disabled'?'selected':'')+'>禁用</option></select>';return '<span class=mono>'+h(r[c]??'')+'</span>'}
function nodeLimitTable(rows){let cols=['node_id','node_name','quota_limit','node_used','status'];return '<table><tr>'+cols.map(c=>'<th>'+h(L[c]||c)+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+nodeLimitCell(r,c)+'</td>').join('')+'</tr>').join('')+'</table>'}
function limId(v){return 'lim_'+String(v).replace(/[^a-zA-Z0-9_-]/g,'_')}
function nodeBody(){let id=safeId(nid.value||nname.value||naddr.value);nid.value=id;let host=(nhost.value||DH).trim();return{id,name:nname.value||id,address:naddr.value.trim(),port:Number(nport.value||443),host,sni:host,path:npath.value||('/node/'+id),group_id:ngroup.value||'default',default_user_quota_gb:Number(nquota.value||0),sort_order:Number(nsort.value||0),enabled:Number(nenabled.value)}} 
async function saveNode(){let b=nodeBody();if(!b.id||!b.address)throwMsg('节点 ID 和入口地址不能为空');if(editingNode){await api('nodes/'+editingNode,{method:'PATCH',body:JSON.stringify(b)});msg.textContent='节点已更新'}else{await api('nodes',{method:'POST',body:JSON.stringify(b)});msg.textContent='节点已创建'}resetNodeForm();loadAll()}
function editNode(id){let r=nodeRows.find(x=>x.id===id);if(!r)return;nid.value=r.id;nname.value=r.name||'';naddr.value=r.address||'';nport.value=r.port||443;nhost.value=r.host||DH;ngroup.value=r.group_id||'default';npath.value=r.path||('/node/'+r.id);nquota.value=gbv(r.default_user_quota_bytes);nsort.value=r.sort_order||0;nenabled.value=r.enabled?1:0;editingNode=id;nsave.textContent='保存修改';msg.textContent='正在编辑节点：'+id;scrollTo({top:0,behavior:'smooth'})}
function resetNodeForm(){editingNode='';for(const x of [nid,nname,naddr,nport,nhost,ngroup,npath,nquota,nsort])x.value='';nenabled.value=1;nsave.textContent='保存节点'}
async function toggleNode(id,en){await api('nodes/'+id,{method:'PATCH',body:JSON.stringify({enabled:en})});msg.textContent=en?'节点已启用':'节点已禁用';loadAll()}
async function copyPath(p){await navigator.clipboard.writeText(p);msg.textContent='节点路径已复制：'+p}
async function importNodes(){let lines=nbulk.value.replace(/\\r/g,'').split('\\n').map(x=>x.trim()).filter(Boolean);let ok=0;for(const line of lines){let n=parseNodeLine(line,ok+1);if(!n)continue;try{let exists=nodeRows.some(x=>x.id===n.id);await api(exists?('nodes/'+n.id):'nodes',{method:exists?'PATCH':'POST',body:JSON.stringify(n)});ok++}catch(e){msg.textContent='导入失败：'+line+' '+e.message;return}}msg.textContent='已导入 '+ok+' 个节点';nbulk.value='';loadAll()}
function parseNodeLine(line,i){let a=line.split(',').map(x=>x.trim());let id='',addr='',name='',group='default',quota=0;if(a.length>=3){id=safeId(a[0]);addr=a[1];name=a[2];group=a[3]||'default';quota=Number(a[4]||0)}else{let h=line.indexOf('#');addr=(h>=0?line.slice(0,h):line).trim();name=(h>=0?line.slice(h+1):'自定义节点-'+i).trim();id=safeId(name||addr)}let p=parseAddr(addr),host=DH;return p.address?{id,name:name||id,address:p.address,port:p.port||443,host,sni:host,path:'/node/'+id,group_id:group||'default',default_user_quota_gb:quota,sort_order:50+i,enabled:1}:null}
function parseAddr(v){if(!v)return{};if(v[0]=='['){let m=v.match(/^\\[([^\\]]+)\\](?::(\\d+))?$/);if(m)return{address:m[1],port:Number(m[2]||443)}}let i=v.lastIndexOf(':');return i>0&&/^\\d+$/.test(v.slice(i+1))?{address:v.slice(0,i),port:Number(v.slice(i+1))}:{address:v,port:443}}
function safeId(v){return String(v||'node').toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||('node-'+Date.now())}
function throwMsg(t){msg.textContent=t;throw new Error(t)}
async function createPlan(){let id=pname.value.toLowerCase().replace(/[^a-z0-9]+/g,'-')||('plan-'+Date.now());await api('plans',{method:'POST',body:JSON.stringify({id,name:pname.value,quota_gb:pquota.value||0,valid_days:pdays.value||0})});msg.textContent='套餐已创建';loadAll()}
async function createGroup(){let id=gname.value.toLowerCase().replace(/[^a-z0-9]+/g,'-')||('group-'+Date.now());await api('groups',{method:'POST',body:JSON.stringify({id,name:gname.value})});msg.textContent='分组已创建';loadAll()}
async function boot(){let proxy=prompt('请输入代理 Worker 域名，例如 proxy.example.com');if(!proxy)return;await api('bootstrap',{method:'POST',body:JSON.stringify({proxy_host:proxy,create_demo_user:true})});msg.textContent='默认数据已初始化';loadAll()}
function h(v){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
loadAll();
</script>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
