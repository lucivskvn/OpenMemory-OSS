import { insert_fact, delete_fact, insert_edge } from './store'
import { get_current_fact, get_related_facts } from './query'
import { run_async, get_async } from '../core/db'

async function test() {
    console.log("Starting Temporal Graph Verification...")

    // 1. Security Test: Multi-tenant isolation
    console.log("\n[Test 1] Multi-tenant isolation...")
    const userA = "user_A"
    const userB = "user_B"

    const factIdA = await insert_fact("John", "location", "New York", new Date(), 1.0, {}, userA)
    console.log(`Created fact for ${userA}: ${factIdA}`)

    // Attempt to delete userA's fact as userB
    console.log(`Attempting to delete ${userA}'s fact as ${userB}...`)
    await delete_fact(factIdA, userB)

    const factA = await get_current_fact("John", "location", userA)
    if (factA && factA.id === factIdA) {
        console.log("SUCCESS: User B could not delete User A's fact.")
    } else {
        console.error("FAILURE: User A's fact was deleted by User B!")
    }

    // 2. Edge Invalidation Test
    console.log("\n[Test 2] Edge auto-invalidation...")
    const factIdB = await insert_fact("John", "works_at", "Google", new Date(), 1.0, {}, userA)

    const edgeId1 = await insert_edge(factIdA, factIdB, "colocated", new Date(Date.now() - 10000), 0.5, {}, userA)
    console.log(`Created edge 1: ${edgeId1}`)

    const edgeId2 = await insert_edge(factIdA, factIdB, "colocated", new Date(), 0.9, {}, userA)
    console.log(`Created edge 2: ${edgeId2}`)

    // Check if edge 1 is invalidated
    const related = await get_related_facts(factIdA, "colocated", new Date(), userA)
    console.log(`Related facts found: ${related.length}`)

    // Wait for DB write if async (though our sqlite/pg wrappers are usually awaited)

    const edge1Result = await get_async<{ valid_to: number | null }>(`SELECT valid_to FROM temporal_edges WHERE id = ?`, [edgeId1])
    if (edge1Result && edge1Result.valid_to !== null) {
        console.log("SUCCESS: Old edge was auto-invalidated.")
    } else {
        console.error("FAILURE: Old edge was NOT invalidated!", edge1Result)
    }

    console.log("\nVerification Complete.")
}

test().catch(console.error)
