export const GET_MY_STATUS_MESSAGE = {
  type: "get-my-status",
  payload: {},
};

export const GET_KNOWN_PORT_LIST = {
  type: "get-known-ports",
  payload: {},
};

export const GET_MAP_REGION = {
  type: "get-my-map",
  payload: { center_sector: 0, max_hops: 8 },
};
