import { button, folder, useControls } from "leva"
import type { Story } from "@ladle/react"

import { PlayerShipPanel } from "@/components/panels/PlayerShipPanel"
import { useGameContext } from "@/hooks/useGameContext";

export const PlayerShipStory: Story = () => {
    const { dispatchAction } = useGameContext();

    useControls(() => ({
        "Ships": folder({
            ["Get My Status"]: button(() => {
                dispatchAction({
                    type: "get-my-status",
                })
            }),
            ["Get My Ships"]: button(() => {
                dispatchAction({
                    type: "get-my-ships",
                    async: true,
                })
            })
        }, { collapsed: false })
    }))

    return (
        <div className="min-h-64">
            <PlayerShipPanel />
        </div>
    )
}

PlayerShipStory.meta = {
    useDevTools: true,
}
