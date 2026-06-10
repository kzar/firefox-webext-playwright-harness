// Shared between the local server, the Playwright config's webServer block, and
// the specs, so the port lives in exactly one place.
export const SERVER_PORT = 8099;
export const SERVER_URL = `http://localhost:${SERVER_PORT}`;
