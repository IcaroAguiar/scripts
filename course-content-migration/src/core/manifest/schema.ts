import { z } from 'zod';

export const assetSchema = z.object({
  type: z.enum(['document', 'audio', 'image', 'external-link', 'unknown']),
  name: z.string().min(1),
  url: z.string().min(1),
  sha256: z.string().nullable(),
  localPath: z.string().optional(),
  targetPath: z.string().optional(),
  status: z.enum(['pending', 'downloaded', 'skipped', 'failed']).optional(),
  uploadStatus: z.enum(['pending', 'uploaded', 'skipped', 'failed']).optional(),
  driveFileId: z.string().optional(),
  driveWebUrl: z.string().optional(),
  lastError: z.string().optional()
});

export const lessonManifestSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  index: z.number().int().positive(),
  url: z.string().min(1),
  slug: z.string().min(1),
  description: z.string(),
  links: z.array(z.string()),
  assets: z.array(assetSchema),
  status: z.enum(['discovered', 'failed']).optional(),
  lastError: z.string().optional()
});

export const moduleManifestSchema = z.object({
  name: z.string().min(1),
  index: z.number().int().positive(),
  slug: z.string().min(1),
  lessons: z.array(lessonManifestSchema)
});

export const courseManifestSchema = z.object({
  platform: z.string().min(1),
  course: z.string().min(1),
  courseId: z.string().min(1),
  url: z.string().min(1),
  slug: z.string().min(1),
  discoveredAt: z.string().datetime(),
  modules: z.array(moduleManifestSchema)
});

export const courseIndexSchema = z.object({
  platform: z.string().min(1),
  discoveredAt: z.string().datetime(),
  courses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string()
    })
  )
});
