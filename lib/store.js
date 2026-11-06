// 任务存储：一个 JSON 文件，读写全同步，坏文件自动备份不吞数据。
//
// 为什么不用数据库：一期只要单机单人几百条任务，JSON 够用，也方便用户自己打开看、
// 自己备份、自己手改。等真到几万条再换 SQLite，接口不变。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export const STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled']
/** 未结束的状态：只有这三个需要催。 */
export const OPEN = ['todo', 'doing', 'blocked']

const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export function defaultStorePath() {
  return join(homedir(), '.dsh', 'taskpilot', 'tasks.json')
}

const emptyDb = () => ({ version: 1, tasks: [], meta: { lastScanAt: 0, lastNag: {} } })

export function createStore(file) {
  const path = file || defaultStorePath()

  function read() {
    if (!existsSync(path)) return emptyDb()
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return emptyDb()
    }
    try {
      const db = JSON.parse(raw)
      if (!db || !Array.isArray(db.tasks)) throw new Error('shape')
      db.meta = db.meta && typeof db.meta === 'object' ? db.meta : { lastScanAt: 0, lastNag: {} }
      db.meta.lastNag = db.meta.lastNag && typeof db.meta.lastNag === 'object' ? db.meta.lastNag : {}
      return db
    } catch {
      // 文件坏了就留证据再重开，别静默把用户的任务写没。
      try { renameSync(path, `${path}.broken-${Date.now()}`) } catch {}
      return emptyDb()
    }
  }

  function write(db) {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, path)
    return db
  }

  return {
    path,
    read,
    write,
    /** 读-改-写，避免调用方每次自己写一遍。 */
    mutate(fn) {
      const db = read()
      const out = fn(db)
      write(db)
      return out
    },
    size() {
      try { return statSync(path).size } catch { return 0 }
    },
  }
}

export function newId() {
  return 't' + randomBytes(4).toString('hex')
}

export function normStatus(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return ''
  const alias = {
    todo: 'todo', pending: 'todo', open: 'todo', 待办: 'todo', 未开始: 'todo',
    doing: 'doing', wip: 'doing', progress: 'doing', 进行中: 'doing', 在做: 'doing',
    blocked: 'blocked', stuck: 'blocked', 卡住: 'blocked', 阻塞: 'blocked',
    done: 'done', complete: 'done', completed: 'done', finished: 'done', 完成: 'done', 已完成: 'done',
    cancelled: 'cancelled', canceled: 'cancelled', dropped: 'cancelled', 取消: 'cancelled', 放弃: 'cancelled',
  }
  return alias[s] || (STATUSES.includes(s) ? s : '')
}

export function normPriority(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return ''
  const alias = {
    low: 'low', 低: 'low', 不急: 'low',
    normal: 'normal', mid: 'normal', medium: 'normal', 普通: 'normal', 一般: 'normal',
    high: 'high', 高: 'high', 重要: 'high',
    urgent: 'urgent', p0: 'urgent', 紧急: 'urgent', 急: 'urgent',
  }
  return alias[s] || (PRIORITIES.includes(s) ? s : '')
}

/** 只认 YYYY-MM-DD 与 YYYY-MM-DD HH:mm，别的时间写法直接判无效，免得存进模糊值。 */
export function normDue(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  if (!m) return ''
  const [, y, mo, d, h, mi] = m
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const probe = new Date(`${date}T00:00:00`)
  if (Number.isNaN(probe.getTime())) return ''
  if (probe.getMonth() + 1 !== Number(mo) || probe.getDate() !== Number(d)) return ''
  if (h === undefined) return date
  const hh = String(Math.min(23, Number(h))).padStart(2, '0')
  return `${date} ${hh}:${String(mi).padStart(2, '0')}`
}

/** 截止时间转成毫秒；纯日期按当天 23:59:59 算，不算当天一早就逾期。 */
export function dueMs(due) {
  if (!due) return 0
  const s = due.length === 10 ? `${due} 23:59` : due
  const t = new Date(s.replace(' ', 'T') + ':59').getTime()
  return Number.isNaN(t) ? 0 : t
}

export function isOverdue(task, now = Date.now()) {
  if (!OPEN.includes(task.status)) return false
  const t = dueMs(task.due)
  return t > 0 && t < now
}

export function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000)
}
