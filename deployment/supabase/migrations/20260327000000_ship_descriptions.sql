-- Add description column to ship_definitions and populate with lore text.

ALTER TABLE ship_definitions
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

UPDATE ship_definitions SET description = CASE ship_type

WHEN 'sparrow_scout' THEN
'The Sparrow is a Federation shuttle design that has been configured for permanent life support and equipped with a basic Taylor-Kramer drive for modest warp capability. At its peak the Federation produced thousands of these ships annually. Many can still be found on Federation worlds being used for private air transport. Some brave souls take these ancient Sparrows back into space despite the inconvenience. Anybody who''s spent more than a day on a Sparrow will remember the tiny and poorly equipped washroom — you can usually smell Sparrow pilots at megaports at a good distance. Yet the classic Federation design is incredibly reliable and the tiny ship is very agile, so Sparrows have been known to successfully flee difficult combat situations. You wouldn''t want to try your luck though, if you can avoid it.'

WHEN 'kestrel_courier' THEN
'Created by the Kestrel Corporation of Solaris IV, the Courier was a bestseller model of commercial astronautics for over a century. After the disappearance of Solaris IV, clone shops in neutral worlds have been churning out these ships using old plans and refurbished nanofactories. The Courier is a decent all-rounder that could actually survive a fight. Due to its affordable price, Courier pilots tend to be young and brash, often still freelancers working outside a corporation, maybe saving up to start their own. But visit the Excelsior Casino''s Venture Lounge at a megaport and eavesdrop on the conversations of the older high-rollers who commanded starcruisers when you were still in diapers — they''ll probably be reminiscing about simpler times when all they flew was a banged-up Courier loaded with volatile proto-quantum foam, corsairs hot on their tail.'

WHEN 'parhelion_seeker' THEN
'One of the most modern ship designs available, the Seeker was created by the Parhelion Guild after the century of isolation was over and humans returned to interstellar contact. The Guild believes that the galaxy is being invaded by aliens who have not yet been detected, so they must be actively discovered and documented. They designed the Seeker to be the ideal ship for long-range exploration. Pilots are particularly grateful for its luxurious nappa leather interior and terrific range. Many Courier pilots face the choice between saving up for a freighter to grow their bread-and-butter business, or buying a Seeker to explore what''s out there — and understandably many are tempted by this sleek, fast vehicle.'

WHEN 'wayfarer_freighter' THEN
'Many a Federation citizen''s childhood was marked by the sight of bulky Wayfarers in the skies, bringing in goods and stories from faraway worlds after a long isolation. Even rose-colored nostalgia can''t make these ships look beautiful, though. The freighter is the workhorse of the interstellar economy. They''re big enough to make deals worthwhile, but small enough that your corporation doesn''t have to risk too much capital on an unproven trade route. In combat, Wayfarers can usually hold their own until they figure out their escape — and that''s generally what you need to protect your cargo.'

WHEN 'pioneer_lifter' THEN
'The Pioneer Corporation is believed to be one of the oldest surviving corporations in human history. Although their only product today is this giant cargo ship, it is equipped with a surprisingly good 30-point 3D surround audio system — perhaps an artifact of the company''s history. The Lifter has been manufactured for over 300 years by Pioneer''s factories on multiple worlds with little change. Its cargo hold is very large but the hull is made of simple steel and titanium, materials that seemed old and proven even all those centuries ago. It has no defensive nano-armor or any other modern outfittings, so a Lifter alone in space would be like a sitting duck. Equip your corporation accordingly.'

WHEN 'atlas_hauler' THEN
'The Hauler was created by the Venture Chamber''s R&D arm. Some say the designers may even have been too influenced by the demands of galactic industrialists, as this ship prioritizes cargo capacity above everything else. Docking this behemoth into a standard spaceport is a sight to behold because the ship will dwarf most orbital ports. The Hauler is slow and its defenses, while technically modern, are simply inadequate for such an enormous surface area. Corporations that are able to purchase haulers will also have strategies to keep them defended on those lucrative trade routes that can benefit from this capacity.'

