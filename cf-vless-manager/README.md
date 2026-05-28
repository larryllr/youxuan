# CF VLESS Manager

这是给现有 `snippets-v2rayng-stable` 代理脚本配套的控制端。它把“卖订阅”需要的管理功能放到独立 Cloudflare Worker 里，代理脚本只负责转发、鉴权和上报流量。

## 已包含功能

- 管理面板：`/admin`
- 用户管理：UUID、订阅 token、状态、到期时间、总流量、设备并发数
- 套餐管理：流量、有效期、设备数、价格字段
- 节点管理：节点地址、Host/SNI、WS path、分组、单用户节点流量上限
- 订阅生成：`/sub/<sub_token>` 输出 v2rayNG base64，`?format=raw` 输出明文，`?format=clash` 输出 Clash Meta
- 订阅分组：用户绑定分组后只看到对应分组节点；不绑定分组则可见全部启用节点
- 到期自动断网：代理端连接时调用 `/api/edge/open`
- 超量自动断网：代理端按流量块调用 `/api/edge/usage`
- 单节点流量控制：`user_node_limits` 按用户和节点单独统计/限制
- 会话记录：`sessions`
- 每日流量统计：`usage_daily`
- 订单表预留：`orders`，后续可接支付 webhook

## 部署

1. 创建 D1：

```powershell
npx wrangler d1 create cf-vless-manager
```

2. 把返回的 `database_id` 写进 `wrangler.jsonc`。

3. 初始化数据库：

```powershell
npx wrangler d1 execute cf-vless-manager --remote --file .\schema.sql
```

4. 设置密钥：

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put EDGE_SECRET
```

`ADMIN_TOKEN` 用于登录面板；`EDGE_SECRET` 要和受控版 snippets 里的 `managerSecret` 一致。

5. 修改 `wrangler.jsonc` 的 `PROXY_HOST` 为你的 snippets 代理域名，例如：

```json
"PROXY_HOST": "your-snippets-worker.workers.dev"
```

6. 部署：

```powershell
npx wrangler deploy
```

7. 打开：

```text
https://cf-vless-manager.<你的 workers.dev 子域>/admin
```

输入 `ADMIN_TOKEN`，点 `Bootstrap`，填你的 snippets 代理域名，会自动创建默认分组、套餐、Native 节点、Custom 节点和演示用户。

## 和 snippets 配合

受控版代理脚本需要配置：

```js
const managerUrl = 'https://你的管理端域名';
const managerSecret = '和 EDGE_SECRET 相同';
```

管理端生成的订阅链接会把 WS path 写成：

```text
/node/<node_id>
```

代理端从 path 里识别节点 ID，从 VLESS 首包里识别用户 UUID，然后调用管理端：

- `/api/edge/open`：连接前检查用户是否可用、是否到期、是否超量、节点是否允许、并发是否超过
- `/api/edge/usage`：连接中上报上传/下载流量，超过总流量或单节点流量时立即让代理端断开
- `/api/edge/close`：连接关闭后记录原因

## 重要说明

- 这个控制端只能控制接入了它的受控版 snippets。旧版没有鉴权/记账钩子的代理脚本无法被外部 Worker 强制断网。
- 支付没有写死某个平台。建议后续新增 `/api/payment/<provider>/webhook`，支付成功后更新 `orders` 和 `users.expires_at/quota_bytes/status`。
- `speed_limit_bps` 字段已经预留，但当前受控 snippets 以“超量断开”为主，不做实时限速；实时限速会增加代理脚本体积和延迟。
