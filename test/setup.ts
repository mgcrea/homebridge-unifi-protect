import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./msw-server.js";

// Any request the tests didn't explicitly stub is a bug in the test, not a
// reason to reach for a real console.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
