import { Database } from "bun:sqlite";
import type {
  Session,
  SessionId,
  Turn,
  TurnId,
  MessageRow,
  MessageId,
  ToolCallRow,
  ToolCallId,
  SummaryRow,
  SummaryId,
} from "../types/persistence.ts";

function generateId(): string {
  return crypto.randomUUID();
}

export class SQLiteRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = -64000");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  createSession(workspacePath: string): Session {
    const id = generateId() as SessionId;
    const now = Date.now();

    this.db
      .query(
        "INSERT INTO sessions (id, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run(id, workspacePath, now, now);

    return {
      id,
      workspacePath,
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: SessionId): Session | null {
    return this.db
      .query<Session>(
        "SELECT id, workspace_path as workspacePath, created_at as createdAt, updated_at as updatedAt FROM sessions WHERE id = ?"
      )
      .get(id);
  }

  addTurn(sessionId: SessionId, prompt: string, stopReason: string): Turn {
    const id = generateId() as TurnId;
    const now = Date.now();

    this.db
      .query(
        "INSERT INTO turns (id, session_id, prompt, stop_reason, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, sessionId, prompt, stopReason, now);

    return {
      id,
      sessionId,
      prompt,
      stopReason,
      createdAt: now,
    };
  }

  getTurnsBySession(sessionId: SessionId): Turn[] {
    return this.db
      .query<Turn>(
        "SELECT id, session_id as sessionId, prompt, stop_reason as stopReason, created_at as createdAt FROM turns WHERE session_id = ? ORDER BY created_at"
      )
      .all(sessionId);
  }

  addMessage(
    turnId: TurnId,
    role: MessageRow["role"],
    content: string
  ): MessageRow {
    const id = generateId() as MessageId;
    const now = Date.now();

    this.db
      .query(
        "INSERT INTO messages (id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, turnId, role, content, now);

    return {
      id,
      turnId,
      role,
      content,
      createdAt: now,
    };
  }

  getMessagesByTurn(turnId: TurnId): MessageRow[] {
    return this.db
      .query<MessageRow>(
        "SELECT id, turn_id as turnId, role, content, created_at as createdAt FROM messages WHERE turn_id = ? ORDER BY created_at"
      )
      .all(turnId);
  }

  addToolCall(
    turnId: TurnId,
    toolName: string,
    args: string,
    result: string | null
  ): ToolCallRow {
    const id = generateId() as ToolCallId;
    const now = Date.now();

    this.db
      .query(
        "INSERT INTO tool_calls (id, turn_id, tool_name, arguments, result, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, turnId, toolName, args, result, now);

    return {
      id,
      turnId,
      toolName,
      arguments: args,
      result,
      createdAt: now,
    };
  }

  getToolCallsByTurn(turnId: TurnId): ToolCallRow[] {
    return this.db
      .query<ToolCallRow>(
        "SELECT id, turn_id as turnId, tool_name as toolName, arguments, result, created_at as createdAt FROM tool_calls WHERE turn_id = ? ORDER BY created_at"
      )
      .all(turnId);
  }

  addSummary(
    sessionId: SessionId,
    content: string,
    originalMessageFromId: MessageId,
    originalMessageToId: MessageId
  ): SummaryRow {
    const now = Date.now();

    const result = this.db
      .query(
        "INSERT INTO summaries (session_id, content, original_message_from_id, original_message_to_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(sessionId, content, originalMessageFromId, originalMessageToId, now);

    const id = Number(result.lastInsertRowid) as SummaryId;

    return {
      id,
      sessionId,
      content,
      originalMessageFromId,
      originalMessageToId,
      createdAt: now,
    };
  }

  getSummariesBySession(sessionId: SessionId): SummaryRow[] {
    return this.db
      .query<SummaryRow>(
        "SELECT id, session_id as sessionId, content, original_message_from_id as originalMessageFromId, original_message_to_id as originalMessageToId, created_at as createdAt FROM summaries WHERE session_id = ? ORDER BY created_at"
      )
      .all(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
