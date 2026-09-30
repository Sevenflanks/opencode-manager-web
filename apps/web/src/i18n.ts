import { createI18n, useI18n } from "vue-i18n"
import zhTW from "./locales/zh-TW.json"

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>
}[keyof T & string]
export type MessageKey = Leaves<typeof zhTW>
export type MessageSchema = typeof zhTW

export const i18n = createI18n<false>({
  legacy: false,
  locale: "zh-TW",
  fallbackLocale: "zh-TW",
  messages: { "zh-TW": zhTW },
  missingWarn: false,
  fallbackWarn: false,
})

// 基準資源若缺 key，terminal 固定顯示中性摘要，不將內部 key 顯示給使用者。
export function useMessages() {
  const composer = useI18n({ useScope: "global" })
  function t(key: MessageKey, named?: Record<string, string | number>): string {
    if (!composer.te(key, "zh-TW")) return zhTW.error.unknown
    return composer.t(key, named ?? {})
  }
  function date(value: Date): string {
    return new Intl.DateTimeFormat(composer.locale.value, { dateStyle: "medium", timeStyle: "medium" }).format(value)
  }
  function number(value: number): string { return new Intl.NumberFormat(composer.locale.value).format(value) }
  return { t, date, number, locale: composer.locale }
}
