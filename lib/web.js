/**
 * 设置页 → 宿主 的本地 HTTP 接口。
 *
 * 浏览器半侧只走同源 HTTP（/api/chatmode/*），不依赖任何 RPC：
 * 插件卸载/重装时页面最多拿到 404，不会把客户端卡死。
 *
 * 认证走宿主自己的「连接」服务，不自己发明一套令牌：
 *   - 每个请求先交给 ctx.connection.requestRejection()（Host/Origin 校验 +
 *     浏览器会话认证），被拒就直接 401/403；
 *   - 拿不到 connection（非 Web 组合、或启动早期）一律拒绝，不做退让；
 *   - 只监听宿主自己的 webServer（默认 127.0.0.1），请求体上限 64 KiB。
 */

export const API_PREFIX = '/api/chatmode'

/** 设置页只传配置，64 KiB 足够；挡住手滑和恶意大包。 */
const MAX_BODY = 64 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolve(value !== null && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 注册 /api/chatmode/*。
 * @param {object} web  ctx.webServer（或 ctx.get('webServer') 的结果）
 * @param {object | undefined} connection  ctx.connection，用于宿主认证；缺失时全部拒绝
 * @param {{getState: Function, applyPatch: Function, ping: Function, reset: Function}} api
 * @param {(message: string) => void} log
 * @returns {() => void} 统一注销
 */
export function registerApi(web, connection, api, log) {
  const disposers = []

  /** 返回 401/403 表示拒绝，undefined 表示放行。 */
  function rejectionOf(req) {
    if (connection === undefined || connection === null) return 401
    try {
      const value = connection.requestRejection({ headers: req.headers })
      return value === 401 || value === 403 ? value : undefined
    } catch {
      // 认证服务异常时宁可不服务，也不降级成裸接口。
      return 401
    }
  }

  function route(path, method, handler) {
    disposers.push(web.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const rejection = rejectionOf(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, error: 'unauthorized' })
          return
        }
        if (req.method !== method) {
          sendJson(res, 405, { ok: false, error: `只接受 ${method}` })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`api ${path} failed: ${message}`)
          sendJson(res, 500, { ok: false, error: message })
        }
      }
    }))
  }

  route(`${API_PREFIX}/state`, 'GET', (req, res) => {
    sendJson(res, 200, { ok: true, ...api.getState() })
  })

  route(`${API_PREFIX}/settings`, 'POST', async (req, res) => {
    const body = await readBody(req)
    const patch = body?.patch
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: 'patch 必须是对象' })
      return
    }
    const result = await api.applyPatch(patch)
    sendJson(res, result.ok === false ? 400 : 200, { ...result, ...api.getState() })
  })

  route(`${API_PREFIX}/action`, 'POST', async (req, res) => {
    const body = await readBody(req)
    const action = String(body?.action ?? '')
    if (action === 'ping') {
      const result = await api.ping()
      sendJson(res, result.ok === false ? 400 : 200, { ...result, ...api.getState() })
      return
    }
    if (action === 'reset') {
      const result = await api.reset()
      sendJson(res, 200, { ...result, ...api.getState() })
      return
    }
    sendJson(res, 400, { ok: false, error: `不认识的 action：${action}` })
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 注销失败不致命。
      }
    }
  }
}
