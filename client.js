/**
 * client.js —— 浏览器半侧：设置 → 「主动聊天」页。
 *
 * 单个手写的 __ModuleLoader__ bundle（不跑构建）：
 *   - 只注册一个 settings.section（id=chatmode），和一个同名导航图标；
 *   - 与宿主只走同源 HTTP（/api/chatmode/*）：GET 状态、POST 设置、POST 立即发一条；
 *   - 样式全部走 --dsw-alias-* 主题变量，亮色/暗色自动跟随；
 *   - 设置页只是「编辑 + 保存」，排期与投递仍然由宿主侧的节拍器负责。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chatmode-plugin',
  factory: function (require) {
    // 宿主只给 require，不给 CommonJS 的 module/exports —— 这两行不能省。
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var NS = 'dsh-chatmode'
    var API = '/api/chatmode'

    var DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

// ---- 文案 -------------------------------------------------------------

    var ZH = {
      kicker: '主动聊天',
      title: 'DSHChatMode',
      subtitle: '按你设定的节奏，让模型自己来找你说话。改完点「保存」才会生效。',
      loading: '正在读取设置…',
      loadError: '读取设置失败：',
      authError: '没有通过 DSH 的浏览器认证：请从启动 DSH 时打印的地址重新打开页面，再进入设置。',
      retry: '重试',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，新的节奏立即生效。',
      ping: '现在跟我说句话',
      pingBusy: '正在找她…',
      pingOk: '已经发过去了，去会话里看看。',
      reset: '恢复默认',
      resetBusy: '恢复中…',
      resetDone: '已恢复默认设置并关闭主动聊天。',
      resetConfirm: '恢复默认会关闭主动聊天、删掉占位任务和专用会话绑定。确定吗？',
      statusTitle: '运行状态',
      statusRunning: '运行中',
      statusPaused: '已暂停',
      statusOff: '关着',
      nextPing: '下一次',
      lastPing: '上一次',
      todayCount: '今日已发',
      targetLabel: '发送到',
      targetDedicated: '专用会话',
      targetDedicatedNew: '专用会话（还没创建，第一次发消息时新建）',
      targetSession: '绑定的会话',
      taskLabel: '占位任务',
      none: '—',
      lastError: '最近的问题',
      paceTitle: '节奏',
      enabledLabel: '打开主动聊天',
      enabledHint: '关掉后不再排期，也不会发任何消息。',
      intervalLabel: '间隔',
      intervalHint: '两次主动说话之间至少隔这么久（最小 5 分钟）。',
      intervalCustom: '自定义',
      jitterLabel: '随机抖动',
      jitterHint: '在间隔基础上随机多等 0-N 分钟，避免秒表感。',
      dailyLabel: '每日上限',
      dailyHint: '一天最多主动说几次，到量就等明天。',
      messagesLabel: '每次最多几条',
      messagesHint: '同一条回复里最多分几段，1-3。',
      minutesUnit: '分钟',
      timesUnit: '次',
      linesUnit: '条',
      windowsTitle: '活跃与免打扰',
      activeLabel: '活跃时段',
      activeHint: '只有落在这些时段里才会说话；留空表示全天。',
      activeEmpty: '没有限制：全天都可以找你。点下面「添加时段」可以收紧。',
      dndLabel: '免打扰',
      dndHint: '优先级高于活跃时段：落在里面的时间一律不发。',
      dndEmpty: '没有免打扰时段。',
      addWindow: '添加时段',
      removeWindow: '删除这个时段',
      daysEvery: '每天',
      topicsTitle: '聊什么',
      topicsLabel: '话题池',
      topicsHint: '一行一个，写具体一点。留空就用默认的那几类。',
      instructionsLabel: '额外口味',
      instructionsHint: '比如「别总问吃饭」「可以损我两句」「多用表情」。',
      targetTitle: '发送到哪',
      targetHint: '专用会话是插件自己建的一个会话，第一次发消息时创建，之后一直用它，你可以在会话列表里找到它。',
      targetDedicatedDesc: '新建一个专用会话，之后一直在这里聊。',
      targetSessionDesc: '往一个已有的会话里发，比如你现在这个。',
      sessionIdLabel: '会话 ID',
      sessionIdHint: '在对话框里说「就绑在这个会话里」会自动填好；也可以手动粘贴 session-… 开头的 id。',
      footerHint: '推送只是往目标会话投一条定时提醒，内容由那边的人设生成，所以语气会跟你平时的对话一致。',
      dirty: '有未保存的修改',
      invalidInterval: '间隔要在 5 到 1440 分钟之间。',
      invalidSession: '绑定已有会话时，要填一个会话 ID。',
      invalidWindow: '时段要有开始和结束时间。',
      pinned: '已固定'
    }

    var EN = {
      kicker: 'PROACTIVE CHAT',
      title: 'DSHChatMode',
      subtitle: 'Let the model reach out on the rhythm you set. Save to apply changes.',
      loading: 'Loading settings…',
      loadError: 'Could not load settings: ',
      authError: 'Not authenticated by DSH: reopen the URL that DSH printed on launch, then open Settings again.',
      retry: 'Retry',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The new rhythm applies immediately.',
      ping: 'Say something to me now',
      pingBusy: 'Finding them…',
      pingOk: 'Sent. Check the conversation.',
      reset: 'Reset to defaults',
      resetBusy: 'Resetting…',
      resetDone: 'Defaults restored; proactive chat is off.',
      resetConfirm: 'Reset turns proactive chat off and removes the placeholder task and session binding. Continue?',
      statusTitle: 'Run status',
      statusRunning: 'Active',
      statusPaused: 'Paused',
      statusOff: 'Off',
      nextPing: 'Next',
      lastPing: 'Last',
      todayCount: 'Today',
      targetLabel: 'Delivers to',
      targetDedicated: 'Dedicated chat',
      targetDedicatedNew: 'Dedicated chat (created with the first message)',
      targetSession: 'Bound conversation',
      taskLabel: 'Placeholder task',
      none: '—',
      lastError: 'Last problem',
      paceTitle: 'Rhythm',
      enabledLabel: 'Enable proactive chat',
      enabledHint: 'When off, nothing is scheduled and nothing is sent.',
      intervalLabel: 'Interval',
      intervalHint: 'Minimum gap between proactive messages (5 min at least).',
      intervalCustom: 'Custom',
      jitterLabel: 'Jitter',
      jitterHint: 'Wait an extra random 0-N minutes so it does not feel like a metronome.',
      dailyLabel: 'Daily cap',
      dailyHint: 'Maximum proactive messages per day.',
      messagesLabel: 'Lines per message',
      messagesHint: 'At most this many short lines, 1-3.',
      minutesUnit: 'min',
      timesUnit: 'times',
      linesUnit: 'lines',
      windowsTitle: 'Active and quiet hours',
      activeLabel: 'Active hours',
      activeHint: 'Only speak inside these windows; empty means all day.',
      activeEmpty: 'No restriction: any hour works. Add a window to narrow it.',
      dndLabel: 'Do not disturb',
      dndHint: 'Wins over active hours: nothing is sent inside these windows.',
      dndEmpty: 'No quiet hours.',
      addWindow: 'Add window',
      removeWindow: 'Remove this window',
      daysEvery: 'every day',
      topicsTitle: 'What to talk about',
      topicsLabel: 'Topic pool',
      topicsHint: 'One per line. Empty means the built-in set.',
      instructionsLabel: 'Extra flavour',
      instructionsHint: 'For example: stop asking about food, tease me a little, use emoji.',
      targetTitle: 'Where it goes',
      targetHint: 'The dedicated chat is a conversation this plugin creates with its first message and keeps using. It shows up in your session list.',
      targetDedicatedDesc: 'Create a dedicated conversation and keep using it.',
      targetSessionDesc: 'Deliver into an existing conversation, such as this one.',
      sessionIdLabel: 'Session ID',
      sessionIdHint: 'Say "bind this conversation" in chat to fill it automatically, or paste an id starting with session-.',
      footerHint: 'A delivery is a scheduled reminder in the target conversation; the text is written by that conversation persona, so the voice matches your normal chats.',
      dirty: 'Unsaved changes',
      invalidInterval: 'Interval must be between 5 and 1440 minutes.',
      invalidSession: 'Binding an existing conversation needs a session ID.',
      invalidWindow: 'Every window needs a start and an end.',
      pinned: 'Pinned'
    }

// ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.cm-app{--cm-fg:var(--dsw-alias-label-primary,#1f1c18);--cm-muted:var(--dsw-alias-label-secondary,#6f6558);--cm-faint:var(--dsw-alias-label-secondary,#8a7f6e);--cm-line:var(--dsw-alias-border-l2,#e3daca);--cm-line-soft:var(--dsw-alias-border-l1,#ece5d8);--cm-card:var(--dsw-alias-bg-layer-2,#f7f4ee);--cm-brand:var(--dsw-alias-brand-primary,#1f6feb);--cm-ok:var(--dsw-alias-state-success-primary,#2f6b46);--cm-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);--cm-err:var(--dsw-alias-state-error-primary,#a83a2c);color:var(--cm-fg);font-size:13px;line-height:20px;box-sizing:border-box;max-width:100%;}',
      '.cm-app *{box-sizing:border-box;}',
      '.cm-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:2px 2px 14px;}',
      '.cm-kicker{margin:0 0 2px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--cm-faint);}',
      '.cm-title{margin:0;font-size:18px;font-weight:650;line-height:26px;}',
      '.cm-sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--cm-muted);max-width:56ch;}',
      '.cm-pill{display:inline-flex;align-items:center;gap:6px;margin-left:auto;padding:4px 10px;border-radius:999px;font-size:11.5px;border:1px solid var(--cm-line);color:var(--cm-muted);background:var(--cm-card);white-space:nowrap;}',
      '.cm-pill i{width:7px;height:7px;border-radius:50%;background:#8a8f98;display:inline-block;}',
      '.cm-pill.on{color:var(--cm-ok);border-color:color-mix(in srgb,var(--cm-ok) 35%,transparent);}',
      '.cm-pill.on i{background:var(--cm-ok);}',
      '.cm-body{display:flex;flex-direction:column;gap:12px;}',
      '.cm-card{border:1px solid var(--cm-line-soft);border-radius:14px;background:var(--cm-card);padding:13px 14px;}',
      '.cm-card-h{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;}',
      '.cm-card-t{margin:0;font-size:13px;font-weight:650;}',
      '.cm-card-note{margin-left:auto;font-size:11px;color:var(--cm-faint);}',
      '.cm-field{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:8px 0;border-top:.5px solid var(--cm-line-soft);}',
      '.cm-field:first-of-type{border-top:none;}',
      '.cm-field-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;}',
      '.cm-label{font-size:12.5px;font-weight:550;}',
      '.cm-hint{font-size:11px;line-height:16px;color:var(--cm-faint);}',
      '.cm-field-ctl{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding-top:2px;}',
      '.cm-num{width:66px;text-align:right;padding:4px 7px;border-radius:8px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);font:inherit;font-size:12.5px;}',
      '.cm-num:focus{outline:2px solid color-mix(in srgb,var(--cm-brand) 45%,transparent);outline-offset:0;}',
      '.cm-unit{font-size:11px;color:var(--cm-faint);}',
      '.cm-select{padding:4px 8px;border-radius:8px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);font:inherit;font-size:12.5px;}',
      '.cm-switch{width:40px;height:23px;border-radius:999px;border:1px solid var(--cm-line);background:rgba(127,127,127,.18);position:relative;cursor:pointer;padding:0;flex:0 0 auto;}',
      '.cm-switch-dot{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s ease;}',
      '.cm-switch.on{background:var(--cm-brand);border-color:var(--cm-brand);}',
      '.cm-switch.on .cm-switch-dot{left:19px;}',
      '.cm-kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:12px;border-top:.5px solid var(--cm-line-soft);}',
      '.cm-kv:first-child{border-top:none;}',
      '.cm-kv>span{color:var(--cm-faint);flex:0 0 auto;}',
      '.cm-kv>b{font-weight:500;text-align:right;word-break:break-all;}',
      '.cm-kv b.mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}',
      '.cm-err-text{color:var(--cm-err);}',
      '.cm-wins{display:flex;flex-direction:column;gap:6px;}',
      '.cm-win{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--cm-line-soft);border-radius:10px;background:rgba(127,127,127,.04);}',
      '.cm-days{display:flex;gap:3px;}',
      '.cm-day{width:22px;height:22px;border-radius:6px;border:1px solid var(--cm-line);background:transparent;color:var(--cm-faint);font:inherit;font-size:11px;cursor:pointer;padding:0;}',
      '.cm-day.on{background:color-mix(in srgb,var(--cm-brand) 16%,transparent);border-color:color-mix(in srgb,var(--cm-brand) 45%,transparent);color:var(--cm-brand);font-weight:600;}',
      '.cm-times{display:flex;align-items:center;gap:4px;}',
      '.cm-times input[type=time]{font:inherit;font-size:12px;padding:3px 6px;border-radius:7px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);}',
      '.cm-time-sep{color:var(--cm-faint);}',
      '.cm-x{margin-left:auto;width:22px;height:22px;border-radius:6px;border:none;background:transparent;color:var(--cm-faint);cursor:pointer;font-size:14px;line-height:1;padding:0;}',
      '.cm-x:hover{background:rgba(200,60,60,.14);color:var(--cm-err);}',
      '.cm-add{margin-top:6px;align-self:flex-start;padding:4px 10px;border-radius:8px;border:1px dashed var(--cm-line);background:transparent;color:var(--cm-muted);font:inherit;font-size:11.5px;cursor:pointer;}',
      '.cm-add:hover{border-color:var(--cm-brand);color:var(--cm-brand);}',
      '.cm-empty{margin:4px 0 2px;font-size:11.5px;color:var(--cm-faint);}',
      '.cm-area{width:100%;min-height:64px;resize:vertical;padding:7px 9px;border-radius:9px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);font:inherit;font-size:12.5px;line-height:18px;}',
      '.cm-area:focus{outline:2px solid color-mix(in srgb,var(--cm-brand) 45%,transparent);}',
      '.cm-radio{display:flex;align-items:flex-start;gap:8px;padding:7px 0;cursor:pointer;border-top:.5px solid var(--cm-line-soft);}',
      '.cm-radio:first-of-type{border-top:none;}',
      '.cm-radio input{margin:2px 0 0;}',
      '.cm-radio div{display:flex;flex-direction:column;gap:1px;}',
      '.cm-radio b{font-size:12.5px;font-weight:550;}',
      '.cm-radio small{font-size:11px;color:var(--cm-faint);line-height:16px;}',
      '.cm-input{width:100%;padding:5px 8px;border-radius:8px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);font:inherit;font-size:12px;}',
      '.cm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 0;}',
      '.cm-btn{padding:6px 14px;border-radius:9px;border:1px solid var(--cm-line);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--cm-fg);font:inherit;font-size:12.5px;cursor:pointer;}',
      '.cm-btn:hover{border-color:var(--cm-brand);color:var(--cm-brand);}',
      '.cm-btn:disabled{opacity:.5;cursor:default;}',
      '.cm-btn.primary{background:var(--cm-brand);border-color:var(--cm-brand);color:#fff;}',
      '.cm-btn.primary:hover{color:#fff;filter:brightness(1.05);}',
      '.cm-msg{font-size:11.5px;line-height:17px;}',
      '.cm-msg.ok{color:var(--cm-ok);}',
      '.cm-msg.err{color:var(--cm-err);}',
      '.cm-foot{margin:2px 2px 6px;font-size:11px;line-height:16px;color:var(--cm-faint);}',
      '.cm-skel{height:12px;border-radius:6px;background:rgba(127,127,127,.14);margin:8px 0;}',
      '.cm-skel.w60{width:60%;}.cm-skel.w40{width:40%;}'
    ]

    function ensureStyles() {
      var id = 'dsh-chatmode-styles'
      if (document.getElementById(id) !== null) return function () {}
      var style = document.createElement('style')
      style.id = id
      style.textContent = CSS.join('\n')
      document.head.appendChild(style)
      return function () {
        var el = document.getElementById(id)
        if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
      }
    }

// ---- 同源 API ---------------------------------------------------------

    function request(method, path, body) {
      var init = { method: method, cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(API + path, init).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || data?.ok === false) {
            throw new Error(data?.error ?? data?.message ?? ('HTTP ' + res.status))
          }
          return data
        }, function () {
          throw new Error('HTTP ' + res.status)
        })
      })
    }

    /** 401 给一句能照着做的提示，其它错误原样显示。 */
    function friendly(error, t) {
      var message = error && error.message ? error.message : String(error)
      if (message.indexOf('401') !== -1) return t('authError')
      return message
    }

    function apiGet(path) { return request('GET', path) }
    function apiPost(path, body) { return request('POST', path, body) }

