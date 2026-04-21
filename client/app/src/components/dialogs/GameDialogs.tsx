import { SocialReplayDialog } from "@/capture/SocialReplayDialog"

import { CorporationDetailsDialog } from "./CorporationDetailsDialog"
import { Disconnect } from "./Disconnect"
import { LeaveConfirmDialog } from "./LeaveConfirmDialog"
import { KickConfirmDialog } from "./KickConfirmDialog"
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
    <SocialReplayDialog />
    <KickConfirmDialog />
    <LeaveConfirmDialog />
    <CorporationDetailsDialog />
  </>
)
