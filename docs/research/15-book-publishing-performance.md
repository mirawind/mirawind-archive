# 15 本真实书出版性能基线与瓶颈

## 状态与结论边界

- 状态：15 本单次分段基线已完成，15/15 构建、预览和发布成功；内容正确性
  comparator 已在测量后重跑并保持 15/15 exact、零差异。
- 范围：MinerU ZIP 从后台分析到草稿准备、预览构建和首次发布的完整链路；阅读
  HTTP 延迟保留为并发安全门禁，不作为构建耗时的一部分。
- 数据原则：本文只引用已保存的端到端结果和 monotonic stage profile。没有采集的
  decoded pixels、Sharp 队列和 SQLite 内部分段不作推断。
- 样本原则：15 本 reference v2 继续承担内容正确性精确门禁。新增的 15 本性能
  采样是诊断集，不替代现有 97/441/583 页真实书加 500 页合成书的正式性能门禁，
  也不允许为了提速改写 reference。

基线确认慢点主要在内容处理而不是 SQLite。15 本总 wall 为 `901.234 s`；准备草稿
占已 profile job wall 的 `47.8%`。预览和发布各自重复的 configured-document 编译合计
`259.021 s`，占全部 stage wall 的 `31.4%`；准备阶段的 source-region 应用为
`116.988 s`，占 `14.2%`。图片检查和预览/发布资源复制合计 `26.169 s`，不是当前
第一优化目标。

这是一轮诊断基线，不是候选优化的 A/B 结果。每本只跑一次，使用独立新 data root，
但没有清空或控制 Linux page cache，也没有随机化顺序。14 本来自同一次顺序执行；其中
一本暴露嵌套 Part/Chapter 的非法显式 role，修复后单独完整重跑。该一行正确性修复只触发
此前失败的嵌套分支；其余 14 本原运行均已通过配置验证。后续优化百分比必须用同机交替
多次运行得出，不能与这轮单样本直接相减。

## 当前基准实际测了什么

`scripts/benchmarks/build.ts` 的 `benchmarkFixture()` 在全新的 data root 中：

1. 初始化存储和数据库；
2. 流式保存上传；
3. 启动 worker；
4. 等待 `analyze_import`；
5. 必要时确认唯一 Markdown 候选；
6. 等待 `prepare_draft` 和对应 `build_preview`；
7. 创建并等待 `build_publish`；
8. 读取发布 manifest、数据库大小和进程树 RSS。

因此现有 `timings.wall_ms` 从 data-root 初始化之前开始，到发布完成和结果采集之后
结束。它包含初始化、worker 启停、轮询间隔和 job 间调度空隙，不等于四个 job 时长之和。
`phases.*.duration_ms` 则由数据库中的 `startedAtMs`、`finishedAtMs` 相减，只能分到 job
粒度。进程树 RSS 每 25 ms 采样；child profile
另有阶段 heap/RSS 峰值，但尚未采集 external、ArrayBuffer、图片解码像素或 Sharp 队列。
当前脚本返回的 FTS 明细仍是 `null`，因此本文
不作图片内存或 SQLite/FTS 内部归因。

## 源码已经证明的重复工作

以下是执行事实，不是耗时归因。

### 1. ZIP 至少解压两次

`analyze_import` 为候选发现解压归档
（`src/jobs/handlers/analyze-import.ts:53-88`）；随后 `prepare_draft` 又从原上传 ZIP
解压到自己的 staging（`src/jobs/handlers/prepare-draft.ts:125-149`）。第一次 job 的
staging 不能被第二次 job 直接复用。本轮已分别记录两次解压的 wall、CPU 和归档计数；
两次累计 `52.054 s`，占全部 stage wall `6.31%`。

### 2. 图片最多经过三次完整校验

准备阶段逐资源 `readFile()` 并调用 `inspectRasterImage()`
（`src/jobs/handlers/prepare-draft.ts:155-168`）；预览再次逐资源读、校验并写入预览资产
（`src/jobs/handlers/build-preview.ts:251-267`）；发布又重复同样的读取和校验，再写入版本
资产（`src/compiler/version-builder.ts:313-335`）。

