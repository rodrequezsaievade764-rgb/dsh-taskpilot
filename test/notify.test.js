// notify：安静时段、催办挑选、lastNag 清理、卡住识别、复盘。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  inQuietHours, pickNags, pruneLastNag, stalled, nagText, review, reviewText,
} from '../lib/notify.js'
import { task, DAY } from './_helpers.js'

const HOUR = 3600000
const cfg = { nagCooldownHours: 24, maxPerScan: 3, stallDays: 3 }

/** 造一个能被 pickNags 直接吃的 db。 */
function db(tasks = [], lastNag = {}) {
  return { version: 1, tasks, meta: { lastScanAt: 0, lastNag } }
}

/** 构造一个本地时间在指定小时的时间戳，避开时区坑。 */
function atHour(h) {
  const d = new Date(2026, 10, 10, h, 0, 0, 0)
  return d.getTime()
}

test('inQuietHours：非跨零点区间', () => {
  assert.equal(inQuietHours(atHour(10), [9, 12]), true)
  assert.equal(inQuietHours(atHour(9), [9, 12]), true)
  assert.equal(inQuietHours(atHour(12), [9, 12]), false)
  assert.equal(inQuietHours(atHour(8), [9, 12]), false)
})

test('inQuietHours：跨零点区间 [23, 8]', () => {
  assert.equal(inQuietHours(atHour(23), [23, 8]), true)
  assert.equal(inQuietHours(atHour(0), [23, 8]), true)
  assert.equal(inQuietHours(atHour(7), [23, 8]), true)
  assert.equal(inQuietHours(atHour(8), [23, 8]), false)
  assert.equal(inQuietHours(atHour(15), [23, 8]), false)
})

test('inQuietHours：参数不合法一律当「不在安静时段」', () => {
  assert.equal(inQuietHours(atHour(3), null), false)
  assert.equal(inQuietHours(atHour(3), [23]), false)
  assert.equal(inQuietHours(atHour(3), [5, 5]), false)
  assert.equal(inQuietHours(atHour(3), ['a', 'b']), false)
})

test('pickNags：只挑逾期的未结束任务，拖最久的先催', () => {
  const now = atHour(12)
  const d = db([
    task({ id: 'a', title: '拖了两天', status: 'todo', due: '2026-11-08' }),
    task({ id: 'b', title: '拖了五天', status: 'doing', due: '2026-11-05' }),
    task({ id: 'c', title: '明天的', status: 'todo', due: '2026-11-20' }),
    task({ id: 'd', title: '做完的', status: 'done', due: '2026-11-01', endedAt: now }),
  ])
  const got = pickNags(d, now, cfg)
  assert.deepEqual(got.map((t) => t.id), ['b', 'a'])
  // 挑中的都记了时间
  assert.equal(d.meta.lastNag.b, now)
  assert.equal(d.meta.lastNag.a, now)
  assert.equal(d.meta.lastNag.c, undefined)
  assert.equal(d.meta.lastNag.d, undefined)
})

test('pickNags：冷却期内不重复催', () => {
  const now = atHour(12)
  const last = now - 2 * HOUR
  const d = db([task({ id: 'a', status: 'todo', due: '2026-11-01' })], { a: last })
  assert.deepEqual(pickNags(d, now, cfg), [])
  // 冷却记录没被改动
  assert.equal(d.meta.lastNag.a, last)
})

test('pickNags：冷却期过了就再催一次', () => {
  const now = atHour(12)
  const last = now - 25 * HOUR
  const d = db([task({ id: 'a', status: 'todo', due: '2026-11-01' })], { a: last })
  const got = pickNags(d, now, cfg)
  assert.equal(got.length, 1)
  assert.equal(d.meta.lastNag.a, now)
})

test('pickNags：最多催 maxPerScan 条，先紧着拖得久的', () => {
  const now = atHour(12)
  const tasks = [
    task({ id: 'a', due: '2026-11-09' }),
    task({ id: 'b', due: '2026-11-08' }),
    task({ id: 'c', due: '2026-11-07' }),
    task({ id: 'd', due: '2026-11-06' }),
  ]
  const got = pickNags(db(tasks), now, { ...cfg, maxPerScan: 2 })
  assert.deepEqual(got.map((t) => t.id), ['d', 'c'])
})

test('pickNags：纯日期任务当天不催，第二天才催', () => {
  const today = atHour(23)
  const d = db([task({ id: 'a', status: 'todo', due: '2026-11-10' })])
  assert.deepEqual(pickNags(d, today, cfg), [], '当天 23:59 才到期，此刻不该催')

  const tomorrow = atHour(9) + DAY
  const got = pickNags(d, tomorrow, cfg)
  assert.equal(got.length, 1)
})

