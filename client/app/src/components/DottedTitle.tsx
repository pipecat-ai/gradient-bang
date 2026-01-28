export const DottedTitle = ({ title }: { title: string }) => {
  return (
    <div className="flex flex-row gap-ui-sm items-center justify-center leading-none">
      <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
      <span className="text-xs font-semibold uppercase text-subtle leading-none pb-px">
        {title}
      </span>
      <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
    </div>
  )
}
