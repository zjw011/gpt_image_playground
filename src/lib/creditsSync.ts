// 生图扣费的自动同步。
//
// 中继在成功出图时会把「本次扣了多少、扣完还剩多少」塞进响应头
// （x-credits-charged / x-credits-balance，见 server/lib/relay.mjs）。
//
// 出图请求散落在 api.ts / agentApi.ts / falAiImageApi.ts 好几处，逐个去加读取逻辑
// 迟早会漏一个；这里在应用启动时包一层 fetch，只做**观察**：
// 读出这两个头更新余额，Response 原样返回，不改状态码、不改 body、不改流。
//
// 之所以可行，是因为 fetch() 在响应头到达时就 resolve（SSE 也一样），
// 所以这一步既不会阻塞出图，也不会破坏流式渲染。

import { applyCreditsBalance } from './backend'
import { useCreditsStore } from './creditsStore'

let installed = false
/** 我们自己包出来的那层 fetch。用来判断"当前的 window.fetch 还是不是我们的"。 */
let wrapped: typeof window.fetch | null = null

/**
 * 已经处理过的响应。
 * 允许重复安装就可能出现嵌套包装（外层包内层），同一个 Response 会被读两遍，
 * 累计消耗就会翻倍。用函数身份做键，既不占内存也不会误伤新响应。
 */
const seenResponses = new WeakSet<Response>()

/** 响应头里能读到的扣费信息。 */
export interface CreditsHeaderInfo {
  /** 本次请求扣掉的积分。中继会一并带上，缺失时按 0 处理。 */
  charged: number
  /** 扣完之后的余额。 */
  balance: number
}

/** 从响应头读一个整数。头不存在或值不合法时返回 null，表示"这次没有信息"。 */
function readNumberHeader(headers: Headers, name: string) {
  const raw = headers.get(name)
  // 必须判 null 而不是直接 Number()：Number(null) 是 0，而 Number.isFinite(0) 为真，
  // 于是"没有余额头"会被读成"余额变成 0"，把界面上刚拿到的数字清零。
  // 这个坑在真实环境里表现为"登录后余额显示 0，刷新一下又有"——因为页面上任何一个
  // 无关请求（版本检查、图片、静态资源）都会顺手把余额抹掉。
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * 解析这两个头。返回 null 表示这次请求不计费（绝大多数请求都走这条）。
 * 抽成纯函数是为了能直接测——上面那个 Number(null) 的坑值得一条回归用例守着。
 */
export function parseCreditsHeaders(headers: Headers): CreditsHeaderInfo | null {
  const balance = readNumberHeader(headers, 'x-credits-balance')
  if (balance == null) return null
  return { balance, charged: readNumberHeader(headers, 'x-credits-charged') ?? 0 }
}

/** 把解析结果写进 store。 */
function readCreditsHeaders(response: Response) {
  if (seenResponses.has(response)) return
  seenResponses.add(response)

  const info = parseCreditsHeaders(response.headers)
  if (!info) return

  const current = useCreditsStore.getState().view
  applyCreditsBalance({
    balance: info.balance,
    // 出图结算完就没有在途占位了，顺手清掉，否则界面会一直显示一个虚低的可用额。
    reserved: 0,
    available: info.balance,
    // 累计消耗能顺手加上就加上；加不上也无所谓——下次兑换或刷新时会拿到准确值。
    ...(current && info.charged > 0 ? { totalOut: current.totalOut + info.charged } : {}),
  })
}

/**
 * 装一次，幂等。必须在任何出图请求之前调用（App 启动时即可）。
 * 纯静态部署下这段代码也在包里，但没有 /api/relay 请求，自然什么都不会发生。
 */
export function installCreditsSync() {
  if (typeof window === 'undefined') return
  // 用函数身份而不是布尔量判断是否已安装：window.fetch 有可能被别人替换
  // （打包器的 polyfill、测试替身、监控 SDK），那时候必须重新包，
  // 否则扣费回执就再也没人读了。重复包装由 seenResponses 兜底。
  if (installed && window.fetch === wrapped) return
  installed = true

  const original = window.fetch
  wrapped = function patchedFetch(input, init) {
    const result = original.call(window, input, init)
    // 响应回来才读头，不挡前面的 await 链。
    if (!(result instanceof Promise)) return result
    return result.then((response) => {
      try {
        readCreditsHeaders(response)
      } catch {
        // 读头失败绝不能影响出图，静默跳过。
      }
      return response
    })
  }
  window.fetch = wrapped
}
