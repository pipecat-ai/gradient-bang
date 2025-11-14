import { useCounter } from "@/hooks/useCounter";

export const CurrencyCounter = ({
  value,
  className,
}: {
  value: number;
  className?: string;
}) => {
  const { displayValue } = useCounter(value, {
    duration: 1500,
    precision: 0,
  });

  return <div className={className}>{displayValue}</div>;
};
