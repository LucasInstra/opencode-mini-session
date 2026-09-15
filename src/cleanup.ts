import type { SessionInfo } from "@opencode/client";
import {
  MINI_SESSION_METADATA_KEY,
  STALE_MINI_SESSION_MAX_AGE_MS,
} from "./constants";
import type { TuiContext } from "./opencode";

export type MiniSessionLike = Pick<SessionInfo, "id" | "metadata" | "time">;

export function isMiniSession(session: Pick<SessionInfo, "metadata">) {
  return session.metadata?.[MINI_SESSION_METADATA_KEY] === true;
}

export function selectStaleMiniSessions(
  sessions: readonly MiniSessionLike[],
  now = Date.now(),
  maxAgeMs = STALE_MINI_SESSION_MAX_AGE_MS,
) {
  return sessions.filter(
    (session) =>
      isMiniSession(session) && now - session.time.created > maxAgeMs,
  );
}

/**
 * Removes ephemeral mini sessions that were left behind by a crashed or
 * force-closed client. Only sessions created by this plugin (metadata marker)
 * and older than `STALE_MINI_SESSION_MAX_AGE_MS` are removed, so live mini
 * sessions in other TUI instances are never touched.
 */
export async function cleanupStaleMiniSessions(
  ctx: Pick<TuiContext, "client">,
  now = Date.now(),
): Promise<number> {
  let sessions: readonly MiniSessionLike[] = [];
  try {
    const result = await ctx.client.session.list();
    if (Array.isArray(result.data)) sessions = result.data;
  } catch {
    return 0;
  }

  let removed = 0;
  for (const session of selectStaleMiniSessions(sessions, now)) {
    try {
      await ctx.client.session.remove({ sessionID: session.id });
      removed += 1;
    } catch {}
  }
  return removed;
}
