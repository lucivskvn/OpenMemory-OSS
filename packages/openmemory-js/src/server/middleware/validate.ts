/**
 * Tiny hand-written request validator.
 * RFC 7807 (Problem Details for HTTP APIs) compliant responses.
 */

export type field_type =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "any";

export interface field_schema {
    type: field_type;
    required?: boolean;
    nullable?: boolean;
    min_length?: number;
    max_length?: number;
    min?: number;
    max?: number;
    items?: field_schema;
    min_items?: number;
    max_items?: number;
    one_of?: ReadonlyArray<string>;
    fields?: schema;
}

export type schema = Record<string, field_schema>;

export interface validate_result<T> {
    ok: boolean;
    data: T;
    errors: string[];
}

function type_of(v: unknown): field_type | "null" | "undefined" {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return "array";
    const t = typeof v;
    if (t === "string") return "string";
    if (t === "number") return "number";
    if (t === "boolean") return "boolean";
    if (t === "object") return "object";
    return "any";
}

function check_field(
    path: string,
    value: unknown,
    spec: field_schema,
    errors: string[],
): unknown {
    if (value === undefined || value === null) {
        if (spec.required && value === undefined) {
            errors.push(`${path}: required`);
        }
        if (value === null && !spec.nullable) {
            if (spec.required) errors.push(`${path}: must not be null`);
        }
        return value;
    }

    const actual = type_of(value);
    switch (spec.type) {
        case "any":
            return value;
        case "string": {
            if (actual !== "string") {
                errors.push(`${path}: expected string, got ${actual}`);
                return value;
            }
            const s = value as string;
            if (spec.min_length !== undefined && s.length < spec.min_length)
                errors.push(`${path}: length < ${spec.min_length}`);
            if (spec.max_length !== undefined && s.length > spec.max_length)
                errors.push(`${path}: length > ${spec.max_length}`);
            if (spec.one_of && !spec.one_of.includes(s))
                errors.push(`${path}: must be one of ${spec.one_of.join(",")}`);
            return s;
        }
        case "number":
        case "integer": {
            if (actual !== "number" || Number.isNaN(value as number)) {
                errors.push(`${path}: expected number, got ${actual}`);
                return value;
            }
            const n = value as number;
            if (spec.type === "integer" && !Number.isInteger(n))
                errors.push(`${path}: expected integer`);
            if (spec.min !== undefined && n < spec.min)
                errors.push(`${path}: < ${spec.min}`);
            if (spec.max !== undefined && n > spec.max)
                errors.push(`${path}: > ${spec.max}`);
            return n;
        }
        case "boolean":
            if (actual !== "boolean") {
                errors.push(`${path}: expected boolean, got ${actual}`);
            }
            return value;
        case "array": {
            if (actual !== "array") {
                errors.push(`${path}: expected array, got ${actual}`);
                return value;
            }
            const arr = value as unknown[];
            if (spec.min_items !== undefined && arr.length < spec.min_items)
                errors.push(`${path}: array length < ${spec.min_items}`);
            if (spec.max_items !== undefined && arr.length > spec.max_items)
                errors.push(`${path}: array length > ${spec.max_items}`);
            if (spec.items) {
                for (let i = 0; i < arr.length; i++) {
                    arr[i] = check_field(
                        `${path}[${i}]`,
                        arr[i],
                        spec.items,
                        errors,
                    );
                }
            }
            return arr;
        }
        case "object": {
            if (actual !== "object") {
                errors.push(`${path}: expected object, got ${actual}`);
                return value;
            }
            if (spec.fields) {
                return run_schema(
                    path,
                    value as Record<string, unknown>,
                    spec.fields,
                    errors,
                );
            }
            return value;
        }
    }
}

function run_schema(
    path: string,
    input: Record<string, unknown>,
    spec: schema,
    errors: string[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, fs] of Object.entries(spec)) {
        const sub_path = path ? `${path}.${key}` : key;
        const v = input ? input[key] : undefined;
        const cleaned = check_field(sub_path, v, fs, errors);
        if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
}

export function validate<T = Record<string, unknown>>(
    input: unknown,
    spec: schema,
): validate_result<T> {
    const errors: string[] = [];
    if (input === null || input === undefined) {
        const data = run_schema("", {}, spec, errors);
        return { ok: errors.length === 0, data: data as unknown as T, errors };
    }
    if (typeof input !== "object" || Array.isArray(input)) {
        errors.push("body: expected object");
        return { ok: false, data: input as unknown as T, errors };
    }
    const data = run_schema("", input as Record<string, unknown>, spec, errors);
    return { ok: errors.length === 0, data: data as unknown as T, errors };
}

/**
 * RFC 7807 (Problem Details for HTTP APIs) formatter.
 */
export function send_problem(
    res: any,
    status: number,
    title: string,
    detail?: string,
    type: string = "about:blank",
    instance?: string,
    additional?: Record<string, any>
) {
    res.status(status).json({
        type,
        title,
        status,
        detail,
        instance: instance || res.req?.url,
        ...additional
    });
}

/**
 * Helper: validate and 400-respond on failure (RFC 7807).
 */
export function parse_or_400<T = Record<string, unknown>>(
    res: any,
    input: unknown,
    spec: schema,
): T | null {
    const r = validate<T>(input, spec);
    if (!r.ok) {
        send_problem(
            res,
            400,
            "Invalid Input",
            "The request body failed validation checks.",
            "https://openmemory.dev/errors/invalid_input",
            undefined,
            { validation_errors: r.errors }
        );
        return null;
    }
    return r.data;
}
