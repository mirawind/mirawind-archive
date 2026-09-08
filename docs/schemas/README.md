# Mirawind Schemas

D-141 冻结三个独立版本化的 JSON Schema Draft 2020-12 格式：

- `book.schema.json`：逻辑正文与构建快照，IR v1；工作稿按块存 SQLite。
- `document-manifest.schema.json`：派生页面、目录、块与资源映射，v5。
- `version.schema.json`：不可变构建/发布的完整性标记，v5。

旧 Markdown、`book.yaml`、旧 manifest 和旧数据库不被新运行时读取。切换使用全新数据
目录重新导入，不实现旧书迁移、独立格式适配器或双写。

## 类型与校验

`pnpm generate:content-types` 从正文 schema 生成 Publishing 类型，并使用仓库格式化配置。
`pnpm typecheck` 先检查生成类型与 schema 一致，避免生成后又被格式化产生差异。语义校验和正文操作
集中在 `src/modules/publishing/core/content/`，不复制另一份独立手写正文接口。

校验严格拒绝未知字段、类型强制转换、重复身份、不完整引用、非法资源路径、层级跳跃、
错误边界、重复页面别名及不合法表格合并。未知格式版本不得 fallback。

正文包含元数据、可选 alias、出版设置、有序块和逻辑资源；不能包含账户、权限、任务、
笔记、绝对路径、正文偏移或块指纹。`updated_at` 是唯一草稿修订标识：服务端 Unix 毫秒
整数，变化保存取 `max(now, previous + 1)`，无变化保存不推进。

## 派生产物

manifest 保存当前版本页面、标题表示、稳定块 ID、规范化可见文本及资源映射，不保存
Markdown 源位置或文本指纹。目录树、角色和自动编号从正文块与出版设置派生。

完整性标记的 `files` 登记产物内文件，`shared_files` 登记书籍资源池中的图片和原始包。
资源以书籍目录为相对定位根，不允许通过产物路径拼接到其他书籍。完整性标记绑定 `book_document_sha256`、`manifest_sha256`、`source_updated_at`、编译器
身份与严格闭合的文件清单。文件摘要用于存储完整性，不是正文修订号。

发布前既验证 schema，也验证引用闭合、页面覆盖、不可变文件完整性和当前工作稿时间。
管理与私人资源依旧经过服务端授权，不放入静态 public 目录。

示例见 `examples/book.v1.json`；完整读写和恢复协议见
[结构化正文 IR](../architecture/structured-content-ir.md)。
