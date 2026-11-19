/**
 * 本地接口的冒烟测试：确认 /api/chatmode/* 确实走宿主认证，
 * 并且认证服务缺失/抛错时一律拒绝（不降级成裸接口）。
 *
 * 用法：node tools/smoke-api.mjs
 */

import { Readable } from 'node:stream'
import { registerApi } from '../lib/web.js'

const log = () => {}
const state = {
  settings: { enabled: true },
  runtime: { nextPingAt: null }
}

function makeApi() {
  return {
    getState: () => state,
    applyPatch: async () => ({ ok: true, message: 'saved' }),
    ping: async () => ({ ok: true, message: 'sent' }),
    reset: async () => ({ ok: true, message: 'reset' })
  }
}

function makeWeb() {
  const routes = []
  const web = { register: (route) => { routes.push(route); return () => {} } }
  return { web, routes }
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body }
  }
}

function makeReq(method, headers, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.headers = headers
  stream.destroy = () => {}
  return stream
}

function routeTo(routes, path) {
  const found = routes.find((route) => route.path === path)
  if (found === undefined) throw new Error(`missing route ${path}`)
  return found
}

function check(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  console.log(`ok  ${label}`)
}

/** 认证服务的假实现：x-test-auth: ok → 放行；bad → 401；缺省 → 抛错。 */
function fakeConnection() {
  return {
    requestRejection(request) {
      const value = request.headers['x-test-auth']
      if (value === 'ok') return undefined
      if (value === 'bad') return 401
      throw new Error('connection not ready')
    }
  }
}

async function main() {
  const { web, routes } = makeWeb()
  let disposed = false
  const dispose = registerApi(web, fakeConnection(), makeApi(), log)
  if (typeof dispose !== 'function') throw new Error('registerApi must return a disposer')

  const stateRoute = routeTo(routes, '/api/chatmode/state')
  const actionRoute = routeTo(routes, '/api/chatmode/action')

  let res = makeRes()
  await stateRoute.handler(makeReq('GET', {}), res)
  check('no auth header → 401', res.status, 401)

  res = makeRes()
  await stateRoute.handler(makeReq('GET', { 'x-test-auth': 'bad' }), res)
  check('rejected header → 401', res.status, 401)

  res = makeRes()
  await stateRoute.handler(makeReq('GET', { 'x-test-auth': 'ok' }), res)
  check('admitted → 200', res.status, 200)
  check('admitted body ok', JSON.parse(res.body).ok, true)

  res = makeRes()
  await stateRoute.handler(makeReq('POST', { 'x-test-auth': 'ok' }), res)
  check('wrong method → 405', res.status, 405)

  res = makeRes()
  await actionRoute.handler(makeReq('POST', { 'x-test-auth': 'ok' }, { action: 'ping' }), res)
  check('action ping → 200', res.status, 200)
  check('action ping ok', JSON.parse(res.body).ok, true)

  res = makeRes()
  await actionRoute.handler(makeReq('POST', { 'x-test-auth': 'ok' }, { action: 'nope' }), res)
  check('unknown action → 400', res.status, 400)

  // 没有 connection：全部拒绝。
  const missing = makeWeb()
  registerApi(missing.web, undefined, makeApi(), log)
  res = makeRes()
  await routeTo(missing.routes, '/api/chatmode/state').handler(makeReq('GET', { 'x-test-auth': 'ok' }), res)
  check('missing connection → 401', res.status, 401)

  // 注销函数可用且幂等。
  dispose()
  dispose()
  disposed = true
  check('disposer callable', disposed, true)

  console.log('SMOKE_API_OK')
}

main().catch((error) => {
  console.error('SMOKE_API_FAILED:', error)
  process.exitCode = 1
})
