type PortLike = PortBase | { port_code?: unknown } | string | null | undefined

export const getPortCode = (port?: PortLike): string => {
  if (!port) return ""
  if (typeof port === "string") return port
  const portObj = port as { code?: unknown; port_code?: unknown }
  if (typeof portObj.code === "string") return portObj.code
  if (typeof portObj.port_code === "string") return portObj.port_code
  return ""
}
