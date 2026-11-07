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

/** 当前数据结构版本。加字段不涨版本；改语义、改形状才涨。 */
export const SCHEMA_VERSION = 1

/** 数据比本插件支持的版本还新：不读不写，免得旧版把新版数据写坏。 */
export class SchemaVersionError extends Error {
  constructor(found) {
    super(`任务文件的数据版本是 ${found}，比本插件认识的 ${SCHEMA_VERSION} 新。为免覆盖你的数据，这次不读也不写。`)
    this.name = 'SchemaVersionError'
    this.found = found
    this.supported = SCHEMA_VERSION
  }
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export function defaultStorePath() {
  return join(homedir(), '.dsh', 'taskpilot', 'tasks.json')
}

const emptyDb = () => ({ version: SCHEMA_VERSION, tasks: [], meta: { lastScanAt: 0, lastNag: {} } })

export function createStore(file) {
  const path = file || defaultStorePath()

  function writeRaw(db) {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, path)
    return db
  }

  function read() {
    if (!existsSync(path)) return emptyDb()
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return emptyDb()
    }

    let db
    try {
      db = JSON.parse(raw)
      if (!db || typeof db !== 'object' || !Array.isArray(db.tasks)) throw new Error('shape')
    } catch {
      // 文件坏了就留证据再重开，别静默把用户的任务写没。
      try { renameSync(path, `${path}.broken-${Date.now()}`) } catch {}
      return emptyDb()
    }

    // 版本判定要排在「坏了就换新」之后：文件是好的、只是版本比本插件新，
    // 这时既不重命名也不写回，直接报错让调用方停手。
    const found = Number(db.version)
    if (Number.isFinite(found) && found > SCHEMA_VERSION) throw new SchemaVersionError(db.version)

    db.meta = db.meta && typeof db.meta === 'object' ? db.meta : { lastScanAt: 0, lastNag: {} }
    db.meta.lastNag = db.meta.lastNag && typeof db.meta.lastNag === 'object' ? db.meta.lastNag : {}

    // 最小迁移：没有 version（老文件）或小于 1，补齐后原地写回一次。
    // 这里只补版本号、不动 tasks，回写失败也不算致命（内存里已经是补齐态）。
    if (!Number.isFinite(found) || found < SCHEMA_VERSION) {
      db.version = SCHEMA_VERSION
      try { writeRaw(db) } catch {}
    }
    return db
  }

  function write(db) {
    const v = Number(db && db.version)
    // 防新版数据被旧版覆盖：读到新版本已经在 read() 拦下了，这里再拦一次写入路径。
    if (Number.isFinite(v) && v > SCHEMA_VERSION) throw new SchemaVersionError(db.version)
    if (!Number.isFinite(v)) db.version = SCHEMA_VERSION
    return writeRaw(db)
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

/**
 * 只认 YYYY-MM-DD 与 YYYY-MM-DD HH:mm，别的时间写法直接判无效，免得存进模糊值。
 * 时分必须真在范围内：早前 18:75 也能通过，存进去之后 dueMs 又认不出来，
 * 结果这条任务的截止时间永远等于「没设」——既不逾期也不催，静默失效。
 */
export function normDue(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  if (!m) return ''
  const [, y, mo, d, h, mi] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''
  const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const probe = new Date(`${date}T00:00:00`)
  if (Number.isNaN(probe.getTime())) return ''
  if (probe.getMonth() + 1 !== month || probe.getDate() !== day) return ''
  if (h === undefined) return date
  const hour = Number(h)
  const minute = Number(mi)
  if (hour > 23 || minute > 59) return ''
  return `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 截止时间转成毫秒；纯日期按当天 23:59:59 算，不算当天一早就逾期。
 * 这里必须自己拆字段，不能把字符串丢给 new Date()：
 * V8 的兜底解析会把「不是时间」这类串当成 1958 年前后的日期，返一个负数毫秒值。
 * 结果一负，isOverdue 的 t > 0 判断就静默失效，逾期任务永远催不出来。
 */
export function dueMs(due) {
  const s = String(due || '').trim()
  if (!s) return 0
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  if (!m) return 0
  const [, y, mo, d, h, mi] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = h === undefined ? 23 : Number(h)
  const minute = h === undefined ? 59 : Number(mi)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0
  const ms = new Date(year, month - 1, day, hour, minute, 59, 0).getTime()
  if (Number.isNaN(ms)) return 0
  // 2026-02-30 会被滚到 3 月，用回读校验拦住
  const probe = new Date(ms)
  if (probe.getFullYear() !== year || probe.getMonth() + 1 !== month || probe.getDate() !== day) return 0
  return ms
}

export function isOverdue(task, now = Date.now()) {
  if (!OPEN.includes(task.status)) return false
  const t = dueMs(task.due)
  return t > 0 && t < now
}

export function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000)
}
