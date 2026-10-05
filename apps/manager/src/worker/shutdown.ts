// Signal path 的硬上限涵蓋 streams/observers 與 namespace cleanup；不是 Start/Stop 的產品 API。
export function installWorkerShutdown(shutdown: () => Promise<unknown>, deadlineMs = 10_000) {
  let stopping = false
  const onSignal = () => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(1), deadlineMs)
    void shutdown().then(() => process.exit(0), () => process.exit(1)).finally(() => clearTimeout(deadline))
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, onSignal)
  return () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.removeListener(signal, onSignal)
  }
}