test('pruneLastNag：清掉已删除任务和已结束任务的死键', () => {
  const now = atHour(12)
  const d = db(
    [
      task({ id: 'alive', status: 'todo' }),
      task({ id: 'done', status: 'done', endedAt: now }),
      task({ id: 'cancelled', status: 'cancelled', endedAt: now }),
    ],
    { alive: now, done: now, cancelled: now, gone: now },
  )
  const removed = pruneLastNag(d)
  assert.equal(removed, 3)
  assert.deepEqual(Object.keys(d.meta.lastNag), ['alive'])
  // 幂等：再清一次没有变化
  assert.equal(pruneLastNag(d), 0)
})

test('pruneLastNag：shape 不对时安全返回 0', () => {
  assert.equal(pruneLastNag({ tasks: [] }), 0)
  assert.equal(pruneLastNag({ tasks: [], meta: {} }), 0)
  assert.equal(pruneLastNag({ tasks: [], meta: { lastNag: null } }), 0)
  assert.equal(pruneLastNag(null), 0)
})

test('pickNags 会顺手清理死键（不会被已删任务的旧记录卡住冷却）', () => {
  const now = atHour(12)
  const stale = { gone: now, done: now }
  const d = db([task({ id: 'a', status: 'todo', due: '2026-11-01' })], stale)
  const got = pickNags(d, now, cfg)
  assert.equal(got.length, 1)
  assert.deepEqual(Object.keys(d.meta.lastNag).sort(), ['a'])
})

test('pickNags：长期反复扫描后 lastNag 不会只增不减', () => {
  const now = atHour(12)
  const d = db([], {})
  // 模拟删掉 200 条任务留下的残渣
  for (let i = 0; i < 200; i++) d.meta.lastNag['dead' + i] = now - DAY * 10
  d.tasks.push(task({ id: 'alive', status: 'todo', due: '2026-11-01' }))
  pickNags(d, now, cfg)
  assert.deepEqual(Object.keys(d.meta.lastNag), ['alive'])
})

test('stalled：doing 超过 stallDays 没动的才算', () => {
  const now = atHour(12)
  const d = db([
    task({ id: 'old', status: 'doing', updatedAt: now - 5 * DAY }),
    task({ id: 'fresh', status: 'doing', updatedAt: now - 1 * DAY }),
    task({ id: 'todoOld', status: 'todo', updatedAt: now - 9 * DAY }),
    task({ id: 'blockedOld', status: 'blocked', updatedAt: now - 9 * DAY }),
  ])
  assert.deepEqual(stalled(d, now, 3).map((t) => t.id), ['old'])
})

test('stalled：updatedAt 缺失时退回 createdAt', () => {
  const now = atHour(12)
  const d = db([{ id: 'x', title: 'x', status: 'doing', createdAt: now - 6 * DAY }])
  assert.deepEqual(stalled(d, now, 3).map((t) => t.id), ['x'])
})

test('stalled：两个时间戳都没有就不判卡住', () => {
  const now = atHour(12)
  const d = db([{ id: 'x', title: 'x', status: 'doing' }])
  assert.deepEqual(stalled(d, now, 3), [])
})

test('nagText 三个分支的话都对得上', () => {
  const now = atHour(12)
  const urgent = task({ title: '交方案', priority: 'urgent', due: '2026-11-05', status: 'todo' })
  const text = nagText(urgent, now)
  assert.match(text, /交方案 还卡着呢/)
  // 11-05 23:59:59 到期，现在 11-10 12:00 → 满 4 天
  assert.match(text, /已经拖了 4 天/)
  assert.match(text, /还要不要做/)

  const blocked = task({ title: '等审批', priority: 'normal', due: '2026-11-05', status: 'blocked' })
  assert.match(nagText(blocked, now), /等审批 还没动/)
  assert.match(nagText(blocked, now), /卡在哪儿了/)

  // 逾期不到 24 小时：已经过点了，不能说成「今天到期」——那听着像还没到。
  // 注意别把断言写成标题的同名词，否则永远匹配得上，测了个寂寞。
  const just = task({ title: '刚过点的事', priority: 'low', due: '2026-11-10 06:00', status: 'todo' })
  const justText = nagText(just, now)
  assert.match(justText, /刚过截止时间/)
  assert.doesNotMatch(justText, /今天到期/)
})

test('review：完成按结束时间统计，不按创建时间', () => {
  const now = atHour(12)
  const d = db([
    // 上个月建的，昨天才做完：算这段成绩
    task({ id: 'long', status: 'done', createdAt: now - 60 * DAY, endedAt: now - 1 * DAY }),
    // 这段建的，做完了但早于统计窗口：不算
    task({ id: 'oldDone', status: 'done', createdAt: now - 3 * DAY, endedAt: now - 40 * DAY }),
    task({ id: 'open', status: 'todo' }),
  ])
  const r = review(d, now, 14)
  assert.equal(r.done, 1)
  assert.equal(r.openNow, 1)
  assert.equal(r.completionRate, 100)
})

