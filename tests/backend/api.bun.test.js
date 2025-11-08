import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";

const BASE_URL = "http://localhost:8080";
const API_KEY = "your"; // As defined in .env.example
let server;

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
  console.log("🧪 Starting backend server for tests...");
  server = spawn(["bun", "run", "start"], {
    cwd: "backend",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OM_API_KEY: "your",
      OM_EMBED_KIND: "local",
      OM_DB_PATH: ":memory:",
    },
  });
  try {
    await waitForServer();
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    const stderr = await new Response(server.stderr).text();
    console.error("Server stderr:", stderr);
    server.kill();
    process.exit(1);
  }
});

afterAll(async () => {
  console.log("🛑 Stopping backend server...");
  if (server) {
    server.kill();
    // Wait a moment to ensure the process is terminated
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log("✅ Server stopped.");
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
