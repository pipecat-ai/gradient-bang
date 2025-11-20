import { useEffect } from "react";

import { AtomIcon, LightningIcon, PlantIcon } from "@phosphor-icons/react";
import { CardTitle, Divider } from "@pipecat-ai/voice-ui-kit";

import { Badge } from "@/components/primitives/Badge";
import { Card, CardContent, CardHeader } from "@/components/primitives/Card";
import useGameStore from "@/stores/game";

import { PanelTitle } from "./PanelTitle";

const IconMap = {
  ro: <PlantIcon size={28} weight="duotone" />,
  qf: <AtomIcon size={28} weight="duotone" />,
  ns: <LightningIcon size={28} weight="duotone" />,
};

const codeToLabel = {
  ro: "Retro-organics",
  qf: "Quantum Foam",
  ns: "Neuro-symbolics",
};

const codeToAbbrev = {
  ro: "RO",
  qf: "QF",
  ns: "NS",
};

const baseClx = "flex flex-col gap-4 elbow-muted elbow-size-20 w-[210px]";
const inactiveClx = "opacity-50";

const CommodityItem = ({
  commodity,
  sells = false,
  buys = false,
  price = 0,
  units = 0,
}: {
  commodity: "ro" | "qf" | "ns";
  sells?: boolean;
  buys?: boolean;
  price?: number;
  units?: number;
}) => {
  return (
    <Card
      className={`${baseClx} ${!buys && !sells ? inactiveClx : ""}`}
      elbow={true}
      size="sm"
    >
      <CardHeader className="flex flex-col gap-2">
        <div className={buys || sells ? "text-agent" : ""}>
          {IconMap[commodity as keyof typeof IconMap]}
        </div>

        <PanelTitle>
          {codeToLabel[commodity as keyof typeof codeToLabel]}{" "}
          <span className="opacity-40">
            ({codeToAbbrev[commodity as keyof typeof codeToAbbrev]})
          </span>
        </PanelTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Badge
            className={`w-full justify-between ${sells ? "" : "opacity-40"}`}
          >
            <span className="opacity-40">Stock:</span>
            {sells ? units : "---"}
          </Badge>
          <Badge
            className={`w-full justify-between ${sells ? "" : "opacity-40"}`}
          >
            <span className="opacity-40">$ per unit:</span>
            {sells ? price.toLocaleString() : "---"}
          </Badge>
        </div>
        <Divider variant="dotted" className="h-2" />
        <Badge
          color={buys ? "active" : "ghost"}
          className={`w-full ${buys ? "animate-pulse" : "opacity-40"}`}
        >
          {buys ? "Buying" : "Does not buy"}
        </Badge>
      </CardContent>
    </Card>
  );
};

export const PortPanel = () => {
  const sector = useGameStore.use.sector?.();
  const starfield = useGameStore.use.starfieldInstance?.();

  useEffect(() => {
    if (starfield) {
      starfield.selectGameObject("port");
    }
  }, [starfield]);

  //  const { setImage, getPortImage, clearImage } = useImageStore();

  const buysQF = sector?.port?.code?.split("")[0] === "B";
  const buysRO = sector?.port?.code?.split("")[1] === "B";
  const buysNS = sector?.port?.code?.split("")[2] === "B";
  const sellsQF = sector?.port?.code?.split("")[0] === "S";
  const sellsRO = sector?.port?.code?.split("")[1] === "S";
  const sellsNS = sector?.port?.code?.split("")[2] === "S";

  return (
    <div className="flex flex-row gap-6">
      <Card
        variant="stripes"
        className="stripe-frame-ui-sm stripe-frame-white/30"
      >
        <CardHeader>
          <CardTitle className="heading-1">
            Tradepost<span className="opacity-40"> / </span>
            {sector?.port?.code || "SSS"}
          </CardTitle>
        </CardHeader>
        <CardContent className="">
          <div className="flex flex-row gap-2">
            <CommodityItem
              commodity="qf"
              buys={buysQF}
              sells={sellsQF}
              price={sector?.port?.prices.quantum_foam || 0}
              units={sector?.port?.stock.quantum_foam || 0}
            />
            <CommodityItem
              commodity="ro"
              buys={buysRO}
              sells={sellsRO}
              price={sector?.port?.prices.retro_organics || 0}
              units={sector?.port?.stock.retro_organics || 0}
            />
            <CommodityItem
              commodity="ns"
              sells={sellsNS}
              buys={buysNS}
              price={sector?.port?.prices.neuro_symbolics || 0}
              units={sector?.port?.stock.neuro_symbolics || 0}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