test('review：取消也算已结束，拉低完成率', () => {
  const now = atHour(12)
  const d = db([
    task({ id: 'a', status: 'done', endedAt: now - DAY }),
    task({ id: 'b', status: 'cancelled', endedAt: now - DAY }),
    task({ id: 'c', status: 'cancelled', endedAt: now - DAY }),
  ])
  const r = review(d, now, 14)
  assert.equal(r.done, 1)
  assert.equal(r.cancelled, 2)
  assert.equal(r.completionRate, 33)
})

test('review：准时率只看有截止时间的完成项', () => {
  const now = atHour(12)
  const d = db([
    // 截止 11-10 23:59，10:00 就做完了 → 准时
    task({ id: 'on', status: 'done', due: '2026-11-10', endedAt: atHour(10), createdAt: now - DAY }),
    // 截止 11-01 23:59，拖到 11-10 11:00 → 迟到
    task({ id: 'late', status: 'done', due: '2026-11-01', endedAt: now - HOUR, createdAt: now - 2 * DAY }),
    // 没截止时间的不算迟到
    task({ id: 'nodue', status: 'done', endedAt: now - HOUR, createdAt: now - 2 * DAY }),
  ])
  const r = review(d, now, 14)
  assert.equal(r.done, 3)
  assert.equal(r.onTimeRate, 67)
})

test('review：平均天数按创建到结束算', () => {
  const now = atHour(12)
  const d = db([
    task({ id: 'a', status: 'done', createdAt: now - 10 * DAY, endedAt: now - 6 * DAY }),   // 4 天
    task({ id: 'b', status: 'done', createdAt: now - 5 * DAY, endedAt: now - 2 * DAY }),    // 3 天
  ])
  assert.equal(review(d, now, 14).avgDays, 3.5)
})

test('review：逾期任务按星期几归类，指出最容易崩的那天', () => {
  const now = atHour(12)
  // 2026-11-06 是周五，2026-11-07 是周六
  const d = db([
    task({ id: 'a', status: 'todo', due: '2026-11-06' }),
    task({ id: 'b', status: 'todo', due: '2026-11-06' }),
    task({ id: 'c', status: 'todo', due: '2026-11-07' }),
  ])
  const r = review(d, now, 14)
  assert.equal(r.overdue, 3)
  assert.equal(new Date('2026-11-06T00:00:00').getDay(), 5)
  assert.equal(r.overdueByWeekday[5], 2)
  assert.equal(r.overdueByWeekday[6], 1)
  assert.equal(r.worstDay, '周五')
})

test('review：没有逾期任务时不给 worstDay', () => {
  const now = atHour(12)
  const d = db([task({ id: 'a', status: 'todo', due: '2030-01-01' })])
  assert.equal(review(d, now, 14).worstDay, '')
})

test('review：积压按优先级分桶，缺 priority 记 normal', () => {
  const now = atHour(12)
  const d = db([
    task({ id: 'a', status: 'todo', priority: 'urgent' }),
    task({ id: 'b', status: 'todo' }),
    { id: 'c', title: 'c', status: 'doing', createdAt: now, updatedAt: now },
  ])
  const r = review(d, now, 14)
  assert.equal(r.backlog.urgent, 1)
  assert.equal(r.backlog.normal, 2)
  assert.equal(r.backlog.high, 0)
})

test('review：老数据没有 endedAt 时退回 updatedAt', () => {
  const now = atHour(12)
  const d = db([{ id: 'a', title: 'a', status: 'done', createdAt: now - 5 * DAY, updatedAt: now - DAY }])
  assert.equal(review(d, now, 14).done, 1)
})

test('reviewText 拼出来的人话包含关键数字', () => {
  const r = {
    days: 14, created: 5, done: 3, cancelled: 1, openNow: 2, overdue: 1,
    completionRate: 75, onTimeRate: 67, avgDays: 3.5, worstDay: '周五',
    overdueByWeekday: [0, 0, 0, 0, 0, 1, 0], backlog: { urgent: 1, high: 0, normal: 1, low: 0 },
  }
  const text = reviewText(r)
  assert.match(text, /这 14 天新建 5 件/)
  assert.match(text, /做完 3 件/)
  assert.match(text, /准时率 67%/)
  assert.match(text, /平均 3\.5 天/)
  assert.match(text, /还开着 2 件/)
  assert.match(text, /最容易被拖掉的是周五/)
  assert.match(text, /紧急的还压着 1 件/)
})

test('reviewText 没有完成项时不吹准时率', () => {
  const r = {
    days: 7, created: 2, done: 0, cancelled: 0, openNow: 2, overdue: 0,
    completionRate: 0, onTimeRate: 0, avgDays: 0, worstDay: '',
    overdueByWeekday: [0, 0, 0, 0, 0, 0, 0], backlog: { urgent: 0, high: 0, normal: 2, low: 0 },
  }
  const text = reviewText(r)
  assert.doesNotMatch(text, /准时率/)
  assert.doesNotMatch(text, /最容易被拖掉/)
  assert.doesNotMatch(text, /紧急的还压着/)
})
