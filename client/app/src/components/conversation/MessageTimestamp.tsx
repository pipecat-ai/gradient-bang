import { useMemo } from "react"

import { cn } from "@/utils/tailwind"

interface Props {
  createdAt: string | number
  className?: string
}

export const MessageTimestamp = ({ createdAt, className }: Props) => {
  const timeString = useMemo(
    () =>
      new Date(createdAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [createdAt]
  )

  return <span className={cn("opacity-70", className)}>[{timeString}]</span>
}
