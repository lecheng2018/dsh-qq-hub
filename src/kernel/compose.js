// 洋葱管道组合器（RFC-0001 §3.2 + §2.2 生命周期冒泡态语义，US-008a 修订）。
//
// 调度引擎提供三条硬保障：
//   1. 中间件数组在组装时拷贝并冻结，运行期无法篡改拓扑。
//   2. next() 只许调用一次：同一层重复调用即熔断（lastDispatchedIndex 游标防重入）。
//   3. abort 的收尾语义（§2.2）：以「abort 时刻在飞的 next() 派发边界」为界——
//      边界及更浅层的在飞 dispatch 就地 resolve（等价于其下游从未返回），让**已派发
//      中间件的 bubble（next 之后代码）正常回溯收尾**；比边界更深层（abort 前从未
//      派发）的中间件两级都不进（entry 与 bubble 都不执行）。预 abort（进管道前
//      已中断）时派发边界为 -1：一切短路，连第 0 层都不进。
//      US-001 的「abort 后零 bubble」旧承诺以本条为准更新：egress/dispatcher 等
//      全部活在 bubble 里的中间件必须能收尾，否则 G2「中断并合并 + 丢弃未 flush
//      回复」无法成立。
// 中间件的异步 reject 与同步 throw 都会包装成 PipelineError，携带出错层级 index 与 originalCause 链。

/**
 * 管道执行异常：明确追踪中间件崩塌时的具体调用点。
 * index 为出错中间件在管道中的层级；originalCause 保留原始错误，堆栈拼接「Caused by:」链。
 */
export class PipelineError extends Error {
  /**
   * @param {string} message
   * @param {number} index 中间件索引
   * @param {unknown} [originalCause] 原始错误
   */
  constructor(message, index, originalCause) {
    super(message)
    this.name = 'PipelineError'
    this.index = index
    this.originalCause = originalCause
    // 同时填标准 cause 字段，方便 Node error.cause 打印与后续 observability 复用
    this.cause = originalCause
    if (originalCause instanceof Error && originalCause.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalCause.stack}`
    }
  }
}

/**
 * 高性能洋葱模型管道执行器。
 *
 * @template {import('./types.js').Context} C
 * @param {ReadonlyArray<import('./types.js').Middleware<C>>} middlewares
 * @returns {(context: C, next?: import('./types.js').Next) => Promise<void>}
 */
export function compose(middlewares) {
  // 冻结引用数组，避免运行时篡改（顺带拷贝一份，不依赖调用方数组的后续变化）
  const stack = Object.freeze([...middlewares])

  return function executePipeline(context, next) {
    // 游标：记录本轮已经派发过的最深层索引，用于拦截 next() 重入
    let lastDispatchedIndex = -1
    // 在飞的 dispatch(index) 调用集合：同步进入登记、promise settle 时注销。
    // abort 时刻这份「调用栈」决定 unwind 边界（§2.2 冒泡态语义）。
    const inFlight = new Set()
    // unwind 边界：abort 时刻最深一笔在飞 dispatch 的 index；-1 = 预 abort（无在飞
    // 调用，连第 0 层都短路）；null = 本轮尚未 abort。
    let abortBoundary = null

    const signal = context.signal
    if (signal && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function') {
      const onAbort = () => {
        if (abortBoundary !== null) return // 只认首次 abort（signal 一次性，双保险）
        let deepest = -1
        for (const i of inFlight) if (i > deepest) deepest = i
        abortBoundary = deepest
      }
      // AbortSignal 规范保证：abort() 同步派发事件，先于任何微任务 continuation，
      // 因此 onAbort 读到的 inFlight 正是「abort 那一刻」的调用栈。
      signal.addEventListener('abort', onAbort, { once: true })
      // 进函数时已 abort（预 abort）：边界按现值定，不等事件
      if (signal.aborted) onAbort()
    }

    /**
     * @param {number} currentIndex
     * @returns {Promise<void>}
     */
    function dispatch(currentIndex) {
      // 1. 拦截对 next() 的并发重入调用（Double-invocation）
      if (currentIndex <= lastDispatchedIndex) {
        return Promise.reject(
          new PipelineError(
            `Illegal next() invocation: middleware at index ${currentIndex} called next() multiple times.`,
            currentIndex
          )
        )
      }

      // 2. abort 收尾判定（§2.2 冒泡态语义）：已 abort 且本轮走的是「派发下一层」的
      //    路径——无论该层在边界内外，都绝不进入一个已经执行过（或将要首次执行）的
      //    中间件：就地 resolve，等价「该层从未返回」，让调用方层的 bubble 正常收尾；
      //    更深的新层级（abort 前从未派发）两级都不进。
      //    预 abort（边界 -1）时 dispatch(0) 也命中本分支：一切短路，US-001 契约保留。
      if (context.signal?.aborted && abortBoundary !== null) {
        return Promise.resolve()
      }
      // signal 不可监听（duck ctx）时退化为保守短路：已 abort 则新层级不进（旧语义），
      // 在飞 bubble 靠各自 await next() 的 resolve 自然收尾。
      if (context.signal?.aborted) {
        return Promise.resolve()
      }

      lastDispatchedIndex = currentIndex
      inFlight.add(currentIndex)

      // 3. 提取执行节点
      let targetFn = stack[currentIndex]

      // 触达管道底部，尝试衔接外部尾部处理器
      if (currentIndex === stack.length) {
        targetFn = next ? (ctx, _) => next() : undefined
      }

      // 管道彻底耗尽
      if (!targetFn) {
        inFlight.delete(currentIndex)
        return Promise.resolve()
      }

      try {
        // 构造连续调用链
        const nextStep = () => dispatch(currentIndex + 1)

        return Promise.resolve(targetFn(context, nextStep)).then(
          (value) => {
            inFlight.delete(currentIndex)
            return value
          },
          (error) => {
            inFlight.delete(currentIndex)
            throw new PipelineError(
              `Unhandled exception during pipeline execution at index ${currentIndex}.`,
              currentIndex,
              error
            )
          }
        )
      } catch (syncError) {
        // 捕获同步抛出的异常并封装
        inFlight.delete(currentIndex)
        return Promise.reject(
          new PipelineError(
            `Synchronous exception thrown by middleware at index ${currentIndex}.`,
            currentIndex,
            syncError
          )
        )
      }
    }

    return dispatch(0)
  }
}
