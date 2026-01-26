import { useEffect } from "react"

import { cva } from "class-variance-authority"
import { motion } from "motion/react"

import { Separator } from "@/components/primitives/Separator"
import usePlaySound from "@/hooks/usePlaySound"
import { cn } from "@/utils/tailwind"

interface ToastBaseProps {
  children: React.ReactNode
  onAnimateIn?: () => void
  onAnimationComplete?: () => void
  onClick?: () => void
}

export const ToastBase = ({
  children,
  onAnimateIn,
  onAnimationComplete,
  onClick,
}: ToastBaseProps) => {
  const { playSound } = usePlaySound()

  useEffect(() => {
    if (onAnimateIn) {
      onAnimateIn()
    }
  }, [onAnimateIn])

  useEffect(() => {
    playSound("chime2")
  }, [playSound])

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      onAnimationComplete={(definition) => {
        if (definition === "exit" && onAnimationComplete) {
          onAnimationComplete()
        }
      }}
      onClick={onClick}
      className="pointer-events-auto cursor-pointer w-full h-full overflow-hidden"
    >
      {children}
    </motion.div>
  )
}

export const ToastTitle = ({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-2 items-center justify-center w-full text-center",
        className
      )}
    >
      <Separator className="w-auto flex-1 bg-accent" />
      <span className="heading-4 tracking-widest leading-none">{children}</span>
      <Separator className="w-auto flex-1 bg-accent" />
    </div>
  )
}

export const ToastValue = ({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-3 items-center bracket bracket-1 bracket-border bracket-offset-0 bracket-vertical py-2 px-6 bg-accent/20 w-1/3 justify-center text-sm font-medium",
        className
      )}
    >
      {children}
    </div>
  )
}

const tileVariants = cva("flex flex-col border items-center justify-center flex-1", {
  variants: {
    color: {
      success: "border-success",
      warning: "border-warning",
      destructive: "border-destructive",
      default: "border-border",
    },
    active: {
      true: "",
      false: "opacity-50 cross-lines-accent border-border",
    },
  },
  compoundVariants: [
    {
      active: false,
      className: "border-border",
    },
  ],
  defaultVariants: {
    color: "success",
    active: true,
  },
})

const tileUnitsVariants = cva("", {
  variants: {
    color: {
      success: "text-success",
      warning: "text-warning",
      destructive: "text-destructive",
      default: "text-foreground",
    },
    empty: {
      true: "opacity-50",
      false: "",
    },
  },
  defaultVariants: {
    color: "success",
    empty: false,
  },
})

export const ToastResourceTile = ({
  color = "success",
  children,
  active = false,
  commodity,
  units,
  prefix = "",
}: {
  color?: "success" | "warning" | "destructive" | "default"
  children: React.ReactNode
  active: boolean
  commodity: string
  units?: number
  prefix?: string
}) => {
  return (
    <div className={cn(tileVariants({ color, active }))}>
      <div className="flex items-center justify-center h-full">{children}</div>
      <div className="bg-black w-full text-center text-xs font-bold py-1 uppercase">
        {commodity}:{" "}
        <span
          className={cn(
            tileUnitsVariants({
              color,
              empty: units === 0 || units === undefined,
            })
          )}
        >
          {prefix}
          {units || 0}
        </span>
      </div>
    </div>
  )
}
