import { cn } from "@/utils/tailwind";

export const PanelTitle = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn("uppercase text-xs font-bold tracking-widest", className)}
    >
      {children}
    </div>
  );
};
