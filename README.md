# dsh-taskpilot

任务全生命周期追踪。给 DeepSeek Harness 用。

不重做待办清单。DSH 自带的待办能记、能查，就够了。
这个插件只补它没有的三件事：

- **逾期自动追** —— 到点主动催，你不用自己去翻
- **卡住识别** —— 标了「在做」却好几天没动，会被点出来
- **复盘** —— 完成率、准时率、平均几天做完一件、最容易崩的是星期几

## 为什么是这三件

所有「AI 帮你管时间」的工具，卡住的都不是模型聪明不聪明，是**数据进不来**。
日程在别人服务器上，微信里的承诺没接口，邮件里的任务得先解析。
本地待办不一样 —— 它是你自己的文件，读得到。

所以选了这个起点：不跟平台要权限，先把手上已有的数据用透。

## 装

```bash
# 在 profile 目录里
pnpm add dsh-taskpilot
```

或直接从本地目录挂：

```bash
pnpm add file:/path/to/dsh-taskpilot
```

再在 profile 的 `package.json` 里加进 `dsh.profile.bundles`，
然后重载 / 重启 harness。

插件自带 `cordis.patch.yml`，会自动往 loader 插一条记录，不用手写。

## 四个工具

| 工具 | 干什么 |
|---|---|
| `taskpilot_add` | 记一条。标题必填，截止时间写 `2026-11-08` 或 `2026-11-08 18:00` |
| `taskpilot_update` | 改状态 / 截止 / 优先级 / 备注，或者删掉。用 id 或标题模糊匹配 |
| `taskpilot_list` | 看清单。默认只给该关注的：逾期、今天到期、在做，最多 8 条 |
| `taskpilot_review` | 复盘。默认看 14 天 |

状态：`todo` `doing` `blocked` `done` `cancelled`，中文别名也认（待办 / 进行中 / 卡住 / 完成 / 取消）。

## 后台扫描

默认 15 分钟一次。启动 40 秒后才第一次扫 —— 别和宿主冷启动抢资源。

```yaml
config:
  scanIntervalMinutes: 15   # 扫描间隔，最小 5
  quietHours: [23, 8]       # 这期间不催，支持跨零点
  nagCooldownHours: 24      # 同一件事多久才再催一次
  maxPerScan: 3             # 一次最多催几条，别刷屏
  stallDays: 3              # 「在做」超过几天算卡住
  reviewDays: 14            # 复盘默认天数
  notifyService: ''         # 走哪个 DSH 服务的 send()，例如配了 IM 插件的服务名
  notifyTo: ''              # 推给谁，留空 = 服务默认目标
  webhookUrl: ''            # 或者直接 POST 到这儿，留空 = 只写日志
```

推送有两条路，按需选一条：

**走服务** —— `notifyService` 填一个提供 `send({target, text})` 的 DSH 服务名。
比如装了 QQ / IM 类插件，就填它 `ctx.provide` 的名字，消息直接进聊天窗口。

**走 webhook** —— `webhookUrl` 填地址，POST 一个 JSON：
`{ "text": "...", "msgtype": "text", "content": { "text": "..." } }`。
飞书、钉钉、Slack、自建服务都能吃。

都没配就只写日志，不报错 —— 插件照常追踪，只是不主动找你。

## 两个细节，踩过才知道

**「今天到期」不算逾期。**
纯日期（没有时分）的任务，按当天 23:59:59 算截止。当天就催等于催命。

**复盘按结束时间算成绩，不按创建时间。**
上个月建、昨天才做完的，该算这段时间的成绩。一开始按创建时间筛，结果把做完的漏了 —— 自测里抓到的。

## 数据

`~/.dsh/taskpilot/tasks.json`，纯 JSON。
能直接打开看、能自己备份、能扔进 git。没有数据库，坏了就先改名成 `.broken-<时间戳>` 再重开，不覆盖你的旧数据。

## 状态

0.1.0。一期只有上面这些。
二期打算做随口捕获（从聊天里自动捞任务），三期做报表。别一次堆太多。

## License

MIT
