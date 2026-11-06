// 洋葱管道组合器（RFC-0001 §3.2）。
//
// 调度引擎提供三条硬保障：
//   1. 中间件数组在组装时拷贝并冻结，运行期无法篡改拓扑。
//   2. next() 只许调用一次：同一层重复调用即熔断（lastDispatchedIndex 游标防重入）。
//   3. ctx 被 abort 后，尚未执行的下游中间件短路返回，不再穿透。
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

      // 2. 检查上下文熔断/中断状态：已 abort 则短路，剩余层级不再执行
      if (context.signal?.aborted) {
        return Promise.resolve()
      }

      lastDispatchedIndex = currentIndex

      // 3. 提取执行节点
      let targetFn = stack[currentIndex]

      // 触达管道底部，尝试衔接外部尾部处理器
      if (currentIndex === stack.length) {
        targetFn = next ? (ctx, _) => next() : undefined
      }

      // 管道彻底耗尽
      if (!targetFn) {
        return Promise.resolve()
      }

      try {
        // 构造连续调用链
        const nextStep = () => dispatch(currentIndex + 1)

        return Promise.resolve(targetFn(context, nextStep)).catch((error) => {
          throw new PipelineError(
            `Unhandled exception during pipeline execution at index ${currentIndex}.`,
            currentIndex,
            error
          )
        })
      } catch (syncError) {
        // 捕获同步抛出的异常并封装
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
