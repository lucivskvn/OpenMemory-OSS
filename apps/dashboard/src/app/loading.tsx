
export default function Loading() {
    return (
        <div className="flex h-screen w-full bg-background transition-colors duration-300">
            <div className="w-64 border-r border-border/50 bg-card/30 p-4 space-y-4">
                <div className="h-8 w-32 bg-muted/50 rounded animate-pulse" />
                <div className="space-y-2 pt-4">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="h-10 w-full bg-muted/30 rounded animate-pulse" />
                    ))}
                </div>
            </div>
            <main className="flex-1 p-8 space-y-8">
                <div className="flex justify-between items-center">
                    <div className="h-10 w-48 bg-muted/50 rounded animate-pulse" />
                    <div className="h-10 w-10 bg-muted/50 rounded-full animate-pulse" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="h-32 bg-muted/30 rounded-xl border border-border/50 animate-pulse" />
                    ))}
                </div>
                <div className="h-64 w-full bg-muted/30 rounded-xl border border-border/50 animate-pulse" />
            </main>
        </div>
    );
}
