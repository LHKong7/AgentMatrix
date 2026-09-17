# 架构约定

## 数据流

```text
React UI → typed preload API → sender-checked IPC → WorkspaceStore → workspace.json
                    ↑                                  ↑
           src/shared/api.ts                  src/shared/workspace.ts
```

渲染进程负责展示和编辑草稿，保存成功后才提交页面状态。主进程负责验证和持久化，UI 无权直接访问文件系统或执行进程。浏览器预览实现相同 API，使用独立 localStorage。

## 配置模型

`Workspace` 包含 `schemaVersion`、`revision`、`agents`、`mcpServers`、`skills`、`plugins`。

- `Agent` 保存角色、模型配置和资源 ID 引用。
- `McpServer` 是 stdio / Streamable HTTP 的可区分联合，避免无效传输字段组合。
- `Skill` 保存指令正文；`sourcePath` 仅记录出处，尚不读取或监听文件。
- `Plugin` 保存版本和资源引用，表达一组可复用能力，不是可执行脚本。
- `resolveResources` 合并直接绑定与已启用插件的资源，过滤已停用资源并去重。
- `removeResource` 同时清理 Agent 和插件引用，避免悬空绑定。

新增字段应同步修改 shared schema、初始化值、编辑器和相关测试。修改文件结构时提升 `schemaVersion` 并实现显式迁移，不能直接覆盖无法读取的配置。

## 存储一致性

单实例桌面应用通过同一个 `WorkspaceStore` 串行处理读写。保存时再次读取并核对 `revision`，校验完整配置后写入同目录临时文件，再用 rename 替换正式文件。失败时不提交 UI 状态，并保留草稿以便重试。配置损坏或来自更高版本时保留原文件并报错。

此机制不提供跨进程数据库事务，也不对外部编辑器加锁。手工编辑应在应用退出后进行。当前没有多窗口编辑或实时外部文件监听。

## 扩展边界

后续运行时放在主进程管理的独立模块或 utility process，负责模型流式请求、MCP 连接、工具执行、取消与日志。通过显式 IPC API 返回事件，不把 `ipcRenderer` 或任意文件 / shell 访问暴露给界面。

凭证应交给系统凭证库，配置中保存 credential ID 或环境变量名。插件安装需要独立的 manifest 校验、来源与权限设计；当前资源组合模型不隐含执行第三方代码的权限。

针对首批多 CLI 接入，下一步采用 engine adapter → session service → typed events → chat UI，复用各 CLI 的原生 Agent 循环。共享配置、专属选项与当前 schema 的迁移建议见 [CLI Agent 接入调研](cli-agent-research.md)。未来若增加自研 Agent，再单独实现直接调用模型的 provider adapter 与 MCP 调用循环。
