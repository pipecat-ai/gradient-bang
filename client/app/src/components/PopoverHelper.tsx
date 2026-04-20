import { Button } from "@/components/primitives/Button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/primitives/Popover"
import { InfoIconSM } from "@/components/svg/InfoIconSM"
import { cn } from "@/utils/tailwind"

export const PopoverHelper = ({
  className = "",
  title = "Help text",
  description = "Work in progress...",
}: {
  className?: string
  title?: string
  description?: string
}) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="link"
          size="icon-xs"
          aria-label={`Open help: ${title}`}
          className={cn("p-0 hover:text-terminal data-[state=open]:text-terminal", className)}
        >
          <InfoIconSM className="shrink-0 size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <PopoverDescription className="text-pretty text-xs">{description}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  )
}
