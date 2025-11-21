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
      // append a user message and rely on the chat hook to stream or handle
      // the assistant response according to SDK behaviour
      c.append?.({ role: 'user' as const, content: text });
      // if the SDK provides a submit/handleSubmit call we can call it as a fallback
      if (typeof c.submit === 'function') {
        c.submit(text);
      }
    },
  };
}
