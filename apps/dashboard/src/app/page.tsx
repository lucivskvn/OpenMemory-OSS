import { DashboardView } from "@/components/DashboardView";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Dashboard | OpenMemory",
    description: "Real-time visualization of OpenMemory neural graph and activity.",
};

export default function Home() {
    return <DashboardView />;
}
