import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "../components/Sidebar";
import { StatusIndicator } from "../components/StatusIndicator";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "OpenMemory Dashboard",
    description: "Advanced AI Memory Management",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className={inter.className}>
                <div className="flex h-screen overflow-hidden">
                    <Sidebar />

                    {/* Main Content */}
                    <main className="flex-1 overflow-y-auto relative">
                        <header className="glass-header">
                            <h1 className="text-lg font-medium">System Overview</h1>
                            <div className="flex items-center gap-4">
                                <StatusIndicator />
                            </div>
                        </header>
                        <div className="p-8">
                            {children}
                        </div>
                    </main>
                </div>
                <Toaster richColors position="top-right" />
            </body>
        </html>
    );
}
