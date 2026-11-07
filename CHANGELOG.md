# CHANGELOG

## 0.2.0

第一版只保证「能记能列」；这一版把静默失效的路径堵上，并且第一次带上测试。

### 修

- **`normDue` 会把非法时间悄悄改成一个合法时间**：原实现 `String(Math.min(23, Number(h)))` 把 `18:75` 钳成 `18:23`，分钟位完全不校验。存进库的 due 解析失败就返回 0，于是这个任务永远不逾期、永远不催——从用户视角看是「加了催办但从来没响」。现在改成自己正则拆字段并回读校验，`18:75`、`2026-02-30` 这类直接判非法。
- **`dueMs` 让「不是时间」变成 1958 年的负数**：原实现把字符串拼上 `:59` 交给 `new Date()` 兜底解析，V8 会把某些乱码解成 1950 年代的负值毫秒，`isOverdue` 里的 `t > 0` 就静默失效。现在自己解析、自己校验，解析不出来就明确当「没设截止」。
- **`meta.lastNag` 只增不减**：催办记录按任务 id 存，任务删了、结束了，键还永久躺在库里，越用越胖。新增 `pruneLastNag()`，每次扫描取记录前先剔掉已不存在或已结束任务的键。
- **`all=true` 与工具说明矛盾**：说明写「看全部未结束任务」，实现却是 `if (!args.all) 才筛掉已结束」——也就是 `all=true` 会把已完成、已取消的一起列出来。现在按说明修正：`all=true` = 全部未结束（不截断到 8 条），要看已结束另开 `includeClosed` 参数。
- **schema 版本号只写不读**：库里写了 `version: 1`，读取时从不检查，将来加字段就没有迁移余地。现在读到缺失或旧版本会补号并写回一次；读到比当前代码更新的版本直接抛 `SchemaVersionError` 拒绝写入，防止新版数据被旧版覆盖。

### 加

- **测试套件（从 0 到 92 个用例）**：`lib/store.js`、`lib/notify.js`、`lib/index.js` 三层全覆盖，文件读写用 `mkdtempSync` 造临时目录，全程离线。
- `package.json` 补 `scripts.test`、`files` 白名单、`keywords`、`repository`、`engines`。
- 存储写入改为「临时文件 + rename」原子写，断电不会留下半截 JSON。

## 0.1.0

首个版本。

- 任务全生命周期：`taskpilot_add` / `taskpilot_update` / `taskpilot_list` / `taskpilot_review`
- 逾期自动催：按 `scanIntervalMinutes` 扫描，跳过 `quietHours` 静默时段，每个任务受 `nagCooldownHours` 冷却
- 卡住识别：超过 `stallDays` 天没动的任务标出来
- 复盘：完成率、准时率、平均耗时、最易拖延的星期
