import { useMemo } from "react"

import { button, folder, useControls } from "leva"
import { Story } from "@ladle/react"

import { MiniMapPanel } from "@/components/panels/MiniMapPanel"
import { DEFAULT_MAX_BOUNDS, MapScreen } from "@/components/screens/MapScreen"
import useGameStore from "@/stores/game"

export const BigMapStory: Story = () => {
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)

  const [levaMapConfig] = useControls(() => ({
    Map: folder({
      ["Get My Map"]: button(() => {
        const currentSector = useGameStore.getState().sector
        dispatchAction({
          type: "get-my-map",
          payload: {
            center_sector: currentSector?.id ?? 0,
            bounds: mapZoomLevel ?? DEFAULT_MAX_BOUNDS,
          },
        })
      }),
      ["Config"]: folder({
        debug: {
          value: true,
        },
        clickable: {
          value: true,
        },
      }),
    }),
  }))

  const storyMapConfig = useMemo(() => {
    return {
      debug: levaMapConfig.debug ?? true,
      clickable: levaMapConfig.clickable ?? true,
    }
  }, [levaMapConfig])

  /*
  const [{ current_sector, center_sector, show_legend }, set] = useControls(() => ({
    Map: folder(
      {
        ["Get My Map"]: button((get) => {
          dispatchAction({
            type: "get-my-map",
            payload: {
              center_sector: get("Map.center_sector"),
              // max_hops: get("Map.max_hops"),
              // max_sectors: get("Map.max_sectors"),
              bounds: get("Map.max_bounds_distance") ?? 15,
            },
          } as GetMapRegionAction)
        }),
        ["Get My Ships"]: button(() => {
          dispatchAction({
            type: "get-my-ships",
          })
        }),

        center_sector: {
          value: sector?.id ?? 0,
          step: 1,
        },
        current_sector: {
          value: sector?.id ?? 0,
          step: 1,
        },
        max_hops: {
          value: 25,
          min: 1,
          max: 100,
          step: 1,
        },
        max_sectors: {
          value: 500,
          min: 1,
          max: 1000,
          step: 1,
        },
        show_legend: {
          value: true,
        },
      },
      { collapsed: false }
    ),
  }))

  const [mapConfig, setMapConfig] = useControls(() => ({
    Map: folder({
      ["Config"]: folder(
        {
          debug: {
            value: true,
          },
          clickable: {
            value: true,
          },
          max_bounds_distance: {
            value: mapZoomLevel ?? 15,
            min: 1,
            max: 50,
            step: 1,
          },
          show_sector_ids: {
            value: true,
          },
          show_partial_lanes: {
            value: true,
          },
          show_ports: {
            value: true,
          },
          show_hyperlanes: {
            value: false,
          },
          show_grid: {
            value: true,
          },
          show_port_labels: {
            value: true,
          },
        },
        { collapsed: true }
      ),
    }),
  }))

  useEffect(() => {
    setMapConfig({ max_bounds_distance: mapZoomLevel ?? 15 })
  }, [setMapConfig, mapZoomLevel])
  */

  return <MapScreen config={storyMapConfig} />
}

BigMapStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}

export const MiniMapStory: Story = () => {
  return (
    <div className="flex flex-col items-center justify-center w-screen h-screen bg-muted">
      <MiniMapPanel className="w-[330px] h-[330px] aspect-square border" />
    </div>
  )
}
MiniMapStory.meta = {
  useDevTools: true,
  useChatControls: false,
  disconnectedStory: true,
  enableMic: false,
  disableAudioOutput: true,
}
