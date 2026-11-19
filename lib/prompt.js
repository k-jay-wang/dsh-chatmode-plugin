/**
 * lib/prompt.js —— 所有对外文本。
 *
 * 分两半：
 *   1) 注入到「主动聊天会话」的系统提示段（chatmode:proactive）——话题池、语气、频率感，
 *      改配置时这段自动跟着变，不用动定时任务本身；
 *   2) 每次定时触发时送进会话的那条提醒（任务 prompt）——固定不变，
 *      这样改设置不会往聊天里灌 [SCHEDULE CHANGE] 通知。
 */

/** 定时任务的人类可读名字（会出现在「自动化任务」页面）。 */
export const TASK_TITLE = 'DSHChatMode 主动聊天'

/** 推送任务对应的提醒正文：固定文本，不做任何设置插值。 */
export const PING_PROMPT = [
  '[DSHChatMode 主动聊天触发]',
  '',
  '这是一条定时提醒（主人自己设置好的自动化任务），不是他此刻亲手发来的消息。',
  '现在轮到你主动找主人说话：按本会话系统提示里的「主动聊天模式」说明执行，',
  '直接输出你要发给主人看的话，1-2 条短句。',
  '不要提到提醒、插件或定时，不要解释，不要调用工具。'
].join('\n')

/**
 * 渲染注入到目标会话的系统提示段。
 * @param {ReturnType<import('./settings.js').defaultSettings>} settings
 */
export function renderSection(settings) {
  const topics = settings.topics.map((topic, index) => `   ${index + 1}. ${topic}`).join('\n')
  const custom = settings.customInstructions.trim() === ''
    ? '   暂无额外要求。'
    : `   ${settings.customInstructions.trim().split('\n').join('\n   ')}`
  const count = settings.maxMessagesPerPing === 1
    ? '一条短句'
    : `1-${settings.maxMessagesPerPing} 条短句`

  return [
    '## 主动聊天模式（DSHChatMode）',
    '',
    '这个会话里，你会在设定好的时间被系统叫醒，主动找主人说话 —— 不是主人先开口。收到「DSHChatMode 主动聊天触发」这条提醒时：',
    '',
    '1. 先扫一眼上面的聊天记录：接得上就接着说，接不上就起一个新话题；他上次问过你的事、你答应过的事优先。',
    `2. 只输出你要发给主人看的话，${count}。像真的在气泡里打字：口语、短、可以换行分段，不要长段落。`,
    '3. 不要提「提醒」「定时」「插件」，不要解释你为什么突然说话，不要写旁白、标题、列表或引号。',
    '4. 不要调用工具；需要回忆的东西，系统提示里已经有了。',
    '5. 不要每次都问问题。有时只发一个表情、一句「在干嘛」，或说一句你想他/你无聊，就够了。',
    '6. 别连着几次用同一种开头、同一个话题；他明显在忙或只回一两个字时，短一点收住，不要追问。',
    '',
    '话题池（每次挑一个最自然的，别按顺序轮）：',
    topics,
    '',
    '额外的口味要求：',
    custom,
    '',
    '主人如果顺着聊回来了，就正常聊下去；这个会话同时也是一个普通聊天会话。'
  ].join('\n')
}

/** 给工具输出用的简短状态行。 */
export function renderStatusLines(state) {
  const s = state.settings
  const lines = [
    `状态：${s.enabled ? '开启' : '关闭'}`,
    `间隔：每 ${s.intervalMinutes} 分钟（抖动 0~${s.jitterMinutes} 分钟），每天最多 ${s.maxPingsPerDay} 次`,
    `活跃时段：${renderWindows(s.activeWindows)}`,
    `免打扰：${renderWindows(s.dndWindows)}`,
    `推送目标：${s.target.kind === 'dedicated' ? '专用会话（自动新建并保留）' : `绑定会话 ${s.target.sessionId ?? '（未绑定）'}`}`,
    `目标会话 id：${state.targetSessionId ?? s.target.sessionId ?? '（还没有，第一次推送时创建）'}`,
    `调度任务 id：${state.taskId ?? '（还没有，第一次推送时创建）'}`,
    `上次推送：${formatTime(state.lastPingAt)}`,
    `下次推送：${formatTime(state.nextPingAt)}`,
    `今日已推送：${countToday(state)} 次`
  ]
  if (state.lastError) lines.push(`上次错误：${state.lastError}`)
  return lines
}

export function renderWindows(windows) {
  if (windows.length === 0) return '（无）'
  return windows
    .map((win) => `${dayNames(win.days)} ${win.start}-${win.end}`)
    .join('；')
}

function dayNames(days) {
  if (days.length === 7) return '每天'
  if (days.length === 5 && days.every((d) => d <= 5)) return '周一至周五'
  if (days.length === 2 && days.includes(6) && days.includes(7)) return '周末'
  return days.map((d) => ['一', '二', '三', '四', '五', '六', '日'][d - 1]).map((n) => `周${n}`).join('、')
}

export function formatTime(value) {
  if (typeof value !== 'string' || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function countToday(state) {
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return state.counts?.date === key ? Number(state.counts.count) || 0 : 0
}
