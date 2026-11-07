// store：读写、坏文件、版本迁移、字段归一化。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'

import {
  createStore, newId, normStatus, normPriority, normDue, dueMs, isOverdue,
  daysBetween, SCHEMA_VERSION, SchemaVersionError, STATUSES, OPEN,
  normTags, hasTag, MAX_TAGS,
} from '../lib/store.js'
import { tempDir, task, DAY } from './_helpers.js'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('文件不存在时读出空库，且带当前版本号', () => {
  const t = tempDir()
  try {
    const store = createStore(t.file)
    const db = store.read()
    assert.equal(db.version, SCHEMA_VERSION)
    assert.deepEqual(db.tasks, [])
    assert.deepEqual(db.meta.lastNag, {})
    assert.equal(db.meta.lastScanAt, 0)
    // 只读不写：读不该顺手创建文件
    assert.equal(existsSync(t.file), false)
    assert.equal(store.size(), 0)
  } finally { t.cleanup() }
})

test('write 之后 read 能原样拿回来', () => {
  const t = tempDir()
  try {
    const store = createStore(t.file)
    const db = store.read()
    db.tasks.push(task({ id: 't0001', title: '写周报' }))
    store.write(db)
    const back = createStore(t.file).read()
    assert.equal(back.tasks.length, 1)
    assert.equal(back.tasks[0].title, '写周报')
    assert.ok(store.size() > 0)
  } finally { t.cleanup() }
})

test('mutate 读改写一步到位，并返回回调结果', () => {
  const t = tempDir()
  try {
    const store = createStore(t.file)
    const out = store.mutate((db) => {
      db.tasks.push(task({ id: 'tA', title: '甲' }))
      return 'ok'
    })
    assert.equal(out, 'ok')
    assert.equal(store.read().tasks.length, 1)
  } finally { t.cleanup() }
})

test('文件是坏 JSON：改名成 .broken-<时间戳> 留证，返回空库', () => {
  const t = tempDir()
  try {
    writeFileSync(t.file, '{ 这不是 json', 'utf8')
    const store = createStore(t.file)
    const db = store.read()
    assert.deepEqual(db.tasks, [])
    assert.equal(db.version, SCHEMA_VERSION)
    const broken = readdirSync(t.dir).filter((f) => f.includes('.broken-'))
    assert.equal(broken.length, 1)
  } finally { t.cleanup() }
})

test('形状不对（tasks 不是数组）也按坏文件处理', () => {
  const t = tempDir()
  try {
    writeFileSync(t.file, JSON.stringify({ version: 1, tasks: 'nope' }), 'utf8')
    const db = createStore(t.file).read()
    assert.deepEqual(db.tasks, [])
    assert.equal(readdirSync(t.dir).filter((f) => f.includes('.broken-')).length, 1)
  } finally { t.cleanup() }
})

test('迁移：老文件没有 version 时补成当前版本并写回一次', () => {
  const t = tempDir()
  try {
    const legacy = { tasks: [task({ id: 'tOld', title: '旧任务' })], meta: { lastScanAt: 7, lastNag: {} } }
    writeFileSync(t.file, JSON.stringify(legacy), 'utf8')
    const db = createStore(t.file).read()
    assert.equal(db.version, SCHEMA_VERSION)
    assert.equal(db.tasks.length, 1)
    assert.equal(db.tasks[0].title, '旧任务')
    // 写回了磁盘
    assert.equal(readJson(t.file).version, SCHEMA_VERSION)
    // 任务数据一个字节都没动
    assert.equal(readJson(t.file).tasks[0].id, 'tOld')
  } finally { t.cleanup() }
})

test('迁移：version 小于当前版本时补齐并写回', () => {
  const t = tempDir()
  try {
    writeFileSync(t.file, JSON.stringify({ version: 0, tasks: [], meta: {} }), 'utf8')
    const db = createStore(t.file).read()
    assert.equal(db.version, SCHEMA_VERSION)
    assert.equal(readJson(t.file).version, SCHEMA_VERSION)
  } finally { t.cleanup() }
})

test('迁移：meta / lastNag 缺字段时补默认值', () => {
  const t = tempDir()
  try {
    writeFileSync(t.file, JSON.stringify({ version: 1, tasks: [] }), 'utf8')
    const db = createStore(t.file).read()
    assert.equal(db.meta.lastScanAt, 0)
    assert.deepEqual(db.meta.lastNag, {})
  } finally { t.cleanup() }
})

test('读：版本比本插件新时抛 SchemaVersionError，且不重命名、不改文件', () => {
  const t = tempDir()
  try {
    const future = { version: SCHEMA_VERSION + 1, tasks: [task({ id: 'tF', title: '新版任务' })], meta: {} }
    const raw = JSON.stringify(future)
    writeFileSync(t.file, raw, 'utf8')

    const store = createStore(t.file)
    assert.throws(() => store.read(), (e) => {
      assert.ok(e instanceof SchemaVersionError)
      assert.equal(e.name, 'SchemaVersionError')
      assert.equal(e.found, SCHEMA_VERSION + 1)
      assert.equal(e.supported, SCHEMA_VERSION)
      return true
    })
    // 文件原样保留，也没被当成坏文件改名
    assert.equal(readFileSync(t.file, 'utf8'), raw)
    assert.equal(readdirSync(t.dir).filter((f) => f.includes('.broken-')).length, 0)
  } finally { t.cleanup() }
})

