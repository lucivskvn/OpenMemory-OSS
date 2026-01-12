import Link from "next/link";
import { FileQuestion, ArrowLeft } from "lucide-react";

export default function NotFound() {
    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background p-4 text-center">
            <div className="rounded-full bg-primary/10 p-4 mb-4">
                <FileQuestion className="w-12 h-12 text-primary" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight mb-2">Page Not Found</h2>
            <p className="text-muted-foreground mb-8">
                Could not find the requested resource. It might have been moved or deleted.
            </p>
            <Link
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors font-medium"
            >
                <ArrowLeft className="w-4 h-4" />
                Return Home
            </Link>
        </div>
    );
}
