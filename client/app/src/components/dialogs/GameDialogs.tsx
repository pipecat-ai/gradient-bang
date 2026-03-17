import type { SocialReplayCapture } from "@/capture/SocialReplayCapture"
import { SocialReplayDialog } from "@/capture/SocialReplayDialog"

import { Disconnect } from "./Disconnect"
import { Leaderboard } from "./Leaderboard"
import { QuestCodec } from "./QuestCodec"
import { QuestList } from "./QuestList"
import { Settings } from "./Settings"
import { ShipDetails } from "./ShipDetails"

export const GameDialogs = ({ capture }: { capture: SocialReplayCapture }) => (
  <>
    <Settings />
    <Leaderboard />
    <Disconnect />
    <QuestCodec />
    <QuestList />
    <ShipDetails />
    <SocialReplayDialog capture={capture} />
  </>
)