`inspectRasterImage()` 先 `Buffer.from(input.bytes)`，然后做 metadata 读取，再以
`.toColorspace("srgb").raw().toBuffer()` 完整解码
（`src/compiler/resources/images.ts:135-189`）。Node 官方说明从现有 Buffer/Uint8Array
创建 `Buffer.from(...)` 会产生新的 Buffer；Sharp 官方说明 `raw()` 输出未压缩像素，
`toBuffer()` 返回整个输出 Buffer。因此压缩输入、输入副本和完整 raw 输出可能同时存活。
这使图片路径成为 2.0 GiB 峰值和 wall time 的首要测量对象，但在采集每张图的像素量、
解码时长及阶段 RSS 前，不能称它为已确认瓶颈。

### 3. 预览和发布重复语义编译与逐页渲染

预览从 Markdown 重新调用 `prepareConfiguredDocument()`，解析、规范化、应用 source
region、验证配置、编号和拆页（`src/jobs/handlers/build-preview.ts:232-250`；
`src/compiler/document/configured-document.ts:105-200`），然后对全部页面运行语义渲染
（`src/jobs/handlers/build-preview.ts:307-383`）。发布重新执行同一语义模型
（`src/compiler/version-builder.ts:244-267`）并再次逐页渲染
（`src/compiler/version-builder.ts:369-452`）。

两者的资源 URL 和外层壳不同，所以不能直接复用预览 HTML；但版本固定、URL 无关的语义
模型或渲染中间结果是否能安全复用，是值得验证的优化假设。任何复用都必须继续校验 source
hash、config revision、compiler/renderer identity 和 semantic digest，不能削弱预览与发布
一致性或不可变发布边界。

### 4. 文件复制、哈希和持久化存在多轮全树扫描

准备固化 source snapshot 时逐文件复制、SHA-256、文件 `sync()`，并同步每层目录
（`src/services/source-snapshot.ts:93-160,236-303`）。发布随后再次复制 source tree，复制后
逐文件哈希（`src/compiler/version-builder.ts:180-202,280-311`），生成 `version.json` 前又
遍历并哈希版本内全部文件（`src/compiler/version-builder.ts:204-223,495-518`）。最终固化
在 rename 前再次全树哈希校验并逐文件 `sync()`
（`src/storage/finalize-version.ts:30-99,101-155`）。

这些扫描服务于恶意输入防护、完整性和断电恢复，不能简单删除。新测量必须把 copy、hash、
file fsync、directory fsync、closure validation 和 rename 分开，才能判断是存储吞吐、
元数据数量还是冗余读取占主导。

### 5. SQLite/FTS 已具备关键批处理边界

SQLite 连接已经使用 WAL、`synchronous=FULL` 并关闭自动 checkpoint
（`src/db/connection.ts:27-38`）；worker 使用 PASSIVE checkpoint
（`src/worker/checkpoint.ts:69-101`）。版本、展示投影和全部 FTS/short rows 已在同一个
`BEGIN IMMEDIATE` 事务中登记和校验（`src/db/repositories/versions.ts:127-200`；
`src/db/repositories/search-index.ts:34-99`）。因此“打开 WAL”或“给 INSERT 加事务”不是
剩余优化。旧 583 页记录中的 FTS 构建只有 247 ms，也不支持当前优先改 FTS；仍需在当前
HEAD 重新测量 spool 生成、文件读写、JSON 解析、数据库插入与校验的各自耗时。

## 15 本测量设计

### 固定环境

每轮报告必须记录：

- commit、dirty 状态、lockfile SHA-256、Node/pnpm/SQLite/better-sqlite3/Sharp/libvips/
  unified/remark/rehype/KaTeX 版本；
- 内核、文件系统类型、挂载选项、CPU 型号/逻辑核数、RAM、容器限额；
- `UV_THREADPOOL_SIZE`、`MALLOC_ARENA_MAX`、`sharp.concurrency()`、`sharp.cache()`；
- 15 个 ZIP 的不透明 fixture ID、SHA-256、压缩/解压字节、条目数、Markdown 字节、
  sidecar 行数、PDF 页数、引用资源数、总压缩图片字节、总解码像素、最终页面/块数；
- 是否发生 PDF native-text fallback、OCR fallback、OCR 页数和工具版本。

真实内容、书名和路径不得写入跟踪报告。fixture ID 只使用 manifest 中的安全代号。

