import { test, expect, describe, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:8080";
const API_KEY = "your"; // As defined in .env.example
let serverHandle;

// Helper to wait for the server to be ready
const waitForServer = async (retries = 30, delay = 200) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        console.log("✅ Server is healthy and ready.");
        return;
      }
    } catch (e) {
      // Ignore fetch errors while server is starting
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Server did not become ready in time.");
};

beforeAll(async () => {
  console.log("🧪 Starting backend server for tests (in-process)...");
  // Start the server in-process to avoid spawning external executables which can fail in CI/test environments.
  // Import the server start helper from the backend source.
  const { startServer } = require("../../backend/src/server/index.ts")

  // Set minimal env overrides for tests
  process.env.OM_API_KEY = process.env.OM_API_KEY || "your"
  process.env.OM_EMBED_KIND = process.env.OM_EMBED_KIND || "local"
  process.env.OM_DB_PATH = process.env.OM_DB_PATH || ":memory:"

  try {
    serverHandle = await startServer()
  } catch (err) {
    console.error("❌ Server startup failed:", err)
    throw err
  }

  try {
    await waitForServer();
  } catch (error) {
    console.error("❌ Server did not become ready:", error)
    if (serverHandle && serverHandle.stop) await serverHandle.stop()
    throw error
  }
});

afterAll(async () => {
  console.log("🛑 Stopping backend server...");
  if (serverHandle && serverHandle.stop) {
    // Release one reference to the shared test server. The server will only
    // actually stop when all callers have released their references.
    if (serverHandle.release) {
      await serverHandle.release()
      console.log("✅ Released server reference.")
    } else {
      await serverHandle.stop()
      console.log("✅ Server stopped (release not available).")
    }
  } else {
    console.log("🤷 Server was not running, skipping shutdown.");
  }
});

describe("Backend API Tests", () => {
  test("Health Check should return 200 OK", async () => {
    const response = await fetch(`${BASE_URL}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("version");
  });

  describe("Memory Operations", () => {
    let testMemoryId;

    test("POST /memory/add - should add a new memory", async () => {
      const content = "This is a test memory created by the bun:test suite";
      const response = await fetch(`${BASE_URL}/memory/add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ content }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("primary_sector");
      expect(body.sectors).toBeArray();
      testMemoryId = body.id;
    });

    test("GET /memory/all - should list memories", async () => {
      const response = await fetch(`${BASE_URL}/memory/all?l=10`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toBeArray();
    });

    test("POST /memory/query - should find relevant memories", async () => {
      const response = await fetch(`${BASE_URL}/memory/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ query: "bun:test suite", k: 5 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.matches).toBeArray();
    });

    // test("DELETE /memory/:id - should delete the test memory", async () => {
    //   expect(testMemoryId).toBeString("Test memory ID should be set from the add test");
    //   const response = await fetch(`${BASE_URL}/memory/${testMemoryId}`, {
    //     method: "DELETE",
    //     headers: { Authorization: `Bearer ${API_KEY}` },
    //   });
    //   expect(response.status).toBe(200);
    //   const body = await response.json();
    //   expect(body).toHaveProperty("ok", true);
    // });
  });

  test("GET /sectors - should return the list of sectors", async () => {
    const response = await fetch(`${BASE_URL}/sectors`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sectors).toBeArray();
    expect(body.sectors).toContain("episodic");
    expect(body.sectors).toContain("semantic");
  });

  test("Error Handling - should return 404 for an invalid memory ID", async () => {
    const response = await fetch(`${BASE_URL}/memory/invalid-id-does-not-exist`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(404);
  });
});
