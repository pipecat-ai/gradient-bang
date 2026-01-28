import { cn } from "@/utils/tailwind"
export const DottedTitle = ({ title, className }: { title: string; className?: string }) => {
  return (
    <div
      className={cn("flex flex-row gap-ui-sm items-center justify-center leading-none", className)}
    >
      <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
      <span className="text-xs font-semibold uppercase text-subtle leading-none pb-px">
        {title}
      </span>
      <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
    </div>
  )
}
