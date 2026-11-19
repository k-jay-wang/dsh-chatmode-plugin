/**
 * lib/settings.js —— DSHChatMode 的配置与时间规划。
 *
 * 设计取舍：配置**不**走 DSH 的插件 Config（那需要客户端表单，改一次还要重启插件），
 * 而是和 dsh-agent-soul 一样存在 DSH 主目录下的 JSON 里：
 *
 *   <DSH_HOME>/chatmode/state.json   —— 配置 + 运行时状态（任务 id、目标会话、上次/下次推送时间）
 *   <DSH_HOME>/chatmode/chatmode.log —— 人可读的运行日志（轮转）
 *
 * 好处：用户在聊天里让模型用 `chatmode` 工具改，或者直接拿编辑器改文件，都立刻生效；
 * 坏处：没有图形表单 —— 但用户要的就是「在聊天里设」。
 *
 * 时间规划：把「活跃时段」和「免打扰时段」看成两组按周重复的分钟区间，
 * 逐分钟寻找下一个允许的时刻（最多往后找 8 天）。逐分钟很土，但窗口边界、
 * 跨午夜、周末差异全都天然正确，比手写区间求交好懂也好维护。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH 主目录：优先环境变量，退回 ~/.dsh（桌面版的实际位置）。 */
export const DSH_HOME = (() => {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return path.join(os.homedir(), '.dsh')
})()

export const DIR = path.join(DSH_HOME, 'chatmode')
export const STATE_FILE = path.join(DIR, 'state.json')
export const LOG_FILE = path.join(DIR, 'chatmode.log')

/** 一天的分钟数。 */
const DAY_MINUTES = 24 * 60

/** 扫窗口时最多往后看几天。 */
const HORIZON_DAYS = 8

/** 单日推送上限的硬顶，避免把上限设成天文数字。 */
const MAX_PINGS_HARD_CAP = 200

/** 内容话题池的默认值：照顾、八卦、身体、天气、工作、表情、想念。 */
export const DEFAULT_TOPICS = [
  '关心他吃没吃、累不累、有没有好好休息',
  '问点没营养的八卦：同事、朋友、热搜、他最近在追的东西',
  '聊聊他的身体：睡眠、腰背、嗓子、今天状态怎么样',
  '说说天气：降温、下雨、要不要带伞、今天适不适合出门',
  '问他手上的活干完没有、今天还剩什么事、要不要搭把手',
  '什么正事都不说，只发一个表情，冒个泡',
  '说一句你想他了，或者你自己有点无聊'
]

/** 每隔几天重置一次日志，防止无限增长（按大小轮转）。 */
const LOG_MAX_BYTES = 256 * 1024

/** 全量默认配置；state.json 里缺的字段都用它补齐（老版本升级也能读）。 */
export function defaultSettings() {
  return {
    version: 1,
    enabled: false,
    intervalMinutes: 60,
    jitterMinutes: 8,
    maxPingsPerDay: 12,
    activeWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '22:00' }],
    dndWindows: [
      { days: [1, 2, 3, 4, 5, 6, 7], start: '12:30', end: '13:30' },
      { days: [1, 2, 3, 4, 5, 6, 7], start: '23:00', end: '08:00' }
    ],
    topics: [...DEFAULT_TOPICS],
    customInstructions: '',
    maxMessagesPerPing: 2,
    target: { kind: 'dedicated', sessionId: null, agentPreset: null, cwd: null }
  }
}

/** 运行时状态的默认值（与配置分开存，避免用户改文件时踩到内部字段）。 */
export function defaultState() {
  return {
    version: 1,
    settings: defaultSettings(),
    targetSessionId: null,
    taskId: null,
    taskCreatedAt: null,
    lastPingAt: null,
    nextPingAt: null,
    counts: { date: '', count: 0 },
    lastError: null,
    updatedAt: null
  }
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true })
}

/** 原子写：先写临时文件再 rename，崩溃时不会留下半个 JSON。 */
function writeJsonAtomic(file, value) {
  ensureDir()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 把数组/对象合并进默认值：数组整体替换，对象逐键递归。 */
function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) {
    return Array.isArray(value) ? value : defaults
  }
  if (defaults !== null && typeof defaults === 'object') {
    const out = {}
    const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    for (const key of Object.keys(defaults)) out[key] = mergeDefaults(source[key], defaults[key])
    // 允许用户自带扩展键（保留，但不知情就不校验）。
    for (const key of Object.keys(source)) if (!(key in out)) out[key] = source[key]
    return out
  }
  return value === undefined ? defaults : value
}

