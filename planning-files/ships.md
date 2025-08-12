# Ships

Each player flies a specific ship type at any time. Let's add code to represent these ship types and keep track of what ship each player is flying. 

Here are the ship types.

```
| Ship                      | Role           |         Price |  Trade‑in | Holds | Fighters | Shields | T/warp | Fuel tank | Slots | Built‑in      |
| ------------------------- | -------------- | ------------: | --------: | ----: | -------: | ------: | -----: | --------: | ----: | ------------- |
| **Kestrel Courier**       | starter        |    **25,000** |    15,000 |    30 |      300 |     150 |      3 |       300 |     2 | —             |
| **Sparrow Scout**         | recon          |    **35,000** |    21,000 |    20 |      200 |     120 |      2 |       280 |     2 | **scanner**   |
| **Wayfarer Freighter**    | main trader    |   **120,000** |    72,000 |   120 |      600 |     300 |      3 |       800 |     3 | —             |
| **Atlas Hauler**          | bulk cargo     |   **260,000** |   156,000 |   300 |      500 |     250 |      4 |      1600 |     3 | —             |
| **Corsair Raider**        | pirate         |   **180,000** |   108,000 |    60 |     1500 |     400 |      3 |       700 |     3 | —             |
| **Pike Frigate**          | assault        |   **300,000** |   180,000 |    70 |     2000 |     600 |      3 |       900 |     3 | —             |
| **Bulwark Destroyer**     | line combat    |   **450,000** |   270,000 |    80 |     4000 |    1200 |      4 |      1500 |     3 | —             |
| **Aegis Cruiser**         | control/escort |   **700,000** |   420,000 |    90 |     3500 |    1000 |      3 |      1300 |     4 | —             |
| **Pioneer Lifter**        | logistics      |   **220,000** |   132,000 |   180 |      500 |     200 |      4 |      1400 |     3 | —             |
| **Sovereign Starcruiser** | flagship       | **2,500,000** | 1,500,000 |   140 |     6500 |    2000 |      3 |      3000 |     5 | **transwarp** |
```

# Implementation

For now, we can add an optional ship argument to the /api/join endpoint. If provided, this argument sets the ship type for the player. If not provided, the player starts with the Kestrel Courier. 

We need to save the player's ship, ship stats, and contents of the ship holds. We should probably use the character knowledge file for this. 
