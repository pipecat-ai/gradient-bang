import { useCallback, useMemo, useState } from "react"

import { ErrorBoundary } from "@/components/ErrorBoundary"
import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"

import { MapScreen } from "./MapScreen"

const MapScreenFallback = ({
  error,
  onRetry,
}: {
  error: Error
  onRetry: () => void
}) => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()

  return (
    <div className="flex h-full w-full items-center justify-center bg-background/80">
      <Card size="sm" className="w-[480px]">
        <CardHeader>
          <CardTitle>Map failed to render</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-ui-sm text-xs">
          <p className="text-subtle">A map error occurred and rendering stopped.</p>
          <p className="text-muted-foreground break-words">{error.message}</p>
          <div className="flex gap-ui-xs justify-end">
            <Button
              variant="secondary"
              onClick={() => setActiveScreen?.(undefined)}
            >
              Close
            </Button>
            <Button onClick={onRetry}>Retry Map</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export const MapScreenBoundary = () => {
  const [resetKey, setResetKey] = useState(0)

  const handleRetry = useCallback(() => {
    setResetKey((value) => value + 1)
  }, [])

  const fallback = useMemo(
    () => (error: Error, reset: () => void) => (
      <MapScreenFallback
        error={error}
        onRetry={() => {
          reset()
          handleRetry()
        }}
      />
    ),
    [handleRetry]
  )

  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={fallback}
      onError={(error, info) =>
        console.error("[MAP SCREEN] Render error", error, info.componentStack)
      }
    >
      <MapScreen key={resetKey} />
    </ErrorBoundary>
  )
}

