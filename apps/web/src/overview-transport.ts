import type { OverviewResponse } from "@omw/contracts"

// 只共用當輪 HTTP，不持有快取。各 consumer 的取消互不影響，最後一位離開才取消 transport。
export function createOverviewTransport(read: (url: string, signal: AbortSignal) => Promise<OverviewResponse>) {
  type Flight = { url: string; controller: AbortController; promise: Promise<OverviewResponse>; subscribers: number; settled: boolean }
  const flights = new Set<Flight>()
  function join(flight: Flight, signal?: AbortSignal): Promise<OverviewResponse> {
    return new Promise((resolve, reject) => {
      let finished = false
      flight.subscribers++
      const finish = (callback: () => void) => {
        if (finished) return
        finished = true
        signal?.removeEventListener("abort", abort)
        flight.subscribers--
        if (!flight.subscribers && !flight.settled) flight.controller.abort()
        callback()
      }
      const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")))
      signal?.addEventListener("abort", abort, { once: true })
      flight.promise.then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(cause)))
      if (signal?.aborted) abort()
    })
  }
  function start(url: string, signal?: AbortSignal) {
    let flight = [...flights].find((entry) => entry.url === url && !entry.controller.signal.aborted)
    if (!flight) {
      const controller = new AbortController()
      flight = { url, controller, promise: read(url, controller.signal), subscribers: 0, settled: false }
      const current = flight
      flights.add(current)
      void current.promise.then(() => settle(current), () => settle(current))
    }
    return join(flight, signal)
  }
  function settle(flight: Flight) { flight.settled = true; flights.delete(flight) }
  return {
    overview: start,
    notifications(signal?: AbortSignal) {
      const current = [...flights].find((entry) => !entry.controller.signal.aborted)
      return current ? join(current, signal) : start("/api/v1/overview?q=&filter=all&view=notifications&scope=current", signal)
    },
  }
}
