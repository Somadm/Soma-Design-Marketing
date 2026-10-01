import type { DbClient } from "../db/pool.js";
import { integrationStates } from "../integrations/registry.js";

export interface ScriptLine {
  t: string;
  part: string;
  line: string;
}

export async function listVideoJobs(db: DbClient) {
  const { rows } = await db.query("SELECT id, title, voiceover_id, due_at, sample, updated_at FROM sagal.video_jobs ORDER BY updated_at DESC");
  return rows;
}

export async function createVideoJob(
  db: DbClient,
  v: { title: string; ideaId?: number | null; script: ScriptLine[]; platformCaptions?: Record<string, string>; dueAt?: Date | null },
  sample = false,
) {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO sagal.video_jobs (title, idea_id, script, platform_captions, due_at, sample) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [v.title, v.ideaId ?? null, JSON.stringify(v.script.slice(0, 30)), JSON.stringify(v.platformCaptions ?? {}), v.dueAt ?? null, sample],
  );
  return rows[0].id;
}

/**
 * Video studio state, derived from what actually exists. HeyGen and Captions are
 * never "rendering" or "done" unless a real job or a file Sabah uploaded says so.
 */
export async function getVideoJob(db: DbClient, id: number) {
  const { rows } = await db.query(
    `SELECT v.*, vo.filename AS vo_filename, vo.size_bytes AS vo_size, vo.created_at AS vo_uploaded_at,
       r.filename AS render_filename, f.filename AS final_filename
     FROM sagal.video_jobs v
     LEFT JOIN sagal.voiceovers vo ON vo.id = v.voiceover_id
     LEFT JOIN sagal.media_assets r ON r.id = v.render_asset_id
     LEFT JOIN sagal.media_assets f ON f.id = v.final_asset_id
     WHERE v.id = $1`,
    [id],
  );
  const job = rows[0];
  if (!job) return null;
  const states = await integrationStates(db);
  const hgConnected = states.heygen?.state === "connected";
  const caConnected = states.captions?.state === "connected";
  const heygen = !job.voiceover_id
    ? "waiting"
    : job.render_asset_id
      ? "render_uploaded"
      : job.heygen?.manualDone
        ? "made_by_hand"
        : hgConnected
          ? "ready"
          : "manual";
  const captions = job.final_asset_id ? "final_uploaded" : job.captions_edit?.manualDone ? "handed_off" : !job.render_asset_id ? "waiting" : caConnected ? "ready" : "manual";
  return { ...job, heygenState: heygen, captionsState: captions, heygenConnection: states.heygen?.state, captionsConnection: states.captions?.state };
}

export async function setHandoffDone(db: DbClient, id: number, which: "heygen" | "captions", done: boolean) {
  const col = which === "heygen" ? "heygen" : "captions_edit";
  await db.query(`UPDATE sagal.video_jobs SET ${col} = ${col} || jsonb_build_object('manualDone', $2::boolean), updated_at = now() WHERE id = $1`, [id, done]);
}