WHEN 'corsair_raider' THEN
'Traders tend to remember the first time a Raider''s outline lights up on their scanner. Each of these sleek and menacing ships is heavily customized by and for their pilots, who generally like to operate outside the Federation''s suffocating protection and patronizing oversight. The origin of the Raider design remains unknown: perhaps it was created by criminal syndicates already in the days of the old Federation. Today these ships are manufactured by rogue shops located in dark asteroids that hide in interstellar space. But owning one is not evidence of a crime, so they are often being sold even in Federation megaports. You may want to consider a set of matching tattoos to go with the ship, depending on what message you''re looking to send to other pilots.'

WHEN 'pike_frigate' THEN
'Named after the legendary Admiral Pike from the days of the Old Federation''s Civil War, the Frigate is the Federation''s most common type of warship. The Federation mostly uses these ships to scare farming worlds into compliance. But the post-isolation Rules of Venture have guaranteed the right for private parties to purchase and equip any type of warship, so little-used Frigates are readily available for purchase at megaports and provide a steady income stream for the Federation''s sprawling budget. The Frigate''s cargo hold is sufficient for the kind of farming supply missions they often do in Federation space, but a corporation that specializes in interstellar trading would soon find it a barrier to growth.'

WHEN 'bulwark_destroyer' THEN
'The Destroyer is the Federation''s heavy-duty police vehicle. These massive ships generally patrol the edges of Federation space to protect the fortress of peace that justifies the Federation''s regular tax hikes on farming worlds. The shields on a Destroyer are fully twice as strong as a Frigate''s which already mounts a powerful defense. The fuel capacity is also massive, so a Destroyer has no problem reaching a far away sector and holding it. But it is a slow-moving vessel, so corporation leaders who acquire these space tanks must think strategically about where and when to move their Destroyers.'

WHEN 'aegis_cruiser' THEN
'Aegis is a megacorporation that emerged after the isolation and became a shipyard. The Cruiser was designed primarily for serious interstellar enterprises rather than Federation fleets. Its entire hull is reinforced with quantum foam, an extremely expensive process that makes it very lightweight. Tap your finger on the outer wall of a Cruiser, and it feels like there''s nothing but aluminum foil between your finger and the cold hard vacuum. The resulting ship design looks almost like an elegant origami up close. It''s more agile than a Destroyer but packs almost as much of a punch in combat. Cargo capacity isn''t quite on the level of a freighter, but enough to make these Cruisers able to turn a profit and contribute to the enterprise''s bottom line rather than just sit still and look menacing, which is more the Federation''s speciality.'

WHEN 'sovereign_starcruiser' THEN
'The flagship that announces to everyone that you''ve made it. The Starcruiser is technically not a single design because every one of them is customized for the corporation''s needs and its executives'' tastes. But the limits of physics and shipyard expertise practically ensure that every Sovereign Starcruiser tends to be built with very similar specs — simply the best that can be fit on a single vessel today without it collapsing on its weight or getting lost in warp currents. For opulent corporations, a zoo deck with an artificial sky remains an ever-popular Starcruiser feature; giraffes and lions make for a fabulously menacing setting to conduct your trade negotiations and to intimidate tinpot dictators of neutral worlds.'

WHEN 'escape_pod' THEN
'The last resort whose only job is getting you safely back to a megaport after everything else failed. You don''t want to think about what it feels like to go through multiple warps in one of these buckets.'

WHEN 'autonomous_probe' THEN
'The tool of choice for an exploration-minded corporation. Fast, cheap, and ultimately expendable because it has no shields at all.'

WHEN 'autonomous_light_hauler' THEN
'A light hauler is effectively a minimal cargo hold attached to the same lightweight warp engine that powers an autonomous probe. It''s slow and doesn''t carry a lot of cargo, but it does let your corporation get its foot in the door of multi-ship trading with a minimal upfront investment.'

ELSE description END;