let cached = { mtimeMs: -1, state: null }

/**
 * 读状态；文件被外部改过（mtime 变了）就重新读。
 * @returns {ReturnType<typeof defaultState>}
 */
export function loadState() {
  let mtimeMs = -1
  try {
    mtimeMs = fs.statSync(STATE_FILE).mtimeMs
  } catch {
    mtimeMs = -1
  }
  if (cached.state !== null && cached.mtimeMs === mtimeMs) return cached.state

  const raw = mtimeMs === -1 ? undefined : readJson(STATE_FILE)
  const merged = mergeDefaults(raw, defaultState())
  // 老文件可能整个是「配置」而不是「状态」，认一下：有 enabled/intervalMinutes 就当配置。
  if (raw && raw.settings === undefined && (raw.enabled !== undefined || raw.intervalMinutes !== undefined)) {
    merged.settings = sanitizeSettings(mergeDefaults(raw, defaultSettings()))
  } else {
    merged.settings = sanitizeSettings(merged.settings)
  }
  merged.counts = normalizeCounts(merged.counts)
  cached = { mtimeMs, state: merged }
  return merged
}

/**
 * 保存状态。写入后刷新缓存里的 mtime，避免下一次读又整份重读。
 * @param {ReturnType<typeof defaultState>} state
 */
export function saveState(state) {
  state.updatedAt = new Date().toISOString()
  state.settings = sanitizeSettings(state.settings)
  writeJsonAtomic(STATE_FILE, state)
  try {
    cached = { mtimeMs: fs.statSync(STATE_FILE).mtimeMs, state }
  } catch {
    cached = { mtimeMs: -1, state: null }
  }
  return state
}

/** 只改配置并落盘，返回完整状态。 */
export function patchSettings(patch) {
  const state = loadState()
  state.settings = sanitizeSettings(mergeDefaults(deepMerge(state.settings, patch), defaultSettings()))
  saveState(state)
  return state
}

function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch
  const out = base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value)
  return out
}

// ---------------------------------------------------------------------------
// 配置清洗
// ---------------------------------------------------------------------------

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return [1, 2, 3, 4, 5, 6, 7]
  const out = []
  for (const day of days) {
    const n = Math.round(Number(day))
    if (Number.isFinite(n) && n >= 1 && n <= 7 && !out.includes(n)) out.push(n)
  }
  return out.length > 0 ? out.sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7]
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

