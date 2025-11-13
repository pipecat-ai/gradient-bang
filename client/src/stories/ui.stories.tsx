import { CurrencyCounter } from "@/components/CurrencyCounter";
import { NumericalBadge } from "@/components/NumericalBadge";
import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardScrollable,
  CardTitle,
} from "@/components/primitives/Card";
import { Progress } from "@/components/primitives/Progress";
import { ScrollArea } from "@/components/primitives/ScrollArea";
import { Separator } from "@/components/primitives/Separator";
import { ScreenContainer } from "@/components/screens/ScreenContainer";
import { ScreenMenu } from "@/components/screens/ScreenMenu";
import { TextInputControl } from "@/components/TextInputControl";
import { UserMicControl } from "@/components/UserMicControl";
import Error from "@/components/views/Error";
import Game from "@/components/views/Game";
import JoinStatus from "@/components/views/JoinStatus";
import { Preload } from "@/components/views/Preload";
import ViewContainer from "@/components/views/ViewContainer";
import useGameStore from "@/stores/game";
import { AnimatedFrame } from "@fx/frame";
import { ActivityStream } from "@hud/ActivityStream";
import type { Story } from "@ladle/react";
import { Dialog } from "radix-ui";
import React, { useState } from "react";

export const PreloadStory: Story = () => (
  <div className="relative w-full h-full">
    <Preload
      onComplete={() => {}}
      className="w-full h-full"
      readyText="LOADING (T-24)"
    />
  </div>
);

PreloadStory.meta = {
  disconnectedStory: true,
};
export const DotStory: Story = () => (
  <div className="relative w-full h-screen">
    <div className="w-full h-full bg-dotted-sm bg-center">DOTS</div>
  </div>
);

DotStory.meta = {
  disconnectedStory: true,
};

export const ScreenUI: Story = () => (
  <div className="relative w-full h-screen flex flex-col items-center justify-center bg-slate-800">
    <ScreenMenu />
    <ScreenContainer />
    <AnimatedFrame />
  </div>
);

ScreenUI.meta = {
  disconnectedStory: true,
};

export const ScreenMenuUI: Story = () => (
  <div className="relative w-full h-screen">
    <ScreenMenu />
  </div>
);

ScreenMenuUI.meta = {
  disconnectedStory: true,
};

