import type { impactEn } from './impact-en'

export const impactZhCN: Record<keyof typeof impactEn, string> = {
  'impact.title': '保存前的影响预览',
  'impact.description': '根据已保存的 Agent 绑定预览当前草稿。保存后，新会话将使用更新的配置输入。',
  'impact.incomplete': '请补全必填项或修正无效字段后再预览。',
  'impact.loading': '正在检查绑定和已有会话的配置快照…',
  'impact.profiles': '{count} 个关联 Agent 中，{changed} 个可确认发生变化',
  'impact.noProfiles': '没有已保存的 Agent 引用这个资源。',
  'impact.profile.changed': '新会话的配置输入发生变化',
  'impact.profile.unchanged': '解析后的配置输入不变',
  'impact.profile.unresolved': '草稿或已停用，暂时无法解析影响',
  'impact.profile.blocked': '当前修改使配置无法解析',
  'impact.profile.resolved': '当前修改使配置可以解析',
  'impact.sessions': '已有会话',
  'impact.retained':
    '已有会话继续使用捕获时的配置，恢复会话也不会更新。以下差异将会话快照与修改后新会话的配置输入进行比较，不包含已关闭会话。',
  'impact.scanned': '已检查 {count} 个会话快照。刷新可纳入新创建的会话。',
  'impact.noSessions': '未找到关联会话；无法读取的快照会单独显示。',
  'impact.noSessionsYet': '目前检查的分页中尚未找到关联会话。',
  'impact.session.pending': '保留之前的配置输入',
  'impact.session.same': '捕获的配置输入仍然一致',
  'impact.session.unresolved': '保留快照，Agent 已删除或无法解析',
  'impact.session.unavailable': '快照无法读取，关联关系及影响未知',
  'impact.alreadyPending': '本次编辑前，该会话与已保存的 Agent 配置就已存在差异。',
  'impact.versions': '保留 v{captured} · 修改后绑定 {proposed}',
  'impact.more': '检查更多会话',
  'impact.browser': '浏览器预览仅检查已保存的 Agent，无法查看桌面端会话。',
  'impact.limits':
    '此预览检查配置，不代表 CLI 兼容性或实际生效验证。固定版本和直接绑定的覆盖规则会纳入计算；不比较凭据值及其轮换。',
}
