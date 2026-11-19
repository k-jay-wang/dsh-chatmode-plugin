/**
 * DSHChatMode —— 让模型按你设定的节奏，主动来找你聊天。
 *
 * 它本身不直接往会话里塞消息，而是复用 DSH 的「定时任务」通道：
 *
 *   1. 插件里有一个 30 秒一次的轻量节拍器，按活跃时段 / 免打扰 / 间隔 / 每日上限
 *      算出「下一次该说话的时间」；
 *   2. 到点后调用 `schedule.run(taskId)`，把一条固定的提醒投进目标会话；
 *   3. DSH 的调度器负责唤醒（或首次创建）那个会话，模型按系统提示里的
 *      「主动聊天模式」段落，用自己的人设说一句/几句。
 *
 * 为什么绕这一圈：调度器自带会话创建、唤醒、落盘和 UI 归属，插件自己
 * `agent.followup()` 等于把这一整套重写一遍，容易和 Web 端抢会话。
 *
 * 配置与运行状态都在 <DSH_HOME>/chatmode/state.json，日志在 chatmode.log。
 */

import {
  loadState,
  saveState,
  patchSettings,
  planNextPing,
  isAllowedNow,
  nextAllowedAt,
  localDateKey,
  log,
  defaultSettings
} from './lib/settings.js'
import { TASK_TITLE, PING_PROMPT, renderSection, renderStatusLines, countToday } from './lib/prompt.js'
import { registerApi } from './lib/web.js'

/** 插件名 = 裸包名（与 cordis.patch.yml 的 name 一致）。 */
export const name = 'dsh-chatmode-plugin'

/** 声明式依赖：拿不到这些服务，插件就什么也做不了。 */
export const inject = ['schedule', 'tools', 'systemPrompt', 'sessions', 'agents', 'timer', 'agentPresets']

/** 节拍器周期：30 秒。只在内存里比对时间，不产生任何模型请求。 */
const TICK_MS = 30_000

/** 调度任务用「很远的一次性时间」占位，真正的投递全部走 run()。 */
const PLACEHOLDER_AT = '2099-12-31T00:00:00.000Z'

/** 单次投递失败后的重试间隔。 */
const RETRY_MS = 10 * 60_000

