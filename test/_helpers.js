// 测试用的假 ctx：只实现 lib/index.js 真正用到的那几个口子。
// 不碰 DSH 宿主，不读 ~/.dsh，全部落在 mkdtempSync 出来的临时目录里。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix = 'taskpilot-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    file: join(dir, 'tasks.json'),
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

export function makeCtx({ service } = {}) {
  const registered = []
  const disposers = []
  const logs = { info: [], warn: [] }
  return {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {
          const i = registered.indexOf(tool)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
    logger: () => ({
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
    }),
    get: (n) => (service && n === service.name ? service : undefined),
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    // 给测试断言用的内部句柄
    registered,
    logs,
    dispose() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d() } catch {}
      }
    },
  }
}

export function findTool(ctx, name) {
  const t = ctx.registered.find((x) => x.name === name)
  if (!t) throw new Error(`工具没注册上：${name}（已注册：${ctx.registered.map((x) => x.name).join(',')}）`)
  return t
}

/** 造一条任务，字段按 store 的实际形状给全。 */
export function task(over = {}) {
  const now = over.now || Date.now()
  return {
    id: over.id || 't' + Math.random().toString(16).slice(2, 10),
    title: over.title || '某件事',
    note: '',
    tags: [],
    status: over.status || 'todo',
    priority: over.priority || 'normal',
    due: over.due || '',
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    endedAt: over.endedAt ?? 0,
    nags: 0,
  }
}

/** 本地时间日期串，避免测试用 UTC 串在别的时区跑偏。 */
export function localDate(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const DAY = 86400000