export const GameUI: Story = () => {
  const addToast = useGameStore.use.addToast();
  const addEntry = useGameStore.use.addActivityLogEntry();

  return (
    <div className="relative w-full h-screen">
      <Game />
      <AnimatedFrame />
      <div className="fixed bottom-0 right-0 p-ui-sm z-9999 ">
        <div className="flex flex-row gap-4">
          <Button
            onClick={() => {
              addEntry({
                ...DEBUG_ENTRIES[0],
              });
            }}
          >
            Add Movement
          </Button>
          <Button
            onClick={() => {
              addEntry({
                ...DEBUG_ENTRIES[1],
              });
            }}
          >
            DM John Doe
          </Button>
          <Button
            onClick={() => {
              addEntry({
                ...DEBUG_ENTRIES[2],
              });
            }}
          >
            DM Foo Bar
          </Button>
        </div>
        <Button
          onClick={() => {
            addToast({
              type: "warp.purchase",
              meta: {
                cost: 250,
                capacity: 300,
                prev_amount: 60,
                new_amount: 300,
                new_credits: 890,
                prev_credits: 1000,
              },
            });
          }}
        >
          Warp Purchase Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "bank.transaction",
              meta: {
                direction: "deposit",
                amount: 1000,
                credits_on_hand_before: 2000,
                credits_on_hand_after: 1000,
                credits_in_bank_before: 1000,
                credits_in_bank_after: 2000,
              },
            });
          }}
        >
          Bank Transaction Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "transfer",
              meta: {
                direction: "received",
                from: {
                  player_type: "human",
                  name: "John Doe",
                  id: "123",
                  ship: {
                    ship_type: "ship",
                    ship_name: "Ship",
                  },
                },
                to: {
                  player_type: "human",
                  name: "Jane Doe",
                  id: "456",
                  ship: {
                    ship_type: "ship",
                    ship_name: "Ship",
                  },
                },
                transfer_details: {
                  credits: 1000,
                },
              },
            });
          }}
        >
          Received Credits Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "transfer",
              meta: {
                direction: "sent",
                from: {
                  player_type: "human",
                  name: "John Doe",
                  id: "123",
                  ship: {
                    ship_type: "ship",
                    ship_name: "Ship",
                  },
                },
                to: {
                  player_type: "human",
                  name: "Jane Doe",
                  id: "456",
                  ship: {
                    ship_type: "ship",
                    ship_name: "Ship",
                  },
                },
                transfer_details: {
                  warp_power: 1000,
                },
              },
            });
          }}
        >
          Sent Warp Power Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "trade.executed",
              meta: {
                trade_type: "buy",
                commodity: "quantum_foam",
                units: 1,
                price_per_unit: 24,
                total_price: 24,
                old_credits: 874,
                new_credits: 850,
                new_cargo: {
                  neuro_symbolics: 0,
                  quantum_foam: 1,
                  retro_organics: 0,
                },
                new_prices: {
                  quantum_foam: 24,
                  retro_organics: 9,
                  neuro_symbolics: 38,
                },
              },
            });
          }}
        >
          Trade Purchase Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "trade.executed",
              meta: {
                trade_type: "sell",
                commodity: "retro_organics",
                units: 1,
                price_per_unit: 24,
                total_price: 24,
                old_credits: 850,
                new_credits: 874,
                new_cargo: {
                  neuro_symbolics: 0,
                  quantum_foam: 0,
                  retro_organics: 0,
                },
                new_prices: {
                  quantum_foam: 24,
                  retro_organics: 9,
                  neuro_symbolics: 38,
                },
              },
            });
          }}
        >
          Trade Sale Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "salvage.collected",
              meta: {
                salvage: {
                  salvage_id: "salv_123",
                  collected: {
                    cargo: {
                      quantum_foam: 8,
                      retro_organics: 0,
                      neuro_symbolics: 15,
                    },
                    scrap: 0,
                    credits: 100,
                  },
                },
              },
            });
          }}
        >
          Salvage Collected Toast
        </Button>
        <Button
          size="sm"
          onClick={() => {
            addToast({
              type: "salvage.created",
              meta: {
                salvage: {
                  salvage_id: "salv_123",
                  cargo: {
                    quantum_foam: 8,
                    retro_organics: 0,
                    neuro_symbolics: 15,
                  },
                  scrap: 0,
                  credits: 100,
                },
              },
            });
          }}
        >
          Salvage Created Toast
        </Button>
      </div>
    </div>
  );
};

GameUI.meta = {
  disconnectedStory: true,
};

export const ViewContainerUI: Story = () => (
  <div className="relative w-full h-screen">
    <ViewContainer />
  </div>
);

ViewContainerUI.meta = {
  disconnectedStory: true,
};

export const JoinStatusStory: Story = () => (
  <div className="relative w-full h-screen">
    <JoinStatus handleStart={() => {}} />
    <AnimatedFrame />
  </div>
);

JoinStatusStory.meta = {
  disconnectedStory: true,
};

const tags = Array.from({ length: 50 }).map(
  (_, i, a) => `v1.2.0-beta.${a.length - i}`
);

export const ScrollAreaDemo: Story = () => {
  return (
    <ScrollArea className="h-72 w-48 border">
      <div className="p-4">
        <h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>
        {tags.map((tag) => (
          <React.Fragment key={tag}>
            <div className="text-sm">{tag}</div>
            <Separator className="my-2" />
          </React.Fragment>
        ))}
      </div>
    </ScrollArea>
  );
};

ScrollAreaDemo.meta = {
  disconnectedStory: true,
};

