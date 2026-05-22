最新的文件已经更新了joey的2.9.8的
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
