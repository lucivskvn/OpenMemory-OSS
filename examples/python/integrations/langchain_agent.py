import asyncio

try:
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder  # type: ignore[import]
    from langchain_core.runnables.history import RunnableWithMessageHistory  # type: ignore[import]
    from langchain_openai import ChatOpenAI  # type: ignore[import]

    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    ChatPromptTemplate = None  # type: ignore[assignment]
    MessagesPlaceholder = None  # type: ignore[assignment]
    RunnableWithMessageHistory = None  # type: ignore[assignment]
    ChatOpenAI = None  # type: ignore[assignment]

from openmemory.integrations.langchain import OpenMemoryChatMessageHistory

# ==================================================================================
# LANGCHAIN INTEGRATION
# ==================================================================================
# Demonstrates using OpenMemory as the persistent storage for a LangChain conversational agent.
# Uses `OpenMemoryChatMessageHistory` to automatically load/save history.
# ==================================================================================

chain_with_history = None

if (
    LANGCHAIN_AVAILABLE
    and ChatPromptTemplate
    and MessagesPlaceholder
    and RunnableWithMessageHistory
    and ChatOpenAI
):
    # 1. Setup Model
    model = ChatOpenAI(model="gpt-4o", temperature=0)

    # 2. Setup Prompt
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", "You are a helpful assistant with long-term memory."),
            MessagesPlaceholder(variable_name="history"),
            ("human", "{input}"),
        ]
    )

    # 3. Create Chain
    chain = prompt | model

    # 4. Wrap with History
    # This wrapper will:
    # - Call `history.messages` (or equivalent) to get context.
    # - Call `history.add_user_message` / `add_ai_message` after generation.
    from openmemory.client import Memory
    mem = Memory()
    chain_with_history = RunnableWithMessageHistory(
        chain,
        lambda session_id: OpenMemoryChatMessageHistory(memory=mem, user_id="user", session_id=session_id),  # type: ignore[arg-type]
        input_messages_key="input",
        history_messages_key="history",
    )

async def main():
    if not LANGCHAIN_AVAILABLE:
        print(
            "LangChain dependencies not installed. Install with: pip install langchain-openai langchain-core"
        )
        return
    if chain_with_history is None:
        print("LangChain chain failed to initialize")
        return

    session_id = "user_langchain_01"
    print(f"Starting chat session: {session_id}")

    # First turn
    print("\nUser: Hi, I'm Bob and I like Python.")
    await chain_with_history.ainvoke(  # type: ignore[union-attr]
        {"input": "Hi, I'm Bob and I like Python."},
        config={"configurable": {"session_id": session_id}},
    )
    # OpenMemoryChatMessageHistory handles async persistence in background (usually),
    # but since RunnableWithMessageHistory might sync call some parts, we ensure our
    # integration handles the loop correctly.

    # Second turn (New session instance, but same ID -> Recall)
    print("\nUser: What is my name?")
    response = await chain_with_history.ainvoke(  # type: ignore[union-attr]
        {"input": "What is my name?"},
        config={"configurable": {"session_id": session_id}},
    )
    print(f"AI: {response.content}")

if __name__ == "__main__":
    asyncio.run(main())
