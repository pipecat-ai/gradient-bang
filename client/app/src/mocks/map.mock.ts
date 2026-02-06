export const MOCK_COURSE_PLOT: CoursePlot = {
  from_sector: 599,
  to_sector: 2792,
  path: [599, 2766, 4822, 2831, 2058, 1611, 1928, 4382, 2792],
  distance: 11,
}

export const SMALL_MAP_DATA_MOCK: MapData = [
  {
    id: 404,
    port: null,
    lanes: [
      {
        to: 863,
        two_way: true,
      },
      {
        to: 1184,
        two_way: true,
      },
      {
        to: 2213,
        two_way: true,
      },
      {
        to: 3359,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "corp",
    visited: true,
    position: [100, 179],
    last_visited: "2026-02-05T23:01:04.169Z",
    adjacent_sectors: [863, 1184, 2213, 3359],
    hops_from_center: 2,
  },
  {
    id: 863,
    port: null,
    lanes: [
      {
        to: 2213,
        two_way: true,
      },
      {
        to: 404,
        two_way: true,
      },
    ],
    visited: false,
    position: [99, 180],
    adjacent_sectors: [],
    hops_from_center: 2,
  },
  {
    id: 914,
    port: null,
    lanes: [
      {
        to: 1823,
        two_way: false,
      },
      {
        to: 2651,
        two_way: true,
      },
      {
        to: 2792,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "corp",
    visited: true,
    position: [102, 170],
    last_visited: "2026-02-05T19:51:44.194Z",
    adjacent_sectors: [],
    hops_from_center: 4,
  },
  {
    id: 1184,
    port: null,
    lanes: [
      {
        to: 404,
        two_way: true,
      },
    ],
    visited: false,
    position: [100, 181],
    adjacent_sectors: [],
    hops_from_center: 3,
  },
  {
    id: 1479,
    port: {
      code: "BBB",
      mega: false,
    },
    lanes: [
      {
        to: 0,
        two_way: false,
      },
      {
        to: 3559,
        two_way: false,
      },
      {
        to: 4138,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "player",
    visited: true,
    position: [90, 177],
    last_visited: "2026-01-27T01:23:50.244Z",
    adjacent_sectors: [],
    hops_from_center: 9,
  },
  {
    id: 1487,
    port: null,
    lanes: [
      {
        to: 1928,
        two_way: true,
      },
      {
        to: 2213,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "both",
    visited: true,
    position: [98, 176],
    last_visited: "2026-02-06T13:36:15.405Z",
    adjacent_sectors: [1928, 2213],
    hops_from_center: 0,
  },
  {
    id: 1611,
    port: {
      code: "SSS",
      mega: true,
    },
    lanes: [
      {
        to: 1928,
        two_way: true,
      },
      {
        to: 2058,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "both",
    visited: true,
    position: [94, 171],
    last_visited: "2026-02-05T22:53:12.020Z",
    adjacent_sectors: [1928, 2058],
    hops_from_center: 2,
  },
  {
    id: 1928,
    port: {
      code: "BBS",
      mega: false,
    },
    lanes: [
      {
        to: 1487,
        two_way: true,
      },
      {
        to: 1611,
        two_way: true,
      },
      {
        to: 4382,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "both",
    visited: true,
    position: [96, 173],
    last_visited: "2026-02-05T23:00:33.523Z",
    adjacent_sectors: [1487, 1611, 4382],
    hops_from_center: 1,
  },
  {
    id: 2058,
    port: null,
    lanes: [
      {
        to: 1611,
        two_way: true,
      },
      {
        to: 2831,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "both",
    visited: true,
    position: [92, 172],
    last_visited: "2026-02-05T22:51:54.578Z",
    adjacent_sectors: [1611, 2831],
    hops_from_center: 3,
  },
  {
    id: 2213,
    port: null,
    lanes: [
      {
        to: 404,
        two_way: true,
      },
      {
        to: 863,
        two_way: true,
      },
      {
        to: 1487,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "corp",
    visited: true,
    position: [99, 178],
    last_visited: "2026-02-05T23:01:01.361Z",
    adjacent_sectors: [404, 863, 1487],
    hops_from_center: 1,
  },
  {
    id: 2531,
    port: null,
    lanes: [
      {
        to: 3559,
        two_way: true,
      },
      {
        to: 4988,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "player",
    visited: true,
    position: [94, 179],
    last_visited: "2026-01-27T00:23:25.556Z",
    adjacent_sectors: [],
    hops_from_center: 10,
  },
  {
    id: 2792,
    port: null,
    lanes: [
      {
        to: 914,
        two_way: true,
      },
      {
        to: 4382,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "both",
    visited: true,
    position: [99, 171],
    last_visited: "2026-02-05T23:00:26.917Z",
    adjacent_sectors: [914, 4382],
    hops_from_center: 3,
  },
  {
    id: 2831,
    port: {
      code: "SSB",
      mega: false,
    },
    lanes: [
      {
        to: 2058,
        two_way: true,
      },
      {
        to: 3494,
        two_way: true,
      },
      {
        to: 4822,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "both",
    visited: true,
    position: [90, 173],
    last_visited: "2026-02-05T22:47:34.162Z",
    adjacent_sectors: [],
    hops_from_center: 4,
  },
  {
    id: 3359,
    port: null,
    lanes: [
      {
        to: 404,
        two_way: true,
      },
    ],
    visited: false,
    position: [102, 180],
    adjacent_sectors: [],
    hops_from_center: 3,
  },
  {
    id: 3559,
    port: null,
    lanes: [
      {
        to: 2531,
        two_way: true,
      },
      {
        to: 4138,
        two_way: true,
      },
      {
        to: 4988,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "player",
    visited: true,
    position: [93, 178],
    last_visited: "2026-01-27T01:25:22.862Z",
    adjacent_sectors: [],
    hops_from_center: 9,
  },
  {
    id: 4138,
    port: {
      code: "BBB",
      mega: false,
    },
    lanes: [
      {
        to: 0,
        two_way: true,
      },
      {
        to: 475,
        two_way: false,
      },
      {
        to: 1479,
        two_way: true,
      },
      {
        to: 3559,
        two_way: true,
      },
    ],
    region: "Federation Space",
    source: "player",
    visited: true,
    position: [90, 178],
    last_visited: "2026-01-27T01:25:26.255Z",
    adjacent_sectors: [],
    hops_from_center: 8,
  },
  {
    id: 4382,
    port: {
      code: "SSB",
      mega: false,
    },
    lanes: [
      {
        to: 1928,
        two_way: true,
      },
      {
        to: 2792,
        two_way: true,
      },
    ],
    region: "Neutral",
    source: "both",
    visited: true,
    position: [98, 172],
    last_visited: "2026-02-05T23:00:29.557Z",
    adjacent_sectors: [1928, 2792],
    hops_from_center: 2,
  },
]

export const MEDIUM_MAP_DATA_MOCK: MapData = []

export const LARGE_MAP_DATA_MOCK: MapData = []
