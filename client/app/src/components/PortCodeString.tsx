export const PortCodeString = ({
  code,
  classNames,
}: {
  code: string
  classNames?: { B?: string; S?: string }
}) => {
  const buyClass = classNames?.B ?? "text-success-foreground"
  const sellClass = classNames?.S ?? "text-warning-foreground"

  return (
    <>
      {[...code].map((ch, i) => (
        <span key={i} className={ch === "B" ? buyClass : ch === "S" ? sellClass : undefined}>
          {ch}
        </span>
      ))}
    </>
  )
}
