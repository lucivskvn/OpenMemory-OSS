export const Skeleton = ({ className }: { className?: string }) => (
    <div className={`animate-pulse bg-white/5 rounded-lg ${className}`} />
);

export const StatsSkeleton = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 bg-white/5 rounded-2xl animate-pulse" />
        ))}
    </div>
);

export const MemorySkeleton = () => (
    <div className="h-32 bg-white/5 rounded-xl animate-pulse" />
);
