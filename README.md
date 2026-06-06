# Cloudflare Snippets VLESS

最新的文件已经更新了 Joey 的 2.9.8 版本。

加入 TCP 建连超时：8000ms，避免卡在坏连接上。
加入首包超时：3500ms，远端握手后迟迟没数据会触发 fallback。
上行改成持久 writer + 限额队列，减少 Android/v2rayNG 抖动时的 read/write closed on pipe。
下行改成 BYOB reader 优先读取，减少内存复制和 GC 压力。
写 socket 前统一转成 Uint8Array，更贴近 Cloudflare TCP sockets 文档要求。
为了塞进 32KB，把根路径首页压缩成简单 ok，订阅页和代理核心还在。
加入 2 路连接竞速：主连接先跑，180ms 后 fallback/ProxyIP 参与竞速，谁先连上用谁。
增强上传队列：按 16KB 切片，最大 256KB 队列，避免 writer 抢锁和大包一次性写入。
队列改成索引读取，减少长连接下 shift() 带来的 CPU 浪费。
保留首包超时、TCP 超时、BYOB 下行读取。
默认路径为llr,删除了之前我自己加上去的ech功能
(部署用min后缀的混淆版,人家还是2.9版本,已经四个多月不维护了,我直接充当维护大师替作者更新好吧)
但是生成订阅格式只有base64，正常也够用

## 当前项目对应文件

详细对应关系见 `PROJECTS.md`。

| 项目 | 域名 | 部署用混淆版 |
| --- | --- | --- |
| 111 | 111.freelx.net | `projects/111-us-managed-current.min.js` |
| 222 | 222.freelx.net | `projects/222-us-region-current.min.js` |
| 333 | 333.freelx.net | `projects/333-hk-region-current.min.js` |
| 444 | 444.freelx.net | `projects/444-us-light-current.min.js` |

222 当前使用 `/r/US/` 地区路径版本，保留 512KB 上传队列。

## Cloudflare Snippets 部署教程

### 1. 准备域名

1. 将域名添加到 Cloudflare，并确保域名处于 Cloudflare 托管状态。
2. 在 DNS 页面添加一个 A 记录，例如 `222.example.com`，IPv4 地址可暂填 `192.0.2.1`。
3. 开启橙色云朵。不要把 CNAME 指向自身，以免形成解析循环。

### 2. 选择脚本

进入本仓库的 `projects` 目录，按照上表选择对应的 `.min.js` 文件。`.min.js` 是部署用混淆版，`.txt` 是便于 GitHub 在线预览的同内容副本。

自行新建项目时，推荐从以下文件选择：

- 普通 US 地区版：`projects/222-us-region-current.min.js`
- HK 地区版：`projects/333-hk-region-current.min.js`
- 轻量管理订阅版：`projects/444-us-light-current.min.js`

部署前至少修改脚本开头的 UUID。UUID 必须保持标准 V4 格式，例如：

```text
f6eddc57-0f54-4705-bf75-cfd646d98c06
```

可以使用浏览器控制台生成：

```js
crypto.randomUUID()
```

### 3. 创建 Snippet

1. 登录 Cloudflare 控制台。
2. 进入对应域名的控制台。
3. 打开 `Rules` -> `Snippets`。
4. 创建一个 Snippet，名称可设为 `222`。
5. 将所选 `.min.js` 文件的全部内容粘贴到编辑器。
6. 保存 Snippet。

如果控制台支持文件上传，也可以直接上传 `.min.js`。脚本必须作为 ES Module 部署，并保留：

```js
import { connect } from "cloudflare:sockets";
export default { async fetch(request) { /* ... */ } };
```

### 4. 添加 Snippet 规则

为 Snippet 添加主机名匹配规则。以 `222.example.com` 为例：

```text
(http.host eq "222.example.com")
```

规则需要：

- `Snippet` 选择刚创建的 `222`
- `Enabled` 保持开启
- 一个域名只绑定到一个代理 Snippet

保存规则后等待数秒，访问：

```text
https://222.example.com/
```

正常应返回：

```text
ok
```

如果出现 1101，不要反复覆盖正在运行的 Snippet。按以下顺序恢复：

1. 暂时清空或禁用全部 Snippet 规则。
2. 删除异常 Snippet。
3. 使用正确的 `.min.js` 重新创建 Snippet。
4. 最后一次性恢复全部规则。

### 5. 获取订阅

默认订阅页面路径为：

```text
https://222.example.com/llr
```

默认 Base64 订阅地址为：

```text
https://222.example.com/llr/sub
```

也可以附带自定义优选 IP：

```text
https://222.example.com/llr/sub?ips=104.17.147.116:443%23优选1,104.19.146.223:443%23优选2
```

将订阅地址导入 v2rayNG。TLS 的 `Host` 和 `SNI` 必须保持为你的 Snippet 域名，不能改成优选 IP。

### 6. 部署管理端

管理端位于 `cf-vless-manager` 目录，需要 Node.js 18 或更高版本。

安装并登录 Wrangler：

```powershell
npm install -g wrangler
wrangler login
```

创建 D1 数据库：

```powershell
cd cf-vless-manager
wrangler d1 create cf-vless-manager
```

将命令返回的 `database_id` 和你的 Cloudflare `account_id` 写入 `wrangler.jsonc`，同时把：

```json
"PROXY_HOST": "your-snippet-domain.example.com"
```

改为你的 Snippet 域名。

初始化数据库：

```powershell
wrangler d1 execute cf-vless-manager --remote --file .\schema.sql
```

设置管理密码和 Snippet API Token：

```powershell
wrangler secret put ADMIN_PASSWORD
wrangler secret put CF_SNIPPET_TOKEN
```

如需使用管理端“一键重启”，还要在 `wrangler.jsonc` 的 `vars` 中设置你的 Zone ID：

```json
"SNIPPET_ZONE_ID": "你的 Zone ID"
```

部署管理端：

```powershell
wrangler deploy
```

部署后访问：

```text
https://你的管理端域名/admin
```

建议给管理 Worker 绑定独立自定义域名，例如 `admin.example.com`。

### 7. 注意事项

- 不要把 API Token、管理密码、Account ID 或 D1 数据库 ID 提交到公开仓库。
- 普通 222/333 Snippet 的代理数据通道不依赖管理端，管理端离线不会直接拖慢已有连接。
- 修改地区会改变 ProxyIP 出口路线，可能改变延迟和实际访问地区。
- Snippet 更新后不需要频繁刷新订阅；只有节点地址、路径或地区发生变化时才重新订阅。
- 建议先用新测试域名验证，再替换长期使用的项目。
