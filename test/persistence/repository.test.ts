import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteRepository } from "../../src/persistence/repository.ts";
import { Migrator } from "../../src/persistence/migrator.ts";
import type { SessionId, TurnId, MessageId } from "../../src/types/persistence.ts";

describe("SQLiteRepository", () => {
  let db: Database;
  let repo: SQLiteRepository;

  beforeEach(async () => {
    db = new Database(":memory:");
    // Run migrations to create schema
    const sql = await Bun.file(
      new URL("../../src/persistence/migrations/001_initial.sql", import.meta.url)
    ).text();
    const migrator = new Migrator(db, [{ name: "001_initial.sql", sql }]);
    migrator.migrate();
    repo = new SQLiteRepository(db);
  });

  describe("createSession / getSession", () => {
    it("should create and retrieve a session", () => {
      const session = repo.createSession("/home/user/project");
      expect(session.workspacePath).toBe("/home/user/project");
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBeGreaterThan(0);

      const retrieved = repo.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(session.id);
      expect(retrieved?.workspacePath).toBe("/home/user/project");
    });

    it("should return null for non-existent session", () => {
      const result = repo.getSession("nonexistent" as SessionId);
      expect(result).toBeNull();
    });
  });

  describe("addTurn / getTurnsBySession", () => {
    it("should add turns to a session and retrieve them", () => {
      const session = repo.createSession("/workspace");
      const turn1 = repo.addTurn(session.id, "hello", "stop");
      const turn2 = repo.addTurn(session.id, "world", "max_tokens");

      expect(turn1.sessionId).toBe(session.id);
      expect(turn1.prompt).toBe("hello");
      expect(turn1.stopReason).toBe("stop");

      const turns = repo.getTurnsBySession(session.id);
      expect(turns.length).toBe(2);
      expect(turns[0].prompt).toBe("hello");
      expect(turns[1].prompt).toBe("world");
    });

    it("should return empty array for session with no turns", () => {
      const session = repo.createSession("/empty");
      const turns = repo.getTurnsBySession(session.id);
      expect(turns).toEqual([]);
    });

    it("should return empty array for non-existent session", () => {
      const turns = repo.getTurnsBySession("nonexistent" as SessionId);
      expect(turns).toEqual([]);
    });
  });

  describe("addMessage / getMessagesByTurn", () => {
    it("should add messages to a turn and retrieve them", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "prompt", "stop");

      const msg1 = repo.addMessage(turn.id, "user", "hi");
      const msg2 = repo.addMessage(turn.id, "assistant", "hello");

      expect(msg1.role).toBe("user");
      expect(msg1.content).toBe("hi");
      expect(msg1.turnId).toBe(turn.id);

      const messages = repo.getMessagesByTurn(turn.id);
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("should return empty array for turn with no messages", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "p", "s");
      const messages = repo.getMessagesByTurn(turn.id);
      expect(messages).toEqual([]);
    });

    it("should return empty array for non-existent turn", () => {
      const messages = repo.getMessagesByTurn("nonexistent" as TurnId);
      expect(messages).toEqual([]);
    });

    it("should reject invalid role via CHECK constraint", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "prompt", "stop");

      expect(() => {
        repo.addMessage(turn.id, "invalid_role" as "user", "hi");
      }).toThrow();
    });
  });

  describe("addToolCall / getToolCallsByTurn", () => {
    it("should add tool calls to a turn and retrieve them", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "prompt", "stop");

      const tc = repo.addToolCall(turn.id, "read_file", '{"path": "/x"}', "content");
      expect(tc.toolName).toBe("read_file");
      expect(tc.arguments).toBe('{"path": "/x"}');
      expect(tc.result).toBe("content");
      expect(tc.turnId).toBe(turn.id);

      const calls = repo.getToolCallsByTurn(turn.id);
      expect(calls.length).toBe(1);
      expect(calls[0].toolName).toBe("read_file");
    });

    it("should allow null result", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "prompt", "stop");
      const tc = repo.addToolCall(turn.id, "search", "{}", null);
      expect(tc.result).toBeNull();
    });

    it("should return empty array for non-existent turn", () => {
      const calls = repo.getToolCallsByTurn("nonexistent" as TurnId);
      expect(calls).toEqual([]);
    });
  });

  describe("addSummary / getSummariesBySession", () => {
    it("should add summaries and retrieve by session", () => {
      const session = repo.createSession("/ws");
      const turn = repo.addTurn(session.id, "prompt", "stop");
      const msg1 = repo.addMessage(turn.id, "user", "hi");
      const msg2 = repo.addMessage(turn.id, "assistant", "hello");

      const summary = repo.addSummary(
        session.id,
        "User greeted assistant",
        msg1.id,
        msg2.id
      );

      expect(summary.sessionId).toBe(session.id);
      expect(summary.content).toBe("User greeted assistant");
      expect(summary.originalMessageFromId).toBe(msg1.id);
      expect(summary.originalMessageToId).toBe(msg2.id);

      const summaries = repo.getSummariesBySession(session.id);
      expect(summaries.length).toBe(1);
      expect(summaries[0].content).toBe("User greeted assistant");
    });

    it("should return empty array for session with no summaries", () => {
      const session = repo.createSession("/ws");
      const summaries = repo.getSummariesBySession(session.id);
      expect(summaries).toEqual([]);
    });

    it("should return empty array for non-existent session", () => {
      const summaries = repo.getSummariesBySession("nonexistent" as SessionId);
      expect(summaries).toEqual([]);
    });
  });

  describe("foreign key constraints", () => {
    it("should enforce foreign keys for addTurn", () => {
      expect(() => {
        repo.addTurn("invalid-id" as SessionId, "prompt", "stop");
      }).toThrow();
    });

    it("should enforce foreign keys for addMessage", () => {
      expect(() => {
        repo.addMessage("invalid-id" as TurnId, "user", "hi");
      }).toThrow();
    });

    it("should enforce foreign keys for addToolCall", () => {
      expect(() => {
        repo.addToolCall("invalid-id" as TurnId, "read_file", "{}", null);
      }).toThrow();
    });

    it("should enforce foreign keys for addSummary", () => {
      expect(() => {
        repo.addSummary(
          "invalid-id" as SessionId,
          "summary",
          "msg1" as MessageId,
          "msg2" as MessageId
        );
      }).toThrow();
    });
  });

  describe("close", () => {
    it("should close the database connection", () => {
      const session = repo.createSession("/ws");
      repo.close();
      expect(() => repo.getSession(session.id)).toThrow();
    });
  });
});
