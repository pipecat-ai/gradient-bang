export const formatCurrency = (value: number, notation: "compact" | "standard" = "compact") => {
  if (notation === "compact" && Math.abs(value) < 100_000) {
    return new Intl.NumberFormat("en-US", {
      notation: "standard",
      maximumFractionDigits: 0,
    }).format(value)
  }
  return new Intl.NumberFormat("en-US", {
    notation,
    maximumFractionDigits: 1,
  }).format(value)
}

export const validateName = (name: string) => {
  return /^[a-zA-Z0-9_ ]{3,20}$/.test(name)
}

export const formatSectorLabel = (
  sector: { id?: number | null; name?: string | null } | null | undefined
): string => {
  if (sector?.id == null) return "Sector unknown"
  return sector.name ? `${sector.id} - ${sector.name}` : `Sector ${sector.id}`
}
