import { DeviceMobileSlashIcon } from "@phosphor-icons/react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/primitives/Card"

export const TempMobileBlock = () => {
  return (
    <div className="md:hidden bg-background fixed inset-0 z-9999 select-none pointer-events-none">
      <Card variant="stripes" className="h-full w-full stripe-frame-destructive bg-destructive/10">
        <CardHeader>
          <DeviceMobileSlashIcon weight="bold" size={42} className="mb-2 animate-pulse" />

          <CardTitle className="text-2xl">
            Sorry, we're not ready for smaller screens yet.
          </CardTitle>
        </CardHeader>
        <CardContent>
          A responsive UI for Gradiant Bang is on its way, but for now, please use a larger screen.
        </CardContent>
        <CardContent className="mt-auto"></CardContent>
      </Card>
    </div>
  )
}
