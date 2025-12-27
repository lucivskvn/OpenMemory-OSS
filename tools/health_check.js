import { Elysia } from 'elysia';
import { req_tracker_plugin } from '../backend/src/server/routes/dashboard';
import { mem } from '../backend/src/server/routes/memory';
import { sys } from '../backend/src/server/routes/system';

(async () => {
    const app = new Elysia().use(req_tracker_plugin).use(mem).use(sys);
    const res = await app.handle(new Request('http://localhost/api/system/health'));
    console.log('status', res.status);
    console.log('body', await res.json());
})();