### 运行协议

1. 先验证全部 fixture hash 和 reference v2 exact，确认输入与正确性基线未变。
2. 为每本书使用独立的新 data root；构建顺序随机化并保存随机种子。
3. 每本至少执行一次基线采样。后续 A/B 必须在同一机器、同一电源模式、无其他重负载时
   交替运行 baseline/candidate，不能把不同日期的一次性结果直接相减。
4. 每次运行都保留单独的 JSON。失败、取消、OCR 降级和诊断数量属于结果，不能只统计成功
   样本。
5. 报告冷/热状态。仅使用新 data root 不等于清空 Linux page cache；若没有受控清缓存权限，
   应明确写作“新数据根、OS cache 未控制”，不能声称纯冷启动。
6. 每个候选优化至少运行三组交替样本；报告中位数、最小/最大和变异系数。15 本汇总同时
   报告总 wall、每本分布和按输入规模归一化的速率，不能只展示最快或最慢一本。
7. 每次 A/B 后重新运行 15/15 reference exact、恶意图片/ZIP、取消清理、版本 crash boundary、
   preview/publication parity 和并发阅读门禁。

### 计时口径

runner 用 `performance.now()` 记录上传、accepted -> preview、publish -> public 和完整 wall。
worker child 在四类 job 的顺序 stage 边界使用同一 monotonic clock，并记录：

- stage/job 的 `duration_ms` 与成功/失败状态；
- `process.resourceUsage()` 的 user/system CPU 和 fs read/write operation delta；
- `performance.eventLoopUtilization()` delta；
- `process.memoryUsage()` 的 RSS/heapUsed 峰值；
- Linux `/proc/self/io` 的实际 storage read/write bytes；
- archive、Markdown、block、heading、layout、PDF、resource、page 和 search 行计数。

父进程另以 25 ms 周期采样完整 worker 进程树 RSS。当前没有 upload 内部 span、cleanup、
external/ArrayBuffer、decoded pixels、Sharp queue/cache、SQLite transaction/FTS/checkpoint 内部
span，因此本文不对这些未测边界作耗时或内存归因。CPU 高于 wall 可能来自原生并行线程；
单一指标不能独立证明因果。

### 基线结果

`preview` 是上传被接受到对应 revision 预览 ready；`publish` 是发布任务创建到公开版本
指针切换。四个 job 列使用 child 内 monotonic profile，`wall` 还包含初始化、上传、worker
启动、轮询和父进程收尾。RSS 是 25 ms 采样的 worker 进程树峰值。

| Fixture      | PDF 页 | analyze s | prepare s | preview job s | publish job s | preview s | publish s | wall s | peak MiB |
| ------------ | -----: | --------: | --------: | ------------: | ------------: | --------: | --------: | -----: | -------: |
| b309a572298b |    441 |      1.98 |      8.26 |          5.83 |          6.48 |     18.41 |      8.42 |  26.97 |      828 |
| e80477ff22ac |     97 |      0.11 |      1.07 |          0.14 |          0.20 |      3.14 |      1.61 |   4.76 |      385 |
| a53faf7243d4 |    583 |      2.90 |     23.88 |         22.29 |         23.13 |     51.84 |     25.98 |  77.95 |    2,159 |
| c281a6b52bad |    775 |      2.01 |     30.43 |         15.36 |         16.32 |     50.23 |     18.86 |  69.27 |      978 |
| 4b6c91d92933 |    492 |      1.01 |     20.08 |          6.89 |          7.83 |     29.96 |      9.93 |  40.00 |      886 |
| 106e479f6de4 |    764 |      2.32 |     21.54 |         11.40 |         12.74 |     37.84 |     15.14 |  53.07 |    1,129 |
| f9a0242dda39 |    448 |      0.55 |      7.62 |          1.76 |          2.10 |     11.88 |      3.81 |  15.76 |      637 |
| 181a379453c5 |    114 |      0.27 |      1.11 |          0.86 |          1.00 |      4.05 |      2.51 |   6.58 |      511 |
| 0c3fbf8d3e51 |    341 |      1.53 |     15.90 |         10.35 |         11.66 |     30.17 |     13.85 |  44.11 |    1,208 |
| 81d6969edaf0 |  1,278 |      2.25 |     46.78 |         25.16 |         26.98 |     76.68 |     29.99 | 106.85 |    1,034 |
| f99d023f60c5 |    553 |      2.20 |     22.86 |         11.58 |         12.59 |     39.34 |     14.96 |  54.42 |    1,134 |
| 1e3cb4f35a88 |    801 |      6.08 |     67.22 |         22.30 |         26.07 |     99.35 |     29.70 | 129.97 |    1,328 |
| f840921d3c8d |    794 |      3.73 |     64.74 |         38.30 |         40.07 |    109.69 |     43.22 | 153.23 |    1,772 |
| 4f198291b7be |    503 |      1.48 |     18.78 |          7.87 |          8.76 |     30.35 |     10.93 |  41.42 |      671 |
| 48f953e9a97e |    599 |      3.47 |     44.46 |         10.57 |         12.48 |     61.41 |     15.15 |  76.88 |    1,045 |

