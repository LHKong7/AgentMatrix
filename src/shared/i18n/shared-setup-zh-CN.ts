import type { sharedSetupEn } from './shared-setup-en'

export const sharedSetupZhCN: Record<keyof typeof sharedSetupEn, string> = {
  'nav.sharedSetup': '统一配置',
  'sharedSetup.eyebrow': '所有 CLI AGENT',
  'sharedSetup.description':
    'System Prompt、Skills 与工具在此统一配置，并应用到所有 CLI Agent。引擎、模型线路、Endpoint 与凭证仍保留在各个 Agent 上，因为它们因 CLI 和项目而异。',
  'sharedSetup.prompts': 'System Prompt',
  'sharedSetup.promptsHint':
    '所有 Agent 都会收到的指令。单个 Agent 仍可自行绑定同一个 Prompt，并覆盖此处的绑定。',
  'sharedSetup.skills': 'Skills',
  'sharedSetup.skillsHint': '所有 Agent 均可加载的可复用知识。',
  'sharedSetup.tools': '工具 · MCP Servers',
  'sharedSetup.toolsHint': '所有 Agent 均可连接的工具服务，仍受各自的执行策略约束。',
  'sharedSetup.bundles': '资源组合',
  'sharedSetup.save': '保存统一配置',
  'sharedSetup.applies': '已应用到 {count} / {total} 个 Agent',
  'sharedSetup.participants': '使用此配置的 Agent',
  'sharedSetup.participantHint':
    '取消勾选后，该 Agent 只使用自己的绑定。无论是否勾选，其引擎、模型与 Endpoint 都不受影响。',
  'sharedSetup.noAgents': '尚无 Agent 配置。',
  'sharedSetup.personal': '保留为个性化配置',
  'sharedSetup.personalHint':
    '运行哪个 CLI Agent、调用的模型线路、API Endpoint 与凭证、工作目录与执行策略，都在各个 Agent 上单独设置。',
  'sharedSetup.inherited': '继承自统一配置',
  'sharedSetup.inheritedHint':
    '这些内容已对该 Agent 生效。下方是该 Agent 自己的绑定，对同一资源会覆盖继承项。',
  'sharedSetup.inheritedEmpty': '统一配置中还没有 Prompt、Skills 或工具。',
  'sharedSetup.excluded': '该 Agent 已排除在统一配置之外，仅使用自己的绑定。',
  'sharedSetup.own': '仅此 Agent',
  'sharedSetup.boundary': '保存后的修改应用于新会话，已有会话仍使用其创建时捕获的配置。',
  'sharedSetup.count':
    '{prompts} 个 Prompt · {skills} 个 Skills · {tools} 个工具 · {bundles} 个组合',
}
