import { ConnectorSettings } from "@/components/ConnectorSettings";
import { SystemConfig } from "@/components/SystemConfig";
import { Settings as SettingsIcon, Cpu, Globe } from "lucide-react";

export default function SettingsPage() {
    return (
        <div className="flex flex-col gap-12 animate-in fade-in duration-700 pb-20">
            <header className="flex items-center gap-5">
                <div className="p-3 bg-white/5 rounded-2xl text-zinc-400 shadow-inner">
                    <SettingsIcon size={32} strokeWidth={1.5} />
                </div>
                <div>
                    <h1 className="text-3xl font-black tracking-tight text-white italic underline decoration-primary/20 underline-offset-8">Control Center</h1>
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-2">
                        Systems & Neural Orchestration
                    </p>
                </div>
            </header>

            <div className="space-y-16">
                {/* Neural Configuration Section */}
                <section className="space-y-8">
                    <div className="flex items-center gap-4 px-2">
                        <div className="p-2 bg-primary/10 rounded-lg text-primary">
                            <Cpu size={20} />
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white tracking-widest uppercase italic">Neural Architecture</h2>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">LLM Provider & Model Management</p>
                        </div>
                    </div>
                    <SystemConfig />
                </section>

                <hr className="border-white/5" />

                {/* External Connectors Section */}
                <section className="space-y-8">
                    <div className="flex items-center gap-4 px-2">
                        <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                            <Globe size={20} />
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white tracking-widest uppercase italic">External Connectors</h2>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Data Sources & Pipelines</p>
                        </div>
                    </div>
                    <div className="glass-card border-white/5 p-2">
                        <ConnectorSettings />
                    </div>
                </section>
            </div>
        </div>
    );
}
