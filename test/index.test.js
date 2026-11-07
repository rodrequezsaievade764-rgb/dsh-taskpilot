// index：四个工具的行为、扫描器、推送通道。全部跑在临时 storePath 上。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply, name, inject } from '../lib/index.js'
import { createStore, SCHEMA_VERSION } from '../lib/store.js'
import { tempDir, makeCtx, findTool, task, DAY } from './_helpers.js'

/** 起一个插件实例，返回工具句柄和清理函数。 */
function boot(t, config = {}) {
  const dir = tempDir()
  const ctx = makeCtx({ service: config.__service })
  const cfg = { storePath: dir.file, quietHours: [7, 7], ...config }
  delete cfg.__service
  const pilot = apply(ctx, cfg)
  t.after(() => {
    ctx.dispose()
    dir.cleanup()
  })
  return { ctx, pilot, dir, tools: ctx.registered }
}

/** 直接往磁盘里塞任务，省得走 add 工具一轮。 */
function seed(dir, tasks, lastNag = {}) {
  const store = createStore(dir.file)
  store.write({ version: SCHEMA_VERSION, tasks, meta: { lastScanAt: 0, lastNag } })
}

test('插件导出 name / inject，apply 注册四个工具', (t) => {
  const { tools } = boot(t)
  assert.equal(name, 'taskpilot')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    ['taskpilot_add', 'taskpilot_list', 'taskpilot_review', 'taskpilot_update'],
  )
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
  }
})

