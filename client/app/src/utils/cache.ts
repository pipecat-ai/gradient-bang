export const checkAssetsAreCached = (): boolean => {
  console.debug("[GAME CACHE] Checking SW state:", {
    hasServiceWorker: "serviceWorker" in navigator,
    controller: navigator.serviceWorker?.controller,
    ready: navigator.serviceWorker?.ready,
  });

  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    console.debug("[GAME CACHE] Service worker active, cache ready");
    return true;
  }

  console.debug("[GAME CACHE] No active service worker, cache not ready");
  return false;
};
