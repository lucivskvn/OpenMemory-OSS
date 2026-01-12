import { GraphView } from "@/components/GraphView";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Knowledge Graph | OpenMemory",
    description: "Deep dive into the neural adjacency map and relationship structures.",
};

export default function GraphPage() {
    return <GraphView />;
}
