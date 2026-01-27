export const formatCurrency = (value: number) => {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

export const validateName = (name: string) => {
  return /^[a-zA-Z0-9_ ]{3,20}$/.test(name)
}
