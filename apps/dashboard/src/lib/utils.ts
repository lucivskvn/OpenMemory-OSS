import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Standard utility for merging tailwind classes with conditional logic.
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
