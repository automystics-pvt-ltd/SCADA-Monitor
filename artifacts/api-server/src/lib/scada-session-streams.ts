import type { Response } from "express";

const sessionStreams = new Map<string, Set<Response>>();
const sessionUsers = new Map<string, string>();
const userSessions = new Map<string, Set<string>>();

function removeSessionUserIndex(sid: string) {
  const userId = sessionUsers.get(sid);
  if (!userId) return;
  sessionUsers.delete(sid);
  const sessions = userSessions.get(userId);
  if (!sessions) return;
  sessions.delete(sid);
  if (sessions.size === 0) userSessions.delete(userId);
}

export function registerScadaSessionStream(sid: string, userId: string, response: Response) {
  const streams = sessionStreams.get(sid) ?? new Set<Response>();
  streams.add(response);
  sessionStreams.set(sid, streams);
  sessionUsers.set(sid, userId);
  const sessions = userSessions.get(userId) ?? new Set<string>();
  sessions.add(sid);
  userSessions.set(userId, sessions);
}

export function unregisterScadaSessionStream(sid: string, response: Response) {
  const streams = sessionStreams.get(sid);
  if (!streams) return;
  streams.delete(response);
  if (streams.size === 0) {
    sessionStreams.delete(sid);
    removeSessionUserIndex(sid);
  }
}

export function closeScadaSessionStreams(sid: string) {
  const streams = sessionStreams.get(sid);
  if (!streams) return;
  sessionStreams.delete(sid);
  removeSessionUserIndex(sid);
  for (const response of streams) {
    if (response.writableEnded) continue;
    response.write("event: auth-expired\ndata: {\"message\":\"SCADA session expired.\"}\n\n");
    response.end();
  }
}

export function closeScadaUserStreams(userId: string) {
  for (const sid of [...(userSessions.get(userId) ?? [])]) {
    closeScadaSessionStreams(sid);
  }
}