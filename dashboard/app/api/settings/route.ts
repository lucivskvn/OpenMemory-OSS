import { NextResponse } from 'next/server'
import path from 'path'

const ENV_PATH = path.resolve(process.cwd(), '../.env')

export async function GET() {
    try {
        const file = Bun.file(ENV_PATH);
        if (!(await file.exists())) {
            return NextResponse.json({
                exists: false,
                settings: {}
            })
        }

        const content = await file.text();
        const settings: Record<string, string> = {}

        // Simple parse for display
        content.split('\n').forEach(line => {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match) {
                const k = match[1].trim();
                const v = match[2].trim();
                if (k) settings[k] = v;
            }
        });

        // Mask sensitive keys
        const sensitive = ["API_KEY", "SECRET", "PASSWORD", "KEY_ID", "TOKEN"];
        for (const k of Object.keys(settings)) {
             if (sensitive.some(s => k.toUpperCase().includes(s))) {
                 if (settings[k] && settings[k].length > 0) settings[k] = "***";
             }
        }

        return NextResponse.json({
            exists: true,
            settings
        })
    } catch (e: any) {
        console.error('[Settings API] read error:', e)
        return NextResponse.json(
            { error: 'internal', message: e.message },
            { status: 500 }
        )
    }
}

export async function POST(request: Request) {
    try {
        const updates = await request.json() as Record<string, string>;

        if (!updates || typeof updates !== 'object') {
            return NextResponse.json(
                { error: 'invalid_body' },
                { status: 400 }
            )
        }

        let content = ''
        const envFile = Bun.file(ENV_PATH);
        if (await envFile.exists()) {
            content = await envFile.text();
        } else {
            const examplePath = path.resolve(process.cwd(), '../.env.example')
            const exampleFile = Bun.file(examplePath);
            if (await exampleFile.exists()) {
                content = await exampleFile.text();
            }
        }

        const lines = content.split('\n');
        const newLines: string[] = [];
        const seenKeys = new Set<string>();

        // Update existing lines while preserving comments
        for (const line of lines) {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                if (updates[key] !== undefined) {
                    // Ignore masked values to prevent overwriting with ***
                    if (updates[key] !== "***" && updates[key] !== "******") {
                         newLines.push(`${key}=${updates[key]}`);
                    } else {
                         newLines.push(line); // Preserve original
                    }
                    seenKeys.add(key);
                } else {
                    newLines.push(line);
                }
            } else {
                newLines.push(line);
            }
        }

        // Append new keys
        for (const [key, val] of Object.entries(updates)) {
             if (!seenKeys.has(key) && val !== "***" && val !== "******") {
                 newLines.push(`${key}=${val}`);
             }
        }

        await Bun.write(ENV_PATH, newLines.join('\n'));

        return NextResponse.json({
            ok: true,
            message: 'Settings saved. Restart the backend to apply changes.'
        })
    } catch (e: any) {
        console.error('[Settings API] write error:', e)
        return NextResponse.json(
            { error: 'internal', message: e.message },
            { status: 500 }
        )
    }
}
