import { useEffect, useRef } from "react";
import { client } from "../api";
import { OpenMemoryEvent } from "openmemory-js/client";

export function useMemoryStream(
    onEvent: (event: OpenMemoryEvent) => void,
    dependencies: any[] = []
) {
    const onEventRef = useRef(onEvent);

    useEffect(() => {
        onEventRef.current = onEvent;
    }, [onEvent]);

    useEffect(() => {
        const cleanup = client.listen((evt: OpenMemoryEvent) => {
            if (onEventRef.current) {
                onEventRef.current(evt);
            }
        });

        return () => {
            cleanup();
        };
    }, dependencies);
}
