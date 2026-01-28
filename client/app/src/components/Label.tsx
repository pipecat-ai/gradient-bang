import { cn } from "@/utils/tailwind"

export const LabelValueText = ({
  label,
  value,
  maxValue,
  highlightValue = false,
}: {
  label: string
  value: string
  maxValue?: string
  highlightValue?: boolean
}) => {
  return (
    <div className="flex flex-row gap-2 items-center justify-between w-full">
      <span className="text-xs font-bold leading-none">{label}</span>
      <div className="text-xs text-subtle-foreground leading-none">
        {highlightValue ?
          <span className="text-white leading-none">{value}</span>
        : value}
        {maxValue !== undefined && <span className="text-subtle/60 leading-none"> / </span>}
        {maxValue !== undefined && (
          <span className="text-xs text-subtle-foreground leading-none">{maxValue}</span>
        )}
      </div>
    </div>
  )
}

export const LabelText = ({ label, className }: { label: string; className?: string }) => {
  return <span className={cn("text-xs font-bold leading-none", className)}>{label}</span>
}