function normalizeTime(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = TIME_RE.exec(text)
  if (match === null) return fallback
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

function normalizeWindows(windows, fallback) {
  if (!Array.isArray(windows)) return fallback
  const out = []
  for (const item of windows) {
    if (item === null || typeof item !== 'object') continue
    out.push({
      days: normalizeDays(item.days),
      start: normalizeTime(item.start, '09:00'),
      end: normalizeTime(item.end, '22:00')
    })
  }
  return out
}

/** 清洗并补齐配置；非法值退回默认，不抛错（宁可用默认也别让插件起不来）。 */
export function sanitizeSettings(input) {
  const base = defaultSettings()
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const targetSource = source.target !== null && typeof source.target === 'object' ? source.target : {}

  const topics = Array.isArray(source.topics)
    ? source.topics.map((t) => String(t ?? '').trim()).filter((t) => t !== '').slice(0, 40)
    : base.topics

  return {
    version: 1,
    enabled: source.enabled === true,
    intervalMinutes: clampInt(source.intervalMinutes, base.intervalMinutes, 5, 24 * 60),
    jitterMinutes: clampInt(source.jitterMinutes, base.jitterMinutes, 0, 60),
    maxPingsPerDay: clampInt(source.maxPingsPerDay, base.maxPingsPerDay, 1, MAX_PINGS_HARD_CAP),
    activeWindows: normalizeWindows(source.activeWindows, base.activeWindows),
    dndWindows: normalizeWindows(source.dndWindows, base.dndWindows),
    topics: topics.length > 0 ? topics : base.topics,
    customInstructions: typeof source.customInstructions === 'string' ? source.customInstructions.slice(0, 4000) : '',
    maxMessagesPerPing: clampInt(source.maxMessagesPerPing, base.maxMessagesPerPing, 1, 3),
    target: {
      kind: targetSource.kind === 'session' ? 'session' : 'dedicated',
      sessionId: typeof targetSource.sessionId === 'string' && targetSource.sessionId !== '' ? targetSource.sessionId : null,
      agentPreset: typeof targetSource.agentPreset === 'string' && targetSource.agentPreset !== '' ? targetSource.agentPreset : null,
      cwd: typeof targetSource.cwd === 'string' && targetSource.cwd !== '' ? targetSource.cwd : null
    }
  }
}

function normalizeCounts(counts) {
  const date = typeof counts?.date === 'string' ? counts.date : ''
  const count = Number.isFinite(Number(counts?.count)) ? Math.max(0, Math.round(Number(counts.count))) : 0
  return { date, count }
}

// ---------------------------------------------------------------------------
// 时间判断
// ---------------------------------------------------------------------------

/** 本地日期键 YYYY-MM-DD（按用户电脑时区，跟 DSH 其余部分一致）。 */
export function localDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** ISO 周几：周一 1 … 周日 7。 */
export function isoDay(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 某个时刻是否落在一条窗口里；跨午夜的窗口按「当天开始、次日结束」理解。 */
export function windowContains(win, date) {
  const start = toMinutes(win.start)
  const end = toMinutes(win.end)
  if (start === end) return false
  const mins = minutesOfDay(date)
  const today = isoDay(date)
  const yesterday = today === 1 ? 7 : today - 1

  if (start < end) return win.days.includes(today) && mins >= start && mins < end
  // 跨午夜：今天 [start, 24:00) 属于今天的 days；[00:00, end) 属于昨天的 days。
  return (win.days.includes(today) && mins >= start) || (win.days.includes(yesterday) && mins < end)
}

/** 此刻是否允许主动说话。活跃窗口为空视为「全天活跃」，免打扰优先。 */
export function isAllowedNow(settings, date) {
  const active = settings.activeWindows.length === 0
    ? true
    : settings.activeWindows.some((win) => windowContains(win, date))
  if (!active) return false
  return !settings.dndWindows.some((win) => windowContains(win, date))
}

/**
 * 从 from 开始找下一个允许的时刻（分钟精度），最多找 HORIZON_DAYS 天。
 * 找不到返回 null（配置永远不重合时才会发生）。
 */
export function nextAllowedAt(settings, from) {
  const probe = new Date(from.getTime())
  probe.setSeconds(0, 0)
  for (let i = 0; i < HORIZON_DAYS * DAY_MINUTES; i += 1) {
    if (isAllowedNow(settings, probe)) return new Date(probe.getTime())
    probe.setMinutes(probe.getMinutes() + 1)
  }
  return null
}

/**
 * 规划下一次推送时间。
 *
 * 节奏：上一次推送 + 间隔（没推送过就是「现在 + 较短的一段」），
 * 加上 0~jitter 分钟的随机抖动，再推到下一个允许的时刻；
 * 当日次数用完了就顺延到次日的第一个允许时刻。
 */
export function planNextPing(settings, state, now = new Date()) {
  if (!settings.enabled) return null
  const intervalMs = settings.intervalMinutes * 60_000
  const jitterMs = settings.jitterMinutes * 60_000

  const last = typeof state.lastPingAt === 'string' ? Date.parse(state.lastPingAt) : Number.NaN
  let base = Number.isFinite(last)
    ? last + intervalMs
    : now.getTime() + Math.min(intervalMs, 10 * 60_000)

  // 关机/睡眠很久之后不要一醒来就连发：至少给 30 秒缓冲，并按新周期重新起算。
  if (Number.isFinite(last) && base < now.getTime() - intervalMs) base = now.getTime()
  base = Math.max(base, now.getTime() + 30_000)
  base += Math.random() * jitterMs

  const counts = normalizeCounts(state.counts)
  const today = localDateKey(new Date(base))
  const usedToday = counts.date === today ? counts.count : 0
  if (usedToday >= settings.maxPingsPerDay) {
    const tomorrow = new Date(base)
    tomorrow.setHours(0, 5, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    base = tomorrow.getTime()
  }

  const next = nextAllowedAt(settings, new Date(base))
  return next === null ? null : next.toISOString()
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

/** 追加一行运行日志；超过上限就轮转成 .1。日志只写本地，不外发。 */
export function log(line) {
  try {
    ensureDir()
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
    const size = fs.statSync(LOG_FILE).size
    if (size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // 日志失败不影响主流程。
  }
}
