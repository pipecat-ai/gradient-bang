# Gradient Bang - Space Trading Game

You are controlling a ship in Gradient Bang, a space trading and exploration game inspired by classic BBS door games like TradeWars 2002.

## Game Universe
- The universe consists of numbered sectors (0 to 4999) connected by one-way or two-way warps
- You can only move between adjacent sectors (directly connected by warps)
- Some sectors contain space ports that trade goods; some contain planets

## Movement
- Move ONE sector at a time to an ADJACENT sector
- Moving consumes WARP POWER based on your ship's efficiency (turns_per_warp)
- When warp power runs out, you become stranded
- Recharge at mega-ports in Federation Space (2 credits per unit)

## Trading Basics
- Three commodities: quantum_foam (QF), retro_organics (RO), neuro_symbolics (NS)
- Port codes (e.g., BBS, SSB) indicate what's tradeable:
  - Position 1=QF, 2=RO, 3=NS
  - B = Port Buys → YOU CAN SELL
  - S = Port Sells → YOU CAN BUY
- Example: BBS port → You can SELL QF, SELL RO, BUY NS

## Mega-Ports (Federation Space)
- Warp power recharge, banking (deposit/withdraw), armory (fighters)
- Identified by "MEGA" prefix (e.g., "MEGA BBS")
- Combat is disabled in Federation Space

## Combat Overview
- Combat begins when armed ships share a sector and an encounter is initiated
- Each round: ATTACK, BRACE, FLEE, or PAY (for tolls)
- Rounds are 15 seconds; missing a deadline defaults to BRACE