// ---- 小工具 -----------------------------------------------------------

    function clone(value) { return JSON.parse(JSON.stringify(value)) }

    function pad(n) { return n < 10 ? '0' + n : '' + n }

    function fmtTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var date = new Date(iso)
      if (!isFinite(date.getTime())) return '—'
      var today = new Date()
      var sameDay = date.toDateString() === today.toDateString()
      var time = pad(date.getHours()) + ':' + pad(date.getMinutes())
      if (sameDay) return '今天 ' + time
      return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + time
    }

    function asArray(value) { return Array.isArray(value) ? value.slice() : [] }

// ---- 基础控件 ---------------------------------------------------------

    function Card(props) {
      return h('section', { className: 'cm-card' },
        h('div', { className: 'cm-card-h' },
          h('h3', { className: 'cm-card-t' }, props.title),
          props.note ? h('span', { className: 'cm-card-note' }, props.note) : null),
        props.children)
    }

    function Field(props) {
      return h('div', { className: 'cm-field' },
        h('div', { className: 'cm-field-main' },
          h('span', { className: 'cm-label' }, props.label),
          props.hint ? h('span', { className: 'cm-hint' }, props.hint) : null),
        h('div', { className: 'cm-field-ctl' }, props.children))
    }

    function NumberField(props) {
      return h('input', {
        className: 'cm-num',
        type: 'number',
        min: props.min,
        max: props.max,
        step: props.step ?? 1,
        value: String(props.value),
        onChange: function (event) {
          var next = Number(event.target.value)
          props.onChange(Number.isFinite(next) ? next : props.min)
        }
      })
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        className: 'cm-switch' + (props.checked ? ' on' : ''),
        onClick: function () { props.onChange(!props.checked) }
      }, h('span', { className: 'cm-switch-dot' }))
    }

    function DayChip(props) {
      return h('button', {
        type: 'button',
        className: 'cm-day' + (props.on ? ' on' : ''),
        title: DAY_LABELS[props.day - 1],
        onClick: props.onClick
      }, DAY_LABELS[props.day - 1])
    }

    function WindowEditor(props) {
      var windows = asArray(props.windows)

      function update(index, patch) {
        var next = windows.slice()
        next[index] = Object.assign({}, next[index], patch)
        props.onChange(next)
      }

      function remove(index) {
        var next = windows.slice()
        next.splice(index, 1)
        props.onChange(next)
      }

      function add() {
        props.onChange(windows.concat([{ days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '22:00' }]))
      }

      return h('div', { className: 'cm-wins' },
        windows.length === 0 ? h('p', { className: 'cm-empty' }, props.emptyText) : null,
        windows.map(function (win, index) {
          var days = Array.isArray(win.days) && win.days.length > 0 ? win.days : [1, 2, 3, 4, 5, 6, 7]
          return h('div', { className: 'cm-win', key: index },
            h('div', { className: 'cm-days' }, [1, 2, 3, 4, 5, 6, 7].map(function (day) {
              var on = days.indexOf(day) >= 0
              return h(DayChip, {
                key: day,
                day: day,
                on: on,
                onClick: function () {
                  var nextDays = on
                    ? days.filter(function (value) { return value !== day })
                    : days.concat([day]).sort()
                  if (nextDays.length === 0) nextDays = [day]
                  update(index, { days: nextDays })
                }
              })
            })),
            h('div', { className: 'cm-times' },
              h('input', {
                type: 'time',
                value: win.start ?? '09:00',
                onChange: function (event) { update(index, { start: event.target.value }) }
              }),
              h('span', { className: 'cm-time-sep' }, '–'),
              h('input', {
                type: 'time',
                value: win.end ?? '22:00',
                onChange: function (event) { update(index, { end: event.target.value }) }
              })),
            h('button', {
              type: 'button',
              className: 'cm-x',
              title: props.removeTitle,
              onClick: function () { remove(index) }
            }, '×'))
        }),
        h('button', { type: 'button', className: 'cm-add', onClick: add }, '+ ' + props.addText))
    }

