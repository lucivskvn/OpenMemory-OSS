import { useChat, type UseChatOptions, UIMessage } from '@ai-sdk/react';

export function useMemoryChat(
  options: UseChatOptions<UIMessage> & { api?: string },
) {
  const chat = useChat(options);

  return {
    messages: chat.messages,
    input: chat.input,
    handleInputChange: chat.handleInputChange,
    handleSubmit: chat.handleSubmit,
    isLoading: chat.isLoading,
    error: chat.error,
    status: chat.status,
    sendMessage: (text: string) => {
      (chat as any).append({ role: 'user' as const, content: text });
    },
  };
}