export const ScrollableDialog: Story = () => {
  return (
    <Dialog.Root open={true} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay bg-gray-800/20 backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center animate-in fade-in-0 duration-300">
          <Dialog.Content className="DialogContent max-w-lg">
            <CardScrollable
              elbow={true}
              size="default"
              className="w-full h-full max-h-max bg-black/80 animate-in fade-in-0 zoom-in origin-center shadow-red-500"
            >
              <CardContent>
                <h4 className="mb-4 text-sm leading-none font-medium">Tags</h4>
                {tags.map((tag) => (
                  <React.Fragment key={tag}>
                    <div className="text-sm">{tag}</div>
                    <Separator className="my-2" />
                  </React.Fragment>
                ))}
              </CardContent>
              <CardFooter>
                <Button onClick={() => {}} className="w-full">
                  Close
                </Button>
              </CardFooter>
            </CardScrollable>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

ScrollableDialog.meta = {
  disconnectedStory: true,
};

export const ScrollableFooterDialog: Story = () => {
  return (
    <Dialog.Root open={true} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Overlay className="DialogOverlay bg-gray-800/20 backdrop-blur-sm bg-dotted-lg bg-dotted-white/10 bg-center animate-in fade-in-0 duration-300">
          <Dialog.Content className="DialogContent max-w-lg">
            <Card
              elbow={true}
              size="default"
              className="w-full h-full max-h-max bg-black/80 animate-in fade-in-0 zoom-in origin-center shadow-2xl"
            >
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <div className="flex-1 overflow-y-auto">
                <ScrollArea className="w-full h-full">
                  <CardContent>
                    <h4 className="mb-4 text-sm leading-none font-medium">
                      Tags
                    </h4>
                    {tags.map((tag) => (
                      <React.Fragment key={tag}>
                        <div className="text-sm">{tag}</div>
                        <Separator className="my-2" />
                      </React.Fragment>
                    ))}
                  </CardContent>
                </ScrollArea>
              </div>
              <CardFooter>
                <Button onClick={() => {}} className="w-full">
                  Close
                </Button>
              </CardFooter>
            </Card>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

ScrollableFooterDialog.meta = {
  disconnectedStory: true,
};

export const CardStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Card variant="stripes">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" className="stripe-frame-destructive">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" size="lg">
      <CardContent>Hello</CardContent>
    </Card>

    <Card variant="stripes" className="stripe-frame-blue-500/20">
      <CardContent>Hello</CardContent>
    </Card>

    <Card
      variant="stripes"
      className="stripe-frame-white/50 border border-white bg-white/10 stripe-frame-ui-sm"
    >
      <CardContent>Custom stripe size override</CardContent>
    </Card>
  </div>
);

CardStory.meta = {
  disconnectedStory: true,
};

export const ErrorCardStory: Story = () => <Error>Connection Error</Error>;

ErrorCardStory.meta = {
  disconnectedStory: true,
};

export const ButtonStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Button>Primary</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="ghost">Ghost</Button>

    <Button size="sm">Small</Button>
    <Button size="lg">Large</Button>
    <Button size="xl">XLarge</Button>

    <Button loader="stripes" isLoading={true}>
      Loading
    </Button>
  </div>
);

ButtonStory.meta = {
  disconnectedStory: true,
};

export const BadgeStory: Story = () => (
  <div className="flex flex-col gap-4">
    <Badge>
      Badge <span>0</span>
    </Badge>
    <div className="flex flex-row gap-4">
      <Badge border="elbow" size="sm">
        Badge
      </Badge>
      <Badge border="elbow">Badge</Badge>
      <Badge border="elbow" size="lg">
        Badge
      </Badge>
    </div>
    <div className="flex flex-row gap-4">
      <Badge border="bracket" size="sm">
        Badge
      </Badge>
      <Badge border="bracket">Badge</Badge>
      <Badge border="bracket" size="lg">
        Badge
      </Badge>
      <Badge border="bracket" size="lg" className="elbow">
        Badge
      </Badge>
    </div>

    <Badge border="none">
      Warp: <Progress value={50} color="fuel" />
    </Badge>
  </div>
);

BadgeStory.meta = {
  disconnectedStory: true,
};

export const ProgressStory: Story = () => {
  const [progress, setProgress] = useState(0);

  const incrementCx =
    "bg-green-800 stripe-bar stripe-bar-green-500 stripe-bar-20 stripe-bar-animate-1";
  const decrementCx =
    "bg-red-900 stripe-bar stripe-bar-red-500 stripe-bar-20 stripe-bar-animate-1 stripe-bar-reverse";

  return (
    <div className="flex flex-col gap-4">
      <Progress value={progress} color="fuel" className="h-[80px]" />
      <Separator />
      <Progress
        value={progress}
        color="fuel"
        className="h-[80px] "
        classNames={{
          increment: incrementCx,
          decrement: decrementCx,
        }}
        segmented={true}
      />
      <Separator />
      <Button onClick={() => setProgress(progress + 10)}>Increment</Button>
      <Button onClick={() => setProgress(progress - 10)}>Decrement</Button>
    </div>
  );
};

ProgressStory.meta = {
  disconnectedStory: true,
};

export const NumberCounter: Story = () => {
  const [count, setCount] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-row gap-4">
        <Button onClick={() => setCount(count + 1)}>Increment</Button>
        <Button onClick={() => setCount(count + 100)}>Increment 100</Button>
        <Button onClick={() => setCount(count + 1000)}>Increment 1000</Button>
        <Button onClick={() => setCount(count + 10000)}>Increment 10000</Button>
        <Button onClick={() => setCount(count + 100000)}>
          Increment 100000
        </Button>
        <Button onClick={() => setCount(count + 1000000)}>
          Increment 1000000
        </Button>
        <Button onClick={() => setCount(count + 10000000)}>
          Increment 10000000
        </Button>
        <Button onClick={() => setCount(0)}>Set to 0</Button>
      </div>
      <CurrencyCounter value={count} className="text-2xl font-bold" />
      <NumericalBadge value={count}>Badge</NumericalBadge>
      <NumericalBadge
        value={count}
        variants={{
          increment: "success",
          decrement: "warning",
        }}
      >
        Badge
      </NumericalBadge>
    </div>
  );
};

NumberCounter.meta = {
  disconnectedStory: true,
};

export const UserMicControlStory: Story = () => (
  <div className="flex flex-col gap-4">
    <UserMicControl />
  </div>
);

UserMicControlStory.meta = {
  enableMic: true,
};

export const TextInputControlStory: Story = () => (
  <div className="flex flex-col gap-4">
    <TextInputControl
      onSend={(text) => {
        console.log(text);
      }}
    />
  </div>
);

TextInputControlStory.meta = {
  disconnectedStory: true,
};

const DEBUG_ENTRIES = [
  {
    type: "movement",
    message: "Moved to [sector 0]",
  },
  {
    type: "chat.direct",
    message: "New direct message from [John Doe]",
    meta: {
      from_name: "John Doe",
    },
  },
  {
    type: "chat.direct",
    message: "New direct message from [Foo Bar]",
    meta: {
      from_name: "Foo Bar",
    },
  },
];

export const ActivityStreamStory: Story = () => {
  const addEntry = useGameStore.use.addActivityLogEntry();
  return (
    <div className="flex flex-col gap-4">
      <div className="h-[400px] p-4 bg-red-500 w-1/2">
        <ActivityStream />
      </div>
      <div className="flex flex-row gap-4">
        <Button
          onClick={() => {
            addEntry({
              ...DEBUG_ENTRIES[0],
            });
          }}
        >
          Add Movement
        </Button>
        <Button
          onClick={() => {
            addEntry({
              ...DEBUG_ENTRIES[1],
            });
          }}
        >
          DM John Doe
        </Button>
        <Button
          onClick={() => {
            addEntry({
              ...DEBUG_ENTRIES[2],
            });
          }}
        >
          DM Foo Bar
        </Button>
      </div>
    </div>
  );
};

ActivityStreamStory.meta = {
  disconnectedStory: true,
};