// ---- 面板 -------------------------------------------------------------

    function Panel(props) {
      var t = props.t
      var [snap, setSnap] = useState(null)
      var [draft, setDraft] = useState(null)
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState('')
      var [msg, setMsg] = useState(null)

      useEffect(function () {
        var alive = true
        apiGet('/state').then(function (data) {
          if (!alive) return
          setSnap(data)
          setDraft(clone(data.settings))
        }, function (error) {
          if (!alive) return
          setMsg({ kind: 'err', text: t('loadError') + friendly(error, t) })
        })
        return function () { alive = false }
      }, [])

      useEffect(function () {
        var timer = setInterval(function () {
          apiGet('/state').then(function (data) {
            setSnap(function (prev) { return prev === null ? prev : Object.assign({}, prev, { runtime: data.runtime }) })
          }, function () { /* 忽略轮询失败 */ })
        }, 20000)
        return function () { clearInterval(timer) }
      }, [])

      function edit(mutator) {
        setDraft(function (prev) {
          if (prev === null) return prev
          var next = clone(prev)
          mutator(next)
          return next
        })
        setDirty(true)
        setMsg(null)
      }

      function reload() {
        setMsg({ kind: 'ok', text: t('loading') })
        apiGet('/state').then(function (data) {
          setSnap(data)
          setDraft(clone(data.settings))
          setDirty(false)
          setMsg(null)
        }, function (error) {
          setMsg({ kind: 'err', text: t('loadError') + friendly(error, t) })
        })
      }

      function validate() {
        if (draft === null) return t('loadError')
        var interval = Number(draft.intervalMinutes)
        if (!isFinite(interval) || interval < 5 || interval > 1440) return t('invalidInterval')
        if (draft.target.kind === 'session' && String(draft.target.sessionId ?? '').trim() === '') return t('invalidSession')
        var all = asArray(draft.activeWindows).concat(asArray(draft.dndWindows))
        for (var i = 0; i < all.length; i++) {
          var win = all[i]
          if (typeof win.start !== 'string' || typeof win.end !== 'string' || win.start === '' || win.end === '') return t('invalidWindow')
        }
        return null
      }

      function save() {
        var problem = validate()
        if (problem !== null) {
          setMsg({ kind: 'err', text: problem })
          return
        }
        var base = snap !== null ? snap.settings.target : {}
        var patch = {
          enabled: draft.enabled,
          intervalMinutes: Number(draft.intervalMinutes),
          jitterMinutes: Number(draft.jitterMinutes),
          maxPingsPerDay: Number(draft.maxPingsPerDay),
          maxMessagesPerPing: Number(draft.maxMessagesPerPing),
          activeWindows: asArray(draft.activeWindows),
          dndWindows: asArray(draft.dndWindows),
          topics: asArray(draft.topics),
          customInstructions: String(draft.customInstructions ?? ''),
          target: draft.target.kind === 'session'
            ? { kind: 'session', sessionId: String(draft.target.sessionId ?? '').trim() }
            : { kind: 'dedicated', cwd: base.cwd ?? null, agentPreset: base.agentPreset ?? null }
        }
        setBusy('save')
        apiPost('/settings', { patch: patch }).then(function (data) {
          setSnap(data)
          setDraft(clone(data.settings))
          setDirty(false)
          setMsg({ kind: 'ok', text: t('saved') })
        }, function (error) {
          setMsg({ kind: 'err', text: friendly(error, t) })
        }).then(function () { setBusy('') })
      }

      function ping() {
        setBusy('ping')
        apiPost('/action', { action: 'ping' }).then(function (data) {
          setSnap(function (prev) { return prev === null ? data : Object.assign({}, prev, { runtime: data.runtime }) })
          setMsg({ kind: 'ok', text: t('pingOk') })
        }, function (error) {
          setMsg({ kind: 'err', text: friendly(error, t) })
        }).then(function () { setBusy('') })
      }

      function reset() {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('resetConfirm'))) return
        setBusy('reset')
        apiPost('/action', { action: 'reset' }).then(function (data) {
          setSnap(data)
          setDraft(clone(data.settings))
          setDirty(false)
          setMsg({ kind: 'ok', text: t('resetDone') })
        }, function (error) {
          setMsg({ kind: 'err', text: friendly(error, t) })
        }).then(function () { setBusy('') })
      }

      var runtime = snap !== null ? snap.runtime : null
      var on = draft !== null && draft.enabled === true
      var running = on && runtime !== null && runtime.enabled === true

      var header = h('div', { className: 'cm-head' },
        h('div', null,
          h('p', { className: 'cm-kicker' }, t('kicker')),
          h('h2', { className: 'cm-title' }, t('title')),
          h('p', { className: 'cm-sub' }, t('subtitle'))),
        h('div', { className: 'cm-pill' + (running ? ' on' : '') },
          h('i'),
          running ? t('statusRunning') : (on ? t('statusPaused') : t('statusOff'))))

      if (draft === null || snap === null) {
        return h('div', { className: 'cm-app' }, header,
          h('div', { className: 'cm-body' },
            msg !== null
              ? h('div', { className: 'cm-card' },
                h('p', { className: 'cm-msg err' }, msg.text),
                h('button', { className: 'cm-btn', onClick: reload }, t('retry')))
              : h('div', { className: 'cm-card' },
                h('p', { className: 'cm-hint' }, t('loading')),
                h('div', { className: 'cm-skel' }),
                h('div', { className: 'cm-skel w60' }))))
      }

      var intervalValue = [10, 20, 30, 60].indexOf(Number(draft.intervalMinutes)) >= 0 ? String(draft.intervalMinutes) : 'custom'
      var targetKind = draft.target.kind === 'session' ? 'session' : 'dedicated'
      var targetText = runtime === null ? '—'
        : targetKind === 'session'
          ? (runtime.targetSessionId ?? t('none'))
          : (runtime.targetSessionId !== null && runtime.targetSessionId !== undefined
            ? t('targetDedicated')
            : t('targetDedicatedNew'))

      return h('div', { className: 'cm-app' },
        header,
        h('div', { className: 'cm-body' },

          h(Card, { title: t('statusTitle'), note: dirty ? t('dirty') : null },
            h('div', { className: 'cm-kv' }, h('span', null, t('nextPing')), h('b', null, fmtTime(runtime.nextPingAt))),
            h('div', { className: 'cm-kv' }, h('span', null, t('lastPing')), h('b', null, fmtTime(runtime.lastPingAt))),
            h('div', { className: 'cm-kv' },
              h('span', null, t('todayCount')),
              h('b', null, (runtime.counts?.date === new Date().toISOString().slice(0, 10) ? runtime.counts.count : 0) + ' / ' + draft.maxPingsPerDay)),
            h('div', { className: 'cm-kv' }, h('span', null, t('targetLabel')), h('b', { className: 'mono' }, targetText)),
            h('div', { className: 'cm-kv' }, h('span', null, t('taskLabel')), h('b', { className: 'mono' }, runtime.taskId ?? t('none'))),
            runtime.lastError ? h('div', { className: 'cm-kv' }, h('span', null, t('lastError')), h('b', { className: 'cm-err-text' }, runtime.lastError)) : null),

          h(Card, { title: t('paceTitle') },
            h(Field, { label: t('enabledLabel'), hint: t('enabledHint') },
              h(Toggle, { checked: draft.enabled, onChange: function (value) { edit(function (next) { next.enabled = value }) } })),
            h(Field, { label: t('intervalLabel'), hint: t('intervalHint') },
              h('select', {
                className: 'cm-select',
                value: intervalValue,
                onChange: function (event) {
                  var raw = event.target.value
                  edit(function (next) {
                    if (raw === 'custom') {
                      next.intervalMinutes = 15
                    } else {
                      next.intervalMinutes = Number(raw)
                    }
                  })
                }
              },
              h('option', { value: '10' }, '10 ' + t('minutesUnit')),
              h('option', { value: '20' }, '20 ' + t('minutesUnit')),
              h('option', { value: '30' }, '30 ' + t('minutesUnit')),
              h('option', { value: '60' }, '60 ' + t('minutesUnit')),
              h('option', { value: 'custom' }, t('intervalCustom'))),
              intervalValue === 'custom'
                ? h('span', { className: 'cm-field-ctl', style: { paddingTop: 0 } },
                  h(NumberField, {
                    min: 5, max: 1440, value: draft.intervalMinutes,
                    onChange: function (value) { edit(function (next) { next.intervalMinutes = value }) }
                  }),
                  h('span', { className: 'cm-unit' }, t('minutesUnit')))
                : null),
            h(Field, { label: t('jitterLabel'), hint: t('jitterHint') },
              h(NumberField, {
                min: 0, max: 60, value: draft.jitterMinutes,
                onChange: function (value) { edit(function (next) { next.jitterMinutes = value }) }
              }),
              h('span', { className: 'cm-unit' }, t('minutesUnit'))),
            h(Field, { label: t('dailyLabel'), hint: t('dailyHint') },
              h(NumberField, {
                min: 1, max: 200, value: draft.maxPingsPerDay,
                onChange: function (value) { edit(function (next) { next.maxPingsPerDay = value }) }
              }),
              h('span', { className: 'cm-unit' }, t('timesUnit'))),
            h(Field, { label: t('messagesLabel'), hint: t('messagesHint') },
              h(NumberField, {
                min: 1, max: 3, value: draft.maxMessagesPerPing,
                onChange: function (value) { edit(function (next) { next.maxMessagesPerPing = value }) }
              }),
              h('span', { className: 'cm-unit' }, t('linesUnit')))),

          h(Card, { title: t('windowsTitle') },
            h(Field, { label: t('activeLabel'), hint: t('activeHint') },
              h('span', null)),
            h(WindowEditor, {
              windows: draft.activeWindows,
              emptyText: t('activeEmpty'),
              addText: t('addWindow'),
              removeTitle: t('removeWindow'),
              onChange: function (windows) { edit(function (next) { next.activeWindows = windows }) }
            }),
            h('div', { style: { height: 10 } }),
            h(Field, { label: t('dndLabel'), hint: t('dndHint') },
              h('span', null)),
            h(WindowEditor, {
              windows: draft.dndWindows,
              emptyText: t('dndEmpty'),
              addText: t('addWindow'),
              removeTitle: t('removeWindow'),
              onChange: function (windows) { edit(function (next) { next.dndWindows = windows }) }
            })),

          h(Card, { title: t('topicsTitle') },
            h(Field, { label: t('topicsLabel'), hint: t('topicsHint') },
              h('span', null)),
            h('textarea', {
              className: 'cm-area',
              value: asArray(draft.topics).join('\n'),
              onChange: function (event) {
                var lines = event.target.value.split('\n').map(function (line) { return line.trim() }).filter(function (line) { return line !== '' })
                edit(function (next) { next.topics = lines })
              }
            }),
            h('div', { style: { height: 10 } }),
            h(Field, { label: t('instructionsLabel'), hint: t('instructionsHint') },
              h('span', null)),
            h('textarea', {
              className: 'cm-area',
              value: String(draft.customInstructions ?? ''),
              onChange: function (event) {
                var value = event.target.value
                edit(function (next) { next.customInstructions = value })
              }
            })),

          h(Card, { title: t('targetTitle'), note: null },
            h('p', { className: 'cm-hint', style: { margin: '0 0 6px' } }, t('targetHint')),
            h('label', { className: 'cm-radio' },
              h('input', {
                type: 'radio',
                name: 'chatmode-target',
                checked: targetKind === 'dedicated',
                onChange: function () { edit(function (next) { next.target = { kind: 'dedicated', cwd: null, agentPreset: null } }) }
              }),
              h('div', null,
                h('b', null, t('targetDedicated')),
                h('small', null, t('targetDedicatedDesc')))),
            h('label', { className: 'cm-radio' },
              h('input', {
                type: 'radio',
                name: 'chatmode-target',
                checked: targetKind === 'session',
                onChange: function () { edit(function (next) { next.target = { kind: 'session', sessionId: String(next.target.sessionId ?? '') } }) }
              }),
              h('div', null,
                h('b', null, t('targetSession')),
                h('small', null, t('targetSessionDesc')))),
            targetKind === 'session'
              ? h('div', { style: { paddingTop: 6 } },
                h('input', {
                  className: 'cm-input',
                  placeholder: 'session-…',
                  value: String(draft.target.sessionId ?? ''),
                  onChange: function (event) {
                    var value = event.target.value
                    edit(function (next) { next.target = { kind: 'session', sessionId: value } })
                  }
                }),
                h('p', { className: 'cm-hint', style: { margin: '4px 0 0' } }, t('sessionIdHint')))
              : null),

          h('div', { className: 'cm-actions' },
            h('button', { className: 'cm-btn primary', disabled: busy !== '', onClick: save },
              busy === 'save' ? t('saving') : t('save')),
            h('button', { className: 'cm-btn', disabled: busy !== '', onClick: ping },
              busy === 'ping' ? t('pingBusy') : t('ping')),
            h('button', { className: 'cm-btn', disabled: busy !== '', onClick: reset },
              busy === 'reset' ? t('resetBusy') : t('reset')),
            msg !== null ? h('span', { className: 'cm-msg ' + msg.kind }, msg.text) : null),

          h('p', { className: 'cm-foot' }, t('footerHint'))))
    }

    function ErrorBoundary(props) {
      var [err, setErr] = useState(null)
      useEffect(function () {
        function onError(event) { setErr(String(event?.error?.message ?? event?.message ?? event)) }
        function onRejection(event) { setErr(String(event?.reason?.message ?? event?.reason ?? event)) }
        window.addEventListener('error', onError)
        window.addEventListener('unhandledrejection', onRejection)
        return function () {
          window.removeEventListener('error', onError)
          window.removeEventListener('unhandledrejection', onRejection)
        }
      }, [])
      if (err !== null) {
        return h('div', { className: 'cm-app' },
          h('div', { className: 'cm-card' },
            h('p', { className: 'cm-label' }, '设置页出错了'),
            h('p', { className: 'cm-hint' }, err),
            h('button', { className: 'cm-btn', onClick: function () { window.location.reload() } }, '重新加载页面')))
      }
      return props.children
    }

    function NavIcon(props) {
      var size = props !== null && props !== undefined && Number(props.size) > 0 ? Number(props.size) : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true'
      },
      h('path', { d: 'M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.4-.7L4 21l1.7-4.7A8.4 8.4 0 1 1 21 11.5Z' }),
      h('path', { d: 'M8.5 11h7' }))
    }

// ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () { return ensureStyles() }, NS + ': styles')

      var t = ctx.locale.bind(NS)

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: ZH, en: EN })
      }, NS + ': dictionaries')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'chatmode',
          order: 50,
          label: function () { return t('kicker') }
        }, function (props) {
          return h(ErrorBoundary, null, h(Panel, Object.assign({}, props, { t: t })))
        })
      })

      ctx.slots.inject('settings.section.icon', function () {
        return ctx.slots.register({
          name: 'settings.section.icon',
          id: 'chatmode'
        }, function (props) {
          return h(NavIcon, props)
        })
      })
    }

    module.exports = { name: 'chatmode', inject: ['slots', 'locale'], apply: apply }
    return module.exports
  }
})
