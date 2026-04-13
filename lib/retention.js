'use strict';

/**
 * Media retention policy.
 *
 * Photos: after RETENTION_MONTHS (default 6), generate a thumbnail and delete
 * the full-resolution original. The thumbnail is kept forever. All DB records
 * and metadata are kept forever regardless of age.
 *
 * Videos: after RETENTION_MONTHS, delete the original video file. The DB record
 * (metadata, duration, storagePath reference) is kept forever. No thumbnail is
 * generated for videos (would require ffmpeg).
 *
 * Set RETENTION_MONTHS=6 in env to change the policy without a code deploy.
 */

const prisma                          = require('./db');
const { saveFile, readFile, deleteFile } = require('./storage');

const RETENTION_MONTHS = parseInt(process.env.RETENTION_MONTHS || '6', 10);

/**
 * Run the retention pass. Called by cron on the 1st of each month.
 * @returns {Promise<{ photosProcessed: number, videosProcessed: number, errors: number }>}
 */
async function runRetention() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

  let photosProcessed = 0;
  let videosProcessed = 0;
  let errors = 0;

  // ── Photos ──────────────────────────────────────────────────────────────────
  const photos = await prisma.inspectionPhoto.findMany({
    where: {
      takenAt:         { lt: cutoff },
      originalDeleted: false,
    },
    select: { id: true, cloudinaryPublicId: true },
  });

  for (const photo of photos) {
    try {
      // Generate thumbnail via Sharp (lazy-loaded — not always in the dep tree)
      const sharp = require('sharp');
      const original = await readFile(photo.cloudinaryPublicId);
      const thumbBuffer = await sharp(original)
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 70, progressive: true })
        .toBuffer();

      // Save thumbnail next to original, under a thumbs/ prefix
      const thumbPath = `thumbs/${photo.cloudinaryPublicId}`;
      const { url: thumbnailUrl } = await saveFile(thumbBuffer, thumbPath);

      // Persist thumbnail URL and mark purged BEFORE deleting the original.
      // If the DB update fails, the file still exists and we retry next month.
      // If we deleted first and the DB update failed, the original would be
      // permanently gone but still flagged as present, causing repeated errors.
      await prisma.inspectionPhoto.update({
        where: { id: photo.id },
        data:  { thumbnailUrl, originalDeleted: true },
      });

      // Safe to delete — DB is already updated
      await deleteFile(photo.cloudinaryPublicId);

      photosProcessed++;
    } catch (err) {
      console.error(`[retention] photo ${photo.id} failed:`, err.message);
      errors++;
    }
  }

  // ── Videos ──────────────────────────────────────────────────────────────────
  const videos = await prisma.inspectionVideo.findMany({
    where: {
      takenAt:         { lt: cutoff },
      originalDeleted: false,
    },
    select: { id: true, storagePath: true },
  });

  for (const video of videos) {
    try {
      // Update DB first (same safe-delete order as photos above)
      await prisma.inspectionVideo.update({
        where: { id: video.id },
        data:  { originalDeleted: true },
      });
      await deleteFile(video.storagePath);
      videosProcessed++;
    } catch (err) {
      console.error(`[retention] video ${video.id} failed:`, err.message);
      errors++;
    }
  }

  return { photosProcessed, videosProcessed, errors };
}

module.exports = { runRetention, RETENTION_MONTHS };
