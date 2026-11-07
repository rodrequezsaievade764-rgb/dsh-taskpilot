// 自动催办：挑出该催的任务，并保证同一件事不会反复骚扰。
//
// 催的规则（都能在 config 里改）：
//   1. 只催未结束的任务（todo / doing / blocked）
//   2. 已过截止时间才催；纯日期的任务当天不催，第二天才开始催
//   3. 同一条任务距上次催办超过 nagCooldownHours 才再催（默认 24 小时）
//   4. 只在 quietHours 之外催，别半夜弹人
//   5. 一次最多催 maxPerScan 条，免得一口气刷屏

import { OPEN, isOverdue, dueMs, daysBetween } from './store.js'

const HOUR = 3600000

/**
 * 现在能不能催（安静时段判断）。
 * quietHours 写成 [开始小时, 结束小时]，跨零点也支持，例如 [23, 8]。
 */
export function inQuietHours(now, quietHours) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false
  const [from, to] = quietHours
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false
  const h = new Date(now).getHours()
  // 跨零点：23 点到次日 8 点
  if (from > to) return h >= from || h < to
  return h >= from && h < to
}

/**
 * 清掉 lastNag 里的过期键：任务已删、或已进 done / cancelled 的，催办记录留着没用了。
 * 不清的话，这个 map 只增不减，用一年就是几千个死键，文件越写越大。
 * 返回清掉的键数，方便测试和日志。
 */
export function pruneLastNag(db) {
  const lastNag = db && db.meta ? db.meta.lastNag : null
  if (!lastNag || typeof lastNag !== 'object') return 0
  const alive = new Set()
  for (const t of db.tasks || []) {
    if (t && OPEN.includes(t.status)) alive.add(t.id)
  }
  let removed = 0
  for (const id of Object.keys(lastNag)) {
    if (!alive.has(id)) {
      delete lastNag[id]
      removed += 1
    }
  }
  return removed
}

/** 挑出这一轮该催的任务，并把「已催过」的时间写回 db.meta。 */
export function pickNags(db, now, config) {
  const cooldownMs = Math.max(1, Number(config.nagCooldownHours) || 24) * HOUR
  const maxPerScan = Math.max(1, Number(config.maxPerScan) || 3)
  // 先清死键再挑：清理必须在读取 last 之前，否则已删任务的旧记录还会被当成冷却依据。
  pruneLastNag(db)
  const lastNag = db.meta.lastNag

  const due = db.tasks
    .filter((t) => OPEN.includes(t.status) && isOverdue(t, now))
    .map((t) => ({ task: t, overdueMs: now - dueMs(t.due), last: Number(lastNag[t.id] || 0) }))
    .filter((x) => now - x.last >= cooldownMs)
    // 拖得最久的先催
    .sort((a, b) => b.overdueMs - a.overdueMs)
    .slice(0, maxPerScan)

  return due.map((x) => {
    lastNag[x.task.id] = now
    return x.task
  })
}

/** 卡住判定：doing 状态超过 stallDays 没动过。 */
export function stalled(db, now, stallDays) {
  const limit = Math.max(1, Number(stallDays) || 3) * 86400000
  return db.tasks.filter((t) => {
    if (t.status !== 'doing') return false
    const seen = Number(t.updatedAt || t.createdAt || 0)
    return seen > 0 && now - seen > limit
  })
}

/** 一条催办要说的话。写得像人，不像系统通知。 */
export function nagText(task, now) {
  const over = Math.floor((now - dueMs(task.due)) / 86400000)
  // 能走到这里说明已经逾期（pickNags 只挑 isOverdue 的），
  // 所以「不到一天」不能说成「今天到期」——那听着像还没到点，
  // 实际上已经过点了，只是没过满 24 小时。
  const when = over >= 1 ? `已经拖了 ${over} 天` : '刚过截止时间'
  const head = task.priority === 'urgent' || task.priority === 'high' ? `${task.title} 还卡着呢` : `${task.title} 还没动`
  const tail = task.status === 'blocked' ? '卡在哪儿了，要帮忙吗' : '还要不要做，不要我就给你划掉'
  return `${head}，${when}。${tail}`
}

/**
 * 复盘：完成率、拖延规律、卡单清单。
 * 只统计有 endedAt 的已完成任务，和当前还开着的，不猜。
 */
export function review(db, now, days = 14) {
  const since = now - Math.max(1, days) * 86400000
  const all = db.tasks
  const touched = all.filter((t) => Number(t.createdAt || 0) >= since)

  // 做完的按「什么时候做完」算，不按「什么时候建的」算：
  // 上个月建、昨天才做完的，也算这段时间的成绩。
  // 老数据可能没有 endedAt，退回 updatedAt，别让它们凭空消失。
  const endOf = (t) => Number(t.endedAt || t.updatedAt || 0)
  const doneList = all.filter((t) => t.status === 'done' && endOf(t) >= since)
  const cancelled = all.filter((t) => t.status === 'cancelled' && endOf(t) >= since)
  const openNow = all.filter((t) => OPEN.includes(t.status))

  const finished = doneList.length + cancelled.length
  const rate = finished ? Math.round((doneList.length / finished) * 100) : 0

  // 准时率：完成时间有没有超过截止时间
  const onTime = doneList.filter((t) => !t.due || endOf(t) <= dueMs(t.due))
  const onTimeRate = doneList.length ? Math.round((onTime.length / doneList.length) * 100) : 0

  // 平均挂多久才做完
  const spans = doneList
    .filter((t) => Number(t.createdAt) > 0 && endOf(t) > Number(t.createdAt))
    .map((t) => daysBetween(Number(t.createdAt), endOf(t)))
  const avgDays = spans.length ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10 : 0

  // 拖延规律：逾期任务按「星期几」分布，看哪几天最容易崩
  const overdueByWeekday = [0, 0, 0, 0, 0, 0, 0]
  for (const t of openNow) {
    if (!isOverdue(t, now)) continue
    overdueByWeekday[new Date(dueMs(t.due)).getDay()] += 1
  }
  const worstDay = overdueByWeekday.indexOf(Math.max(...overdueByWeekday))
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  // 按优先级看积压
  const backlog = { urgent: 0, high: 0, normal: 0, low: 0 }
  for (const t of openNow) backlog[t.priority || 'normal'] += 1

  return {
    days,
    created: touched.length,
    done: doneList.length,
    cancelled: cancelled.length,
    openNow: openNow.length,
    overdue: openNow.filter((t) => isOverdue(t, now)).length,
    completionRate: rate,
    onTimeRate,
    avgDays,
    worstDay: Math.max(...overdueByWeekday) > 0 ? dayNames[worstDay] : '',
    overdueByWeekday,
    backlog,
  }
}

/** 复盘结果翻译成一段人话。 */
export function reviewText(r) {
  const bits = []
  bits.push(`这 ${r.days} 天新建 ${r.created} 件，做完 ${r.done} 件，取消 ${r.cancelled} 件`)
  if (r.done) bits.push(`准时率 ${r.onTimeRate}%，平均 ${r.avgDays} 天做完一件`)
  bits.push(`现在手上还开着 ${r.openNow} 件，其中 ${r.overdue} 件已经逾期`)
  if (r.worstDay) bits.push(`最容易被拖掉的是${r.worstDay}`)
  if (r.backlog.urgent) bits.push(`紧急的还压着 ${r.backlog.urgent} 件`)
  return bits.join('。')
}