test('写：db.version 比本插件新时拒写，文件不被覆盖', () => {
  const t = tempDir()
  try {
    const store = createStore(t.file)
    const good = store.read()
    good.tasks.push(task({ id: 't1' }))
    store.write(good)
    const before = readFileSync(t.file, 'utf8')

    assert.throws(
      () => store.write({ version: SCHEMA_VERSION + 5, tasks: [], meta: { lastNag: {} } }),
      (e) => e instanceof SchemaVersionError,
    )
    assert.equal(readFileSync(t.file, 'utf8'), before)
  } finally { t.cleanup() }
})

test('写：db.version 缺失时自动补当前版本', () => {
  const t = tempDir()
  try {
    const store = createStore(t.file)
    store.write({ tasks: [task({ id: 't1' })], meta: { lastNag: {} } })
    assert.equal(readJson(t.file).version, SCHEMA_VERSION)
  } finally { t.cleanup() }
})

test('newId 每次不同且以 t 开头', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newId()))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^t[0-9a-f]{8}$/)
})

test('normStatus 认英文、别名和中文', () => {
  assert.equal(normStatus('todo'), 'todo')
  assert.equal(normStatus('PENDING'), 'todo')
  assert.equal(normStatus(' 待办 '), 'todo')
  assert.equal(normStatus('进行中'), 'doing')
  assert.equal(normStatus('wip'), 'doing')
  assert.equal(normStatus('stuck'), 'blocked')
  assert.equal(normStatus('完成'), 'done')
  assert.equal(normStatus('canceled'), 'cancelled')
  assert.equal(normStatus('放弃'), 'cancelled')
  assert.equal(normStatus('瞎写'), '')
  assert.equal(normStatus(''), '')
  assert.equal(normStatus(undefined), '')
})

test('normPriority 认别名，未知值返回空串', () => {
  assert.equal(normPriority('urgent'), 'urgent')
  assert.equal(normPriority('P0'), 'urgent')
  assert.equal(normPriority('紧急'), 'urgent')
  assert.equal(normPriority('medium'), 'normal')
  assert.equal(normPriority('一般'), 'normal')
  assert.equal(normPriority('低'), 'low')
  assert.equal(normPriority('whatever'), '')
})

test('normDue 只认两种写法，非法日期返回空串', () => {
  assert.equal(normDue('2026-11-08'), '2026-11-08')
  assert.equal(normDue('2026-11-08 18:00'), '2026-11-08 18:00')
  assert.equal(normDue('2026-11-8'), '2026-11-08')
  assert.equal(normDue('2026-11-8 7:05'), '2026-11-08 07:05')
  assert.equal(normDue('2026-11-08T18:00'), '2026-11-08 18:00')
  // 不存在的日子不能蒙过去
  assert.equal(normDue('2026-02-30'), '')
  assert.equal(normDue('2026-13-01'), '')
  // 别的写法一律不收
  assert.equal(normDue('明天'), '')
  assert.equal(normDue('11/08'), '')
  assert.equal(normDue('2026-11-08 18:00:00'), '')
  assert.equal(normDue(''), '')
})

test('dueMs：纯日期按当天 23:59:59 算，非法或空返回 0', () => {
  const dayOnly = dueMs('2026-11-08')
  const d = new Date(dayOnly)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 10)
  assert.equal(d.getDate(), 8)
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
  assert.equal(d.getSeconds(), 59)

  const withTime = dueMs('2026-11-08 18:00')
  assert.equal(new Date(withTime).getHours(), 18)
  assert.equal(new Date(withTime).getMinutes(), 0)
  assert.ok(withTime < dayOnly)

  assert.equal(dueMs(''), 0)
  assert.equal(dueMs(undefined), 0)
  assert.equal(dueMs('不是时间'), 0)
})

test('normDue：时分越界一律判无效（别再靠钳位蒙过去）', () => {
  assert.equal(normDue('2026-11-08 18:75'), '')
  assert.equal(normDue('2026-11-08 25:00'), '')
  assert.equal(normDue('2026-11-08 24:00'), '')
  assert.equal(normDue('2026-11-08 23:60'), '')
  // 边界上合法的要过
  assert.equal(normDue('2026-11-08 23:59'), '2026-11-08 23:59')
  assert.equal(normDue('2026-11-08 00:00'), '2026-11-08 00:00')
})

