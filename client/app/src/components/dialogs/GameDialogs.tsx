import { Disconnect } from "./Disconnect"
import { Leaderboard } from "./Leaderboard"
import { QuestCodec } from "./QuestCodec"
import { QuestList } from "./QuestList"
import { Settings } from "./Settings"
import { ShipDetails } from "./ShipDetails"

export const GameDialogs = () => (
  <>
    <Settings />
    <Leaderboard />
    <Disconnect />
    <QuestCodec />
    <QuestList />
    <ShipDetails />
  </>
)
