export const BlankSlateTile = ({ text }: { text: string }) => {
  return (
    <div className="w-full bg-subtle-background items-center justify-center py-2 text-xs uppercase text-subtle text-center">
      {text}
    </div>
  )
}
