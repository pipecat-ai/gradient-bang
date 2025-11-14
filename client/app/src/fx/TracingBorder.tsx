import { cn } from "@/utils/tailwind";

interface TracingBorderProps {
  active?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const TracingBorder = ({
  active = false,
  children,
  className,
}: TracingBorderProps) => {
  return (
    <div
      className={cn(
        "relative tracing-border-wrapper",
        active && "tracing-border-wrapper-active",
        className
      )}
    >
      {children}
    </div>
  );
};
