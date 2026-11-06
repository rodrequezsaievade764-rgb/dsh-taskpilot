// 工具的写法。和 @deepseek-ai/dsh-tools 的 defineTool 产物同形：
// parameters / output.schema 是 JSON Schema，所以不直接依赖那个包，
// 少一层解析、少一次 profile 升级就崩的风险。
//
// 工具定义一旦确定尽量别改：每改一次，模型侧的前缀缓存就失效一次。

export function defineTool({ name, description, properties = {}, required = [], execute, render, slow }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    ...(slow ? { slow } : {}),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render:
        render ||
        ((_args, value) => [
          { type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' },
        ]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const bool = (description) => ({ type: 'boolean', description })
