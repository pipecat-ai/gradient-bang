import { useEffect, useRef, useState } from "react"

import { CaretRightIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

export const TaskEngineSummaryText = ({
  description,
  placeholder,
  active,
  className,
  showArrow,
}: {
  description?: string
  placeholder?: string
  active?: boolean
  className?: string
  showArrow?: boolean
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  const text = description ?? placeholder

  useEffect(() => {
    const textEl = textRef.current
    const containerEl = containerRef.current
    if (!textEl || !containerEl) return
    setOverflow(Math.max(0, textEl.scrollWidth - containerEl.clientWidth))
  }, [text])

  const maskWidth = 24
  const scrollDistance = overflow + maskWidth
  const duration = overflow > 0 ? scrollDistance / 25 : 0

  return (
    <div className={cn("relative text-xxs flex flex-row gap-1 items-center uppercase", className)}>
      {showArrow && (
        <div className="aspect-square bg-muted p-1 flex items-center justify-center border box-border">
          <CaretRightIcon weight="bold" size={12} className="text-foreground" />
        </div>
      )}

      <div
        ref={containerRef}
        className={cn(
          "group/task-summary overflow-hidden flex-1 self-stretch flex items-center leading-none",
          showArrow ? "bg-subtle/20 px-ui-xs" : ""
        )}
        style={
          overflow > 0 ?
            { maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)" }
          : undefined
        }
      >
        <span
          ref={textRef}
          className={cn(
            "whitespace-nowrap inline-block transition-transform duration-0 ease-linear group-hover/task-summary:delay-200 group-hover/task-summary:duration-(--marquee-duration) group-hover/task-summary:transform-[translateX(var(--marquee-offset,0px))]",
            active ? "text-foreground" : (
              "text-foreground/60 group-hover/task-summary:text-foreground"
            )
          )}
          style={{
            ...(overflow > 0 &&
              ({
                "--marquee-offset": `-${scrollDistance}px`,
                "--marquee-duration": `${duration}s`,
              } as React.CSSProperties)),
          }}
        >
          {text}
        </span>
      </div>
    </div>
  )
}
