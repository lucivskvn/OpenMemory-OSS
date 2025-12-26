import { v1_2_0 } from "./v1.2.0";
import { v1_3_0 } from "./v1.3.0";
import { v1_4_0 } from "./v1.4.0";
import { v1_5_0 } from "./v1.5.0";
import { v1_6_0 } from "./v1.6.0";

export const migrations = [v1_2_0, v1_3_0, v1_4_0, v1_5_0, v1_6_0];
export * from "./initial";
export * from "./migration_types";
