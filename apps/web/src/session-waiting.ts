import type { ManagedInstance } from "@omw/contracts"

const waitingStyles = `
  :root { color-scheme: dark; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; color: #e7ebed; background: #0d1012; font-synthesis: none; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .waiting-stage { display: grid; min-height: 100vh; min-height: 100dvh; place-items: center; padding: 32px 20px; }
  .waiting { width: min(100%, 370px); min-width: 0; text-align: center; }
  .waiting h1, .waiting p { margin: 0; }
  .waiting-signal { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 25px; }
  .waiting-signal i { width: 5px; height: 5px; border-radius: 50%; background: #83b99b; animation: breathe 1.5s ease-in-out infinite alternate; }
  .waiting-signal i:nth-child(2) { animation-delay: .25s; }
  .waiting-signal i:nth-child(3) { animation-delay: .5s; }
  .waiting-eyebrow { color: #8aa99a; font: 600 .7rem/1.5 "Cascadia Code", Consolas, monospace; letter-spacing: .11em; }
  .waiting h1 { margin: 9px 0 12px; font-size: clamp(1.4rem, 5vw, 1.8rem); font-weight: 550; letter-spacing: -.025em; }
  .waiting-copy { color: #9ca8ad; font-size: .87rem; line-height: 1.65; }
  .waiting .waiting-hint { margin-top: 12px; color: #9ca8ad; font-size: .8rem; line-height: 1.6; }
  .waiting .waiting-context { margin-top: 34px; border-top: 1px solid #2b3437; padding-top: 17px; color: #aeb9bd; font-size: .8rem; line-height: 1.6; }
  .waiting-context > span { display: block; margin-bottom: 4px; color: #77868a; font: .64rem "Cascadia Code", Consolas, monospace; letter-spacing: .09em; }
  .waiting-session { display: block; overflow-wrap: anywhere; }
  .waiting-context small { display: block; margin-top: 6px; color: #829094; font-size: .72rem; overflow-wrap: anywhere; }
  @keyframes breathe { from { opacity: .3; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .waiting-signal i { animation: none; opacity: 1; } }
`

export function renderSessionWaiting(document: Document, instance: ManagedInstance, expectedSessionId?: string): void {
  const element = (tag: string, className: string, content: string): HTMLElement => {
    const node = document.createElement(tag)
    node.className = className
    node.textContent = content
    return node
  }
  const known = (value?: string): string => value?.trim() || "尚未取得"

  const viewport = document.createElement("meta")
  viewport.name = "viewport"
  viewport.content = "width=device-width, initial-scale=1"
  const style = document.createElement("style")
  // about:blank 沒有管理器的 CSS；靜態樣式留在 popup，動態目的地只以 textContent 寫入。
  style.textContent = waitingStyles
  document.head.append(viewport, style)

  const stage = document.createElement("main")
  stage.className = "waiting-stage"
  const waiting = document.createElement("section")
  waiting.className = "waiting"
  const signal = document.createElement("span")
  signal.className = "waiting-signal"
  signal.setAttribute("role", "img")
  signal.setAttribute("aria-label", "等待中")
  for (let index = 0; index < 3; index++) signal.append(document.createElement("i"))

  const context = element("p", "waiting-context", "")
  context.append(element("span", "", "SESSION"))
  const title = expectedSessionId && expectedSessionId === instance.primarySession?.sessionId ? instance.primarySession.title : undefined
  context.append(element("strong", "waiting-session", known(title || expectedSessionId)))
  const destination = document.createElement("small")
  destination.append(
    element("span", "waiting-instance", `Instance ${known(instance.id)}`),
    document.createTextNode(" · "),
    element("span", "waiting-project", known(instance.projectName)),
  )
  context.append(destination)

  waiting.append(
    signal,
    element("p", "waiting-eyebrow", "OPENING SESSION"),
    element("h1", "", "正在為你開啟工作階段"),
    element("p", "waiting-copy", "正在連線到 OpenCode Web…"),
    element("p", "waiting-hint", "請稍候，頁面準備好後會前往目的地。"),
    context,
  )
  stage.append(waiting)
  document.body.replaceChildren(stage)
}