| 指标                | 合计 s | 中位数 s | 最小 s | 最大/p95 s |
| ------------------- | -----: | -------: | -----: | ---------: |
| accepted -> preview | 654.33 |    37.84 |   3.14 |     109.69 |
| publish -> public   | 244.06 |    14.96 |   1.61 |      43.22 |
| 完整 wall           | 901.23 |    53.07 |   4.76 |     153.23 |

15 个样本的 nearest-rank p95 就是最大值，不应将它解释为稳定尾延迟。最慢五本依次是
`f840921d3c8d`、`1e3cb4f35a88`、`81d6969edaf0`、`a53faf7243d4` 和
`48f953e9a97e`。

### 阶段归因

四类 job 的 stage 覆盖率均超过 `99.92%`。以下列出累计 wall 最大的阶段；百分比的
分母是 15 本全部 stage wall `825.525 s`。CPU 是进程累计 user+system 时间，Sharp 等
原生并行线程会使 CPU 高于 wall，所以不能按单核占用解释。

| Job/stage                               | wall s | 占 stage wall |  CPU s |
| --------------------------------------- | -----: | ------------: | -----: |
| build_preview/configured_document       | 129.60 |        15.70% | 139.52 |
| build_publish/configured_document       | 129.42 |        15.68% | 138.89 |
| prepare_draft/source_regions            | 116.99 |        14.17% | 117.09 |
| prepare_draft/typography                |  65.12 |         7.89% |  76.75 |
| prepare_draft/pdf_evidence              |  59.92 |         7.26% |   2.64 |
| prepare_draft/repaired_printed_contents |  54.21 |         6.57% |  56.82 |
| build_preview/page_render               |  46.90 |         5.68% |  71.81 |
| build_publish/page_render               |  46.22 |         5.60% |  70.32 |
| prepare_draft/structure_proposal        |  29.33 |         3.55% |  38.16 |
| analyze_import/archive_extract          |  26.26 |         3.18% |  51.04 |
| prepare_draft/archive_extract           |  25.80 |         3.13% |  50.45 |
| prepare_draft/initial_printed_contents  |  22.28 |         2.70% |  25.11 |

已确认的 top-2 成本族是：预览/发布重复执行 configured-document 编译，以及准备阶段的
目录区域过滤与目录检测链。`pdf_evidence` wall 高而 CPU 低，符合子进程/等待型成本；其余
目录和 configured-document 热点 CPU 接近或高于 wall，适合下一轮 CPU profile 和算法
复杂度检查。图片检查加两次 asset copy 只占 stage wall `3.17%`，不能继续凭峰值内存先验
把图片当作 wall 优化首选；但最高进程树 RSS `2,159 MiB` 仍需单独做内存优化。

### 环境与证据

- 基础 commit：`8ec532dcd5e95e1fbdf3fec1a7c579cc4001fd6a`，测量代码和结构修复尚未提交，
  因此结果明确标记为 dirty-worktree baseline；lockfile SHA-256 为
  `4b37bc0a708bae0aea53fe4120ad8d802b9bfeb1f1f88033611f357b8599b8be`。
- Node `24.15.0`、pnpm `11.9.0`、Sharp `0.35.3`、libvips `8.18.3`；Sharp concurrency
  为 `1`，未显式设置 `UV_THREADPOOL_SIZE` 或 `MALLOC_ARENA_MAX`。