test('normDue 的产出必须都能被 dueMs 认出来（两处口径对齐）', () => {
  // 早前 normDue 放过了 18:75，dueMs 却解析失败返回 0，
  // 于是这条任务的截止时间静默等于「没设」。这条用例把两个函数钉在一起。
  const samples = [
    '2026-01-01', '2026-12-31', '2026-02-28', '2028-02-29',
    '2026-11-08 00:00', '2026-11-08 23:59', '2026-06-15 9:05',
    '2026-11-8', '2026-11-8 7:05',
  ]
  for (const raw of samples) {
    const norm = normDue(raw)
    assert.notEqual(norm, '', `normDue 该收下 ${raw}`)
    assert.ok(dueMs(norm) > 0, `dueMs 认不出 normDue 的产出：${raw} → ${norm}`)
  }
  // 反过来：normDue 拒掉的，dueMs 也必须给 0，不能一个拒一个收
  for (const raw of ['2026-11-08 18:75', '2026-13-01', '2026-02-30', '明天', '11/08']) {
    assert.equal(normDue(raw), '', `normDue 不该收 ${raw}`)
    assert.equal(dueMs(raw), 0, `dueMs 不该认 ${raw}`)
  }
})

test('normDue：非法日期不会被 Date 的滚动兜底骗过去', () => {
  assert.equal(normDue('2026-02-30'), '')
  assert.equal(normDue('2026-04-31'), '')
  assert.equal(normDue('2026-00-10'), '')
  assert.equal(normDue('2026-01-00'), '')
})

test('dueMs：闰年 2 月 29 认得，平年不认', () => {
  assert.ok(dueMs('2028-02-29') > 0)
  assert.equal(dueMs('2026-02-29'), 0)
  assert.equal(dueMs('2026-02-30'), 0)
})

test('dueMs：非法字符串不会被当成 1958 年的负数时间戳', () => {
  // 老实现把串直接丢给 new Date()，V8 兜底解析会返负数。
  // 负数进来 isOverdue 的 t > 0 就静默失效了，这里钉住返回值必须是 0。
  for (const junk of ['不是时间', 'abc', '2026/11/08', '2026年11月8日', '18:00', 'x'.repeat(40)]) {
    const v = dueMs(junk)
    assert.equal(v, 0, `dueMs(${JSON.stringify(junk)}) 应是 0，实际 ${v}`)
    assert.ok(v >= 0, 'dueMs 永远不能返回负数')
  }
})

test('isOverdue：只有未结束状态才算逾期', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0)
  assert.equal(isOverdue(task({ status: 'todo', due: '2026-11-01' }), now), true)
  assert.equal(isOverdue(task({ status: 'doing', due: '2026-11-01' }), now), true)
  assert.equal(isOverdue(task({ status: 'blocked', due: '2026-11-01' }), now), true)
  assert.equal(isOverdue(task({ status: 'done', due: '2026-11-01' }), now), false)
  assert.equal(isOverdue(task({ status: 'cancelled', due: '2026-11-01' }), now), false)
  assert.equal(isOverdue(task({ status: 'todo', due: '' }), now), false)
  // 未来的截止时间不算逾期
  assert.equal(isOverdue(task({ status: 'todo', due: '2030-01-01' }), now), false)
})

test('daysBetween 向下取整', () => {
  assert.equal(daysBetween(0, DAY), 1)
  assert.equal(daysBetween(0, DAY - 1), 0)
  assert.equal(daysBetween(0, DAY * 3 + 5), 3)
})

test('导出常量保持稳定（工具层依赖它们）', () => {
  assert.deepEqual(STATUSES, ['todo', 'doing', 'blocked', 'done', 'cancelled'])
  assert.deepEqual(OPEN, ['todo', 'doing', 'blocked'])
  assert.equal(SCHEMA_VERSION, 1)
})

test('normTags：中文逗号 / 顿号 / 空白都算分隔符', () => {
  assert.deepEqual(normTags('a，b、c d'), ['a', 'b', 'c', 'd'])
})

test('normTags：去重且小写，保持首次出现顺序', () => {
  assert.deepEqual(normTags('FE fe Fe backend'), ['fe', 'backend'])
})

test('normTags：上限 MAX_TAGS，多的截掉', () => {
  const got = normTags('a,b,c,d,e,f,g,h,i,j')
  assert.equal(got.length, MAX_TAGS)
  assert.deepEqual(got, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
})

test('normTags：空输入 / null / 数组都能吃', () => {
  assert.deepEqual(normTags(''), [])
  assert.deepEqual(normTags(null), [])
  assert.deepEqual(normTags(undefined), [])
  assert.deepEqual(normTags(['X', 'y']), ['x', 'y'])
})

test('hasTag：大小写不敏感、只认全等、无 tags 不炸', () => {
  assert.equal(hasTag({ tags: ['FE'] }, 'fe'), true)
  assert.equal(hasTag({ tags: ['fe'] }, 'FE'), true)
  assert.equal(hasTag({ tags: ['frontend'] }, 'front'), false)
  assert.equal(hasTag({}, 'x'), false)
  assert.equal(hasTag(null, 'x'), false)
  assert.equal(hasTag({ tags: ['x'] }, ''), false)
})