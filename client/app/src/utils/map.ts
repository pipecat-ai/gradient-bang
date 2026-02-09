export const DEFAULT_MAX_BOUNDS = 12
export const MAX_BOUNDS_PADDING = 2
export const MIN_BOUNDS = 4
export const MAX_BOUNDS = 50

export const normalizePort = (port: PortLike): PortBase | null => {
  if (!port) return null

  if (typeof port === "string") {
    const code = port.trim()
    if (!code) return null
    return { code }
  }

  if (typeof port === "object") {
    const portObj = port as {
      code?: unknown
      port_code?: unknown
      mega?: unknown
      [key: string]: unknown
    }
    const code =
      typeof portObj.code === "string" ? portObj.code
      : typeof portObj.port_code === "string" ? portObj.port_code
      : null
    if (!code || !code.trim()) return null
    if (typeof portObj.code === "string") {
      return portObj as PortBase
    }
    return { ...portObj, code } as PortBase
  }

  return null
}

export const normalizeMapData = (mapData: MapData): MapData =>
  mapData.map((sector) => normalizeSector(sector))

export const normalizeSector = <T extends Sector>(sector: T): T => ({
  ...sector,
  port: normalizePort(sector.port as PortLike),
})