export function apply(ctx) {
  /** 防止 tick 重入。 */
  let ticking = false

  const now = () => new Date()

  const todayKey = () => localDateKey(now())

  /** 目标会话 id：专用会话在第一次投递后才有。 */
  function targetSessionId(state) {
    if (typeof state.targetSessionId === 'string' && state.targetSessionId !== '') return state.targetSessionId
    const configured = state.settings.target.kind === 'session' ? state.settings.target.sessionId : null
    return typeof configured === 'string' && configured !== '' ? configured : null
  }

  // ---------------------------------------------------------------------
  // 调度任务
  // ---------------------------------------------------------------------

  /**
   * 拿到（必要时创建）承载投递的任务。
   * @param {ReturnType<typeof loadState>} state
   */
  async function ensureTask(state) {
    if (typeof state.taskId === 'string' && state.taskId !== '') {
      try {
        const entry = await ctx.schedule.view({ id: state.taskId })
        if (entry && entry.status === 'active') return entry
      } catch {
        // 任务可能被用户在「自动化任务」页面删了；下面重建。
      }
      state.taskId = null
      state.taskCreatedAt = null
    }

    const existingTarget = targetSessionId(state)
    const request = {
      title: TASK_TITLE,
      prompt: PING_PROMPT,
      timing: { kind: 'at', at: PLACEHOLDER_AT },
      target: existingTarget === null
        ? { kind: 'new_once', create: buildCreateSpec(state.settings) }
        : { kind: 'session', sessionId: existingTarget }
    }

    const entry = await ctx.schedule.create(request)
    state.taskId = entry.id
    state.taskCreatedAt = entry.createdAt ?? now().toISOString()

    // new_once 在创建时就会预留好会话 id —— 记下来，从而系统提示段从第一条消息起就生效。
    const reserved = entry?.target?.sessionId
    if (typeof reserved === 'string' && reserved !== '') state.targetSessionId = reserved
    if (typeof entry?.target?.kind === 'string' && entry.target.kind === 'session' && existingTarget === null) {
      state.targetSessionId = entry.target.sessionId
    }
    saveState(state)
    log(`task created ${entry.id} target=${JSON.stringify(request.target)} session=${state.targetSessionId ?? '?'}`)
    return entry
  }

  /** 默认工作目录：注册表里的第一个工作区（设置页没有当前会话可继承时用它）。 */
  function defaultWorkspaceCwd() {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry === undefined || typeof registry.list !== 'function') return null
    try {
      const list = registry.list()
      if (Array.isArray(list) && list.length > 0 && typeof list[0].path === 'string' && list[0].path !== '') return list[0].path
    } catch {
      // 注册表还没起来时会抛，退回不指定目录。
    }
    return null
  }

  function buildCreateSpec(settings) {
    const spec = {}
    const cwd = typeof settings.target.cwd === 'string' && settings.target.cwd !== ''
      ? settings.target.cwd
      : defaultWorkspaceCwd()
    if (cwd !== null) spec.cwd = cwd
    if (typeof settings.target.agentPreset === 'string' && settings.target.agentPreset !== '') {
      spec.agentPreset = settings.target.agentPreset
    }
    return spec
  }

  /** 已配置的绑定会话是否还活着（删掉/归档后要能自愈）。 */
  function boundSessionKnown(state) {
    const configured = state.settings.target.kind === 'session' ? state.settings.target.sessionId : null
    if (configured === null) return true
    try {
      const sessions = ctx.sessions.list()
      return sessions.some((session) => session.id === configured)
    } catch {
      return true
    }
  }

  // ---------------------------------------------------------------------
  // 推送
  // ---------------------------------------------------------------------

  /**
   * 立即投递一次。成功返回 true。
   * @param {ReturnType<typeof loadState>} state
   */
  async function deliver(state) {
    if (!boundSessionKnown(state)) {
      state.lastError = '绑定的会话不存在了：请重新 bind 一个会话'
      state.nextPingAt = new Date(now().getTime() + RETRY_MS).toISOString()
      saveState(state)
      log('deliver skipped: bound session missing')
      return false
    }

    const entry = await ensureTask(state)
    let result
    try {
      result = await ctx.schedule.run({ id: entry.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 目标会话被归档或删掉了：作废这个任务，下次推送时重新建一个，别卡死。
      if (/archiv|not[ _-]?found|不存在|已归档/i.test(message)) {
        await dropTask(state)
        state.taskId = null
        state.taskCreatedAt = null
        if (state.settings.target.kind !== 'session') state.targetSessionId = null
        state.lastError = '目标会话已失效，下次推送会重新建一个。'
        state.nextPingAt = planNextPing(state.settings, state, now())
        saveState(state)
        log(`target session gone, task dropped: ${message}`)
        return false
      }
      throw error
    }
    const delivered = result?.delivered !== false
    if (!delivered) {
      state.lastError = `投递未确认：${JSON.stringify(result ?? null)}`
      state.nextPingAt = new Date(now().getTime() + RETRY_MS).toISOString()
      saveState(state)
      log(`run not delivered: ${JSON.stringify(result ?? null)}`)
      return false
    }

    const stamp = now()
    state.lastPingAt = stamp.toISOString()
    if (state.counts.date !== localDateKey(stamp)) state.counts = { date: localDateKey(stamp), count: 0 }
    state.counts.count += 1
    state.lastError = null
    state.nextPingAt = planNextPing(state.settings, state, stamp)
    saveState(state)
    log(`ping delivered task=${entry.id} session=${state.targetSessionId ?? state.settings.target.sessionId ?? '?'} next=${state.nextPingAt}`)
    return true
  }

  /** 节拍器：检查是否到点，到点就投递。 */
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const state = loadState()
      if (!state.settings.enabled) return

      const stamp = now()

      if (typeof state.nextPingAt !== 'string' || state.nextPingAt === '') {
        state.nextPingAt = planNextPing(state.settings, state, stamp)
        saveState(state)
        return
      }

      const due = Date.parse(state.nextPingAt)
      if (!Number.isFinite(due) || stamp.getTime() < due) return

      // 应用关了太久（比如睡了一夜）：这次算错过，不补发，直接重新排期。
      const staleMs = Math.max(state.settings.intervalMinutes * 2 * 60_000, 30 * 60_000)
      if (stamp.getTime() - due > staleMs) {
        state.nextPingAt = planNextPing(state.settings, state, stamp)
        saveState(state)
        log(`missed by ${Math.round((stamp.getTime() - due) / 60000)}m, rescheduled -> ${state.nextPingAt}`)
        return
      }

      // 到点了，但可能刚好落在免打扰/活跃时段之外（比如改过配置）——往后顺延。
      if (!isAllowedNow(state.settings, stamp)) {
        const next = nextAllowedAt(state.settings, stamp)
        state.nextPingAt = next === null ? null : next.toISOString()
        saveState(state)
        log(`deferred outside window -> ${state.nextPingAt}`)
        return
      }

      if (countToday(state) >= state.settings.maxPingsPerDay) {
        const tomorrow = new Date(stamp)
        tomorrow.setHours(0, 5, 0, 0)
        tomorrow.setDate(tomorrow.getDate() + 1)
        const next = nextAllowedAt(state.settings, tomorrow)
        state.nextPingAt = next === null ? null : next.toISOString()
        saveState(state)
        log(`daily cap reached -> ${state.nextPingAt}`)
        return
      }

      // 目标会话正在跑一轮：别打断，几分钟后再来。
      const sid = targetSessionId(state)
      if (sid !== null) {
        try {
          const agent = ctx.agents.get(sid)
          if (agent !== undefined && agent.status === 'running') {
            state.nextPingAt = new Date(stamp.getTime() + RETRY_MS).toISOString()
            saveState(state)
            log('deferred: target agent busy')
            return
          }
        } catch {
          // 查不到就当空闲。
        }
      }

      await deliver(state)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`tick error: ${message}`)
      try {
        const state = loadState()
        state.lastError = message
        state.nextPingAt = new Date(now().getTime() + RETRY_MS).toISOString()
        saveState(state)
      } catch {
        // 忽略二次失败。
      }
    } finally {
      ticking = false
    }
  }

  /** 配置被改动后重新排期。 */
  function replan(state) {
    state.nextPingAt = state.settings.enabled ? planNextPing(state.settings, state, now()) : null
    if (!state.settings.enabled) state.lastError = null
    saveState(state)
    return state
  }

  /** 清掉调度任务（用户 reset / 换目标时）。失败不致命。 */
  async function dropTask(state) {
    if (typeof state.taskId !== 'string' || state.taskId === '') return
    try {
      await ctx.schedule.edit({ id: state.taskId, action: 'delete' })
      log(`task deleted ${state.taskId}`)
    } catch (error) {
      log(`task delete failed ${state.taskId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    state.taskId = null
    state.taskCreatedAt = null
  }

  // ---------------------------------------------------------------------
  // 设置变更（工具与设置页共用）
  // ---------------------------------------------------------------------

  /**
   * 改配置的唯一入口：工具与设置页都走这里，保证行为一致。
   * @param {object} patch 设置补丁（深合并）
   * @param {{currentSessionId?: string|null, headCwd?: string|null, headPreset?: string|null, source?: string}} env
   */
  async function applyConfiguration(patch, env = {}) {
    const currentSessionId = env.currentSessionId ?? null
    const headCwd = env.headCwd ?? null
    const headPreset = env.headPreset ?? null
    const before = loadState()
    const nextPatch = { ...patch }

    if (nextPatch.target === undefined) {
      // 还没显式选目标、又正好在专用会话模式下：把当前会话的环境带上，第一次推送就照着它建。
      if (before.settings.target.kind === 'dedicated' && before.settings.target.cwd === null && headCwd !== null) {
        const preset = before.settings.target.agentPreset ?? headPreset
        nextPatch.target = {
          kind: 'dedicated',
          cwd: headCwd,
          ...(typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {})
        }
      }
    } else {
      if (nextPatch.target.kind === 'session' && !nextPatch.target.sessionId && currentSessionId) {
        nextPatch.target = { ...nextPatch.target, sessionId: currentSessionId }
      }
      if (nextPatch.target.kind === 'dedicated') {
        if (nextPatch.target.cwd === undefined) nextPatch.target.cwd = headCwd ?? before.settings.target.cwd ?? null
        if (nextPatch.target.agentPreset === undefined) nextPatch.target.agentPreset = headPreset ?? before.settings.target.agentPreset ?? null
      }
    }

    const prevKind = before.settings.target.kind
    const prevSessionId = before.targetSessionId ?? before.settings.target.sessionId ?? null
    const finalTarget = nextPatch.target ?? before.settings.target
    // 只有「真的换了目标」才丢任务重建；重复下发同一个目标不该把已经建好的会话弄丢。
    const targetChanged = nextPatch.target !== undefined && (
      finalTarget.kind !== prevKind ||
      (finalTarget.kind === 'session' && (finalTarget.sessionId ?? null) !== prevSessionId)
    )

    const state = patchSettings(nextPatch)
    if (targetChanged) {
      await dropTask(state)
      state.targetSessionId = state.settings.target.kind === 'session' ? state.settings.target.sessionId : null
      saveState(state)
    }
    replan(state)
    log(`settings updated via ${env.source ?? 'api'} target=${state.settings.target.kind} enabled=${state.settings.enabled}`)
    return state
  }

  /** 给设置页的完整快照（配置 + 运行状态）。 */
  function snapshot(state) {
    return {
      settings: state.settings,
      runtime: {
        enabled: state.settings.enabled,
        taskId: state.taskId ?? null,
        targetSessionId: targetSessionId(state),
        lastPingAt: state.lastPingAt ?? null,
        nextPingAt: state.nextPingAt ?? null,
        counts: state.counts,
        lastError: state.lastError ?? null,
        now: now().toISOString()
      }
    }
  }

  /** 恢复默认：删任务、清目标、关掉主动聊天。 */
  async function resetAll() {
    const state = loadState()
    await dropTask(state)
    state.targetSessionId = null
    state.nextPingAt = null
    state.lastPingAt = null
    state.counts = { date: '', count: 0 }
    state.settings = defaultSettings()
    saveState(state)
    log('reset')
    return state
  }

  // ---------------------------------------------------------------------
  // 系统提示段：只对「主动聊天会话」生效
  // ---------------------------------------------------------------------

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'chatmode:proactive',
    order: 200,
    text: (context) => {
      const sessionId = context?.agent?.session?.header?.id ?? context?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      const state = loadState()
      if (!state.settings.enabled) return ''
      const target = targetSessionId(state)
      if (target === null || target !== sessionId) return ''
      return renderSection(state.settings)
    }
  }))

  // ---------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------

  const WINDOW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      days: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 7 },
        description: '周几生效，1=周一 … 7=周日；不填为每天'
      },
      start: { type: 'string', description: '开始时间 HH:mm（24 小时制）' },
      end: { type: 'string', description: '结束时间 HH:mm；比 start 早表示跨午夜' }
    },
    required: ['start', 'end']
  }

  ctx.effect(() => ctx.tools.register({
    name: 'chatmode',
    description: [
      'DSHChatMode 主动聊天模式的控制开关：设置活跃时段、免打扰时段、推送间隔、话题口味，',
      '把推送绑定到当前会话或一个专用的新会话，也可以现在立刻发一条。',
      '用户说「每隔半小时主动找我」「晚上十点以后别烦我」「换个话题」时用 configure；',
      '说「就在这里跟我聊」「新建一个会话」时用 bind；说「现在就跟我说句话」时用 ping。'
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'configure', 'bind', 'ping', 'reset'],
          description: 'status 看现状；configure 改设置；bind 选推送目标；ping 立刻发一条；reset 清掉任务与目标会话'
        },
        enabled: { type: 'boolean', description: 'configure 时用：开启/关闭主动聊天' },
        intervalMinutes: { type: 'integer', minimum: 5, maximum: 1440, description: '推送间隔（分钟），10/20/30/60 或自定义' },
        jitterMinutes: { type: 'integer', minimum: 0, maximum: 60, description: '每次间隔的随机抖动上限（分钟）' },
        maxPingsPerDay: { type: 'integer', minimum: 1, maximum: 200, description: '每天最多主动说几次' },
        maxMessagesPerPing: { type: 'integer', minimum: 1, maximum: 3, description: '每次最多几条短句' },
        activeWindows: { type: 'array', items: WINDOW_SCHEMA, description: '活跃时段（工作时间内允许推送），整体替换' },
        dndWindows: { type: 'array', items: WINDOW_SCHEMA, description: '免打扰时段，优先级高于活跃时段，整体替换' },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: '话题池，整体替换。写具体一点，例如「问他今天的工作做完没有」'
        },
        customInstructions: { type: 'string', description: '额外的口味/语气要求，例如「别总问吃饭」' },
        target: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['dedicated', 'session'], description: 'dedicated=专用会话；session=绑定到某个已有会话' },
            sessionId: { type: 'string', description: 'session 模式下的会话 id，不填则用当前会话' }
          },
          description: '推送目标'
        }
      },
      required: ['action']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } }
        }
      },
      render: (args, value) => {
        const lines = Array.isArray(value?.lines) ? value.lines : []
        const text = [value?.message ?? '', ...lines].filter((line) => typeof line === 'string' && line !== '').join('\n')
        return [{ type: 'text', text: text === '' ? '好了。' : text }]
      }
    },
    execute: async (args, execution) => {
      const action = String(args?.action ?? '').trim()
      const session = execution?.agent?.session
      const currentSessionId = session?.header?.id ?? session?.id ?? null
      // 专用会话要跟当前会话用同一个工作目录和同一个人设预设，聊天体验才一致。
      const headCwd = typeof session?.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : null
      const headPreset = typeof session?.header?.agentPreset === 'string' && session.header.agentPreset !== '' ? session.header.agentPreset : null

      try {
        if (action === 'status') {
          const state = loadState()
          return { ok: true, message: '主动聊天模式当前设置：', lines: renderStatusLines(state) }
        }

        if (action === 'configure') {
          const patch = {}
          for (const key of ['enabled', 'intervalMinutes', 'jitterMinutes', 'maxPingsPerDay', 'maxMessagesPerPing', 'activeWindows', 'dndWindows', 'topics', 'customInstructions']) {
            if (args?.[key] !== undefined) patch[key] = args[key]
          }
          if (args?.target !== undefined) patch.target = { ...args.target }
          // 说「绑定到会话」但没给 id 时，用当前会话（applyConfiguration 里处理）。
          const state = await applyConfiguration(patch, { currentSessionId, headCwd, headPreset, source: 'tool' })
          return {
            ok: true,
            message: '设置已更新。',
            lines: renderStatusLines(state)
          }
        }

        if (action === 'bind') {
          const kind = args?.target?.kind === 'session' ? 'session' : 'dedicated'
          const wanted = kind === 'session'
            ? String(args?.target?.sessionId ?? currentSessionId ?? '').trim()
            : ''
          if (kind === 'session' && wanted === '') {
            return { ok: false, message: '要绑定会话，但拿不到当前会话 id —— 请显式传 target.sessionId。' }
          }
          const state = await applyConfiguration(
            { target: kind === 'session' ? { kind: 'session', sessionId: wanted } : { kind: 'dedicated' } },
            { currentSessionId, headCwd, headPreset, source: 'bind' }
          )
          return {
            ok: true,
            message: kind === 'dedicated'
              ? '已改成专用会话：第一次推送时会自动新建一个会话并一直用下去（在会话列表里能找到它）。'
              : `已绑定到会话 ${wanted}。`,
            lines: renderStatusLines(state)
          }
        }

        if (action === 'ping') {
          const state = loadState()
          if (!state.settings.enabled) {
            return { ok: false, message: '主动聊天还是关闭的：先 configure 把 enabled 设为 true。' }
          }
          const okDelivered = await deliver(state)
          return okDelivered
            ? { ok: true, message: '已经让她现在去找你说话了。', lines: renderStatusLines(loadState()) }
            : { ok: false, message: `这次没发出去：${loadState().lastError ?? '未知原因'}（详见 chatmode.log）` }
        }

        if (action === 'reset') {
          await resetAll()
          return { ok: true, message: '已清空：关闭主动聊天，删掉调度任务，恢复默认设置。' }
        }

        return { ok: false, message: `不认识的 action：${action}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`tool error ${action}: ${message}`)
        return { ok: false, message: `操作失败：${message}` }
      }
    }
  }))

  // ---------------------------------------------------------------------
  // 设置页接口（同源 HTTP）
  // ---------------------------------------------------------------------

  ctx.effect(() => {
    const web = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (web === undefined || typeof web.register !== 'function') {
      log('webServer unavailable: settings page API disabled')
      return () => {}
    }
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    return registerApi(web, connection, {
      getState: () => snapshot(loadState()),
      applyPatch: async (patch) => {
        const state = await applyConfiguration(patch, { source: 'settings-page' })
        return { ok: true, message: '设置已保存', ...snapshot(state) }
      },
      ping: async () => {
        const state = loadState()
        if (!state.settings.enabled) {
          return { ok: false, error: '主动聊天还是关着的：先打开开关并保存。' }
        }
        const delivered = await deliver(state)
        return delivered
          ? { ok: true, message: '已发出一条。', ...snapshot(loadState()) }
          : { ok: false, error: loadState().lastError ?? '投递失败' }
      },
      reset: async () => {
        const state = await resetAll()
        return { ok: true, message: '已恢复默认。', ...snapshot(state) }
      }
    }, log)
  })

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------

  ctx.effect(() => {
    // 首次 tick 稍微等一下，别和宿主启动抢资源。
    const first = ctx.timer.timeout(() => { void tick() }, 3_000)
    const beat = ctx.timer.interval(() => { void tick() }, TICK_MS)
    log('chatmode started')
    return () => {
      if (typeof first === 'function') first()
      if (typeof beat === 'function') beat()
    }
  })
}
