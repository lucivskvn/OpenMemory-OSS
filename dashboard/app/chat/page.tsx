"use client"

export const dynamic = 'force-dynamic'

import nextDynamic from 'next/dynamic'

const ChatInner = nextDynamic(() => import('./ChatInner'), { ssr: false })

export default function Page() {
    return <ChatInner />
}
