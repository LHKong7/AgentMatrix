import type { discoveryEn } from './discovery-en'

export const discoveryZhCN: Record<keyof typeof discoveryEn, string> = {
  'discovery.title': '已安装的 Agent CLI',
  'discovery.description':
    '打开本页时，AgentMatrix 会自动检查是否已安装受支持的 CLI，并可一键下载锁定版本。',
  'discovery.boundary':
    '检测只在临时配置目录中执行各可执行文件的版本命令，不会修改原生设置，也不会发送任何提示词。',
  'discovery.check': '重新检查',
  'discovery.checking': '正在查找已安装的 Agent CLI…',
  'discovery.checkedAt': '检查时间：{time}',
  'discovery.never': '尚未检查',
  'discovery.status.ready': '已安装锁定版本',
  'discovery.status.version-mismatch': '已安装，但版本不同',
  'discovery.status.missing': '未安装',
  'discovery.expected': '锁定版本 {version}',
  'discovery.origin.managed': '由 AgentMatrix 下载',
  'discovery.origin.path': '在 PATH 中找到',
  'discovery.origin.common': '常见安装位置',
  'discovery.versionUnknown': '无法读取版本命令',
  'discovery.use': '使用此 CLI',
  'discovery.linked': '已保存为“{name}”',
  'discovery.saving': '正在保存并检查…',
  'discovery.download': '下载 {version}',
  'discovery.downloading': '正在下载 {package}…',
  'discovery.downloadHint':
    '在本应用自己的数据目录中下载 {package}@{version}，并禁用安装脚本，然后验证版本命令。不会修改该目录之外的任何内容。',
  'discovery.manual': '也可以自行执行以下命令：',
  'discovery.mismatchHint': '此适配器仅启动锁定版本。其他版本仍会显示并可编辑，但无法启动会话。',
  'discovery.empty': '在 PATH 和常见安装位置中都没有找到可执行文件。',
  'discovery.unsupported': '检测与下载需要 macOS 或 Linux 桌面应用。',
  'discovery.unavailable': '未找到 npm，无法一键下载。请安装 Node.js，或自行安装 CLI 后重新检查。',
  'discovery.managedRoot': '下载位置',
  'discovery.savedName': '{engine}（自动检测）',
  'error.engineDiscoveryBusy': '已有一次 CLI 检查正在进行，请等待完成。',
  'error.engineDownloadBusy': '已有一次下载正在进行，请等待完成。',
  'error.engineDownloadUnsupported': '下载 Agent CLI 需要 macOS 或 Linux 桌面应用。',
  'error.engineDownloadUnavailable': '未找到 npm。请安装 Node.js，或自行安装 CLI 后重新检查。',
  'error.engineDownloadFailed':
    '下载未生成可运行的锁定版本 CLI。请在终端执行显示的命令，然后重新检查。',
}
