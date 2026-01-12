"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCcw } from "lucide-react";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("Dashboard Error:", error);
    }, [error]);

    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background p-4 text-center">
            <div className="rounded-full bg-destructive/10 p-4 mb-4">
                <AlertCircle className="w-12 h-12 text-destructive" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-8 max-w-md">
                We encountered an unexpected error while loading the dashboard.
                {error.message && <span className="block mt-2 font-mono text-xs bg-muted/50 p-2 rounded">{error.message}</span>}
            </p>
            <button
                onClick={() => reset()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
            >
                <RefreshCcw className="w-4 h-4" />
                Try again
            </button>
        </div>
    );
}
