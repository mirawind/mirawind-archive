# Mirawind Library

Mirawind 是一个自托管、单管理员的语义化在线图书馆。当前出版闭环接受“一本书一个
MinerU v2 JSON ZIP”，在后台安全解包、生成结构化工作稿、构建阅读预览并建立搜索索引，再以不可变
版本原子发布；读者可以从 `/library` 浏览当前公开版本、查看 `/books/:bookKey`
详情，再进入带目录、提纲、搜索、下载和移动抽屉的阅读器。读者请求始终读取已经
发布的版本。管理员还可以在私有书库中永久删除单本图书；接受后立即隐藏并由 worker
清理，没有回收站或恢复入口。

当前架构固定为一台 Linux 主机、一个 Astro Web 进程、一个同代码库 worker、
SQLite WAL 和本地持久化存储。不要横向扩容 Web/worker，也不要自行加入 Redis、
另一种数据库或对象存储。

## 快速开始

开发环境需要 Node.js 24、pnpm 11.9 和带 FTS5 trigram 的 SQLite（项目使用
`better-sqlite3` 自带版本）。

### 本地 Docker 一键启动

只安装 Docker Engine 和 Compose plugin 即可：

```bash
./docker/local.sh
```

第一次运行会创建权限为 `0600` 的本地 `.env`、构建镜像、初始化 Docker
volume、执行迁移，并在当前终端安全询问管理员邮箱、显示名称和备用密码。以后
再次运行同一命令会保留管理员、图书和已发布版本并直接启动。

打开 <http://localhost:4321/manage>。本地 Docker 启动器使用现有唯一管理员身份，不要求
Passkey、备用密码或登录 Cookie。常用管理命令：

```bash
./docker/local.sh status
./docker/local.sh logs
./docker/local.sh stop
```

本地启动仍保持一个 Web 进程和一个独立 worker 进程，只是由一个 Compose
项目统一管理；浏览器只能通过回环地址访问。生产部署继续使用下方经过 Caddy
保护的 HTTPS 拓扑。

### 本机 Node.js 启动

```bash
corepack enable
pnpm install --frozen-lockfile
cp -n .env.example .env
pnpm dev
```

默认打开 <http://127.0.0.1:4322/manage>。源码开发数据保存在 Git 忽略的
`data/library`；首次运行初始化当前数据库基线并建立仅供 loopback 开发信任使用的本地管理员，
不需要登录或输入密码。已有 `.env` 时保留原文件；首次配置需设置随机 `MIRAWIND_AUTH_SECRET`。
开发和生产共用 `.env` 中同一组变量：`MIRAWIND_DATA_DIR` 指定数据目录，
`MIRAWIND_PUBLIC_ORIGIN` 指定地址与端口。部署时修改对应的值即可。

保持此终端运行；按 `Ctrl+C` 同时停止 Web 和 worker。启动成功会输出
`Mirawind development ready`，此时 worker 已就绪。重复启动或端口占用会明确报错。

`pnpm dev:web` 和 `pnpm dev:worker` 仅用于定向调试。只运行 `dev:web` 时上传任务没有
消费者，会保持排队，而且两个诊断命令都要求调用者提供完整环境配置，因此不要把它们
作为日常启动方式。

普通 `pnpm dev` 和 `docker/local.sh` 都显式启用受 loopback 条件约束的本地开发信任；打开
`/manage` 不需要登录。单独运行 `dev:web` 不会隐式获得该身份。`test`、production 和远程
Compose 永远忽略本地标记并继续使用正式认证。

正式部署登录后在受信任设备保持 90 天，并在有活动时每 7 天滚动刷新；Passkey
敏感操作仍要求最近 5 分钟认证。

生产环境推荐 Docker Compose：

```bash
docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm data-init
docker compose -f docker/compose.yaml run --rm migrate
docker compose -f docker/compose.yaml run --rm --no-deps web \
  node dist/processes/cli/index.js admin bootstrap \
  --data-dir /var/lib/mirawind
docker compose -f docker/compose.yaml up -d
```

先在 `.env` 中设置真实 HTTPS 域名、RP ID、允许的主机名和至少 32 字节的随机
认证密钥。首次启动的 `data-init` 和 `migrate` 是一次性服务；长期运行的只有
Web、worker 和 Caddy。

## 验证

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm benchmark:library --output-json docs/audits/m2a-library-performance.json \
  --output-markdown docs/audits/m2a-library-performance.md
```

真实 MinerU 3.4.4 样本放在 Git 与 Docker 构建上下文都忽略的
`tests/fixtures/mineru/real/`，通过不含书名的清单登记并校验哈希：

```bash
pnpm fixtures:verify-real --dir "$PWD/tests/fixtures/mineru/real"
MIRAWIND_REAL_FIXTURE_DIR="$PWD/tests/fixtures/mineru/real" pnpm test:e2e
```

## 文档

- [产品规格](docs/product/product-spec.md)
- [决策日志](docs/decisions/decision-log.md)
- [当前运行架构](docs/architecture/m1-architecture.md)
- [结构化正文与保存协议](docs/architecture/structured-content-ir.md)
- [本轮重构验收](docs/operations/content-refactor-acceptance.md)
- [运行配置](docs/operations/configuration.md)
- [部署与升级](docs/operations/deployment.md)
- [恢复与事故处理](docs/operations/recovery.md)
- [当前接口与历史规格索引](specs/README.md)

SQLite 的 `book_documents` 和 `book_blocks` 是工作稿权威，`book_nodes` 定位嵌套块。
所有 block 编辑统一按 ID 读写所属根块；结构变化只补充读取标题上下文，元数据／编号模式
不读取正文。`updated_at` 是保存冲突标识。保存事务完成即返回成功，预览
在后台合并构建；未变化页面可以复用已验证 HTML。图片和原始 ZIP 每书只保存一份。
`book.json` 仅存在于不可变构建快照中，预览与发布共用构建 ID；SQLite 的
`current_version_id` 是唯一发布指针。旧数据库不得原地升级，D-141 使用获批的数据重置。

在 DBeaver 连接 `data/library/db/mirawind.sqlite`，可直接查看正文：

```sql
SELECT id, ordinal, type, content_json
FROM book_blocks
WHERE book_id = 1
ORDER BY ordinal;
```

不要直接修改运行中的表；通过工作台保存才能执行语义校验、冲突检查和预览调度。
