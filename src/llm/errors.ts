/**
 * Shared error normalization for LLM provider SDKs.
 */

function hasStatus(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof (error as Record<string, unknown>).status === "number"
  );
}

function isConnectionError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("enotfound") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout")
  );
}

export function normalizeLLMError(error: unknown, host?: string, provider?: string): Error {
  if (error instanceof Error) {
    if (isConnectionError(error)) {
      const name = provider ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} server` : "Server";
      const hostMsg = host ? ` at ${host}` : "";
      return new Error(
        `${name} not available${hostMsg}. Is it running?`,
      );
    }

    if (hasStatus(error)) {
      const status = error.status;

      if (status === 401) {
        return new Error("Authentication failed: check your API key");
      }
      if (status === 429) {
        return new Error("Rate limit exceeded: please retry later");
      }
      return new Error(`LLM API error (${status}): please check your request`);
    }
    return new Error(`LLM request failed: ${error.message}`);
  }

  return new Error(`LLM request failed: ${String(error)}`);
}
