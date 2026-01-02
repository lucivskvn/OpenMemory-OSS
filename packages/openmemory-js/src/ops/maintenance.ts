import { q } from "../core/db";
import { LearnedClassifier } from "../core/learned_classifier";
import { bufferToVector } from "../utils/vectors";
import { env } from "../core/cfg";

/**
 * Trains/Updates the sector classifier model for a specific user.
 * Fetches existing memories, extracts vectors and labels, and trains the model.
 */
export async function trainUserClassifier(user_id: string, epochs = 20) {
    if (env.verbose) console.log(`[maintenance] Training classifier for user: ${user_id}`);

    // 1. Fetch training data (memories with embeddings)
    const data = await q.get_training_data.all(user_id, 10000); // Limit to 10k for now

    if (data.length < 10) {
        if (env.verbose) console.log(`[maintenance] Not enough data to train classifier for ${user_id} (${data.length} samples)`);
        return null;
    }

    // 2. Format data for training
    const trainingSamples = data.map(d => ({
        vector: bufferToVector(d.mean_vec),
        label: d.primary_sector
    }));

    // 3. Get existing model if any
    const existing = await q.get_classifier_model.get(user_id);
    let existingModel = undefined;
    if (existing) {
        try {
            existingModel = {
                user_id: user_id,
                weights: JSON.parse(existing.weights),
                biases: JSON.parse(existing.biases),
                version: existing.version,
                updated_at: existing.updated_at
            };
        } catch (e) {
            console.error(`[maintenance] Error parsing existing model for ${user_id}:`, e);
        }
    }

    // 4. Train the model
    const newModel = LearnedClassifier.train(trainingSamples, existingModel, 0.01, epochs);

    // 5. Save the model back to DB
    await q.ins_classifier_model.run(
        user_id,
        JSON.stringify(newModel.weights),
        JSON.stringify(newModel.biases),
        (existing?.version || 0) + 1,
        Date.now()
    );

    if (env.verbose) console.log(`[maintenance] Successfully trained and saved model for ${user_id}. Samples: ${data.length}`);
    return newModel;
}

/**
 * Maintenance job to retrain classifiers for all active users.
 */
export async function maintenanceRetrainAll() {
    const users = await q.get_active_users.all();
    if (env.verbose) console.log(`[maintenance] Starting routine retraining for ${users.length} users`);

    for (const { user_id } of users) {
        if (!user_id) continue;
        try {
            await trainUserClassifier(user_id);
        } catch (e) {
            console.error(`[maintenance] Failed to train classifier for user ${user_id}:`, e);
        }
    }
}
