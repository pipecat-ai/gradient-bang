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

export const PopoverHelper = ({ className = "" }: { className?: string }) => {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="link" size="icon-xs" className={cn("p-0 hover:text-terminal data-[state=open]:text-terminal", className)}>
                    <InfoIconSM className="shrink-0 size-3" />
                </Button>
            </PopoverTrigger>
            <PopoverContent>
                <PopoverHeader>
                    <PopoverTitle>Help text</PopoverTitle>
                    <PopoverDescription>Work in progress...</PopoverDescription>
                </PopoverHeader>
            </PopoverContent>
        </Popover>
    );
};