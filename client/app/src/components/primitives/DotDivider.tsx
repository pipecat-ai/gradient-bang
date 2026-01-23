import { cn } from "@/utils/tailwind"

export const DotDivider = ({ className }: { className?: string }) => {
  return <div className={cn("w-1 h-1 bg-accent shrink-0", className)} />
}
