import { registerSW } from "virtual:pwa-register"

/**
 * Register the service worker and check for updates when the user
 * returns to the page (tab becomes visible again).
 *
 * With `registerType: "autoUpdate"` in vite.config.ts, VitePWA will
 * automatically skipWaiting and reload when a new SW takes control.
 */

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        registration.update()
      }
    })
  },
  onRegisterError(error) {
    console.error("[SW] Registration error:", error)
  },
})