- Linux `7.0.0-28-generic`、ext4、Intel Core Ultra 5 125H、18 logical CPUs、31.9 GB RAM。
- 原始 14 成功加 1 失败报告 SHA-256：
  `acb075a2edc75197bbb05d170981984b4a58770c1b355cc06e01e1c040ed9a34`；修复后单书
  重跑：`b096649178e2276d1b87418dff8f180d97870a73b444b1a79a07a20a3121d733`；经 15 个
  唯一 fixture、全成功、四 job 齐全和全 stage 成功断言后的本地 canonical JSON：
  `fd10f2d29fd7506408da8cfb192766ab8c154fc2760548e1faf420f7dbfdd90b`。
- 测量后 reference comparator 报告 SHA-256：
  `c93c8964bac92ebd4decdcd970d2dcde8d270ac84a2954c7455905075816103a`。

以下保留原测量方式；当前统一使用 `benchmark:build` 的 profiling 参数，reference 使用 v3。
这些命令产生当前实现的测量，不能直接重现上文已归档的旧架构数值。输出目录必须被 Git 忽略：

```sh
pnpm build
pnpm benchmark:build \
  --real-dir "$PWD/tests/fixtures/mineru/real" \
  --real-manifest real-fixtures.json \
  --include-stress false \
  --profile-dir "$PWD/.cache/15-book-performance/profiles" \
  --output "$PWD/.cache/15-book-performance/results.json" \
  --repetitions 1
pnpm fixtures:observe-references \
  --real-dir "$PWD/tests/fixtures/mineru/real" \
  --output "$PWD/.cache/15-book-performance/observed"
pnpm fixtures:compare-references \
  --reference-dir "$PWD/tests/fixtures/mineru/real/references-v3" \
  --observed-dir "$PWD/.cache/15-book-performance/observed"
```

## 优化候选与实验顺序

| 优先级  | 候选                              | 依据与实验                                                                | 主要风险                                                                   |
| ------- | --------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0 完成 | 分段 telemetry 与 15 本基线       | 四类 job stage 覆盖率均超过 99.92%，15/15 成功并保持 reference exact      | 单次顺序运行只能排序瓶颈，不能给出优化百分比                               |
| P1      | 优化 source-region 应用复杂度     | 累计 116.99 s；先在最慢五本做 CPU profile 和最小复杂度 benchmark          | 必须保持 reference-only 排除、块 ID、字节范围和 15/15 exact                |
| P1      | 消除重复 configured-document 编译 | 预览与发布累计 259.02 s；A/B revision-pinned、identity-bound 中间模型复用 | 不得复用 preview URL/HTML；不可削弱不可变发布和 preview/publication parity |
| P1      | 优化目录检测与修复链              | 两次检测、PDF 修复和 structure proposal 合计超过 165 s                    | 不得以裁剪证据或改写 reference 换取速度                                    |
| P2      | 页面渲染有界 pipeline             | 预览和发布渲染累计 93.12 s；完成一页即写入并释放                          | wall、CSS 聚合、诊断顺序和确定性需要 A/B                                   |
| P2      | 图片峰值内存实验                  | wall 占比仅 3.17%，但峰值 RSS 达 2,159 MiB                                | 缓存与并发可能降低 wall 却提高 RSS                                         |
| P2      | 复用安全解压结果                  | 两次解压累计 52.05 s                                                      | 跨 job 信任边界、取消、重启和暂存清理复杂                                  |
| P3      | 文件复制/hash/SQLite 调整         | 当前分段均非主要 wall 成本，保持现有耐久性边界                            | 错删验证层会削弱 crash/tamper 边界                                         |

第一轮 P0 已完成。第二轮应以测得的 top-2 成本族为对象。候选被接受时
必须同时满足：15 本 exact 不退化、总 wall 有稳定改善、最慢书改善、峰值 RSS 不越过部署
预算、阅读 p95 仍不超过 300 ms、取消和失败清理不退化。具体 build SLO 尚无批准决策，
不在本文擅自新增秒数门禁。

## 官方一手资料

### Node.js 24

- [`fs.readFile()`](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsreadfilepath-options-callback)：
  将完整文件内容缓冲到内存；需要控制大文件内存时应使用流式 API。
