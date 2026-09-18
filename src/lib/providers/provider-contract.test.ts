import { describe, expect, it } from "vitest";

import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
} from "@/lib/types";

function createRequest(model: string): ChatRequest {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are OmniAgent.",
    },
    {
      role: "user",
      content: "Say hello.",
    },
  ];

  return {
    model,
    messages,
  };
}

async function collect(
  provider: ChatProvider,
  request: ChatRequest,
): Promise<string> {
  let output = "";

  for await (const chunk of provider.stream(request)) {
    expect(typeof chunk).toBe("string");
    output += chunk;
  }

  return output;
}

describe("provider contract", () => {
  it("defines valid provider identity", async () => {
    const provider: ChatProvider = {
      id: "ollama",
      label: "Test Provider",
      execution: "local",
      isConfigured: () => true,

      async *stream() {
        yield "hello";
        yield " world";
      },
    };

    expect(provider.id).toBe("ollama");
    expect(provider.label).toBeTruthy();
    expect(provider.execution).toBe("local");

    const output = await collect(
      provider,
      createRequest("test-model"),
    );

    expect(output).toBe("hello world");
  });

  it("preserves chunk order", async () => {
    const provider: ChatProvider = {
      id: "ollama",
      label: "Ordered Test Provider",
      execution: "local",
      isConfigured: () => true,

      async *stream() {
        yield "A";
        yield "B";
        yield "C";
      },
    };

    const output = await collect(
      provider,
      createRequest("test-model"),
    );

    expect(output).toBe("ABC");
  });

  it("allows an empty completion", async () => {
    const provider: ChatProvider = {
      id: "ollama",
      label: "Empty Test Provider",
      execution: "local",
      isConfigured: () => true,

      async *stream() {
        return;
      },
    };

    const output = await collect(
      provider,
      createRequest("test-model"),
    );

    expect(output).toBe("");
  });

  it("propagates provider errors", async () => {
    const provider: ChatProvider = {
      id: "ollama",
      label: "Failing Test Provider",
      execution: "local",
      isConfigured: () => true,

      async *stream() {
        throw new Error("synthetic provider failure");
      },
    };

    await expect(
      collect(
        provider,
        createRequest("test-model"),
      ),
    ).rejects.toThrow("synthetic provider failure");
  });

  it("does not require a provider API key for local providers", () => {
    const provider: ChatProvider = {
      id: "ollama",
      label: "Local Provider",
      execution: "local",
      isConfigured: () => true,

      async *stream() {
        yield "local";
      },
    };

    expect(provider.isConfigured()).toBe(true);
    expect(provider.execution).toBe("local");
  });
});
