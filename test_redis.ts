import { RedisClient } from "bun"; try { const r = new RedisClient(); console.log("ok"); } catch (e) { console.error(e); }
