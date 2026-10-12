import upstream from "@prevalentware/opencode-goal-plugin/server"

// 只選上游 V1 server；不改 Goal policy，也不載入 V2 setup／TUI。
export default upstream.server
