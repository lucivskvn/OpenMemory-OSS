export interface Memory {
    id: string;
    content: string;
    salience?: number;
    primary_sector: string;
    tags?: string[];
    metadata?: Record<string, any>;
    decay_lambda?: number;
    version?: number;
    created_at?: number;
    updated_at?: number;
    last_seen_at?: number;
    compressed_vec?: string;
    mean_dim?: number;
    user_id?: string;
}

export interface Pattern {
    id?: string;
    description: string;
    frequency?: number;
    context?: string;
    confidence?: number;
    metadata?: Record<string, any>;
}

export interface SessionConfig {
    user_id: string;
    project_name: string;
    ide_name: string;
}

export interface EventData {
    event_type: string;
    file_path: string;
    language: string;
    content?: string;
    metadata?: any;
    timestamp?: string;
}

export interface ApiErrorResponse {
    error: {
        code: string;
        message: string;
        details?: any;
    };
}
