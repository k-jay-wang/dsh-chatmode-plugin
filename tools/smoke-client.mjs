/**
 * 客户端 bundle 冒烟测试：用最小 React 桩加载 client.js，
 * 确认 factory 不抛错、slot 注册正确、设置面板能渲染出结构。
 *
 * 桩的要点：每次调用函数组件时压入一个独立的 hook 帧，
 * 这样不同组件的 useState 不会串（真实 React 的 hook 链也是按组件隔离的）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

const registered = []
const window = { __ModuleLoader__: { load: (entry) => registered.push(entry) } }

const frames = []
let seed = {}

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
  Fragment: 'fragment',
  useState(initial) {
    const frame = frames[frames.length - 1]
    const idx = frame.cursor++
    if (!(idx in frame.values)) frame.values[idx] = typeof initial === 'function' ? initial() : initial
    return [frame.values[idx], (next) => { frame.values[idx] = typeof next === 'function' ? next(frame.values[idx]) : next }]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(initial) { return { current: initial } },
  startTransition(fn) { fn() }
}

/** 调用一个函数组件：压帧、填种子、渲染、弹帧。 */
function callComponent(fn, props) {
  const frame = { cursor: 0, values: [] }
  const seeded = seed[fn.name]
  if (Array.isArray(seeded)) frame.values = seeded.slice()
  frames.push(frame)
  try {
    return fn(props)
  } finally {
    frames.pop()
  }
}

/** 极简渲染器：函数组件直接调用，元素继续展开。 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'function') return render(callComponent(node, {}))
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') return render(callComponent(node.type, node.props ?? {}))
    if (node.type === 'fragment') return render(node.props?.children ?? [])
    return { type: node.type, props: decorate(node.props ?? {}) }
  }
  return node
}

function decorate(props) {
  const out = {}
  for (const [key, value] of Object.entries(props)) {
    if (key !== 'children') out[key] = value
  }
  out.children = Array.isArray(props.children) ? props.children.map(render) : render(props.children)
  return out
}

const context = vm.createContext({
  window,
  document: {
    head: { appendChild() {}, removeChild() {} },
    createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, textContent: '' }),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {}
  },
  console,
  fetch: async () => { throw new Error('no network in smoke test') },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
})
context.globalThis = context

new vm.Script(source, { filename: file }).runInContext(context)
if (registered.length !== 1) throw new Error(`expected 1 registration, got ${registered.length}`)
const entry = registered[0]
if (entry.id !== 'dsh-chatmode-plugin') throw new Error(`bad id ${entry.id}`)

const mod = entry.factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require ${name}`)
})
console.log('exports:', Object.keys(mod))
if (typeof mod.apply !== 'function') throw new Error('apply missing')

const slots = []
const effects = []
const locales = []
const fakeCtx = {
  effect: (fn) => {
    const cleanup = fn()
    effects.push(cleanup)
    return () => { if (typeof cleanup === 'function') cleanup() }
  },
  on() {},
  get: () => undefined,
  slots: {
    inject(name, cb) { cb() },
    register(decl, component) { slots.push({ decl, component }) }
  },
  locale: {
    register(ns, dict) { locales.push({ ns, dict }) },
    bind: (ns) => (key) => {
      const found = locales.find((entry) => entry.ns === ns)
      const dict = (found && found.dict && found.dict.zh) || {}
      return typeof dict[key] === 'string' ? dict[key] : key
    }
  }
}
mod.apply(fakeCtx)
console.log('slots:', slots.map((s) => `${s.decl.name}#${s.decl.id}`))
console.log('locales:', locales.map((l) => Object.keys(l.dict).join(',')))

const section = slots.find((s) => s.decl.name === 'settings.section')
if (!section) throw new Error('settings.section not registered')

const zhDict = locales[0]?.dict?.zh ?? {}
const props = { t: (key) => (typeof zhDict[key] === 'string' ? zhDict[key] : key), close() {} }

// 第一次渲染是「读取中」。
const loading = render(section.component(props))
const loadingFlat = JSON.stringify(loading, (k, v) => (typeof v === 'function' ? '[fn]' : v))
console.log('loading tree chars:', loadingFlat.length)
if (loadingFlat.includes('出错了')) throw new Error('loading state rendered the error banner')

// 把 Panel 的 hook 帧预先填成「已加载」状态，再渲染一次，看到真正的面板。
const snapshot = {
  settings: {
    enabled: true,
    intervalMinutes: 30,
    jitterMinutes: 5,
    maxPingsPerDay: 12,
    maxMessagesPerPing: 2,
    activeWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '18:00' }],
    dndWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '12:30', end: '13:30' }],
    topics: ['关心他吃没吃', '问他工作做完没有'],
    customInstructions: '',
    target: { kind: 'dedicated', sessionId: null, cwd: '/tmp/ws', agentPreset: 'cordis' }
  },
  runtime: {
    enabled: true,
    taskId: 'schedule-test',
    targetSessionId: 'session-test',
    lastPingAt: '2026-11-19T08:00:00.000Z',
    nextPingAt: '2026-11-19T09:00:00.000Z',
    counts: { date: '2026-11-19', count: 3 },
    lastError: null,
    now: '2026-11-19T08:30:00.000Z'
  }
}
seed = { Panel: [snapshot, JSON.parse(JSON.stringify(snapshot.settings)), false, '', null] }
const tree = render(section.component(props))
const flat = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
console.log('loaded tree chars:', flat.length)
for (const needle of ['运行状态', '保存', '现在跟我说句话', '免打扰', '话题', '发送到哪']) {
  if (!flat.includes(needle)) throw new Error(`missing text ${needle}`)
}
if (!flat.includes('schedule-test')) throw new Error('task id not rendered')
if (!flat.includes('专用会话')) throw new Error('target text not rendered')
console.log('SMOKE_OK')
