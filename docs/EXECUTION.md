# Bounded execution

Agent and structured tasks default to a 180s wall-time budget; each tool attempt has a 15s deadline and model calls a 60s deadline. MCP discovery and CLI connection are bounded too. ToolExecutor retries transient reads or confirmed writes with a durable operation id, at most three attempts with bounded backoff. Previews, unknown tools and unkeyed writes are not retried. Validation failures, version conflicts, expired/cancelled approvals and unknown records are not transient.

ExecutionBudget propagates cancellation to MCP and model SDK requests; model retry waits stop on cancellation. A remote service may finish work after cancellation: this is why writes are idempotent. A disconnected stdio server is not automatically restarted; durable operations allow a new session to recover the result using the same operation id, but a new human approval is required for new mutations. Never replace an uncertain operation with a new id just to retry.

Tests inject temporary failure, a hanging cancellable tool, user cancellation, exhausted deadlines and a committed write whose response was lost. These are host-level fault-injection tests, not measurements of live provider uptime.
