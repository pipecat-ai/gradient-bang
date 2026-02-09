const BaseTile = ({ children, percent = 100 }: { children: React.ReactNode; percent: number }) => {
  return (
    <div className="relative flex flex-col gap-1 p-ui-xs items-center justify-center bg-accent-background flex-1">
      <div className="relative z-10">{children}</div>
      <div
        className="absolute inset-x-0 bottom-0 bg-terminal"
        style={{ height: `${percent}%` }}
      ></div>
    </div>
  )
}

export const CombatFighterTile = () => {
  return <BaseTile percent={80}>Hello</BaseTile>
}
