import { Badge } from "@/components/primitives/Badge"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"

export const ConnectionStatusBadge = () => {
  const { state } = usePipecatConnectionState()

  return <Badge variant="secondary">Status: {state}</Badge>
}
