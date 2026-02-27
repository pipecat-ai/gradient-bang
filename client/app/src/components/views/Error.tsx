import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"

export const Error = ({
  children,
  title,
  noButton = false,
  onRetry,
}: {
  children: React.ReactNode
  title?: string
  noButton?: boolean
  onRetry?: () => void
}) => {
  return (
    <Card
      variant="stripes"
      className="h-screen stripe-frame-destructive bg-destructive/10"
      size="lg"
    >
      <CardHeader>
        <CardTitle className="text-5xl animate-pulse">{title || "Connection Error"}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="normal-case">{children}</p>
      </CardContent>
      {!noButton && (
        <CardContent className="mt-auto">
          <Button size="xl" onClick={onRetry}>
            Try again
          </Button>
        </CardContent>
      )}
    </Card>
  )
}

export default Error
