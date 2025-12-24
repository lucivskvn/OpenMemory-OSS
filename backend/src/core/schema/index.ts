import { v1_2_0 } from "./v1.2.0";
import { v1_3_0 } from "./v1.3.0";
import { v1_4_0 } from "./v1.4.0";
export { get_initial_schema_pg, get_initial_schema_sqlite } from "./initial";
export type { Migration } from "./migration_types";

export const migrations = [v1_2_0, v1_3_0, v1_4_0];
