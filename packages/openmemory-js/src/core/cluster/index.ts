import { env } from "../config";

export function broadcastMemory(memoryState: import("../types").mem_row): void {
    if (!env.OM_CLUSTER_PEERS || env.OM_CLUSTER_PEERS.length === 0) return;

    const peers = env.OM_CLUSTER_PEERS;
    const nodeId = env.OM_NODE_ID || "unknown";

    const payload = {
        source_node: nodeId,
        event: "memory_sync",
        data: memoryState,
    };

    for (const peer of peers) {
        if (!peer) continue;
        const endpoint = `${peer.replace(/\/$/, "")}/api/cluster/sync`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // Passing api key if available to authenticate cluster nodes
                ...(env.api_key ? { "x-api-key": env.api_key } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        })
            .then((response) => {
                clearTimeout(timeout);
                if (!response.ok) {
                    console.error(`[CLUSTER] Failed to sync with peer ${peer}: HTTP ${response.status}`);
                }
            })
            .catch((e) => {
                clearTimeout(timeout);
                console.error(`[CLUSTER] Failed to sync with peer ${peer}:`, e.message);
            });
    }
}
