import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { DbClient } from "../db/pool.js";
import { storageFilename, type Storages } from "../storage/storage.js";

export const MEDIA_KINDS = ["image", "pdf", "footage", "audio_reference", "conversation_audio", "brand", "portrait", "inspiration", "render", "export"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const ACCEPT: Record<MediaKind, RegExp> = {
  image: /^image\//,
  pdf: /^application\/pdf$/,
  footage: /^video\//,
  audio_reference: /^audio\//,
  conversation_audio: /^audio\//,
  brand: /^image\//,
  portrait: /^image\//,
  inspiration: /^image\//,
  render: /^video\//,
  export: /^(video|image)\/|^application\/pdf$/,
};

export class UploadError extends Error {}

const keyFor = (prefix: string, filename: string) =>
  `${prefix}/${new Date().toISOString().slice(0, 10)}/${randomBytes(8).toString("hex")}-${storageFilename(filename)}`;

/**
 * Stores an upload in the media area. Voice notes (Talk to Sagal) go under
 * conversation-audio/; everything else under media/<kind>/. Sabah's voiceovers never
 * come through here (see saveVoiceover).
 */
export async function saveMedia(
  db: DbClient,
  storages: Storages,
  kind: MediaKind,
  file: { filename: string; mimetype: string; stream: Readable | Buffer },
  opts: { doNotPublish?: boolean; label?: string } = {},
) {
  if (!ACCEPT[kind]?.test(file.mimetype)) throw new UploadError(`That file type (${file.mimetype}) doesn't fit here.`);
  const key = keyFor(kind === "conversation_audio" ? "conversation-audio" : `media/${kind.replace(/_/g, "-")}`, file.filename);
  const { size } = await storages.media.put(key, file.stream, file.mimetype);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sagal.media_assets (kind, storage_key, filename, content_type, size_bytes, label, do_not_publish)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [kind, key, file.filename.slice(0, 200), file.mimetype, size, opts.label ?? null, opts.doNotPublish ?? kind === "conversation_audio"],
  );
  return { id: rows[0].id, kind, filename: file.filename, size };
}

/** Sabah's own voiceover: separate table, separate storage area (voiceovers/). */
export async function saveVoiceover(db: DbClient, storages: Storages, file: { filename: string; mimetype: string; stream: Readable | Buffer }) {
  if (!/^audio\//.test(file.mimetype)) throw new UploadError("A voiceover must be an audio file (.m4a, .mp3 or .wav).");
  const key = keyFor("voiceovers", file.filename);
  const { size } = await storages.voiceovers.put(key, file.stream, file.mimetype);
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO sagal.voiceovers (storage_key, filename, content_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id",
    [key, file.filename.slice(0, 200), file.mimetype, size],
  );
  return { id: rows[0].id, filename: file.filename, size };
}

export async function assetLink(db: DbClient, storages: Storages, id: number): Promise<string | null> {
  const { rows } = await db.query<{ storage_key: string; filename: string }>("SELECT storage_key, filename FROM sagal.media_assets WHERE id = $1", [id]);
  return rows[0] ? storages.media.signedUrl(rows[0].storage_key, storageFilename(rows[0].filename)) : null;
}

export async function voiceoverLink(db: DbClient, storages: Storages, id: number): Promise<string | null> {
  const { rows } = await db.query<{ storage_key: string; filename: string }>("SELECT storage_key, filename FROM sagal.voiceovers WHERE id = $1", [id]);
  return rows[0] ? storages.voiceovers.signedUrl(rows[0].storage_key, storageFilename(rows[0].filename)) : null;
}
