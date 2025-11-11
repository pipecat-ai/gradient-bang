import { cn } from "@/utils/tailwind";
import { motion } from "motion/react";
import { useEffect } from "react";
import { Separator } from "../primitives/Separator";

interface ToastBaseProps {
  children: React.ReactNode;
  onAnimateIn?: () => void;
  onAnimationComplete?: () => void;
  onClick?: () => void;
}

export const ToastBase = ({
  children,
  onAnimateIn,
  onAnimationComplete,
  onClick,
}: ToastBaseProps) => {
  useEffect(() => {
    if (onAnimateIn) {
      onAnimateIn();
    }
  }, [onAnimateIn]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      onAnimationComplete={(definition) => {
        if (definition === "exit" && onAnimationComplete) {
          onAnimationComplete();
        }
      }}
      onClick={onClick}
      className="pointer-events-auto cursor-pointer w-full h-full overflow-hidden"
    >
      {children}
    </motion.div>
  );
};

export const ToastTitle = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-3 items-center justify-center w-full text-center",
        className
      )}
    >
      <Separator className="w-auto flex-1" />
      <span className="heading-4 tracking-widest">{children}</span>
      <Separator className="w-auto flex-1" />
    </div>
  );
};

export const ToastValue = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-3 items-center bracket bracket-1 bracket-border bracket-offset-0 bracket-vertical py-1 px-6 bg-accent/20 w-1/3 justify-center text-sm font-medium",
        className
      )}
    >
      {children}
    </div>
  );
};
