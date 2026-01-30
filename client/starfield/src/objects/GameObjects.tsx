import { useGameStore } from "@/useGameStore"

import { Port } from "./Port"

export const GameObjects = () => {
  const positionedGameObjects = useGameStore(
    (state) => state.positionedGameObjects
  )

  return (
    <group name="game-objects">
      {positionedGameObjects.map((obj) => {
        switch (obj.type) {
          case "port":
            return <Port key={obj.id} {...obj} />
          // TODO: Add other object types as they're implemented
          // case "ship":
          //   return <Ship key={obj.id} {...obj} />
          // case "garrison":
          //   return <Garrison key={obj.id} {...obj} />
          // case "salvage":
          //   return <Salvage key={obj.id} {...obj} />
          default:
            return null
        }
      })}
    </group>
  )
}