- [`Buffer.from(buffer)`](https://nodejs.org/docs/latest-v24.x/api/buffer.html#static-method-bufferfrombuffer)：
  从 Buffer/Uint8Array 创建新的 Buffer，当前图片检查因此存在可测量的输入复制。
- [`UV_THREADPOOL_SIZE`](https://nodejs.org/docs/latest-v24.x/api/cli.html#uv_threadpool_sizesize)：
  文件系统和其他异步原生任务共享固定 libuv threadpool，增加并行任务不等于线性提速。
- [Worker threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#worker-threads)：
  适合 CPU 密集型 JavaScript，不太帮助 I/O；官方建议使用池而非为每项工作新建线程。
- [`perf_hooks`](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html)：
  monotonic `performance.now()` 和 event-loop utilization 是本文分段计时依据。
- [`fs.copyFile()`](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisescopyfilesrc-dest-mode)：
  `COPYFILE_FICLONE` 尝试 copy-on-write reflink，不支持时回退；官方不保证一定更快。

### Sharp/libvips

- [Output `raw()` / `toBuffer()`](https://sharp.pixelplumbing.com/api-output/#raw)：
  raw 输出是无 padding 的未压缩像素；`toBuffer()` 返回完整输出 Buffer。
- [Input `metadata()`](https://sharp.pixelplumbing.com/api-input/#metadata)：只读图像 header，
  不解码压缩像素，不能单独替代当前完整恶意图片校验。
- [Input `stats()`](https://sharp.pixelplumbing.com/api-input/#stats)：统计来自各 channel 像素，
  可作为避免保留 raw buffer 的实验候选，但官方未承诺与 raw 的失败语义完全等价。
- [Performance: parallelism and concurrency](https://sharp.pixelplumbing.com/performance/#parallelism-and-concurrency)：
  libuv pool 控制并行图片数，`sharp.concurrency()` 控制每张图的 libvips 线程；glibc 环境的
  allocator 设置会影响默认并发与内存碎片。
- [Utility API](https://sharp.pixelplumbing.com/api-utility/)：`concurrency()`、`cache()`、
  `counters()` 和 queue 事件可用于矩阵实验和队列观测。

### SQLite

- [Write-Ahead Logging](https://sqlite.org/wal.html)：WAL 允许读写并发，但仍只有一个 writer；
  长读事务和 WAL/checkpoint 行为必须测量，不能把“开启 WAL”当作新优化。
- [Transactions](https://sqlite.org/lang_transaction.html) 与
  [FAQ Q19](https://sqlite.org/faq.html#q19)：批量 INSERT 应放在事务中；当前实现已经如此。
- [`PRAGMA synchronous`](https://sqlite.org/pragma.html#pragma_synchronous)：WAL + FULL 和
  NORMAL 具有明确的断电耐久权衡，不能作为无风险提速开关。
- [FTS5 detail](https://sqlite.org/fts5.html#the_detail_option) 与
  [FTS5 optimize](https://sqlite.org/fts5.html#the_optimize_command)：更小 detail 会减少能力，
  全量 optimize 可能耗时很久，不应未经测量放入发布热路径。

### unified/remark

- [unified overview](https://unifiedjs.com/explore/package/unified/#overview)：处理模型是完整文本
  到语法树的 parse、transform、compile；可分开调用以测量各阶段。
- [Processor freeze](https://unifiedjs.com/explore/package/unified/#processorfreeze)：固定 processor
  可以冻结后复用配置，但官方没有承诺可观性能收益，必须微基准验证。
- [remark-rehype HTML](https://github.com/remarkjs/remark-rehype#html)：raw HTML 进入后续
  rehype 处理仍需安全解析/清理；没有 profiling 证据前不得为提速删除安全链。

## 下一步

先为 `source_regions` 建立最小复杂度 benchmark，并对最慢五本采集一次 CPU profile；同时
验证 preview/publish 的 configured-document 中间模型是否能严格绑定 source hash、config
revision 和 compiler identity。只有原型在同机交替三次 A/B 中稳定降低总 wall，且 15/15
reference exact、安全、取消、恢复和阅读并发门禁不退化，才进入生产优化 spec。
