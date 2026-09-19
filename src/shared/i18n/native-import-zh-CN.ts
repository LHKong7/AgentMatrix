import type { nativeImportEn } from './native-import-en'
export const nativeImportZhCN: Record<keyof typeof nativeImportEn, string> = {
  'nativeImport.promptFiles': '引用的 Prompt 文件',
  'nativeImport.promptFilesHint':
    '为需要导入的引用选择本地文件，其正文将成为共享 Prompt。这是你明确选择的文件；不会自动搜索原生目录、展开通配符、访问远程 URL 或解析嵌套宏，请检查导入后的草稿。',
  'nativeImport.replacePrompt': 'Agent 替换提示词',
  'nativeImport.appendPrompt': '共享追加指令',
  'nativeImport.selectedPrompt': '所选来源',
  'nativeImport.selectPromptFile': '选择 Prompt 文件',
  'nativeImport.replaceFile': '选择其他文件',
  'nativeImport.diagnostic.review-prompt-selection':
    '此 Prompt 来自你选中的文件，不复现原生目录搜索、通配符匹配、其他配置来源及指令优先级；启用草稿前请检查绑定。',
  'nativeImport.title': '导入原生配置',
  'nativeImport.description':
    '选择 OpenCode、Pi 或 DeepSeek Harness 原生配置，预览共享资源和 Agent 草稿。',
  'nativeImport.dshFiles':
    'DSH 可选择 cordis.yml、cordis.patch.yml、settings.yaml 和/或 .credentials.yaml。仅读取选中的文件；settings 覆盖选中的配置行。不加载 bundle、不执行 JavaScript 或插件。存储的 key 将作为明确的托管凭据副本导入，原生环境优先级需要另行检查。 可通过“向预览添加文件”从其他目录补充文件；同一文件名只能选一次。',
  'nativeImport.diagnostic.review-precedence':
    '导入的存储 key 是明确的副本，不读取或复现原生启动环境的覆盖值及 .env 回退。请检查认证方式。',
  'error.nativeImportYaml':
    'DSH 需要 YAML 配置行/patch 列表或 settings/credentials 映射。不支持重复或非字符串键、别名、合并键、非有限数值及未知标签。仅 Cordis 文件允许将 JavaScript 标签作为不执行的数据保留。',
  'nativeImport.addFiles': '向预览添加文件',
  'nativeImport.piFiles':
    'Pi 可从同一目录选择 models.json、auth.json、settings.json、SYSTEM.md 和 APPEND_SYSTEM.md 中的一个或多个文件。仅读取所选文件，不执行命令或扩展，也不读取系统环境变量内容。启用草稿前请核对执行策略。',
  'nativeImport.installation': '导入到引擎安装',
  'nativeImport.choose': '选择配置文件',
  'nativeImport.reading': '正在读取配置…',
  'nativeImport.preview': '导入预览',
  'nativeImport.apply': '导入配置',
  'nativeImport.importing': '正在导入…',
  'nativeImport.scope':
    '仅导入所选文件。其他原生来源、引用文件、插件和未支持字段不会自动应用。新 Agent 将保存为待核对的禁用草稿。',
  'nativeImport.secrets':
    '将把 {count} 个直接填写的密钥保存为加密凭据。导入时不读取系统环境变量内容。预览不包含密钥内容。',
  'nativeImport.archive': '包含未转换字段的完整源文件将加密保存在应用内，原始文件不会被修改。',
  'nativeImport.entities': '新增资源',
  'nativeImport.diagnostics': '需要核对的字段',
  'nativeImport.none': '没有未转换的字段。',
  'nativeImport.history': '已保存的导入来源',
  'nativeImport.empty': '尚未导入原生配置。',
  'nativeImport.source': '导入时的来源',
  'nativeImport.mapping': '导入字段映射',
  'nativeImport.saved': '配置已导入，请核对新 Agent 草稿，并在就绪后启用。',
  'nativeImport.noInstallation':
    '请先在引擎页面保存 OpenCode、Pi 或 DeepSeek Harness 安装。导入本身不会运行或验证 CLI。',
  'nativeImport.diagnostic.unconverted': '保留在加密源文件中，未应用共享字段映射。',
  'nativeImport.diagnostic.invalid-value': '该值无法用共享字段表示，请核对草稿。',
  'nativeImport.diagnostic.unresolved-reference': '已保留引用，未读取文件或解析环境变量内容。',
  'nativeImport.diagnostic.review-policy': '需要核对原生配置或执行策略；导入的 Agent 保持禁用。',
  'error.nativeImportDesktopOnly': '原生配置导入仅在桌面应用中可用。',
  'error.nativeImportEngine': '请为此次导入选择已保存的 OpenCode、Pi 或 DeepSeek Harness 安装。',
  'error.nativeImportSelection':
    '请选择一个 OpenCode JSON/JSONC 文件，再按需为支持的 Prompt 引用逐项选择文件（最多 16 个）；或同一目录下最多五种不同的 Pi 文件：models.json、auth.json、settings.json、SYSTEM.md、APPEND_SYSTEM.md；或最多四种 DSH 文件：cordis.yml、cordis.patch.yml、settings.yaml、.credentials.yaml。',
  'error.nativeImportSyntax':
    'JSON 设置必须是无重复键的对象。Pi 需要严格 JSON，OpenCode 也接受 JSONC。源文件内容不会写入日志。',
  'error.nativeImportLimit':
    '所选文件合计上限为 1 MiB；每份 JSON/YAML 上限为 4,000 个值、32 层嵌套及 200 字符的键。',
  'error.nativeImportRead': '无法将所选配置读取为普通 UTF-8 文件。',
  'error.nativeImportChanged': '预览后源文件或引擎安装发生变化，请重新选择文件。',
  'error.nativeImportExpired': '导入预览已过期或不可用，请重新选择文件。',
  'error.nativeImportBusy': '另一项原生配置导入正在进行。',
  'error.nativeImportArchive': '无法保存或验证加密导入存档。',
  'error.nativeImportHistory': '不能删除或改写已保存的原生导入来源记录。',
  'error.nativeImportRecovery': '需要先恢复上次未完成的导入，才能修改凭据。',
}
