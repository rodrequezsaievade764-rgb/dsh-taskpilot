// dsh-taskpilot — 任务全生命周期追踪
//
// 定位：不重复造待办清单。DSH 自带的 dtodo 已经能记录、能查；
// 这个插件只补它没有的三件事：
//   1. 逾期自动追 —— 不等你来问，到点主动催，且不会反复骚扰
//   2. 卡住识别 —— doing 状态放太久自动提醒
//   3. 复盘 —— 完成率、准时率、最容易拖垮的是星期几
//
// 推送通道：配了 webhookUrl 就往那儿 POST，没配就只写日志。
// 存储：~/.dsh/taskpilot/tasks.json，纯 JSON，能直接打开看、自己备份。
//
// 一期只做这四个工具 + 一个扫描器，别往上堆功能。

import { createStore, newId, normStatus, normPriority, normDue, dueMs, isOverdue, normTags, hasTag, OPEN, STATUSES } from './store.js'
import { defineTool, str, int } from './tool.js'
import { pickNags, stalled, nagText, review, reviewText, inQuietHours } from './notify.js'

export const name = 'taskpilot'
// tools 用 inject 等就绪（0.2.x apply 阶段 ctx.get('tools') 会静默拿到空）。
export const inject = ['tools']

// 扫描间隔下限（分钟）。只在这里定义一次：
// 早先 cfg 里夹一次、effect 里又拿毫秒常量夹一次，两个魔法数要同步改，改漏就漂。
const MIN_SCAN_MINUTES = 5

