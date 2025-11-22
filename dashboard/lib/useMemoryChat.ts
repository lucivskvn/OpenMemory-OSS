import { useChat, type UseChatOptions, UIMessage } from '@ai-sdk/react';

export function useMemoryChat(
  options: UseChatOptions<UIMessage> & { api?: string },
) {
  const chat = useChat(options);

  const c = chat as any;

  return {
    messages: c.messages,
    // Backwards-compat: expose input & handlers when available; otherwise
    // provide safe defaults for UI components and tests that expect them.
    input: (c.input as string) ?? '',
    handleInputChange: c.handleInputChange ?? (() => {}),
    handleSubmit: c.handleSubmit ?? (() => {}),
    // useChat doesn't expose a guaranteed `input`/`handleInputChange` shape
    // across SDK versions — consumers (ChatInner) manage local input state.
    isLoading: c.isLoading,
    error: c.error,
    status: c.status,
    sendMessage: (text: string) => {
      if (typeof c.append === 'function') {
        c.append({ role: 'user' as const, content: text });
      } else if (typeof c.submit === 'function') {
        c.submit(text);
      } else {
        console.error('useMemoryChat: No sendMessage implementation available');
      }
    },
  };
}
