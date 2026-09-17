# AgentMatrix

一个以本地配置为中心的 Agent 桌面工作空间。基于 **Electron + React + TypeScript**，使用 electron-vite 开发和构建。

项目文档：[架构约定](docs/architecture.md) · [首批 9 个 CLI Agent 接入调研与配置架构](docs/cli-agent-research.md) · [接入落地计划](docs/cli-agent-plan.md)。

## 启动

需要 Node.js **22.12+（22.x）或 24+**，推荐使用 `.nvmrc` 对应的 Node 22。

```bash
npm ci
npm run dev
```

首次打开会创建一个「通用助手」配置。修改后点击保存，重启仍然保留。

仅预览界面：

```bash
npm run dev:web
```

浏览器预览使用独立的 localStorage，不会读写桌面端配置。

## 当前功能

- **Agent 管理**：新增、编辑、删除、启停和搜索。
- **模型配置**：记录提供方、模型 ID、Base URL、Temperature。
- **System Prompt**：独立编辑系统指令。
- **MCP Servers**：维护 stdio 命令 / 参数 / 环境变量引用，或 Streamable HTTP 地址 / Token 环境变量名。
- **Skills**：维护 Markdown 指令和可选的来源路径。
- **插件配置**：将已有 MCP 与 Skills 组合为可复用的能力集合。
- **能力绑定**：直接绑定资源或通过插件组合，合并去重，过滤已停用配置；删除资源时自动清理引用。
- **本地持久化**：版本化 JSON、Zod 校验、临时文件替换、串行保存与 revision 冲突检查。

这是配置管理基础版本。**尚未执行模型请求、MCP 连接、Skills 文件读取或第三方插件安装**，启用状态代表配置可用，不代表 Agent / 服务正在运行。插件目前是资源组合清单，不运行任意第三方代码。

## 命令

| 命令                   | 说明                                                      |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | 启动 Electron，支持界面热更新                             |
| `npm run dev:web`      | 在浏览器中预览 UI                                         |
| `npm run check`        | ESLint、单元测试、TypeScript 和生产构建                   |
| `npm run test:smoke`   | 构建并启动真实 Electron，验证配置编辑、绑定、重启和持久化 |
| `npm run format`       | 格式化源码与文档                                          |
| `npm run format:check` | 检查格式                                                  |
| `npm run build`        | 构建到 `out/`                                             |
| `npm start`            | 运行已有生产构建                                          |
| `npm run package`      | 为当前平台生成未签名应用目录                              |
| `npm run dist`         | 为当前平台生成分发包，输出到 `release/`                   |

桌面冒烟测试使用临时配置目录并自动清理，需要可用的桌面图形环境。CI 默认运行不依赖图形环境的 `check`。

## 目录

```text
src/
  main/                  Electron 生命周期、IPC 边界、本地存储
  preload/               只暴露明确的类型化配置 API
  shared/                配置 schema、领域类型、资源组合规则、IPC 契约
  renderer/
    src/
      components/        Agent、MCP、Skill、插件编辑器
      lib/               桌面 API / 浏览器预览适配器
      App.tsx            工作空间页面与导航
      tokens.css         颜色、字体设计变量
      styles.css         界面样式
tests/                   配置校验、资源组合、持久化测试
scripts/                 开发 CSP 与真实 Electron 冒烟测试
docs/architecture.md     架构约定和后续扩展点
```

## 数据与开发约定

桌面配置位于 Electron `userData/workspace.json`，可以在「设置」页面查看准确路径。macOS 通常为 `~/Library/Application Support/AgentMatrix/workspace.json`。开发冒烟测试通过 `AGENT_MATRIX_DATA_DIR` 指定临时目录；打包版本忽略该环境变量。

环境变量配置保存的是**变量名引用**，例如 `{"API_TOKEN":"MY_API_TOKEN"}`，预留给未来运行时从系统环境解析。当前版本未实现凭证库，不要将密钥写入 Prompt、参数或普通配置字段。

配置无法解析或版本不兼容时会展示错误，并保留原文件。没有静默重置逻辑。手工编辑配置建议先退出应用并备份文件。

主进程启用 `contextIsolation`、渲染沙箱并关闭 Node 集成；Preload 仅提供读取配置、保存配置和读取应用信息三个接口，IPC 验证来源。生产页面限制 CSP，开发模式仅为 React Fast Refresh 放开内联脚本。参考 [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) 与 [electron-vite 开发文档](https://electron-vite.org/guide/dev)。

## 下一阶段

1. 分离 CLI 引擎、模型连接与共享资源，增加系统凭证库和能力校验。
2. 实现各 CLI 的配置适配器与原生会话接口，支持流式事件、审批、取消和恢复。
3. 完整 Skill 目录导入、MCP 配置分发、原生插件管理与配置生效状态。
4. 逐个验证首批九类引擎，再扩展任务调度和多 Agent 协作。具体设计见 [CLI Agent 接入调研](docs/cli-agent-research.md)。

桌面分发配置已预留 macOS DMG、Windows NSIS、Linux AppImage；正式发布前需补充品牌图标、签名、公证及各平台验证。