export function apply(ctx, config = {}) {
  const cfg = {
    storePath: String(config.storePath || ''),
    scanIntervalMinutes: Math.max(MIN_SCAN_MINUTES, Number(config.scanIntervalMinutes) || 15),
    notifyService: String(config.notifyService || ''),
    notifyTo: String(config.notifyTo || ''),
    webhookUrl: String(config.webhookUrl || ''),
    quietHours: Array.isArray(config.quietHours) ? config.quietHours : [23, 8],
    nagCooldownHours: Number(config.nagCooldownHours) || 24,
    maxPerScan: Number(config.maxPerScan) || 3,
    stallDays: Number(config.stallDays) || 3,
    reviewDays: Number(config.reviewDays) || 14,
  }
  const store = createStore(cfg.storePath)

  let logger
  try { logger = ctx.logger('taskpilot') } catch { logger = null }
  const info = (m) => { try { logger ? logger.info(m) : console.log('[taskpilot] ' + m) } catch {} }
  const warn = (m) => { try { logger ? logger.warn(m) : console.warn('[taskpilot] ' + m) } catch {} }

  // ---------- 推送 ----------
  // 两条路：配了 notifyService 就走那个 DSH 服务的 send()；
  // 否则配了 webhookUrl 就 POST；都没配只写日志，不报错。
  async function push(text) {
    if (!String(text || '').trim()) return false
    if (cfg.notifyService) {
      try {
        const svc = ctx.get(cfg.notifyService)
        if (svc && typeof svc.send === 'function') {
          const r = await svc.send({ target: cfg.notifyTo || undefined, text })
          if (r && r.ok) return true
          warn(`${cfg.notifyService} 没发出去：${(r && r.message) || '未知原因'}`)
        }
      } catch (e) {
        warn('推送异常：' + ((e && e.message) || e))
      }
    }
    if (cfg.webhookUrl) {
      try {
        const r = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, msgtype: 'text', content: { text } }),
          signal: AbortSignal.timeout(10000),
        })
        if (r.ok) return true
        warn(`推送失败：HTTP ${r.status}`)
      } catch (e) {
        warn('推送异常：' + ((e && e.message) || e))
      }
    }
    info('（未发出，仅记录）' + text.replace(/\n/g, ' / '))
    return false
  }

  // ---------- 扫描 ----------
  let scanning = false
  async function scanOnce(now = Date.now()) {
    if (scanning) return
    scanning = true
    try {
      if (inQuietHours(now, cfg.quietHours)) {
        const db = store.read()
        db.meta.lastScanAt = now
        store.write(db)
        return
      }

      const db = store.read()
      const nags = pickNags(db, now, cfg)
      const stuck = stalled(db, now, cfg.stallDays)
      db.meta.lastScanAt = now
      // pickNags 已经改过 db.meta.lastNag，这里要连任务一起写回
      store.write(db)

      if (nags.length) {
        const lines = nags.map((t) => '· ' + nagText(t, now))
        await push(['有事儿提醒你——', ...lines].join('\n'))
      }
      if (stuck.length) {
        const lines = stuck.slice(0, 2).map((t) => '· ' + t.title)
        await push(['这两个挂在手上好几天了，还做不做', ...lines].join('\n'))
      }
    } catch (e) {
      warn('扫描失败：' + ((e && e.message) || e))
    } finally {
      scanning = false
    }
  }

  // ---------- 工具 ----------
  const ok = (message, extra) => ({ ok: true, message, ...extra })
  const bad = (message) => ({ ok: false, message })

  const addTool = defineTool({
    name: 'taskpilot_add',
    description:
      '新建一条要追踪的任务。用户说「记一下我要做什么」「这个帮我盯着」时用。' +
      'title 写清要做什么（动词开头，别写「那件事」这种指代不明的）。' +
      'due 只认 YYYY-MM-DD 或 YYYY-MM-DD HH:mm；用户说「明天」就先换算成具体日期再填。' +
      'priority 有 low/normal/high/urgent，不确定就 normal。',
    properties: {
      title: str('任务标题，一句话说清做什么'),
      due: str('截止时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm，可不填'),
      priority: str('优先级 low / normal / high / urgent，可不填'),
      note: str('备注，可不填'),
      tags: str('标签，逗号分隔，可不填'),
    },
    required: ['title'],
    execute: async (args) => {
      const title = String(args.title || '').trim()
      if (!title) return bad('标题不能空')
      if (title.length > 200) return bad('标题太长了，压到 200 字以内')

      const dueRaw = String(args.due || '').trim()
      const due = normDue(dueRaw)
      if (dueRaw && !due) return bad(`截止时间看不懂：${dueRaw}。写成 2026-11-08 或 2026-11-08 18:00`)

      const pr = normPriority(args.priority) || 'normal'
      const now = Date.now()
      const task = {
        id: newId(),
        title,
        note: String(args.note || '').trim().slice(0, 2000),
        tags: normTags(args.tags),
        status: 'todo',
        priority: pr,
        due,
        createdAt: now,
        updatedAt: now,
        endedAt: 0,
        nags: 0,
      }
      store.mutate((db) => { db.tasks.push(task) })
      const tail = due ? `，${due} 前` : ''
      return ok(`记下了：${title}${tail}`, { task })
    },
  })

  const updateTool = defineTool({
    name: 'taskpilot_update',
    description:
      '改一条任务的状态、截止时间、优先级，或把它删掉。' +
      '状态：todo 待办 / doing 在做 / blocked 卡住 / done 完成 / cancelled 取消。' +
      'id 或 title 给一个就够；title 支持模糊匹配，只能命中一条，命中多条会列出来让你选。' +
      '用户说「做完了」「不做了」「卡住了」就是改状态。',
    properties: {
      id: str('任务 id，可不填（用 title 找）'),
      title: str('任务标题（模糊匹配），可不填'),
      status: str('新状态 todo / doing / blocked / done / cancelled'),
      due: str('新截止时间，传空字符串表示清掉，不传表示不改'),
      priority: str('新优先级'),
      note: str('新备注'),
      tags: str('新标签，逗号分隔（会整组替换）'),
      remove: { type: 'boolean', description: 'true 表示直接删掉这条任务' },
    },
    execute: async (args) => {
      const id = String(args.id || '').trim()
      const keyword = String(args.title || '').trim().toLowerCase()
      if (!id && !keyword) return bad('给 id 或 title')

      const db = store.read()
      let hit
      if (id) {
        hit = db.tasks.find((t) => t.id === id)
        if (!hit) return bad(`没有 id 为 ${id} 的任务`)
      } else {
        const matches = db.tasks.filter((t) => String(t.title || '').toLowerCase().includes(keyword))
        if (!matches.length) return bad(`没找到含「${args.title}」的任务`)
        if (matches.length > 1) {
          const list = matches.slice(0, 5).map((t) => `${t.id} ${t.title}`).join('\n')
          return bad(`匹配到 ${matches.length} 条，说清是哪一条：\n${list}`)
        }
        hit = matches[0]
      }

      if (args.remove === true) {
        store.mutate((d) => { d.tasks = d.tasks.filter((t) => t.id !== hit.id) })
        return ok(`删掉了：${hit.title}`)
      }

      const now = Date.now()
      const changes = []
      const target = db.tasks.find((t) => t.id === hit.id)

      if (args.status !== undefined) {
        const st = normStatus(args.status)
        if (!st) return bad(`状态只认 ${STATUSES.join(' / ')}`)
        if (st !== target.status) {
          changes.push(`${target.status} → ${st}`)
          target.status = st
          // 结束时间只在进 done / cancelled 时打一次，回退到未结束就清掉
          if (st === 'done' || st === 'cancelled') target.endedAt = now
          else target.endedAt = 0
        }
      }
      if (args.due !== undefined) {
        const raw = String(args.due || '').trim()
        if (!raw) { target.due = ''; changes.push('截止时间清掉了') }
        else {
          const d = normDue(raw)
          if (!d) return bad(`截止时间看不懂：${raw}`)
          target.due = d
          changes.push('截止时间改成 ' + d)
        }
      }
      if (args.priority !== undefined) {
        const pr = normPriority(args.priority)
        if (!pr) return bad('优先级只认 low / normal / high / urgent')
        target.priority = pr
        changes.push('优先级改成 ' + pr)
      }
      if (args.note !== undefined) {
        target.note = String(args.note || '').slice(0, 2000)
        changes.push('备注改好了')
      }
      if (args.tags !== undefined) {
        // 整组替换而不是追加：追加没法删标签，改错了只能重建任务。
        const next = normTags(args.tags)
        target.tags = next
        changes.push(next.length ? '标签改成 ' + next.join(' / ') : '标签清空了')
      }
      if (!changes.length) return ok('没有要改的字段')

      target.updatedAt = now
      store.write(db)
      return ok(`${target.title}：${changes.join('，')}`, { task: target })
    },
  })

  const listTool = defineTool({
    name: 'taskpilot_list',
    description:
      '看任务清单。默认只给该关注的：已逾期、今天到期、正在做的，最多 8 条。' +
      'all 设成 true 就列出全部未结束任务（最多 30 条），但仍不含已完成 / 已取消。' +
      '要把做完的和取消的也列出来，得再加 includeClosed 设成 true。' +
      'tag 只看带这个标签的（大小写不敏感）。' +
      '用户问「我还有啥没做」「哪些拖着」时用。',
    properties: {
      all: { type: 'boolean', description: 'true 列出全部未结束任务（最多 30 条），不含已完成 / 已取消' },
      includeClosed: { type: 'boolean', description: 'true 把已完成和已取消的任务一起列出来' },
      status: str('只看某个状态'),
      overdueOnly: { type: 'boolean', description: 'true 只看已逾期的' },
      keyword: str('按标题关键词筛'),
      tag: str('只看带这个标签的，可不填'),
    },
    execute: async (args) => {
      const now = Date.now()
      const db = store.read()
      let list = db.tasks.slice()
      const includeClosed = args.includeClosed === true
      const tagRaw = String(args.tag == null ? '' : args.tag).trim()

      if (args.status) {
        const st = normStatus(args.status)
        if (!st) return bad('状态只认 ' + STATUSES.join(' / '))
        list = list.filter((t) => t.status === st)
      } else if (!includeClosed) {
        // all 只放宽「条数上限」，不放宽「未结束」这个语义：
        // 已完成 / 已取消的任务默认不进清单，要看得显式传 includeClosed。
        list = list.filter((t) => OPEN.includes(t.status))
      }
      if (args.overdueOnly === true) list = list.filter((t) => isOverdue(t, now))
      if (args.keyword) {
        const k = String(args.keyword).toLowerCase()
        list = list.filter((t) => String(t.title).toLowerCase().includes(k))
      }
      // 标签筛选放在最后：它和状态、关键词是正交条件，叠加时才不会互相覆盖。
      if (tagRaw) list = list.filter((t) => hasTag(t, tagRaw))

      if (!list.length) {
        // 空态要说清是「筛空了」还是「本来就没有」。
        // 而且范围要说准：传了 status 或 includeClosed 时看的不只是未结束任务，
        // 一律说「未结束任务」会让人以为筛错了。
        const scope = args.status ? `状态是「${normStatus(args.status)}」的` : includeClosed ? '' : '未结束的'
        if (tagRaw) return ok(`没有${scope}带「${tagRaw}」标签的任务`)
        if (args.status) return ok(`没有状态是「${normStatus(args.status)}」的任务`)
        return ok(includeClosed ? '一条任务都没有，干净' : '没有要做的了，干净')
      }

      // 排序：逾期越久越前，然后按截止时间，最后按优先级
      const weight = { urgent: 0, high: 1, normal: 2, low: 3 }
      list.sort((a, b) => {
        const ao = isOverdue(a, now) ? 1 : 0
        const bo = isOverdue(b, now) ? 1 : 0
        if (ao !== bo) return bo - ao
        const ad = dueMs(a.due) || 9e15
        const bd = dueMs(b.due) || 9e15
        if (ad !== bd) return ad - bd
        return (weight[a.priority] ?? 2) - (weight[b.priority] ?? 2)
      })
      const cut = args.all === true || includeClosed ? 30 : 8
      const shown = list.slice(0, cut)

      const mark = (t) => {
        if (isOverdue(t, now)) {
          const days = Math.floor((now - dueMs(t.due)) / 86400000)
          return days >= 1 ? `逾期 ${days} 天` : '今天该交了'
        }
        if (t.status === 'doing') return '在做'
        if (t.status === 'blocked') return '卡住'
        if (t.status === 'done') return '已完成'
        if (t.status === 'cancelled') return '已取消'
        if (t.due) return t.due
        return ''
      }
      const lines = shown.map((t) => {
        const m = mark(t)
        // 标签跟着标题一起显示：记的时候填了，看的时候得能看见。
        const tags = Array.isArray(t.tags) && t.tags.length ? ' #' + t.tags.join(' #') : ''
        return `${t.title}${m ? '（' + m + '）' : ''}${tags}`
      })
      const more = list.length > cut ? `\n还有 ${list.length - cut} 条没列` : ''
      const tagNote = tagRaw ? `\n（以上只列了带「${tagRaw}」标签的）` : ''
      return ok(lines.join('\n') + more + tagNote, { count: list.length, shown: shown.length })
    },
  })

  const reviewTool = defineTool({
    name: 'taskpilot_review',
    description:
      '复盘最近的执行情况：新建多少、做完多少、准时率、平均几天做完一件、最容易拖延的是星期几、现在还压着几件紧急的。' +
      '用户问「我最近效率怎么样」「拖延严重吗」或者到周末想看总结时用。days 默认 14。',
    properties: {
      days: int('回看多少天，默认 14'),
    },
    execute: async (args) => {
      const days = Math.max(1, Math.min(365, Number(args.days) || cfg.reviewDays))
      const db = store.read()
      const r = review(db, Date.now(), days)
      if (!r.created && !r.openNow) return ok('这段时间没有任务记录')
      return ok(reviewText(r), { stats: r })
    },
  })

  const tools = [addTool, updateTool, listTool, reviewTool]
  const offs = []
  for (const t of tools) {
    try {
      offs.push(ctx.tools.register(t))
    } catch (e) {
      warn(`工具 ${t.name} 挂不上：` + ((e && e.message) || e))
    }
  }
  info(`已注册 ${tools.length} 个工具：${tools.map((t) => t.name).join('、')}`)

  // ---------- 定时扫描 ----------
  ctx.effect(() => {
    const intervalMs = cfg.scanIntervalMinutes * 60000
    // 启动 40 秒后才第一次扫：别和宿主冷启动抢资源
    const first = setTimeout(() => void scanOnce(), 40000)
    const timer = setInterval(() => void scanOnce(), intervalMs)
    info(`追踪已启动：每 ${Math.round(intervalMs / 60000)} 分钟扫一次，安静时段 ${cfg.quietHours.join(' 点到 ')} 点`)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      for (const off of offs) { try { off() } catch {} }
    }
  })

  return {
    scan: () => scanOnce(),
    store,
    path: store.path,
  }
}
