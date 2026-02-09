import { ErrorBoundary } from "react-error-boundary"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"
import useGameStore from "@/stores/game"

import { MapScreen } from "./MapScreen"

export const MapScreenBoundary = () => {
  const setActiveScreen = useGameStore.use.setActiveScreen?.()

  return (
    <ErrorBoundary
      onError={(error, info) =>
        console.error("%c[MAP SCREEN] Render error", "color: red;", error, info.componentStack)
      }
      fallbackRender={({ error, resetErrorBoundary }) => (
        <div className="flex h-full w-full items-center justify-center bg-background/80">
          <Card size="sm" className="w-[480px]">
            <CardHeader>
              <CardTitle>Map failed to render</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-ui-sm text-xs">
              <p className="text-subtle">A map error occurred and rendering stopped.</p>
              <p className="text-muted-foreground wrap-break-word">
                {error instanceof Error ? error.message : String(error)}
              </p>
              <div className="flex gap-ui-xs justify-end">
                <Button variant="secondary" onClick={() => setActiveScreen?.(undefined)}>
                  Close
                </Button>
                <Button onClick={resetErrorBoundary}>Retry Map</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    >
      <MapScreen />
    </ErrorBoundary>
  )
}