// 宿主对工具的校验：output 里必须同时有 schema 与 render，缺一个就 warn 级拒收。
// 这种失败最阴——插件加载成功、日志只有一行警告，工具却一个都调不到。
test('每个工具的 output 里都有 schema 与 render（宿主拒收的形状）', (t) => {
  const { tools } = boot(t)
  for (const tool of tools) {
    assert.ok(tool.output && typeof tool.output === 'object', `${tool.name} 缺 output`)
    assert.equal(typeof tool.output.schema, 'object', `${tool.name} 的 output.schema 不是对象`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 的 output.render 不是函数`)
    assert.equal(tool.render, undefined, `${tool.name} 不该在顶层挂 render`)
  }
})

test('工具的 render 返回内容块数组，不是裸字符串', (t) => {
  const { tools } = boot(t)
  for (const tool of tools) {
    const blocks = tool.output.render({}, { ok: true, message: 'hi' })
    assert.ok(Array.isArray(blocks), `${tool.name} 的 render 没返回数组`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    const fail = tool.output.render({}, { ok: false, message: '炸了' })
    assert.match(fail[0].text, /✗/, `${tool.name} 的失败渲染该带 ✗`)
  }
})

// ---------- add ----------

test('add：正常记一条，字段补齐', async (t) => {
  const { ctx, dir } = boot(t)
  const add = findTool(ctx, 'taskpilot_add')
  const r = await add.execute({ title: '  写周报  ', due: '2026-11-08 18:00', priority: 'high', note: '别拖', tags: '工作, 周报' })
  assert.equal(r.ok, true)
  assert.match(r.message, /记下了：写周报/)
  assert.equal(r.task.title, '写周报')
  assert.equal(r.task.due, '2026-11-08 18:00')
  assert.equal(r.task.priority, 'high')
  assert.equal(r.task.status, 'todo')
  assert.deepEqual(r.task.tags, ['工作', '周报'])
  const back = createStore(dir.file).read()
  assert.equal(back.tasks.length, 1)
  assert.equal(back.version, SCHEMA_VERSION)
})

test('add：标题空 / 超长被拒', async (t) => {
  const { ctx } = boot(t)
  const add = findTool(ctx, 'taskpilot_add')
  assert.equal((await add.execute({ title: '   ' })).ok, false)
  assert.equal((await add.execute({})).ok, false)
  const long = await add.execute({ title: 'x'.repeat(201) })
  assert.equal(long.ok, false)
  assert.match(long.message, /200/)
})

test('add：截止时间写法不认就报错，不塞模糊值进去', async (t) => {
  const { ctx, dir } = boot(t)
  const add = findTool(ctx, 'taskpilot_add')
  const r = await add.execute({ title: 'x', due: '明天下午' })
  assert.equal(r.ok, false)
  assert.match(r.message, /看不懂/)
  assert.equal(createStore(dir.file).read().tasks.length, 0)
})

test('add：不写截止时间也能记，due 为空串', async (t) => {
  const { ctx } = boot(t)
  const r = await findTool(ctx, 'taskpilot_add').execute({ title: '随手记一条' })
  assert.equal(r.ok, true)
  assert.equal(r.task.due, '')
  assert.match(r.message, /记下了：随手记一条$/)
})

test('add：优先级不认就退回 normal', async (t) => {
  const { ctx } = boot(t)
  const r = await findTool(ctx, 'taskpilot_add').execute({ title: 'x', priority: '超级急' })
  assert.equal(r.task.priority, 'normal')
})

// ---------- update ----------

test('update：按 id 改状态，进 done 打 endedAt', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '交方案' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', status: '完成' })
  assert.equal(r.ok, true)
  assert.match(r.message, /todo → done/)
  assert.ok(r.task.endedAt > 0)
})

test('update：从 done 退回 todo 会清掉 endedAt', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '交方案', status: 'done', endedAt: Date.now() })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', status: 'todo' })
  assert.equal(r.task.endedAt, 0)
})

test('update：按标题模糊匹配', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' }), task({ id: 'tB', title: '交方案' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ title: '周报', status: 'doing' })
  assert.equal(r.ok, true)
  assert.equal(r.task.id, 'tA')
  assert.equal(r.task.status, 'doing')
})

test('update：标题命中多条时列出来让人挑，不改任何数据', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' }), task({ id: 'tB', title: '写月报' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ title: '写', status: 'done' })
  assert.equal(r.ok, false)
  assert.match(r.message, /匹配到 2 条/)
  assert.match(r.message, /tA 写周报/)
  const back = createStore(dir.file).read()
  assert.equal(back.tasks.filter((x) => x.status === 'done').length, 0)
})

test('update：找不到就报清楚', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' })])
  const byId = await findTool(ctx, 'taskpilot_update').execute({ id: 'nope', status: 'done' })
  assert.equal(byId.ok, false)
  assert.match(byId.message, /没有 id 为 nope/)
  const byTitle = await findTool(ctx, 'taskpilot_update').execute({ title: '不存在', status: 'done' })
  assert.equal(byTitle.ok, false)
  assert.match(byTitle.message, /没找到/)
})

test('update：id 和 title 都不给就拒绝', async (t) => {
  const { ctx } = boot(t)
  const r = await findTool(ctx, 'taskpilot_update').execute({ status: 'done' })
  assert.equal(r.ok, false)
  assert.match(r.message, /给 id 或 title/)
})

test('update：remove 真删掉', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' }), task({ id: 'tB', title: '交方案' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', remove: true })
  assert.equal(r.ok, true)
  assert.match(r.message, /删掉了/)
  const back = createStore(dir.file).read()
  assert.deepEqual(back.tasks.map((x) => x.id), ['tB'])
})

test('update：截止时间可以清空', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报', due: '2026-11-08' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', due: '' })
  assert.equal(r.task.due, '')
  assert.match(r.message, /截止时间清掉了/)
})

test('update：状态 / 优先级写错就拒绝，数据不动', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' })])
  const badStatus = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', status: '瞎写' })
  assert.equal(badStatus.ok, false)
  assert.match(badStatus.message, /状态只认/)
  const badPri = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA', priority: '瞎写' })
  assert.equal(badPri.ok, false)
  assert.match(badPri.message, /优先级只认/)
  assert.equal(createStore(dir.file).read().tasks[0].status, 'todo')
})

test('update：什么都没改就说没有要改的字段', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'tA', title: '写周报' })])
  const r = await findTool(ctx, 'taskpilot_update').execute({ id: 'tA' })
  assert.equal(r.ok, true)
  assert.match(r.message, /没有要改的字段/)
})

// ---------- list：all / includeClosed 语义 ----------

test('list：默认只列未结束任务，最多 8 条', async (t) => {
  const { ctx, dir } = boot(t)
  const open = Array.from({ length: 12 }, (_, i) => task({ id: 'o' + i, title: '开着的' + i }))
  seed(dir, [...open, task({ id: 'd1', title: '做完了', status: 'done', endedAt: Date.now() })])
  const r = await findTool(ctx, 'taskpilot_list').execute({})
  assert.equal(r.ok, true)
  assert.equal(r.count, 12, '默认视图里不该混进已完成任务')
  assert.equal(r.shown, 8)
  assert.match(r.message, /还有 4 条没列/)
  assert.doesNotMatch(r.message, /做完了/)
})

test('list：all=true 列出全部未结束任务，不截断到 8', async (t) => {
  const { ctx, dir } = boot(t)
  const open = Array.from({ length: 12 }, (_, i) => task({ id: 'o' + i, title: '开着的' + i }))
  seed(dir, [...open, task({ id: 'd1', title: '做完了', status: 'done', endedAt: Date.now() })])
  const r = await findTool(ctx, 'taskpilot_list').execute({ all: true })
  assert.equal(r.count, 12)
  assert.equal(r.shown, 12)
  assert.doesNotMatch(r.message, /没列/)
})

test('list：all=true 仍不含已完成 / 已取消（描述与实现一致）', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'a', title: '开着的', status: 'todo' }),
    task({ id: 'b', title: '做完了', status: 'done', endedAt: Date.now() }),
    task({ id: 'c', title: '不做了', status: 'cancelled', endedAt: Date.now() }),
  ])
  const r = await findTool(ctx, 'taskpilot_list').execute({ all: true })
  assert.equal(r.count, 1)
  assert.match(r.message, /开着的/)
  assert.doesNotMatch(r.message, /做完了/)
  assert.doesNotMatch(r.message, /不做了/)
})

test('list：includeClosed=true 才把已完成 / 已取消列出来', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'a', title: '开着的', status: 'todo' }),
    task({ id: 'b', title: '做完了', status: 'done', endedAt: Date.now() }),
    task({ id: 'c', title: '不做了', status: 'cancelled', endedAt: Date.now() }),
  ])
  const r = await findTool(ctx, 'taskpilot_list').execute({ includeClosed: true })
  assert.equal(r.count, 3)
  assert.match(r.message, /开着的/)
  assert.match(r.message, /做完了（已完成）/)
  assert.match(r.message, /不做了（已取消）/)
})

test('list：all + includeClosed 上限 30 条', async (t) => {
  const { ctx, dir } = boot(t)
  const tasks = Array.from({ length: 35 }, (_, i) => task({ id: 'o' + i, title: '任务' + i }))
  seed(dir, tasks)
  const r = await findTool(ctx, 'taskpilot_list').execute({ all: true, includeClosed: true })
  assert.equal(r.count, 35)
  assert.equal(r.shown, 30)
  assert.match(r.message, /还有 5 条没列/)
})

test('list：status 精确筛某个状态（绕过默认过滤）', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'a', title: '做完了', status: 'done', endedAt: Date.now() }),
    task({ id: 'b', title: '开着的', status: 'todo' }),
  ])
  const r = await findTool(ctx, 'taskpilot_list').execute({ status: 'done' })
  assert.equal(r.count, 1)
  assert.match(r.message, /做完了/)
})

test('list：overdueOnly 只看逾期的', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'a', title: '过期了', status: 'todo', due: '2020-01-01' }),
    task({ id: 'b', title: '还早', status: 'todo', due: '2099-01-01' }),
  ])
  const r = await findTool(ctx, 'taskpilot_list').execute({ overdueOnly: true })
  assert.equal(r.count, 1)
  assert.match(r.message, /过期了/)
  assert.match(r.message, /逾期/)
  assert.doesNotMatch(r.message, /还早/)
})

test('list：keyword 按标题筛，大小写不敏感', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'a', title: 'Write Report' }), task({ id: 'b', title: '写周报' })])
  const r = await findTool(ctx, 'taskpilot_list').execute({ keyword: 'report' })
  assert.equal(r.count, 1)
  assert.match(r.message, /Write Report/)
})

test('list：空清单给一句干净的话', async (t) => {
  const { ctx } = boot(t)
  const r = await findTool(ctx, 'taskpilot_list').execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /没有要做的了/)
})

test('list：逾期排最前，其次按截止时间', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'later', title: '晚的', due: '2099-01-02' }),
    task({ id: 'soon', title: '早的', due: '2099-01-01' }),
    task({ id: 'over', title: '过期的', due: '2020-01-01' }),
  ])
  const r = await findTool(ctx, 'taskpilot_list').execute({ all: true })
  const lines = r.message.split('\n')
  assert.match(lines[0], /过期的/)
  assert.match(lines[1], /早的/)
  assert.match(lines[2], /晚的/)
})

test('list：doing / blocked 的标记写对', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [
    task({ id: 'a', title: '在做的', status: 'doing' }),
    task({ id: 'b', title: '卡住的', status: 'blocked' }),
  ])
  const msg = (await findTool(ctx, 'taskpilot_list').execute({ all: true })).message
  assert.match(msg, /在做的（在做）/)
  assert.match(msg, /卡住的（卡住）/)
})

test('list：description 说清 all 与 includeClosed 的分工', (t) => {
  const { ctx } = boot(t)
  const d = findTool(ctx, 'taskpilot_list').description
  assert.match(d, /includeClosed/)
  assert.match(d, /未结束/)
  assert.equal(findTool(ctx, 'taskpilot_list').parameters.properties.includeClosed.type, 'boolean')
})

// ---------- review ----------

test('review：没记录时给一句空话', async (t) => {
  const { ctx } = boot(t)
  const r = await findTool(ctx, 'taskpilot_review').execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /没有任务记录/)
})

test('review：给出统计并用大白话说出来', async (t) => {
  const { ctx, dir } = boot(t)
  const now = Date.now()
  seed(dir, [
    task({ id: 'a', title: '做完了', status: 'done', createdAt: now - 5 * DAY, endedAt: now - DAY }),
    task({ id: 'b', title: '还开着', status: 'todo' }),
  ])
  const r = await findTool(ctx, 'taskpilot_review').execute({ days: 30 })
  assert.equal(r.ok, true)
  assert.equal(r.stats.days, 30)
  assert.equal(r.stats.done, 1)
  assert.equal(r.stats.openNow, 1)
  assert.match(r.message, /这 30 天/)
})

test('review：days 被夹在 1..365', async (t) => {
  const { ctx, dir } = boot(t)
  seed(dir, [task({ id: 'a', title: '还开着', status: 'todo' })])
  const review = findTool(ctx, 'taskpilot_review')
  assert.equal((await review.execute({ days: 999 })).stats.days, 365)
  assert.equal((await review.execute({ days: -5 })).stats.days, 1)
  assert.equal((await review.execute({})).stats.days, 14, '不传就用默认 14 天')
})

// ---------- 扫描与推送 ----------

test('scan：安静时段只记 lastScanAt，不推送', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  let sent = 0
  const service = { name: 'im', send: async () => { sent += 1; return { ok: true } } }
  const ctx = makeCtx({ service })
  t.after(() => ctx.dispose())
  apply(ctx, { storePath: dir.file, quietHours: [0, 24], notifyService: 'im' })

  seed(dir, [task({ id: 'a', title: '过期的', status: 'todo', due: '2020-01-01' })])
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [0, 24], notifyService: 'im' })
  t.after(() => ctx.dispose())
  await pilot.scan()

  assert.equal(sent, 0)
  const db = createStore(dir.file).read()
  assert.ok(db.meta.lastScanAt > 0)
  assert.deepEqual(db.meta.lastNag, {})
})

test('scan：静默期外把逾期任务推出去，并写回 lastNag', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const seen = []
  const service = { name: 'im', send: async (p) => { seen.push(p); return { ok: true } } }
  const ctx = makeCtx({ service })
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7], notifyService: 'im', notifyTo: 'me' })

  seed(dir, [task({ id: 'a', title: '交方案', status: 'todo', due: '2020-01-01', priority: 'urgent' })])
  await pilot.scan()

  assert.equal(seen.length, 1)
  assert.match(seen[0].text, /有事儿提醒你/)
  assert.match(seen[0].text, /交方案/)
  assert.equal(seen[0].target, 'me')

  const db = createStore(dir.file).read()
  assert.ok(db.meta.lastNag.a > 0)
})

test('scan：同一件事冷却期内不会被连催两次', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  let sent = 0
  const service = { name: 'im', send: async () => { sent += 1; return { ok: true } } }
  const ctx = makeCtx({ service })
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7], notifyService: 'im' })
  seed(dir, [task({ id: 'a', title: '交方案', status: 'todo', due: '2020-01-01' })])

  await pilot.scan()
  await pilot.scan()
  assert.equal(sent, 1)
})

test('scan：卡住的任务会被点出来', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const seen = []
  const service = { name: 'im', send: async (p) => { seen.push(p.text); return { ok: true } } }
  const ctx = makeCtx({ service })
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7], notifyService: 'im' })

  seed(dir, [task({ id: 'a', title: '卡了五天', status: 'doing', updatedAt: Date.now() - 5 * DAY })])
  await pilot.scan()
  assert.equal(seen.length, 1)
  assert.match(seen[0], /挂在手上好几天/)
  assert.match(seen[0], /卡了五天/)
})

test('scan：删掉的任务不会在 lastNag 里留死键', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const ctx = makeCtx({ service: { name: 'im', send: async () => ({ ok: true }) } })
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7], notifyService: 'im' })

  seed(dir, [task({ id: 'alive', title: '还在', status: 'todo', due: '2020-01-01' })], {
    gone: Date.now() - DAY,
    doneAlready: Date.now() - DAY,
  })
  await pilot.scan()
  const db = createStore(dir.file).read()
  assert.deepEqual(Object.keys(db.meta.lastNag), ['alive'])
})

test('scan：webhook 通道 POST 出去的 JSON 形状对', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const bodies = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push({ headers: req.headers, body: raw })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const port = server.address().port

  const ctx = makeCtx()
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, {
    storePath: dir.file,
    quietHours: [7, 7],
    webhookUrl: `http://127.0.0.1:${port}/hook`,
  })
  seed(dir, [task({ id: 'a', title: '交方案', status: 'todo', due: '2020-01-01' })])
  await pilot.scan()

  assert.equal(bodies.length, 1)
  assert.match(bodies[0].headers['content-type'], /application\/json/)
  const payload = JSON.parse(bodies[0].body)
  assert.match(payload.text, /交方案/)
  assert.equal(payload.msgtype, 'text')
  assert.ok(payload.content.text.startsWith('有事儿提醒你'))
})

