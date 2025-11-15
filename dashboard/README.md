# Dashboard

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
bun run dev
# or
# npm run dev
# or
# yarn dev
# or
# pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load a font.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Admin Key (server-side)

- For server-to-server admin calls (e.g., exporting telemetry), do not expose admin keys to the browser. Set `OM_ADMIN_API_KEY_PLAIN` as a server-only secret (for example, in Vercel Environments) rather than a public env var. The backend validates admin keys using `OM_ADMIN_API_KEY` (hashed) — set that value in your backend environment from the output of `backend/scripts/hash-api-key.ts`.

Example (Vercel):

1. Add `OM_ADMIN_API_KEY` to the backend environment for your OpenMemory server (hashed argon2 value).
2. Add `OM_ADMIN_API_KEY_PLAIN` to the dashboard server environment (server-only) containing the plaintext admin key to enable server-to-server admin calls.
