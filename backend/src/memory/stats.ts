// Export memory stats for dashboard
import { q } from "../core/db";

export async function get_memory_stats(): Promise<any> {
    try {
        const stats = await q.get_max_segment.get();
        const active_segments = stats?.max_seg || 0;
        return { active_segments };
    } catch (e) {
        console.error("Failed to get memory stats", e);
        return { active_segments: 0 };
    }
}
