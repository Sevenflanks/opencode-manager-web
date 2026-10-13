import { createApp } from "vue"
import App from "./RootModeApp.vue"
import { i18n } from "./i18n"
import "./style.css"

createApp(App).use(i18n).mount("#app")
