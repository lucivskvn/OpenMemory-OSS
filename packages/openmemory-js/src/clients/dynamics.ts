/**
 * @file dynamics.ts
 * @description sub-client for Cognitive Dynamics operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    DynamicsConstants,
    SalienceResult,
    ResonanceResult,
    RetrievalResult,
    ReinforcementResult,
    SpreadingActivationResult,
    WaypointGraphResult,
    WaypointWeightResult,
} from "../core/types/dynamics";

/**
 * Cognitive Dynamics Operations sub-client.
 */
export class DynamicsClient extends BaseSubClient {
    /**
     * Get cognitive dynamics constants.
     */
    async getConstants(options?: { signal?: AbortSignal }): Promise<{
        success: boolean;
        constants: DynamicsConstants;
    }> {
        return await this.request<{
            success: boolean;
            constants: DynamicsConstants;
        }>("/dynamics/constants", { signal: options?.signal });
    }

    /**
     * Calculate salience for a hypothetical memory.
     */
    async calculateSalience(params: {
        initialSalience?: number;
        decayLambda?: number;
        recallCount?: number;
        emotionalFrequency?: number;
        timeElapsedDays?: number;
        userId?: string;
        signal?: AbortSignal;
    }): Promise<SalienceResult> {
        return await this.request<SalienceResult>(
            "/dynamics/salience/calculate",
            {
                method: "POST",
                body: JSON.stringify(params),
                signal: params.signal,
            },
        );
    }

    /**
     * Calculate resonance between two sectors.
     */
    async calculateResonance(params: {
        memorySector?: string;
        querySector?: string;
        baseSimilarity?: number;
        signal?: AbortSignal;
    }): Promise<ResonanceResult> {
        return await this.request<ResonanceResult>(
            "/dynamics/resonance/calculate",
            {
                method: "POST",
                body: JSON.stringify(params),
                signal: params.signal,
            },
        );
    }

    /**
     * Retrieve memories using energy-based selection.
     */
    async retrieveEnergyBased(params: {
        query: string;
        sector?: string;
        minEnergy?: number;
        userId?: string;
        signal?: AbortSignal;
    }): Promise<RetrievalResult> {
        return await this.request<RetrievalResult>(
            "/dynamics/retrieval/energy-based",
            {
                method: "POST",
                body: JSON.stringify(params),
                signal: params.signal,
            },
        );
    }

    /**
     * Reinforce a memory trace.
     */
    async reinforceTrace(memoryId: string, userId?: string, options?: { signal?: AbortSignal }): Promise<ReinforcementResult> {
        const uid = userId || this.defaultUser;
        return await this.request<ReinforcementResult>(
            "/dynamics/reinforcement/trace",
            {
                method: "POST",
                body: JSON.stringify({ memoryId, userId: uid }),
                signal: options?.signal,
            },
        );
    }

    /**
     * Perform spreading activation from a set of memories.
     */
    async spreadingActivation(
        memoryIds: string[],
        maxIterations = 3,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<SpreadingActivationResult> {
        const uid = userId || this.defaultUser;
        return await this.request<SpreadingActivationResult>(
            "/dynamics/activation/spreading",
            {
                method: "POST",
                body: JSON.stringify({
                    initialMemoryIds: memoryIds,
                    maxIterations,
                    userId: uid,
                }),
                signal: options?.signal,
            },
        );
    }

    /**
     * Get the waypoint graph for visualization or navigation.
     */
    async getWaypointGraph(limit = 1000, userId?: string, options?: { signal?: AbortSignal }): Promise<WaypointGraphResult> {
        const uid = userId || this.defaultUser;
        return await this.request<WaypointGraphResult>(
            `/dynamics/waypoints/graph?limit=${limit}${uid ? `&userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
    }

    /**
     * Calculate the weight between two waypoints.
     */
    async calculateWaypointWeight(
        sourceId: string,
        targetId: string,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<WaypointWeightResult> {
        const uid = userId || this.defaultUser;
        return await this.request<WaypointWeightResult>(
            "/dynamics/waypoints/calculate-weight",
            {
                method: "POST",
                body: JSON.stringify({
                    sourceMemoryId: sourceId,
                    targetMemoryId: targetId,
                    userId: uid,
                }),
                signal: options?.signal,
            },
        );
    }
}
