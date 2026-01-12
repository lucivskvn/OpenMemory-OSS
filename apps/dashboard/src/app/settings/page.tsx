import { ConnectorSettings } from "@/components/ConnectorSettings";
import { Settings as SettingsIcon } from "lucide-react";

export default function SettingsPage() {
    return (
        <div className="flex flex-col gap-10 animate-in fade-in duration-700">
            <header className="flex items-center gap-5">
                <div className="p-3 bg-white/5 rounded-2xl text-zinc-400 shadow-inner">
                    <SettingsIcon size={32} strokeWidth={1.5} />
                </div>
                <div>
                    <h1 className="text-3xl font-black tracking-tight text-white italic">Control Center</h1>
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">
                        Systems & Integrations
                    </p>
                </div>
            </header>

            <section className="glass-card border-primary/5">
                <div className="mb-8">
                    <h2 className="text-xl font-bold text-white mb-2">Neural Connectors</h2>
                    <p className="text-sm text-zinc-500 font-medium">Manage external data sources and automated ingestion pipelines.</p>
                </div>
                <ConnectorSettings />
            </section>
        </div>
    );
}