test('scan：推送服务抛异常也不崩，日志里留痕', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const service = { name: 'im', send: async () => { throw new Error('网络断了') } }
  const ctx = makeCtx({ service })
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7], notifyService: 'im' })
  seed(dir, [task({ id: 'a', title: '交方案', status: 'todo', due: '2020-01-01' })])
  await pilot.scan()
  assert.ok(ctx.logs.warn.some((m) => m.includes('网络断了')))
})

test('scan：store 版本比插件新时整轮失败但不破坏文件', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const ctx = makeCtx()
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file, quietHours: [7, 7] })
  const store = createStore(dir.file)
  store.write({ version: SCHEMA_VERSION, tasks: [], meta: { lastScanAt: 0, lastNag: {} } })
  // 手改成未来版本
  const { writeFileSync, readFileSync } = await import('node:fs')
  const future = JSON.stringify({ version: SCHEMA_VERSION + 1, tasks: [], meta: { lastNag: {} } })
  writeFileSync(dir.file, future, 'utf8')

  await pilot.scan()
  assert.equal(readFileSync(dir.file, 'utf8'), future, '拒绝覆盖新版数据')
  assert.ok(ctx.logs.warn.some((m) => m.includes('版本')))
})

test('工具层遇到未来版本：返回 ok:false，不抛裸异常', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const ctx = makeCtx()
  t.after(() => ctx.dispose())
  apply(ctx, { storePath: dir.file, quietHours: [7, 7] })
  const { writeFileSync } = await import('node:fs')
  const future = JSON.stringify({ version: SCHEMA_VERSION + 9, tasks: [], meta: { lastNag: {} } })
  writeFileSync(dir.file, future, 'utf8')

  const r = await findTool(ctx, 'taskpilot_list').execute({})
  assert.equal(r.ok, false)
  assert.match(r.message, /版本/)
  assert.equal((await import('node:fs')).readFileSync(dir.file, 'utf8'), future)
})

// ---------- 配置 ----------

test('apply：storePath 指到哪就写哪，默认路径不落盘', (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const ctx = makeCtx()
  t.after(() => ctx.dispose())
  const pilot = apply(ctx, { storePath: dir.file })
  assert.equal(pilot.path, dir.file)
  assert.equal(pilot.store.path, dir.file)
  assert.equal(typeof pilot.scan, 'function')
})

test('apply：插件产出的文件能被下一轮实例读回（无状态漂移）', async (t) => {
  const dir = tempDir()
  t.after(() => dir.cleanup())
  const ctx1 = makeCtx()
  const p1 = apply(ctx1, { storePath: dir.file, quietHours: [7, 7] })
  await findTool(ctx1, 'taskpilot_add').execute({ title: '跨实例任务' })
  ctx1.dispose()

  const ctx2 = makeCtx()
  t.after(() => ctx2.dispose())
  apply(ctx2, { storePath: dir.file, quietHours: [7, 7] })
  const r = await findTool(ctx2, 'taskpilot_list').execute({ all: true })
  assert.match(r.message, /跨实例任务/)
})
