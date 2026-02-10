export const DEFAULT_MAX_BOUNDS = 12
export const MAX_BOUNDS_PADDING = 2
export const MIN_BOUNDS = 4
export const MAX_BOUNDS = 50

export const ZOOM_LEVELS = (() => {
  const levels = Array.from({ length: 5 }, (_, index) =>
    Math.round(MIN_BOUNDS + ((MAX_BOUNDS - MIN_BOUNDS) * index) / 4)
  )
  if (!levels.includes(DEFAULT_MAX_BOUNDS)) {
    levels[1] = DEFAULT_MAX_BOUNDS
  }
  return Array.from(new Set(levels)).sort((a, b) => a - b)
})()

export const clampZoomIndex = (index: number) =>
  Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))

export const getClosestZoomIndex = (zoomLevel: number) => {
  let closestIndex = 0
  let closestDistance = Infinity
  ZOOM_LEVELS.forEach((level, index) => {
    const distance = Math.abs(level - zoomLevel)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })
  return closestIndex
}

export const getNextZoomLevel = (currentZoom: number, direction: "in" | "out") => {
  const currentIndex = getClosestZoomIndex(currentZoom)
  const nextIndex = clampZoomIndex(
    direction === "in" ? currentIndex - 1 : currentIndex + 1
  )
  return ZOOM_LEVELS[nextIndex]
}
