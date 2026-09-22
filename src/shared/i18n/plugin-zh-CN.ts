import type { pluginEn } from './plugin-en'

export const pluginZhCN: Record<keyof typeof pluginEn, string> = {
  'plugin.opencodeOptions': 'OpenCode 插件配置（JSON）',
  'plugin.opencodeOptionsHint':
    '作为第二个参数传给原生插件初始化函数的普通 JSON，最多 64 KiB，宏文本保持原样。修改仅应用于新会话。API Key 请使用共享凭据引用管理。',
  'plugin.optionsEngineMismatch':
    '这些选项属于其他引擎。请先清除，再配置当前引擎；不会自动转换选项含义。',
  'plugin.dshOptions': 'DSH 插件配置（JSON）',
  'plugin.dshOptionsHint':
    '交给原生插件校验的普通配置，最多 64 KiB，不接受可执行表达式对象。API Key 请使用共享凭据引用管理。',
  'error.dshPluginEntry':
    '请选择已编译的 DSH JavaScript 模块，或具有明确根 import 导出、main 入口或 index.js 的安装包。目前不支持导出数组和 TypeScript 源文件。',
  'error.dshPluginBundle': '此目录是 DSH 补丁包。请明确选择组件模块；目前尚未实现补丁包导入。',
  'error.dshPluginId':
    'DSH 插件 ID 必须唯一，只能使用最多 100 个字母、数字、连字符或下划线，且不能与托管组件 ID 冲突。',
  'error.dshPluginRange': '已安装插件声明的 DSH 或 Cordis 同级依赖版本范围不兼容或无效。',
  'error.dshPluginFramework':
    '已安装的 DSH 或 Cordis 框架与验证过的插件加载器版本不符，或无法检查其文件。',
  'plugin.clearOptions': '清除插件选项',
  'plugin.inspect': '检查已安装文件',
  'plugin.inspecting': '正在检查文件…',
  'plugin.result': '已安装文件检查',
  'plugin.filesOnly': '文件已检查 · 激活尚未验证',
  'plugin.scope':
    '检查按所选引擎规则解析的入口和包元数据。支持的插件会在会话启动与恢复时再次验证。传递依赖未捕获，仅凭此次文件检查不能证明激活成功。',
  'plugin.engineHint': '请选择 OpenCode、Pi 或 DeepSeek Harness 安装以检查文件。',
  'plugin.versionHint': '入口解析依据 {engine} {version}。所选引擎版本尚未通过此契约的验证。',
  'plugin.package': '包名称',
  'plugin.version': '包版本',
  'plugin.range': '声明的 {engine} 版本范围',
  'plugin.rangeHint':
    '引擎范围使用已保存的 CLI 版本比较，其他依赖需要单独检查；此次文件检查不证明运行时兼容性。',
  'plugin.range.matched': '声明的范围包含已保存的 {engine} 版本 {version}。',
  'plugin.range.mismatched': '声明的范围不包含已保存的 {engine} 版本 {version}。',
  'plugin.range.undeclared': '未声明 {engine} 版本范围，兼容性未知。',
  'plugin.range.invalid-range': '声明的 {engine} 版本范围无效。',
  'plugin.dependencyUnverified': '尚未检查此依赖的安装版本。已保存的 CLI 版本不能证明其兼容性。',
  'plugin.range.engine-unverified': '请先检查引擎安装，再比较版本。',
  'plugin.range.invalid-version': '已保存的引擎版本不符合语义化版本格式。',
  'plugin.unknown': '未声明',
  'plugin.entry': '解析后的入口',
  'plugin.localSource': '本地来源',
  'plugin.checkedAt': '检查时间',
  'plugin.digest': '入口 SHA-256',
  'plugin.metadataDigest': '包元数据 SHA-256',
  'plugin.metadataSource': '包元数据来源',
  'plugin.useVersion': '使用包版本',
  'plugin.versionMismatch': '配置版本与已安装的包版本不同，请在保存前核对。',
  'plugin.idHint':
    'V1 导出的 ID 会在启动时核对。没有导出 ID 的 OpenCode 旧式模块和 Pi 扩展使用此字段作为标签，并以来源摘要标识绑定。DSH 将此字段用作唯一的原生组件 ID；不同 ID 可创建同一模块的独立实例。',
  'error.pluginDesktopOnly': '已安装插件检查仅在桌面应用中可用。',
  'error.pluginBusy': '另一个插件检查仍在进行中。',
  'error.pluginEngine': '请先选择已保存的 OpenCode、Pi 或 DeepSeek Harness 安装，再检查插件。',
  'error.pluginPath': '请输入本机已安装插件的绝对路径。',
  'error.pluginMissing': '所选插件或其声明的入口不存在。',
  'error.pluginFile': '插件入口和包元数据必须是普通文件。',
  'error.pluginMetadata': '解析出的 package.json 中元数据字段无效或超出长度限制。',
  'error.pluginEntry':
    '未能识别支持的服务端入口。请选择 JavaScript/TypeScript 文件或明确声明服务端入口的包。',
  'error.pluginOutside': '声明的入口解析到了所选插件目录之外。',
  'error.pluginLimit': '检查上限为 256 KiB 包元数据和 20 MB 入口文件。',
  'error.pluginChanged': '检查过程中插件文件发生了变化，请在编辑完成后重试。',
  'error.pluginDependencyLimit': '插件来源检查超过文件数量、字节数或包目录深度限制。',
  'error.pluginRead': '无法读取已安装的插件文件。',
  'error.pluginExports':
    '请选择包含显式 JavaScript/TypeScript 导出的 ESM 插件。目前不支持 CommonJS 和 export-star 入口。',
  'error.pluginDuplicate': '两个已选插件解析到了同一入口，请只保留一个绑定。',
  'error.pluginVersion': '已安装的包版本与所选插件版本不一致。',
  'error.pluginRange': '已安装的插件要求其他 OpenCode 版本，或声明了无效的版本范围。',
  'error.piPluginEntry':
    '请选择 Pi 扩展文件、含 index.ts/index.js 的目录，或 pi.extensions 显式列出文件的包。目前不支持通配符和目录入口。',
  'error.piPluginResources':
    '此 Pi 包还声明了 Skills、提示词或主题。请显式选择扩展文件，并单独配置共享资源。',
  'error.piPluginRange': '已安装扩展声明了不兼容或无效的 Pi peer dependency 版本范围。',
}
